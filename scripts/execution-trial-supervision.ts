import {lstatSync} from "node:fs";
import {join, resolve} from "node:path";
import {types} from "node:util";
import {readTextBounded, sha256} from "../src/study.ts";
import {bindRunCode, verifyRunCodeCommit, type RunCodeBinding} from "./execution-code-binding.ts";
import {canonical, filePath, FROZEN_RECEIPT, verifyPreregistration} from "./execution-eval.ts";
import {loadSupervisionAmendmentCases, verifySupervisionAmendment, type SupervisionAmendmentCase} from "./execution-supervision-amendment.ts";
import {verifyReuseRematerializationR2} from "./execution-reuse-rematerialize-r2.ts";
import {scoreSupervisionIntentRecords, SUPERVISION_PRODUCER_COMMIT, type SupervisionIntentScore} from "./execution-supervision.ts";

export const SUPERVISION_SLOT_BYTES = 65_536, SUPERVISION_SHADOW_SLOTS = 144;
const PERMUTATIONS = [["A", "B", "C"], ["A", "C", "B"], ["B", "A", "C"], ["B", "C", "A"], ["C", "A", "B"], ["C", "B", "A"]] as const;
export interface SupervisionSlot {caseIndex: number; repetition: number; condition: "cold" | "warm"; permutation: ("A" | "B" | "C")[]; shadowIndex: number}
/** Fixed B-slot schedule, not a producer invocation or a launch authorization. */
export function supervisionSlots(): SupervisionSlot[] {
  return Array.from({length: 12}, (_, caseIndex) => PERMUTATIONS.flatMap((permutation, repetition) => (["cold", "warm"] as const).map(condition => ({caseIndex, repetition, condition, permutation: [...permutation], shadowIndex: permutation.indexOf("B")})))).flat();
}
export interface SupervisionTrialBindings {
  codeCommit: string; codeTree: string; codeSha256: string; v1ReceiptSha256: string; v2ReceiptSha256: string; reuseR2ReceiptSha256: string;
  inputSha256: string; methodSha256: string; producerCommit: string; producerModuleSha256: string; generatorSha256: string; imageDigest: string; environmentSha256: string;
}
export interface SupervisionGeneration {
  wallMs: number; cpuSeconds: number; containerCpuSeconds: number; containerCpuScope: "admitted-container-cgroup"; cpuScope: "generator-parent-process-only"; slotCpuScope: "slot-child-process"; observeCallsScope: "confirmed-child-receipts"; observeCallsUnknown: boolean; subprocessCpuSeconds: "unknown";
  observeCalls: number; freshShadowPerSlot: true; coldInput: "reread-private-bytes"; warmInput: "retained-input-bytes-only"; coldness: "not-os-or-jit";
}
export interface SupervisionTrialEnvironment {os: string; osRelease: string; arch: string; bun: string; logicalCpus: number; cpuLimit: number; memoryLimitBytes: number; pidsLimit: number; cpuModelsSha256: string; containerIdentitySha256: string; imageDigest: string; sequentialChildren: 1}
export interface SupervisionSlotCosts {wallMs: number; cpuSeconds: number; memoryRssBytes: number}
interface Manifest {v: 1; code: RunCodeBinding; environment: SupervisionTrialEnvironment; kind: "supervision-shadow-generated-records"; bindings: SupervisionTrialBindings; generation: SupervisionGeneration; slots: {file: string; sha256: string}[]}
export interface SupervisionGeneratedFile {file: string; text: string}
interface SlotResult {slot: SupervisionSlot; caseId: string; inputSha256: string; status: "succeeded" | "failed" | "unknown"; failure: "producer-failed" | "producer-unknown" | "case-budget" | "budget-stopped" | null; costs: SupervisionSlotCosts | null; score: SupervisionIntentScore | null}
interface Totals {full: number; succeeded: number; failed: number; unknown: number; helpful: number; falseCases: number; falseProposals: number; wrongAction: number; falseProposalBudget: number; missed: number | null; correctNonTriggers: number | null; insufficient: number}
export interface SupervisionTrialReport {
  v: 1; kind: "supervision-external-record-report"; authority: "synthetic-shadow-records-only"; code: RunCodeBinding; environment: SupervisionTrialEnvironment; bindings: SupervisionTrialBindings;
  slots: SlotResult[]; summary: {total: Totals; byCondition: {cold: Totals; warm: Totals}; byCase: {caseId: string; totals: Totals}[]};
  arms: {A: {planned: 144; executed: 0; notExecuted: 144; reason: "no-adapter-current-hub-no-outputs"}; B: {planned: 144; executed: number; failed: number; unknown: number}; C: {planned: 144; executed: 0; notExecuted: 144; reason: "unauthorized"}};
  costs: {sourceGeneration: SupervisionGeneration; total: "unknown"; perSlot: "slot-child-process-when-observed"; trialBudgetExceeded: boolean};
  bindingAssurance: {local: "code-and-sealed-input-method-receipts"; external: "source-declared-producer-generator-image-environment-digests"};
  E1: {disposition: "retain-shadow"; adoption: "insufficient"; reasons: string[]};
  personDecisions: 0; workerTurns: 0; actionWrites: 0; notifications: 0; limitations: string[];
}
function fail(cause: string): never {throw new Error(`execution supervision trial: ${cause}; restore the complete bounded external generation and matching sealed source/input/method bindings before scoring; do not regenerate or launch a trial from this reader`);}
function object(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail(`${label} needs a closed JSON object`);
  const fields = Object.getOwnPropertyDescriptors(raw);
  if (Reflect.ownKeys(raw).length !== keys.length || keys.some(key => !Object.hasOwn(fields, key)) || Object.entries(fields).some(([key, value]) => !keys.includes(key) || !("value" in value) || !value.enumerable)) fail(`${label} has missing, unknown or non-data fields`);
  return Object.fromEntries(keys.map(key => [key, fields[key]!.value]));
}
function array(raw: unknown, count: number, label: string): unknown[] {
  if (types.isProxy(raw) || !Array.isArray(raw) || raw.length !== count || Reflect.ownKeys(raw).length !== count + 1) fail(`${label} needs exactly ${count} dense items`);
  const values: unknown[] = [];
  for (let i = 0; i < count; i++) {const field = Object.getOwnPropertyDescriptor(raw, String(i)); if (!field || !("value" in field) || !field.enumerable) fail(`${label} has non-data items`); values.push(field.value);}
  return values;
}
function digest(value: unknown, label: string): string {if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(`${label} needs a lowercase SHA-256 digest`); return value;}
function gitId(value: unknown): string {if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail("Git identity is invalid"); return value;}
function elapsed(value: unknown): number {if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("generation clock is invalid"); return value;}
function json(text: string, label: string): unknown {if (Buffer.byteLength(text) > SUPERVISION_SLOT_BYTES) fail(`${label} exceeds 64 KiB`); try {return JSON.parse(text);} catch {return fail(`${label} is invalid JSON`);}}
const filename = (index: number) => `slot-${String(index).padStart(3, "0")}.json`;
function codeBinding(raw: unknown): RunCodeBinding {
  const row = object(raw, ["commit", "tree", "codeSha256", "files"], "code inventory");
  if (types.isProxy(row.files) || !Array.isArray(row.files) || row.files.length < 1 || row.files.length > 256) fail("code inventory count is unsupported");
  let bytes = 0;
  const files = array(row.files, row.files.length, "code files").map(raw => {
    const item = object(raw, ["path", "sha256", "bytes"], "code file");
    if (typeof item.path !== "string" || item.path.length > 4096 || item.path.startsWith("/") || item.path.includes("\\") || item.path.split("/").some(part => !part || part === "." || part === "..") || !Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0 || (item.bytes as number) > 1024 * 1024) fail("code inventory entry is invalid");
    bytes += item.bytes as number;
    return {path: item.path, sha256: digest(item.sha256, "code file hash"), bytes: item.bytes as number};
  });
  if (bytes > 16 * 1024 * 1024 || new Set(files.map(file => file.path)).size !== files.length || sha256(JSON.stringify(files)) !== row.codeSha256) fail("code inventory is duplicated, over-bound or changed");
  return {commit: gitId(row.commit), tree: gitId(row.tree), codeSha256: digest(row.codeSha256, "code hash"), files};
}
function environment(raw: unknown): SupervisionTrialEnvironment {
  const row = object(raw, ["os", "osRelease", "arch", "bun", "logicalCpus", "cpuLimit", "memoryLimitBytes", "pidsLimit", "cpuModelsSha256", "containerIdentitySha256", "imageDigest", "sequentialChildren"], "environment");
  for (const key of ["os", "osRelease", "arch", "bun"] as const) if (typeof row[key] !== "string" || !(row[key] as string).length || Buffer.byteLength(row[key] as string) > 256 || /[\p{Cc}\p{Cs}]/u.test(row[key] as string)) fail("environment identity is invalid");
  if (row.bun !== "1.4.2") fail("source Bun runtime differs from the frozen 1.4.2 admission");
  if (row.os !== "linux" || !Number.isSafeInteger(row.logicalCpus) || (row.logicalCpus as number) < 1 || typeof row.cpuLimit !== "number" || !Number.isFinite(row.cpuLimit) || row.cpuLimit <= 0 || row.cpuLimit > 2 || !Number.isSafeInteger(row.memoryLimitBytes) || (row.memoryLimitBytes as number) <= 0 || (row.memoryLimitBytes as number) > 256 * 1024 * 1024 || !Number.isSafeInteger(row.pidsLimit) || (row.pidsLimit as number) <= 0 || (row.pidsLimit as number) > 32 || row.sequentialChildren !== 1 || typeof row.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(row.imageDigest)) fail("source environment exceeds the admitted CPU/memory/PID limits");
  return {...row, cpuModelsSha256: digest(row.cpuModelsSha256, "CPU model hash"), containerIdentitySha256: digest(row.containerIdentitySha256, "container hash")} as unknown as SupervisionTrialEnvironment;
}
function manifest(raw: unknown, expected: SupervisionTrialBindings): Manifest {
  const value = object(raw, ["v", "kind", "code", "environment", "bindings", "generation", "slots"], "manifest");
  if (value.v !== 1 || value.kind !== "supervision-shadow-generated-records") fail("manifest version/kind is unsupported");
  const code = codeBinding(value.code), env = environment(value.environment);
  const keys = ["codeCommit", "codeTree", "codeSha256", "v1ReceiptSha256", "v2ReceiptSha256", "reuseR2ReceiptSha256", "inputSha256", "methodSha256", "producerCommit", "producerModuleSha256", "generatorSha256", "imageDigest", "environmentSha256"] as const;
  const fields = object(value.bindings, keys, "bindings"), bindings = Object.fromEntries(keys.map(key => [key, key === "codeCommit" || key === "codeTree" || key === "producerCommit" ? gitId(fields[key]) : key === "imageDigest" ? fields[key] : digest(fields[key], key)])) as unknown as SupervisionTrialBindings;
  if (typeof bindings.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(bindings.imageDigest) || bindings.producerCommit !== SUPERVISION_PRODUCER_COMMIT || canonical(bindings) !== canonical(expected)) fail("generation bindings do not match the intended source/input/method/producer/environment");
  if (code.commit !== bindings.codeCommit || code.tree !== bindings.codeTree || code.codeSha256 !== bindings.codeSha256 || env.imageDigest !== bindings.imageDigest || sha256(canonical(env)) !== bindings.environmentSha256) fail("code/environment facts differ from their generation bindings");
  const g = object(value.generation, ["wallMs", "cpuSeconds", "containerCpuSeconds", "containerCpuScope", "cpuScope", "slotCpuScope", "observeCallsScope", "observeCallsUnknown", "subprocessCpuSeconds", "observeCalls", "freshShadowPerSlot", "coldInput", "warmInput", "coldness"], "generation");
  if (g.containerCpuScope !== "admitted-container-cgroup" || g.cpuScope !== "generator-parent-process-only" || g.slotCpuScope !== "slot-child-process" || g.observeCallsScope !== "confirmed-child-receipts" || typeof g.observeCallsUnknown !== "boolean" || g.subprocessCpuSeconds !== "unknown" || (!Number.isSafeInteger(g.observeCalls) || (g.observeCalls as number) < 0 || (g.observeCalls as number) > 144) || g.freshShadowPerSlot !== true || g.coldInput !== "reread-private-bytes" || g.warmInput !== "retained-input-bytes-only" || g.coldness !== "not-os-or-jit") fail("generation scope is unsupported");
  const generation: SupervisionGeneration = {wallMs: elapsed(g.wallMs), cpuSeconds: elapsed(g.cpuSeconds), containerCpuSeconds: elapsed(g.containerCpuSeconds), containerCpuScope: g.containerCpuScope, cpuScope: g.cpuScope, slotCpuScope: g.slotCpuScope, observeCallsScope: g.observeCallsScope, observeCallsUnknown: g.observeCallsUnknown, subprocessCpuSeconds: g.subprocessCpuSeconds, observeCalls: g.observeCalls as number, freshShadowPerSlot: true, coldInput: g.coldInput, warmInput: g.warmInput, coldness: g.coldness};
  const slots = array(value.slots, 144, "manifest slots").map((raw, index) => {const row = object(raw, ["file", "sha256"], "manifest slot"); if (row.file !== filename(index)) fail("manifest slot order/name differs from the complete schedule"); return {file: row.file, sha256: digest(row.sha256, "slot hash")};});
  return {v: 1, kind: "supervision-shadow-generated-records", code, environment: env, bindings, generation, slots};
}
function totals(rows: SlotResult[]): Totals {
  const result: Totals = {full: rows.length, succeeded: 0, failed: 0, unknown: 0, helpful: 0, falseCases: 0, falseProposals: 0, wrongAction: 0, falseProposalBudget: 0, missed: null, correctNonTriggers: null, insufficient: 0};
  for (const row of rows) {
    result[row.status]++;
    if (!row.score) {result.insufficient++; continue;}
    const score = row.score.scores, outcome = row.score.rows[0]?.outcome;
    if (outcome === "insufficient") result.insufficient++;
    if (!score) continue;
    result.helpful += score.helpful; result.falseCases += score.falseCases; result.falseProposals += score.falseProposals; result.wrongAction += score.wrongAction; result.falseProposalBudget += score.falseProposalBudget;
    if (score.missed !== null) result.missed = (result.missed ?? 0) + score.missed;
    if (score.correctNonTriggers !== null) result.correctNonTriggers = (result.correctNonTriggers ?? 0) + score.correctNonTriggers;
  }
  return result;
}
/** Pure unit seam: supplied records are decoded/scored; no producer, model, hub, network or data generation. */
export function scoreSupervisionGeneratedRecords(rawManifest: unknown, files: readonly SupervisionGeneratedFile[], cases: readonly SupervisionAmendmentCase[], expected: SupervisionTrialBindings): SupervisionTrialReport {
  if (cases.length !== 12 || new Set(cases.map(row => row.id)).size !== 12) fail("exactly twelve unique sealed cases are required");
  const header = manifest(rawManifest, expected), schedule = supervisionSlots();
  if (Buffer.byteLength(JSON.stringify(header)) > SUPERVISION_SLOT_BYTES || files.reduce((sum, file) => sum + Buffer.byteLength(file.text), Buffer.byteLength(JSON.stringify(header))) > 16 * 1024 * 1024) fail("generation exceeds its manifest or total output budget");
  if (files.length !== 144 || new Set(files.map(file => file.file)).size !== 144) fail("generated slots are missing or duplicated");
  const inputFiles = new Map(files.map(file => [file.file, file.text]));
  const slots = schedule.map((slot, index): SlotResult => {
    const declared = header.slots[index]!, text = inputFiles.get(declared.file);
    if (text === undefined || sha256(text) !== declared.sha256) fail("generated slot bytes are missing or changed");
    const value = object(json(text, "slot"), ["v", "slot", "caseId", "inputSha256", "status", "snapshot", "failure", "costs"], "slot"), identity = object(value.slot, ["caseIndex", "repetition", "condition", "permutation", "shadowIndex"], "slot identity");
    const permutation = array(identity.permutation, 3, "slot permutation");
    if (value.v !== 1 || canonical({...identity, permutation}) !== canonical(slot)) fail("slot identity differs from the fixed schedule");
    const studyCase = cases[slot.caseIndex]!;
    if (value.caseId !== studyCase.id || digest(value.inputSha256, "slot input hash") !== studyCase.inputSha256) fail("slot does not bind its exact sealed case/input pair");
    if (!["succeeded", "failed", "unknown"].includes(String(value.status))) fail("slot status is unsupported");
    const status = value.status as SlotResult["status"];
    let costs: SupervisionSlotCosts | null = null;
    if (value.costs !== null) {
      const raw = object(value.costs, ["wallMs", "cpuSeconds", "memoryRssBytes"], "slot costs");
      if (!Number.isSafeInteger(raw.memoryRssBytes) || (raw.memoryRssBytes as number) < 0) fail("slot memory reading is invalid");
      costs = {wallMs: elapsed(raw.wallMs), cpuSeconds: elapsed(raw.cpuSeconds), memoryRssBytes: raw.memoryRssBytes as number};
    }
    const exceeded = costs !== null && (costs.wallMs > 60_000 || costs.cpuSeconds > 60 || costs.memoryRssBytes > 256 * 1024 * 1024);
    if (status !== "succeeded") {
      const allowed = status === "failed" ? ["producer-failed", "case-budget"] : ["producer-unknown", "budget-stopped"];
      if (value.snapshot !== null || !allowed.includes(String(value.failure)) || exceeded && value.failure !== "case-budget" || value.failure === "budget-stopped" && costs !== null) fail("failed/unknown slot must retain its actual failure/cost scope without fabricated records");
      return {slot, caseId: studyCase.id, inputSha256: studyCase.inputSha256, status, failure: value.failure as SlotResult["failure"], costs, score: null};
    }
    if (value.failure !== null || value.snapshot === null || costs === null || exceeded) fail("successful slot needs its actual snapshot and observed within-budget wall/CPU/RSS costs");
    const score = scoreSupervisionIntentRecords([value.snapshot], studyCase.payload.facts, [studyCase.expected]);
    return {slot, caseId: studyCase.id, inputSha256: studyCase.inputSha256, status, failure: null, costs, score};
  });
  const total = totals(slots);
  if (header.generation.observeCalls < total.succeeded) fail("generation observe count is smaller than successful slot records");
  const stop = slots.findIndex(row => row.failure === "case-budget" || row.failure === "producer-unknown" || row.failure === "budget-stopped");
  if (stop >= 0 && slots.slice(stop + (slots[stop]!.failure === "budget-stopped" ? 0 : 1)).some(row => row.failure !== "budget-stopped")) fail("a budget or unobserved outcome must preserve the complete unexecuted suffix");
  if (header.generation.observeCalls > slots.filter(row => row.failure !== "budget-stopped").length || slots.some(row => row.failure === "producer-unknown") && !header.generation.observeCallsUnknown) fail("confirmed observe calls exceed attempted slots or hide an unobserved invocation");
  return {v: 1, kind: "supervision-external-record-report", authority: "synthetic-shadow-records-only", code: header.code, environment: header.environment, bindings: header.bindings, slots,
    summary: {total, byCondition: {cold: totals(slots.filter(row => row.slot.condition === "cold")), warm: totals(slots.filter(row => row.slot.condition === "warm"))}, byCase: cases.map(row => ({caseId: row.id, totals: totals(slots.filter(slot => slot.caseId === row.id))}))},
    arms: {A: {planned: 144, executed: 0, notExecuted: 144, reason: "no-adapter-current-hub-no-outputs"}, B: {planned: 144, executed: header.generation.observeCalls, failed: total.failed, unknown: total.unknown}, C: {planned: 144, executed: 0, notExecuted: 144, reason: "unauthorized"}},
    costs: {sourceGeneration: header.generation, total: "unknown", perSlot: "slot-child-process-when-observed", trialBudgetExceeded: header.generation.wallMs > 7_200_000 || header.generation.containerCpuSeconds > 7200}, bindingAssurance: {local: "code-and-sealed-input-method-receipts", external: "source-declared-producer-generator-image-environment-digests"},
    E1: {disposition: "retain-shadow", adoption: "insufficient", reasons: ["A adapter/current hub outputs unavailable", "no accepted outcome or recovery measurement", "C is unauthorized", "descriptive shadow repetitions are not independent benefit evidence"]},
    personDecisions: 0, workerTurns: 0, actionWrites: 0, notifications: 0,
    limitations: ["external one-off producer record consumer only; no rule evaluator, hub import, model, network or generation is executed here", "cold rereads private input bytes; warm retains bytes only; neither condition represents OS/JIT coldness", "every admitted slot declares a fresh ShadowSupervisor and one observe call; confirmed child receipts give an invocation lower bound, with unknown calls retained after a lost acknowledgement; the consumer does not attest generation", "generation process CPU is parent scoped and slot CPU/RSS is child scoped; admitted-container cgroup CPU is a separate kernel budget counter, never added to process CPU; complete trial and recovery costs remain unknown", "144 shadow repetitions preserve full failed/unknown denominators, not independent treatment benefit"]};
}
function capture(root: string) {
  const v1 = verifyPreregistration(root, filePath(root, FROZEN_RECEIPT)), v2 = verifySupervisionAmendment(root), r2 = verifyReuseRematerializationR2(root);
  if (r2.state !== "verified") fail("reuse r2 seal is unavailable or changed");
  return {code: bindRunCode(root), v1, v2, r2: r2.receipt};
}
/** Read-only bounded consumer of externally generated records, fenced by all three seals before and after. */
export function scoreSupervisionTrial(rootArg: string, generatedDir: string): SupervisionTrialReport {
  const root = resolve(rootArg), dir = resolve(generatedDir), stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("generation directory must be an explicit physical directory");
  const before = capture(root), loaded = loadSupervisionAmendmentCases(root);
  const manifestText = readTextBounded(join(dir, "manifest.json"), SUPERVISION_SLOT_BYTES, {noFollow: true}), raw = json(manifestText, "manifest");
  const code = codeBinding(object(raw, ["v", "kind", "code", "environment", "bindings", "generation", "slots"], "manifest").code);
  verifyRunCodeCommit(root, code);
  const external = object(object(raw, ["v", "kind", "code", "environment", "bindings", "generation", "slots"], "manifest").bindings, ["codeCommit", "codeTree", "codeSha256", "v1ReceiptSha256", "v2ReceiptSha256", "reuseR2ReceiptSha256", "inputSha256", "methodSha256", "producerCommit", "producerModuleSha256", "generatorSha256", "imageDigest", "environmentSha256"], "bindings");
  const expected: SupervisionTrialBindings = {codeCommit: code.commit, codeTree: code.tree, codeSha256: code.codeSha256, v1ReceiptSha256: before.v1.receiptSha256, v2ReceiptSha256: before.v2.receiptSha256, reuseR2ReceiptSha256: before.r2.receiptSha256,
    inputSha256: before.v2.bindings.inputSha256, methodSha256: before.v2.bindings.methodSha256, producerCommit: SUPERVISION_PRODUCER_COMMIT,
    producerModuleSha256: digest(external.producerModuleSha256, "producer module hash"), generatorSha256: digest(external.generatorSha256, "generator hash"), imageDigest: String(external.imageDigest), environmentSha256: digest(external.environmentSha256, "environment hash")};
  const files = supervisionSlots().map((_, index) => ({file: filename(index), text: readTextBounded(join(dir, filename(index)), SUPERVISION_SLOT_BYTES, {noFollow: true})}));
  const result = scoreSupervisionGeneratedRecords(raw, files, loaded.cases, expected);
  if (canonical(before) !== canonical(capture(root)) || sha256(manifestText) !== sha256(readTextBounded(join(dir, "manifest.json"), SUPERVISION_SLOT_BYTES, {noFollow: true}))) fail("sealed source or generation manifest changed while scoring");
  for (const file of files) if (sha256(file.text) !== sha256(readTextBounded(join(dir, file.file), SUPERVISION_SLOT_BYTES, {noFollow: true}))) fail("generated slot changed while scoring");
  verifyRunCodeCommit(root, code);
  return result;
}
