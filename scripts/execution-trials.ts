import {existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statfsSync, unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, isAbsolute, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {randomUUID} from "node:crypto";
import {types} from "node:util";
import {baselineEnvironment, baselineSlots, classifyChildFailure, RESULT_AUTHORITY_DEVIATION} from "./execution-baseline.ts";
import {bindRunCode, RUN_CODE_FILE_BYTES, RUN_CODE_FILES, verifyRunCodeCommit, type RunCodeBinding} from "./execution-code-binding.ts";
import {canonical, COST_FIELDS, FROZEN_RECEIPT, PREREGISTRATION, validateCostRecord, verifyPreregistration, type CostRecord} from "./execution-eval.ts";
import {verifySupervisionAmendment} from "./execution-supervision-amendment.ts";
import {verifyReuseRematerializationR2} from "./execution-reuse-rematerialize-r2.ts";
import {resolveDiagnosticFixture} from "./execution-diagnose.ts";
import {plain, readBytesBounded, readTextBounded, sha256, writeAtomic} from "../src/study.ts";

export const TREATMENT_RECEIPT_BYTES = 65_536, TREATMENT_BUNDLE_BYTES = 16 * 1024 * 1024;
export const TREATMENT_BUNDLE_PREFIX = "EXECUTION_TREATMENT_BUNDLE ";
export const TREATMENT_AUTHORITY_DEVIATION = {...RESULT_AUTHORITY_DEVIATION, resultAuthorityDecision: {issue: 63, date: "2026-11-10", scope: "observation-only paired T3 adapter"}};
const INPUT_BYTES = 16_384, STUB_BYTES = 4096, SLOTS = 144;
export type TreatmentTrial = "diagnose" | "reuse";
export type TreatmentArm = "current-workflow" | "H1-A1-C1-lineage-view" | "fresh" | "eligible-reuse";
export type TreatmentStatus = "succeeded" | "failed" | "cancelled" | "unknown" | "excluded";
const STATUSES: TreatmentStatus[] = ["succeeded", "failed", "cancelled", "unknown", "excluded"];
const ARMS: Record<TreatmentTrial, readonly [TreatmentArm, TreatmentArm]> = {diagnose: ["current-workflow", "H1-A1-C1-lineage-view"], reuse: ["fresh", "eligible-reuse"]};
export interface TreatmentSlot {seed: number; repetition: number; condition: "cold" | "warm"; slotOrder: TreatmentArm[]; executedSlot: number; arm: TreatmentArm}
export interface DiagnoseSetupCode {helperSha256: string; fixtureFactorySha256: string}
interface FileIdentity {path: string; sha256: string; bytes: number}
interface Binding {registration: string; supervision: string; reuseR2: string; reuseSetup: string}
export interface TreatmentObservation extends TreatmentSlot {
  v: 1; authority: "harness-observed"; trial: TreatmentTrial; caseId: string; caseIndex: number; slot: number;
  codeSha256: string; methodSha256: string; inputSha256: string; expectedSha256: string;
  status: TreatmentStatus; cause: string | null; matched: boolean | "unknown"; result: unknown; integration: unknown;
  processWallMs: number | "unknown"; humanTimeToFind: "unknown"; costs: CostRecord;
  containerCpuSeconds: number | "unknown";
  diagnoseSetupCode?: DiagnoseSetupCode;
  artifact: {sha256: string; bytes: number} | null;
  logs: {stdout: {sha256: string; bytes: number}; stderr: {sha256: string; bytes: number}} | null;
}
export interface TreatmentTrialManifest {
  v: 1; kind: "synthetic-paired-treatment-observations"; authority: "harness-observed"; trial: TreatmentTrial;
  resultAuthorityLinks: string[]; resultAuthorityLinksReason: string; resultAuthorityDecision: {issue: number; date: string; scope: string};
  state: "complete" | "incomplete"; failure: {cause: string; nextStep: string} | null; startedAt: string; endedAt: string;
  bindings: Binding; methodSha256: string; inputSha256: string; expectedSha256: string; code: RunCodeBinding;
  environment: ReturnType<typeof baselineEnvironment>;
  schedule: {cases: 12; repetitions: 3; conditions: ["cold", "warm"]; arms: TreatmentArm[]; observations: 144; sha256: string};
  denominators: ReturnType<typeof treatmentDenominators>; costs: CostRecord;
  admission: {parentCpuSeconds: number; wallMs: number; codeMaterializationBytes: number; tmpfs: {kind: "controller-tmpfs-cap"; bytes: number}};
  accounting: {cpuScope: string; components: string; transferBytes: number; retainedBytes: number; unpublishedSlots: number; containerCpuSeconds: number | "unknown"; containerCpuScope: "admitted-container-cgroup"};
  files: FileIdentity[]; limitations: string[];
}
function fail(cause: string, next = "keep existing receipts, restore the frozen seals and committed code, and use a fresh admitted output directory before a separately authorized run"): never {throw new Error(`execution treatment trials: ${cause}; ${next}`);}
function trialName(raw: unknown): TreatmentTrial {if (raw !== "diagnose" && raw !== "reuse") fail("trial must be diagnose or reuse"); return raw;}
function hash(raw: unknown): string {if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) fail("lowercase SHA-256 required"); return raw;}
function integer(raw: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < min || raw > max) fail("bounded safe integer required"); return raw;}
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (types.isProxy(raw) || !plain(raw)) fail("closed JSON object required");
  const own = Reflect.ownKeys(raw), result: Record<string, unknown> = {};
  if (own.length !== keys.length) fail("missing or unknown receipt fields");
  for (const key of own) {
    if (typeof key !== "string" || key === "__proto__" || key === "toJSON" || !keys.includes(key)) fail("missing, unknown or reserved receipt fields");
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (!field || !("value" in field) || !field.enumerable) fail("receipt fields must be inert JSON data");
    result[key] = field.value;
  }
  return result;
}
function array(raw: unknown, maximum: number): unknown[] {
  if (types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) fail("bounded dense JSON array required");
  const length = Object.getOwnPropertyDescriptor(raw, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maximum || Reflect.ownKeys(raw).length !== length.value + 1) fail("bounded dense JSON array required");
  return Array.from({length: length.value}, (_, index) => {const field = Object.getOwnPropertyDescriptor(raw, String(index)); if (!field || !("value" in field) || !field.enumerable) fail("dense array data required"); return field.value;});
}
function inert(raw: unknown, depth = 0, budget = {bytes: 0, nodes: 0}): unknown {
  if (depth > 24 || ++budget.nodes > 8192) fail("receipt nesting or node bound exceeded");
  const add = (size: number) => {budget.bytes += size; if (budget.bytes > TREATMENT_RECEIPT_BYTES) fail("receipt exceeds 64 KiB");};
  if (raw === null || typeof raw === "boolean") {add(Buffer.byteLength(JSON.stringify(raw))); return raw;}
  if (typeof raw === "number") {if (!Number.isFinite(raw)) fail("finite receipt number required"); add(Buffer.byteLength(JSON.stringify(raw))); return raw;}
  if (typeof raw === "string") {if (raw.length > TREATMENT_RECEIPT_BYTES || Buffer.byteLength(raw) > TREATMENT_RECEIPT_BYTES || /^(?:\/|[A-Za-z]:[\\/]|file:)/.test(raw)) fail("receipt text must be bounded and path-free"); add(Buffer.byteLength(JSON.stringify(raw))); return raw;}
  if (types.isProxy(raw)) fail("inert JSON receipt data required");
  if (Array.isArray(raw)) {const values = array(raw, 8192); add(2 + Math.max(0, values.length - 1)); return values.map(value => inert(value, depth + 1, budget));}
  if (!plain(raw)) fail("inert JSON receipt data required");
  const keys = Reflect.ownKeys(raw); if (keys.length > 8192 || keys.some(key => typeof key !== "string")) fail("inert JSON receipt keys required");
  add(2 + Math.max(0, keys.length - 1));
  const row = object(raw, keys as string[]), result: Record<string, unknown> = {};
  for (const key of keys as string[]) {if (key.length > TREATMENT_RECEIPT_BYTES) fail("receipt key bound exceeded"); add(Buffer.byteLength(JSON.stringify(key)) + 1); result[key] = inert(row[key], depth + 1, budget);}
  return result;
}
function bounded(raw: unknown): unknown {const normalized = inert(raw); if (Buffer.byteLength(JSON.stringify(normalized)) > TREATMENT_RECEIPT_BYTES) fail("receipt exceeds 64 KiB"); return normalized;}
function unknownCosts(): CostRecord {return Object.fromEntries(COST_FIELDS.map(key => [key, "unknown"])) as CostRecord;}
function cpu(before: NodeJS.CpuUsage): number {const used = process.cpuUsage(before); return (used.user + used.system) / 1_000_000;}
export function treatmentChildCpuSeconds(usage: {cpuTime: {total: number | bigint}} | undefined): number | "unknown" {
  if (!usage) return "unknown";
  const microseconds = Number(usage.cpuTime.total);
  return Number.isFinite(microseconds) && microseconds >= 0 && microseconds <= Number.MAX_SAFE_INTEGER ? microseconds / 1_000_000 : "unknown";
}
export function parseTreatmentCgroupCpu(text: string): number {
  if (text.length > 4096 || Buffer.byteLength(text) > 4096) fail("cgroup CPU meter exceeded its bound");
  const rows = text.split("\n").filter(line => /^usage_usec(?:\s|$)/.test(line));
  if (rows.length !== 1 || !/^usage_usec [0-9]+$/.test(rows[0]!)) fail("cgroup CPU usage counter is unavailable");
  return integer(Number(rows[0]!.slice("usage_usec ".length))) / 1_000_000;
}
function cgroupCpu(): number {try {return parseTreatmentCgroupCpu(readTextBounded("/sys/fs/cgroup/cpu.stat", 4096));} catch {return fail("bounded admitted-container cgroup CPU meter is unavailable");}}
const tally = () => ({full: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0, excluded: 0});
/** The original global corpus index, including other trials, controls both arms' paired order. */
export function treatmentSlots(index: number, seeds: readonly number[], trial: TreatmentTrial): TreatmentSlot[] {
  trialName(trial);
  return baselineSlots(index, seeds).flatMap(slot => {
    const order = slot.executedSlot === 0 ? [...ARMS[trial]] : [...ARMS[trial]].reverse();
    return order.map((arm, executedSlot) => ({seed: slot.seed, repetition: slot.repetition, condition: slot.condition, slotOrder: [...order], executedSlot, arm}));
  });
}
export function treatmentDenominators(rows: readonly {arm: TreatmentArm; status: TreatmentStatus}[]) {
  const total = tally(), arms: Partial<Record<TreatmentArm, ReturnType<typeof tally>>> = {};
  for (const row of rows) {
    if (![...ARMS.diagnose, ...ARMS.reuse].includes(row.arm) || !STATUSES.includes(row.status)) fail("denominator arm/status is invalid");
    total.full++; total[row.status]++;
    const arm = arms[row.arm] ??= tally(); arm.full++; arm[row.status]++;
  }
  return {...total, arms};
}
function totals(rows: readonly TreatmentObservation[]): CostRecord {
  const result = unknownCosts();
  for (const key of COST_FIELDS) {const values = rows.map(row => row.costs[key]); if (values.length && values.every((value): value is number => typeof value === "number")) result[key] = key === "storagePeakBytes" ? Math.max(...values) : values.reduce((sum, value) => sum + value, 0);}
  return validateCostRecord(result);
}
function seals(root: string): Binding {
  const registration = verifyPreregistration(root, join(root, FROZEN_RECEIPT));
  const supervision = verifySupervisionAmendment(root), reuse = verifyReuseRematerializationR2(root);
  if (reuse.state !== "verified") fail("a verified Reuse r2 seal is required; the original seal is immutable history");
  return {registration: registration.receiptSha256, supervision: supervision.receiptSha256, reuseR2: reuse.receipt.receiptSha256, reuseSetup: reuse.receipt.setup.setupSha256};
}
interface Case {id: string; index: number; payload: Record<string, unknown>; truth: Record<string, unknown>; inputSha256: string; expectedSha256: string}
export interface RegisteredTreatmentSlot extends TreatmentSlot {slot: number; caseId: string; caseIndex: number; inputSha256: string; expectedSha256: string}
function loadCases(root: string, trial: TreatmentTrial, registration: ReturnType<typeof verifyPreregistration>): Case[] {
  const inputHashes = new Map(registration.inputFiles.map(file => [file.path, file.sha256])), expectedHashes = new Map(registration.expectedFiles.map(file => [file.path, file.sha256]));
  const read = (name: string, hashes: Map<string, string>, max: number) => {const text = readTextBounded(join(root, name), max, {noFollow: true}); if (sha256(text) !== hashes.get(name)) fail("sealed fixture identity changed"); const raw: unknown = JSON.parse(text); if (!plain(raw)) fail("fixture object required"); return raw;};
  const corpus = read("test/fixtures/execution-eval/corpus.json", inputHashes, TREATMENT_RECEIPT_BYTES), cases: Case[] = [];
  for (const [index, raw] of array(corpus.cases, 48).entries()) {
    if (!plain(raw) || raw.trial !== trial) continue;
    if (typeof raw.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) || raw.input !== `test/fixtures/execution-eval/${raw.id}.input.json` || raw.expected !== `test/fixtures/execution-eval/${raw.id}.expected.json`) fail("frozen case identity is invalid");
    const input = read(raw.input, inputHashes, INPUT_BYTES), truth = read(raw.expected, expectedHashes, INPUT_BYTES);
    if (!plain(input.input)) fail("candidate payload is missing");
    cases.push({id: raw.id, index, payload: input.input, truth, inputSha256: inputHashes.get(raw.input)!, expectedSha256: expectedHashes.get(raw.expected)!});
  }
  if (cases.length !== 12) fail("each registered trial requires exactly twelve cases");
  return cases;
}
function planCases(cases: Case[], trial: TreatmentTrial, firstVariant: unknown) {
  const planned = cases.flatMap(row => {
    const seeds = trial === "reuse" && plain(row.payload.workload) ? row.payload.workload.seeds : firstVariant;
    if (!Array.isArray(seeds)) fail("declared seed triplet is missing");
    return treatmentSlots(row.index, seeds as number[], trial).map(slot => ({row, slot}));
  });
  if (planned.length !== SLOTS) fail("paired schedule must contain 144 observations");
  return planned;
}
function registeredSlots(planned: ReturnType<typeof planCases>): RegisteredTreatmentSlot[] {
  return planned.map(({row, slot}, index) => ({...slot, slot: index, caseId: row.id, caseIndex: row.index, inputSha256: row.inputSha256, expectedSha256: row.expectedSha256}));
}
/** Reconstruct only frozen evaluator metadata; never launches an adapter or trial. */
export function readRegisteredTreatmentSchedule(root: string, trial: TreatmentTrial) {
  trialName(trial);
  const bindings = seals(root), registration = verifyPreregistration(root, join(root, FROZEN_RECEIPT));
  const protocol = JSON.parse(readTextBounded(join(root, PREREGISTRATION), TREATMENT_RECEIPT_BYTES));
  const cases = loadCases(root, trial, registration), slots = registeredSlots(planCases(cases, trial, protocol.design.seedSets.firstVariant));
  return {bindings, methodSha256: registration.bindings.methodSha256, inputSha256: registration.bindings.inputSha256, expectedSha256: registration.bindings.expectedSha256, slots, sha256: sha256(canonical(slots))};
}
function diagnostic(raw: unknown) {if (!plain(raw)) return null; return {provenance: raw.provenance, nextAction: raw.nextAction, ...(raw.retryOf === undefined ? {} : {retryOf: raw.retryOf}), ...(raw.independentSamples === undefined ? {} : {independentSamples: raw.independentSamples})};}
export function diagnoseSetupCode(binding: RunCodeBinding): DiagnoseSetupCode {
  const fileHash = (path: string) => {const files = binding.files.filter(file => file.path === path); if (files.length !== 1) fail("Diagnose setup helpers are absent or duplicated in measured code"); return hash(files[0]!.sha256);};
  return {helperSha256: fileHash("scripts/execution-diagnose-setup.ts"), fixtureFactorySha256: fileHash("scripts/execution-native-fixtures.ts")};
}
function setupCode(raw: unknown): DiagnoseSetupCode {const row = object(raw, ["helperSha256", "fixtureFactorySha256"]); return {helperSha256: hash(row.helperSha256), fixtureFactorySha256: hash(row.fixtureFactorySha256)};}
export function validateDiagnosticScaffolding(raw: unknown, expected: DiagnoseSetupCode, payload?: unknown): void {
  const row = object(raw, ["v", "kind", "authority", "source", "independentPhysicalAttestation", "state", "reason", "helperSha256", "fixtureFactorySha256", "setup", "current", "clockScope", "components"]);
  if (row.v !== 1 || row.kind !== "synthetic-native-scaffolding" || row.authority !== "harness-observed" || row.source !== "visible-facts-only" || row.independentPhysicalAttestation !== false || row.clockScope !== "child-parent-process-only") fail("Diagnose scaffolding authority or clock scope is invalid");
  if (row.helperSha256 !== expected.helperSha256 || row.fixtureFactorySha256 !== expected.fixtureFactorySha256) fail("Diagnose scaffolding hashes differ from explicit setup code binding");
  if (row.state !== "materialized" && row.state !== "skipped" || row.state === "materialized" && row.reason !== null || row.state === "skipped" && row.reason !== "no-visible-producer") fail("Diagnose scaffolding state and reason disagree");
  if (typeof row.components !== "string" || !row.components.trim() || row.components.length > 1024 || /\p{Cc}/u.test(row.components)) fail("Diagnose component clock scope is missing");
  for (const field of ["setup", "current"]) {const clock = object(row[field], ["wallMs", "parentCpuSeconds", "subprocessCpuSeconds"]); if (clock.subprocessCpuSeconds !== "unknown") fail("Diagnose subprocess CPU must stay unknown"); for (const unit of ["wallMs", "parentCpuSeconds"]) if (typeof clock[unit] !== "number" || !Number.isFinite(clock[unit]) || clock[unit] < 0) fail("Diagnose phase clock must be finite and nonnegative");}
  if (payload !== undefined && (row.state === "skipped") !== (resolveDiagnosticFixture(payload).provenance.attemptId === null)) fail("Diagnose scaffolding skip state differs from visible producer facts");
}
function observationScaffolding(row: TreatmentObservation, expected: DiagnoseSetupCode, payload?: unknown): void {
  if (canonical(row.diagnoseSetupCode) !== canonical(expected)) fail("diagnostic setup code binding differs from measured helper inventory");
  if (row.result !== null || row.integration !== null) {
    if (!plain(row.integration)) fail("observed Diagnose result requires scaffolding metadata");
    validateDiagnosticScaffolding(row.integration.scaffolding, expected, payload);
  }
}
export function treatmentMatches(trial: TreatmentTrial, truth: unknown, seed: number, result: unknown): boolean {
  if (!plain(truth)) fail("sealed expected object required");
  if (trialName(trial) === "diagnose") return canonical(diagnostic(result)) === canonical(diagnostic(truth));
  if (!plain(truth.freshExecution) || !Array.isArray(truth.freshExecution.outputs)) fail("sealed fresh-output truth is unavailable");
  const expected = truth.freshExecution.outputs.filter(value => plain(value) && value.seed === seed);
  if (expected.length !== 1) fail("seed has no unique sealed fresh-output truth");
  return canonical(result) === canonical(expected[0]);
}
function exclusive(file: string, text: string): void {
  const temp = join(dirname(file), `.treatment-${randomUUID()}.tmp`);
  try {writeAtomic(temp, text, TREATMENT_RECEIPT_BYTES, 0o600); try {linkSync(temp, file);} catch {fail("create-once receipt publication failed; existing receipts were preserved");}}
  finally {if (existsSync(temp)) unlinkSync(temp);}
}
export function validateTreatmentObservation(raw: unknown): TreatmentObservation {
  const normalized = bounded(raw); if (!plain(normalized)) fail("closed observation object required");
  const trial = trialName(normalized.trial);
  const row = object(normalized, ["v", "authority", "trial", "caseId", "caseIndex", "slot", "seed", "repetition", "condition", "slotOrder", "executedSlot", "arm", "codeSha256", "methodSha256", "inputSha256", "expectedSha256", "status", "cause", "matched", "result", "integration", "processWallMs", "humanTimeToFind", "costs", "containerCpuSeconds", "artifact", "logs", ...(trial === "diagnose" ? ["diagnoseSetupCode"] : [])]);
  if (row.v !== 1 || row.authority !== "harness-observed" || typeof row.caseId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(row.caseId) || !ARMS[trial].includes(row.arm as TreatmentArm) || !STATUSES.includes(row.status as TreatmentStatus) || !["cold", "warm"].includes(String(row.condition)) || row.humanTimeToFind !== "unknown" || ![true, false, "unknown"].includes(row.matched as boolean | string)) fail("observation identity or state is invalid");
  integer(row.caseIndex, 0, 47); integer(row.slot, 0, SLOTS - 1); integer(row.repetition, 0, 2); integer(row.seed, -2147483648, 2147483647); integer(row.executedSlot, 0, 1);
  const order = array(row.slotOrder, 2); if (order.length !== 2 || new Set(order).size !== 2 || order.some(arm => !ARMS[trial].includes(arm as TreatmentArm)) || order[row.executedSlot as number] !== row.arm) fail("paired slot order is invalid");
  for (const field of ["codeSha256", "methodSha256", "inputSha256", "expectedSha256"]) hash(row[field]);
  if (row.cause !== null && (typeof row.cause !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(row.cause))) fail("observation cause must be a safe token");
  if (row.status === "succeeded" && row.matched !== true || row.result === null && row.matched !== "unknown") fail("observation outcome and available result are inconsistent");
  if (row.processWallMs !== "unknown" && (typeof row.processWallMs !== "number" || !Number.isFinite(row.processWallMs) || row.processWallMs < 0)) fail("process wall time is invalid");
  if (row.containerCpuSeconds !== "unknown" && (typeof row.containerCpuSeconds !== "number" || !Number.isFinite(row.containerCpuSeconds) || row.containerCpuSeconds < 0)) fail("container CPU time is invalid");
  validateCostRecord(object(row.costs, COST_FIELDS));
  for (const artifact of [row.artifact, ...(row.logs === null ? [] : Object.values(object(row.logs, ["stdout", "stderr"])))]) if (artifact !== null) {const entry = object(artifact, ["sha256", "bytes"]); hash(entry.sha256); integer(entry.bytes, 0, TREATMENT_BUNDLE_BYTES);}
  if (trial === "diagnose") observationScaffolding(row as unknown as TreatmentObservation, setupCode(row.diagnoseSetupCode));
  return row as unknown as TreatmentObservation;
}
export function readTreatmentObservation(file: string): TreatmentObservation {try {return validateTreatmentObservation(JSON.parse(readTextBounded(file, TREATMENT_RECEIPT_BYTES, {noFollow: true})));} catch {return fail("slot receipt is malformed, linked, unreadable or over-bound");}}

/** Repository-only paired runner. Calling it is a separately authorized T3 launch, never a unit-test seam. */
export function runTreatmentTrials(rootArg: string, outputArg: string, imageDigest: string, trial: TreatmentTrial): TreatmentTrialManifest {
  trialName(trial);
  const containerTrialStart = cgroupCpu();
  const admissionWall = performance.now(), admissionCpu = process.cpuUsage(), root = realpathSync(rootArg), environment = baselineEnvironment(imageDigest);
  const temporaryRoot = realpathSync(tmpdir()), storage = statfsSync(temporaryRoot), capacity = Number(storage.blocks) * Number(storage.bsize);
  if (temporaryRoot !== "/tmp" || Number(storage.type) !== 0x01021994 || !Number.isSafeInteger(capacity) || capacity <= 0 || capacity > TREATMENT_BUNDLE_BYTES) fail("the admission controller must mount /tmp as a tmpfs capped at 16 MiB before any run effects");
  const tmpfs = {kind: "controller-tmpfs-cap" as const, bytes: capacity}, beforeSeals = seals(root);
  const registration = verifyPreregistration(root, join(root, FROZEN_RECEIPT)), code = bindRunCode(root);
  const protocol = JSON.parse(readTextBounded(join(root, PREREGISTRATION), TREATMENT_RECEIPT_BYTES));
  if (environment.bun !== protocol.design.versions.bun) fail("Bun differs from the frozen runtime");
  const cases = loadCases(root, trial, registration), output = resolve(outputArg), rel = relative(root, output);
  if (!isAbsolute(outputArg) || rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)) || existsSync(output)) fail("output must be fresh, absolute and outside the checkout");
  const temporaryOutput = relative(temporaryRoot, output);
  if (!temporaryOutput || isAbsolute(temporaryOutput) || temporaryOutput === ".." || temporaryOutput.startsWith(".." + sep)) fail("output must be inside the controller-capped /tmp filesystem");
  if (lstatSync(dirname(output)).isSymbolicLink() || realpathSync(dirname(output)) !== dirname(output)) fail("output parent must be a physical directory");
  const planned = planCases(cases, trial, protocol.design.seedSets.firstVariant);
  const rows: TreatmentObservation[] = planned.map(({row, slot}, index) => ({...slot, ...(trial === "diagnose" ? {diagnoseSetupCode: diagnoseSetupCode(code)} : {}), v: 1, authority: "harness-observed", trial, caseId: row.id, caseIndex: row.index, slot: index, codeSha256: code.codeSha256, methodSha256: registration.bindings.methodSha256, inputSha256: row.inputSha256, expectedSha256: row.expectedSha256, status: "unknown", cause: "not-started", matched: "unknown", result: null, integration: null, processWallMs: "unknown", humanTimeToFind: "unknown", costs: unknownCosts(), containerCpuSeconds: "unknown", artifact: null, logs: null}));
  const work = mkdtempSync(join(tmpdir(), "ares-treatment-")), privateCode = join(work, "code"), home = join(work, "home"), files: FileIdentity[] = [];
  let materialized = 0, retained = 0, transferred = 0, createdOutput = false, trialCpu = 0, totalChildCpu = 0, stopped = false, failure: TreatmentTrialManifest["failure"] = null;
  const retainedInputs = new Map<string, number>();
  let containerCpuSeconds: number | "unknown" = "unknown";
  const containerNow = (): number | "unknown" => {try {const value = cgroupCpu(); if (value < containerTrialStart) return "unknown"; containerCpuSeconds = value - containerTrialStart; return value;} catch {containerCpuSeconds = "unknown"; return "unknown";}};
  let admission = {parentCpuSeconds: 0, wallMs: 0, codeMaterializationBytes: 0, tmpfs};
  let startedAt = new Date().toISOString(), trialWall = performance.now(), trialParentCpu = process.cpuUsage();
  const manifest = (): TreatmentTrialManifest => ({...TREATMENT_AUTHORITY_DEVIATION, v: 1, kind: "synthetic-paired-treatment-observations", authority: "harness-observed", trial, state: failure || rows.some(row => row.status === "unknown") ? "incomplete" : "complete", failure, startedAt, endedAt: new Date().toISOString(), bindings: beforeSeals, methodSha256: registration.bindings.methodSha256, inputSha256: registration.bindings.inputSha256, expectedSha256: registration.bindings.expectedSha256, code, environment,
    schedule: {cases: 12, repetitions: 3, conditions: ["cold", "warm"], arms: [...ARMS[trial]], observations: 144, sha256: sha256(canonical(registeredSlots(planned)))}, denominators: treatmentDenominators(rows), costs: totals(rows), admission,
    accounting: {cpuScope: "scheduled parent process CPU plus direct child resourceUsage CPU; admission and post-run verification are outside slot totals; child descendants are not individually metered", components: "integration sourceSetup/current/total parent CPU are nested subsets of child CPU, never added to costs.cpuSeconds; separate cgroup CPU is budget-only, never added", transferBytes: transferred + TREATMENT_RECEIPT_BYTES, retainedBytes: retained + TREATMENT_RECEIPT_BYTES, unpublishedSlots: SLOTS - files.length, containerCpuSeconds, containerCpuScope: "admitted-container-cgroup"}, files: [...files],
    limitations: ["harness-observed synthetic paired observations only; no winner, adoption, ares-sealed result authority or native Docker isolation proof", "current Reuse evaluator is fresh; reused stages are not independent samples", "cold resets private fixture input/output state; warm retains payload bytes; both start a new process, no host-cache or JIT coldness claim", "human time-to-find, provider/GPU/person/idle and uninstrumented subprocess dimensions remain unknown", "private code, workspace, child TMPDIR and output share the controller-enforced /tmp tmpfs cap; transient actual storage peak is unknown", "retained/transfer accounting includes code, payloads, output transfer and receipts plus a conservative 64 KiB manifest reservation", "T2a baseline receipts are immutable context, never substituted for a paired T3 control"]});
  try {
    mkdirSync(home, {mode: 0o700});
    for (const file of code.files) {
      const bytes = readBytesBounded(join(root, file.path), RUN_CODE_FILE_BYTES, {noFollow: true});
      if (sha256(bytes) !== file.sha256) fail("code changed while copying its private snapshot");
      materialized += bytes.length; if (materialized > protocol.budgets.trialRetainedBytes / 2) fail("code exceeds its reserved half of the retention budget");
      const target = join(privateCode, file.path); mkdirSync(dirname(target), {recursive: true, mode: 0o700}); writeAtomic(target, bytes.toString("utf8"), RUN_CODE_FILE_BYTES, 0o600);
    }
    retained = materialized; transferred = materialized;
    admission = {parentCpuSeconds: cpu(admissionCpu), wallMs: performance.now() - admissionWall, codeMaterializationBytes: materialized, tmpfs};
    mkdirSync(output, {mode: 0o700}); createdOutput = true; trialWall = performance.now(); trialParentCpu = process.cpuUsage(); startedAt = new Date().toISOString();
    const childEnv = {PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, AGENTHUB_HOME: join(home, "family"), XDG_CONFIG_HOME: join(home, "config"), TMPDIR: home, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0"};
    for (const [index, entry] of planned.entries()) {
      const observation = rows[index]!, workspace = join(work, `${entry.row.id}-${entry.slot.arm}`), candidate = join(workspace, "candidate.json"), artifact = join(workspace, "observed.json");
      const containerCaseStart = containerNow();
      if (containerCaseStart === "unknown" || typeof containerCpuSeconds === "number" && containerCpuSeconds >= protocol.budgets.trialCpuSeconds) stopped = true;
      trialCpu = totalChildCpu + cpu(trialParentCpu);
      const headroom = (SLOTS - index) * STUB_BYTES + TREATMENT_RECEIPT_BYTES + INPUT_BYTES + 4 * TREATMENT_RECEIPT_BYTES;
      if (transferred + headroom > protocol.budgets.trialTransferBytes || retained + headroom > protocol.budgets.trialRetainedBytes) stopped = true;
      if (!stopped && performance.now() - trialWall < protocol.budgets.trialWallMs && trialCpu < protocol.budgets.trialCpuSeconds) {
        const started = performance.now(), parentCpu = process.cpuUsage(), materializationWall = performance.now(), materializationCpu = process.cpuUsage();
        const payload = JSON.stringify(entry.row.payload) + "\n";
        if (entry.slot.condition === "cold") {rmSync(workspace, {recursive: true, force: true}); mkdirSync(workspace, {mode: 0o700}); writeAtomic(candidate, payload, INPUT_BYTES, 0o600); transferred += Buffer.byteLength(payload); retained += Buffer.byteLength(payload) - (retainedInputs.get(workspace) ?? 0); retainedInputs.set(workspace, Buffer.byteLength(payload));}
        if (existsSync(artifact)) unlinkSync(artifact);
        observation.costs.materializationCpuSeconds = cpu(materializationCpu); observation.costs.materializationWallMs = performance.now() - materializationWall;
        observation.costs.materializationTransferBytes = entry.slot.condition === "cold" ? Buffer.byteLength(payload) : 0;
        let childCpu: number | "unknown" = "unknown";
        try {
          const childStart = performance.now();
          const child = Bun.spawnSync([process.execPath, "--smol", join(privateCode, "scripts", "execution-trial-child.ts"), trial, observation.arm, candidate, artifact, String(observation.seed)], {cwd: workspace, env: childEnv, stdout: "pipe", stderr: "pipe", timeout: Math.max(1, Math.min(protocol.budgets.caseWallMs, protocol.budgets.trialWallMs - (performance.now() - trialWall))), maxBuffer: TREATMENT_RECEIPT_BYTES});
          observation.processWallMs = performance.now() - childStart;
          observation.logs = {stdout: {sha256: sha256(child.stdout), bytes: child.stdout.length}, stderr: {sha256: sha256(child.stderr), bytes: child.stderr.length}};
          transferred += child.stdout.length + child.stderr.length;
          const usage = child.resourceUsage;
          childCpu = treatmentChildCpuSeconds(usage);
          const childFailure = classifyChildFailure(child);
          if (childFailure) {observation.status = "failed"; observation.cause = childFailure.cause.replace(/[^a-z0-9-]/g, "-");}
          else if (usage && usage.maxRSS > protocol.budgets.caseMemoryMiB * 1024 * 1024) {observation.status = "failed"; observation.cause = "memory-budget"; stopped = true;}
          else {
            const verificationWall = performance.now(), verificationCpu = process.cpuUsage();
            try {
              const bytes = readBytesBounded(artifact, TREATMENT_RECEIPT_BYTES, {noFollow: true}); transferred += bytes.length;
              observation.artifact = {sha256: sha256(bytes), bytes: bytes.length};
              const output = object(bounded(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes))), ["result", "integration"]);
              observation.result = output.result; observation.integration = output.integration;
              if (trial === "diagnose") observationScaffolding(observation, diagnoseSetupCode(code), entry.row.payload);
              observation.matched = treatmentMatches(trial, entry.row.truth, observation.seed, output.result);
              observation.status = observation.matched ? "succeeded" : "failed"; observation.cause = observation.matched ? null : "expected-mismatch";
            } finally {observation.costs.verificationCpuSeconds = cpu(verificationCpu); observation.costs.verificationWallMs = performance.now() - verificationWall;}
          }
        } catch {observation.status = "failed"; observation.cause = "spawn-or-observation-unavailable";}
        observation.costs.wallElapsedMs = performance.now() - started;
        observation.costs.cpuSeconds = childCpu === "unknown" ? "unknown" : childCpu + cpu(parentCpu);
        const containerCaseEnd = containerNow();
        observation.containerCpuSeconds = containerCaseStart === "unknown" || containerCaseEnd === "unknown" || containerCaseEnd < containerCaseStart ? "unknown" : containerCaseEnd - containerCaseStart;
        if (childCpu === "unknown") {observation.status = "unknown"; observation.cause = "cpu-measurement-unavailable"; stopped = true;}
        else {totalChildCpu += childCpu; trialCpu = totalChildCpu + cpu(trialParentCpu);}
        if (observation.containerCpuSeconds === "unknown") {observation.status = "unknown"; observation.cause = "container-cpu-measurement-unavailable"; stopped = true;}
        else if (observation.containerCpuSeconds > protocol.budgets.caseCpuSeconds || typeof containerCpuSeconds === "number" && containerCpuSeconds > protocol.budgets.trialCpuSeconds) {observation.status = "failed"; observation.cause = "container-cpu-budget"; stopped = true;}
        if (typeof observation.costs.cpuSeconds === "number" && (observation.costs.cpuSeconds > protocol.budgets.caseCpuSeconds || trialCpu > protocol.budgets.trialCpuSeconds)) {observation.status = "failed"; observation.cause = "cpu-budget"; stopped = true;}
        if (observation.costs.wallElapsedMs > protocol.budgets.caseWallMs || performance.now() - trialWall > protocol.budgets.trialWallMs) {observation.status = "failed"; observation.cause = "wall-budget"; stopped = true;}
        observation.costs.failureCpuSeconds = observation.status === "succeeded" ? 0 : observation.costs.cpuSeconds;
        observation.costs.failureWallMs = observation.status === "succeeded" ? 0 : observation.costs.wallElapsedMs;
        if (existsSync(artifact)) unlinkSync(artifact);
      } else {stopped = true; observation.cause = "budget-stopped-not-started";}
      let text: string;
      try {text = JSON.stringify(validateTreatmentObservation(observation), null, 2) + "\n"; if (Buffer.byteLength(text) > TREATMENT_RECEIPT_BYTES) fail("formatted slot exceeds its bound");}
      catch {observation.status = "failed"; observation.cause = "receipt-bound-or-invalid"; observation.result = null; observation.integration = null; observation.matched = "unknown"; observation.costs.failureCpuSeconds = observation.costs.cpuSeconds; observation.costs.failureWallMs = observation.costs.wallElapsedMs; text = JSON.stringify(validateTreatmentObservation(observation), null, 2) + "\n"; stopped = true;}
      const reserved = (SLOTS - index - 1) * STUB_BYTES + TREATMENT_RECEIPT_BYTES;
      if (retained + Buffer.byteLength(text) + reserved > protocol.budgets.trialRetainedBytes || transferred + Buffer.byteLength(text) + reserved > protocol.budgets.trialTransferBytes) {
        observation.status = "failed"; observation.cause = "retention-or-transfer-budget"; observation.result = null; observation.integration = null; observation.matched = "unknown"; observation.costs.failureCpuSeconds = observation.costs.cpuSeconds; observation.costs.failureWallMs = observation.costs.wallElapsedMs;
        text = JSON.stringify(validateTreatmentObservation(observation), null, 2) + "\n"; stopped = true;
      }
      const name = `slot-${String(index).padStart(3, "0")}.json`; exclusive(join(output, name), text);
      const bytes = Buffer.byteLength(text); retained += bytes; transferred += bytes; files.push({path: name, sha256: sha256(text), bytes});
    }
    if (stopped) failure = {cause: "trial-budget-or-measurement-stopped", nextStep: "preserve all slots including unknown/not-started observations; inspect recorded budget and measurement causes without automatic retry"};
    if (canonical(seals(root)) !== canonical(beforeSeals) || canonical(bindRunCode(root)) !== canonical(code)) fail("frozen seals or committed code changed during collection");
    if (containerNow() === "unknown") failure = {cause: "container-cpu-measurement-unavailable", nextStep: "preserve the complete slot receipts; the whole-container budget trace is insufficient and this run must not pass a budget gate"};
    else if (typeof containerCpuSeconds === "number" && containerCpuSeconds > protocol.budgets.trialCpuSeconds || performance.now() - trialWall > protocol.budgets.trialWallMs) failure = {cause: "whole-trial-budget", nextStep: "preserve all observed slots and the budget overrun; do not retry or increase the registered budget"};
    const result = manifest(), text = JSON.stringify(result, null, 2) + "\n";
    exclusive(join(output, "manifest.json"), text); return result;
  } catch {
    if (!createdOutput) fail("admission or code materialization failed before observation collection");
    failure = {cause: "collection-interrupted", nextStep: "keep published slot receipts and inspect this incomplete manifest; do not retry or substitute slots within this run"};
    for (const row of rows.slice(files.length)) {row.status = "unknown"; row.cause = "collection-interrupted-not-published"; row.matched = "unknown"; row.result = null; row.integration = null;}
    const result = manifest();
    try {exclusive(join(output, "manifest.json"), JSON.stringify(result, null, 2) + "\n"); return result;}
    catch {return fail("collection interrupted; all already-published slot receipts were retained", "inspect the fresh output directory and preserve its partial receipts; do not rerun into it");}
  } finally {rmSync(work, {recursive: true, force: true});}
}

export function validateTreatmentTrialManifest(input: unknown): TreatmentTrialManifest {
  const raw = object(bounded(input), ["v", "kind", "authority", "trial", "resultAuthorityLinks", "resultAuthorityLinksReason", "resultAuthorityDecision", "state", "failure", "startedAt", "endedAt", "bindings", "methodSha256", "inputSha256", "expectedSha256", "code", "environment", "schedule", "denominators", "costs", "admission", "accounting", "files", "limitations"]);
  if (raw.v !== 1 || raw.kind !== "synthetic-paired-treatment-observations" || raw.authority !== "harness-observed" || !["complete", "incomplete"].includes(String(raw.state))) fail("manifest version or state is unsupported");
  const trial = trialName(raw.trial), files = array(raw.files, SLOTS), paths = new Set<string>();
  for (const [index, file] of files.entries()) {const row = object(file, ["path", "sha256", "bytes"]); if (row.path !== `slot-${String(index).padStart(3, "0")}.json` || paths.has(row.path as string)) fail("manifest slot filename is invalid, out of order or duplicated"); paths.add(row.path as string); hash(row.sha256); integer(row.bytes, 1, TREATMENT_RECEIPT_BYTES);}
  if (canonical(raw.resultAuthorityLinks) !== "[]" || raw.resultAuthorityLinksReason !== TREATMENT_AUTHORITY_DEVIATION.resultAuthorityLinksReason || canonical(raw.resultAuthorityDecision) !== canonical(TREATMENT_AUTHORITY_DEVIATION.resultAuthorityDecision)) fail("result authority boundary differs from the registered harness");
  for (const field of ["startedAt", "endedAt"]) if (typeof raw[field] !== "string" || raw[field].length > 64 || !Number.isFinite(Date.parse(raw[field]))) fail("manifest time is invalid");
  if (Date.parse(raw.endedAt as string) < Date.parse(raw.startedAt as string)) fail("manifest end precedes admission");
  if (raw.failure !== null) {const error = object(raw.failure, ["cause", "nextStep"]); if (typeof error.cause !== "string" || !/^[a-z][a-z0-9-]{0,95}$/.test(error.cause) || typeof error.nextStep !== "string" || !error.nextStep.trim() || error.nextStep.length > 1024) fail("manifest failure requires safe cause and next step");}
  const binding = object(raw.bindings, ["registration", "supervision", "reuseR2", "reuseSetup"]); for (const value of Object.values(binding)) hash(value);
  for (const field of ["methodSha256", "inputSha256", "expectedSha256"]) hash(raw[field]);
  const code = object(raw.code, ["commit", "tree", "codeSha256", "files"]);
  for (const field of ["commit", "tree"]) if (typeof code[field] !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(code[field])) fail("stored Git identity is invalid");
  hash(code.codeSha256); const sourceFiles = array(code.files, RUN_CODE_FILES), sourceNames = new Set<string>();
  if (!sourceFiles.length) fail("run code inventory is empty");
  for (const file of sourceFiles) {const row = object(file, ["path", "sha256", "bytes"]); if (typeof row.path !== "string" || !/^[A-Za-z0-9_.\/-]{1,4096}$/.test(row.path) || row.path.startsWith("/") || row.path.split("/").some(part => !part || part === "." || part === "..") || sourceNames.has(row.path)) fail("stored code path is invalid or duplicate"); sourceNames.add(row.path); hash(row.sha256); integer(row.bytes, 0, RUN_CODE_FILE_BYTES);}
  if (sha256(JSON.stringify(sourceFiles)) !== code.codeSha256) fail("stored code inventory hash changed");
  const schedule = object(raw.schedule, ["cases", "repetitions", "conditions", "arms", "observations", "sha256"]);
  if (schedule.cases !== 12 || schedule.repetitions !== 3 || schedule.observations !== 144 || canonical(schedule.conditions) !== '["cold","warm"]' || canonical(schedule.arms) !== canonical(ARMS[trial])) fail("registered schedule changed"); hash(schedule.sha256);
  const denominator = object(raw.denominators, ["full", ...STATUSES, "arms"]), arms = object(denominator.arms, ARMS[trial]);
  const validateTally = (row: Record<string, unknown>, full: number) => {if (integer(row.full, full, full) !== full || STATUSES.reduce((sum, state) => sum + integer(row[state], 0, full), 0) !== full) fail("denominator status totals changed");};
  validateTally(denominator, 144); for (const arm of ARMS[trial]) validateTally(object(arms[arm], ["full", ...STATUSES]), 72);
  for (const state of STATUSES) if (denominator[state] !== ARMS[trial].reduce((sum, arm) => sum + (arms[arm] as Record<string, number>)[state]!, 0)) fail("arm and trial denominator totals disagree");
  validateCostRecord(object(raw.costs, COST_FIELDS));
  const admission = object(raw.admission, ["parentCpuSeconds", "wallMs", "codeMaterializationBytes", "tmpfs"]); for (const key of ["parentCpuSeconds", "wallMs", "codeMaterializationBytes"]) {const value = admission[key]; if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("admission measurement is invalid");} integer(admission.codeMaterializationBytes, 0, TREATMENT_BUNDLE_BYTES / 2);
  const tmpfs = object(admission.tmpfs, ["kind", "bytes"]); if (tmpfs.kind !== "controller-tmpfs-cap") fail("controller tmpfs admission is missing"); integer(tmpfs.bytes, 1, TREATMENT_BUNDLE_BYTES);
  const accounting = object(raw.accounting, ["cpuScope", "components", "transferBytes", "retainedBytes", "unpublishedSlots", "containerCpuSeconds", "containerCpuScope"]);
  for (const key of ["cpuScope", "components"]) if (typeof accounting[key] !== "string" || !accounting[key].length || accounting[key].length > 1024) fail("accounting scope is missing");
  integer(accounting.transferBytes, 0, TREATMENT_BUNDLE_BYTES); integer(accounting.retainedBytes, 0, TREATMENT_BUNDLE_BYTES); integer(accounting.unpublishedSlots, 0, SLOTS);
  if (accounting.containerCpuScope !== "admitted-container-cgroup" || accounting.containerCpuSeconds !== "unknown" && (typeof accounting.containerCpuSeconds !== "number" || !Number.isFinite(accounting.containerCpuSeconds) || accounting.containerCpuSeconds < 0)) fail("container budget CPU scope or measurement is invalid");
  if (accounting.unpublishedSlots !== SLOTS - files.length || raw.state === "complete" && (files.length !== SLOTS || raw.failure !== null || denominator.unknown !== 0)) fail("manifest collection completeness is inconsistent");
  const env = object(raw.environment, ["os", "osRelease", "arch", "bun", "cpuModelsSha256", "logicalCpus", "cpuLimit", "memoryLimitBytes", "pidsLimit", "containerIdentitySha256", "imageDigest", "imageDigestSource", "sequentialChildren"]);
  if (env.os !== "linux" || env.sequentialChildren !== 1 || env.imageDigestSource !== "admission-controller-pinned-image-id" || typeof env.imageDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(env.imageDigest) || typeof env.cpuLimit !== "number" || !Number.isFinite(env.cpuLimit) || env.cpuLimit <= 0 || env.cpuLimit > 2) fail("admitted environment identity is invalid");
  integer(env.memoryLimitBytes, 1, 256 * 1024 * 1024); integer(env.pidsLimit, 1, 32); integer(env.logicalCpus, 1); hash(env.cpuModelsSha256); hash(env.containerIdentitySha256);
  for (const key of ["osRelease", "arch", "bun"]) if (typeof env[key] !== "string" || !env[key].length || env[key].length > 256) fail("runtime identity is invalid");
  if (array(raw.limitations, 32).some(value => typeof value !== "string" || !value.trim() || value.length > 2048)) fail("limitations must be bounded text");
  return raw as unknown as TreatmentTrialManifest;
}
/** Historical verification binds the measured commit, so a later data-only commit is allowed. */
export function readTreatmentTrialManifest(output: string, root = fileURLToPath(new URL("..", import.meta.url))): TreatmentTrialManifest {
  let raw: unknown; try {raw = JSON.parse(readTextBounded(join(output, "manifest.json"), TREATMENT_RECEIPT_BYTES, {noFollow: true}));} catch {return fail("manifest is malformed, linked, unreadable or over-bound");}
  const manifest = validateTreatmentTrialManifest(raw); verifyRunCodeCommit(root, manifest.code);
  const registered = readRegisteredTreatmentSchedule(root, manifest.trial);
  if (manifest.schedule.sha256 !== registered.sha256 || canonical(manifest.bindings) !== canonical(registered.bindings)
    || manifest.methodSha256 !== registered.methodSha256 || manifest.inputSha256 !== registered.inputSha256 || manifest.expectedSha256 !== registered.expectedSha256) fail("manifest differs from the frozen registered schedule or source bindings");
  const registration = verifyPreregistration(root, join(root, FROZEN_RECEIPT)), cases = loadCases(root, manifest.trial, registration), truth = new Map(cases.map(row => [row.id, row.truth])), payload = new Map(cases.map(row => [row.id, row.payload]));
  const rows: TreatmentObservation[] = [];
  for (const entry of manifest.files) {
    const file = join(output, entry.path), text = readTextBounded(file, TREATMENT_RECEIPT_BYTES, {noFollow: true});
    if (sha256(text) !== entry.sha256 || Buffer.byteLength(text) !== entry.bytes) fail("published slot identity changed");
    const row = readTreatmentObservation(file);
    if (row.trial !== manifest.trial || row.slot !== Number(entry.path.slice(5, 8)) || row.codeSha256 !== manifest.code.codeSha256 || row.methodSha256 !== manifest.methodSha256) fail("slot receipt differs from its trial/code binding");
    const expected = registered.slots[row.slot];
    if (!expected || Object.entries(expected).some(([key, value]) => canonical(row[key as keyof TreatmentObservation]) !== canonical(value))) fail("slot identity differs from the frozen case, seed, repetition, condition, arm or input/expected pair");
    if (manifest.trial === "diagnose") observationScaffolding(row, diagnoseSetupCode(manifest.code), payload.get(row.caseId));
    if (row.matched !== "unknown" && treatmentMatches(manifest.trial, truth.get(row.caseId), row.seed, row.result) !== row.matched) fail("slot matched flag differs from sealed evaluator truth");
    rows.push(row);
  }
  const counted = treatmentDenominators([...rows, ...registered.slots.slice(rows.length).map(slot => ({arm: slot.arm, status: "unknown" as const}))]);
  if (canonical(counted) !== canonical(manifest.denominators)) fail("manifest denominator differs from published and explicitly missing slots");
  return manifest;
}
export function serializeTreatmentBundle(files: Record<string, string>): string {
  if (types.isProxy(files) || !plain(files)) fail("bundle must be an inert JSON object");
  const keys = Reflect.ownKeys(files);
  if (keys.length > SLOTS + 1 || !Object.hasOwn(files, "manifest.json")) fail("bounded bundle requires one manifest");
  let total = 0;
  for (const key of keys) {
    if (typeof key !== "string" || key !== "manifest.json" && !/^slot-[0-9]{3}\.json$/.test(key)) fail("bundle contains an invalid filename");
    const value = Object.getOwnPropertyDescriptor(files, key);
    if (!value || !("value" in value) || !value.enumerable || typeof value.value !== "string" || Buffer.byteLength(value.value) > TREATMENT_RECEIPT_BYTES) fail("bundle file exceeds its bound or is non-data");
    total += Buffer.byteLength(value.value); if (total > TREATMENT_BUNDLE_BYTES) fail("raw bundle exceeds 16 MiB");
  }
  const serialized = JSON.stringify({v: 1, files});
  if (Buffer.byteLength(TREATMENT_BUNDLE_PREFIX + serialized + "\n") > TREATMENT_BUNDLE_BYTES) fail("escaped bundle exceeds 16 MiB; transfer existing receipt files individually");
  return serialized;
}
export function emitTreatmentTrials(output: string, root = fileURLToPath(new URL("..", import.meta.url))): string {
  const manifest = readTreatmentTrialManifest(output, root), text = readTextBounded(join(output, "manifest.json"), TREATMENT_RECEIPT_BYTES, {noFollow: true}), files: Record<string, string> = {"manifest.json": text};
  let total = Buffer.byteLength(text);
  for (const entry of manifest.files) {const body = readTextBounded(join(output, entry.path), TREATMENT_RECEIPT_BYTES, {noFollow: true}); if (sha256(body) !== entry.sha256 || Buffer.byteLength(body) !== entry.bytes) fail("published slot identity changed"); readTreatmentObservation(join(output, entry.path)); total += entry.bytes; if (total > TREATMENT_BUNDLE_BYTES) fail("raw bundle exceeds 16 MiB"); files[entry.path] = body;}
  return serializeTreatmentBundle(files);
}
if (import.meta.main) {
  const [trial, output, emit, ...extra] = process.argv.slice(2);
  try {if (!output || extra.length || emit !== undefined && emit !== "--emit") fail("usage: execution-trials.ts diagnose|reuse ABSOLUTE_OUTPUT [--emit]");
    const imageDigest = process.env.ARES_TRIAL_IMAGE_DIGEST;
    if (!imageDigest) fail("admission controller must provide ARES_TRIAL_IMAGE_DIGEST");
    const result = runTreatmentTrials(fileURLToPath(new URL("..", import.meta.url)), output, imageDigest, trialName(trial));
    console.log(emit === "--emit" ? TREATMENT_BUNDLE_PREFIX + emitTreatmentTrials(resolve(output)) : JSON.stringify(result));
    if (result.state !== "complete") process.exitCode = 1;
  } catch (error) {console.error(error instanceof Error ? error.message : "execution treatment trials: collection failed; keep receipts and inspect admission"); process.exitCode = 1;}
}
