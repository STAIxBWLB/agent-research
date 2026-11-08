import {existsSync} from "node:fs";
import {isAbsolute, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {plain, readBytesBounded, readTextBounded, sha256} from "../src/study.ts";
import {canonical, filePath, publishEvaluationReceipt, COST_FIELDS, validateCostRecord, type CostRecord} from "./execution-eval.ts";
import {bindRunCode, verifyRunCodeCommit, type RunCodeBinding} from "./execution-code-binding.ts";

export const HARNESS_CONTROLS = "docs/verification/harness-eval-controls.json";
export const HARNESS_PROTOCOL = "docs/verification/harness-eval-preregistration.json", HARNESS_METHOD = "docs/verification/harness-eval-protocol.md", HARNESS_FROZEN = "docs/verification/harness-eval-frozen.json";
export const CONDITIONS = ["frozen-base", "repeated-base", "retrieval-only", "contrastive-no-library", "contrastive-prior"] as const;
export const ROLES = ["proposer", "worker", "composer", "selector", "reflector"] as const;
export const STAGES = ["reference", "proposal", "probe", "composition", "successor", "selection", "reflection", "retrieval"] as const;
export const HARNESS_DENOMINATORS = ["planned", "executed", "succeeded", "failed", "cancelled", "denied", "judge-unavailable", "unknown", "excluded", "unavailable"] as const;
const DOCUMENT_BYTES = 65_536, FIXTURE_BYTES = 16_384, TOTAL_BYTES = 1024 * 1024, RECEIPT_BYTES = 8 * 1024 * 1024;
type Condition = typeof CONDITIONS[number]; type Role = typeof ROLES[number];
interface HashFile {path: string; sha256: string; bytes: number}
export interface Experience {sourceTaskId: string; text: string; sha256: string}
interface PublicInput {v: 1; taskId: string; family: string; prompt: string; data: Record<string, unknown>}
interface Control {v: 1; taskId: string; baseOutputs: string[]; editor: {proposal: string; probeOutput: string; composedGuidance: string; successorOutput: string}; selection: {selectedSlot: number}; reflection: {text: string}}
export interface HarnessCase {id: string; family: string; split: "learning" | "heldout"; input: PublicInput; control: Control; inputSha256: string}
interface Order {id: string; repetition: number; taskIds: string[]}
interface ConditionPlan {id: Condition; stageCalls: Record<typeof STAGES[number], number>}
interface Snapshot {protocol: Record<string, unknown>; cases: HarnessCase[]; orders: Order[]; conditions: ConditionPlan[]; learning: string[]; heldout: string[]; seal: HarnessSeal; faults: Record<string, unknown>[]}
export interface HarnessSeal {v: 1; status: "preregistered-not-measured"; bindings: Record<string, string>; files: HashFile[]; receiptSha256: string}
function fail(cause: string): never {throw new Error(`harness eval ${cause}; restore the registered files or preregister a separately reviewed experiment before retrying`);}
function object(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plain(raw) || Object.keys(raw).some(key => !keys.includes(key))) fail(`${label}: invalid shape or unknown field`); return raw;
}
function text(raw: unknown, max = 4000): string {if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw) > max || raw.includes("\0")) fail("invalid bounded text"); return raw;}
function strings(raw: unknown, max: number, label: string): string[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > max || raw.some(value => typeof value !== "string" || !value.length)) fail(`${label}: invalid bounded list`); return raw as string[];
}
function decode(bytes: Uint8Array): string {try {return new TextDecoder("utf-8", {fatal: true}).decode(bytes);} catch {return fail("invalid UTF-8 source");}}
function parsed(text: string): unknown {try {return JSON.parse(text);} catch {return fail("invalid JSON source");}}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function snapshot(root: string): Snapshot {
  const files: HashFile[] = []; let total = 0;
  const read = (path: string, limit: number): unknown => {
    const bytes = readBytesBounded(filePath(root, path), limit, {noFollow: true}); total += bytes.length;
    if (total > TOTAL_BYTES || files.length >= 160) fail("source bound exceeded");
    files.push({path, sha256: sha256(bytes), bytes: bytes.length}); return parsed(decode(bytes));
  };
  const p = object(read(HARNESS_PROTOCOL, DOCUMENT_BYTES), ["v", "id", "status", "scope", "authority", "corpus", "orders", "conditions", "budgets", "metrics", "denominators", "thresholds", "costs", "reporting", "stopConditions"], "protocol");
  if (p.v !== 1 || p.status !== "proposed-not-measured") fail("unsupported protocol version/status");
  const corpus = object(p.corpus, ["index", "learningSourceIds", "heldoutIds", "partitionBeforeLibrary", "transferFamily"], "corpus");
  const learning = strings(corpus.learningSourceIds, 16, "learning-source set"), heldout = strings(corpus.heldoutIds, 16, "held-out set");
  if (corpus.partitionBeforeLibrary !== true || new Set([...learning, ...heldout]).size !== learning.length + heldout.length) fail("split must be disjoint and fixed before any library");
  if (!same(p.denominators, HARNESS_DENOMINATORS)) fail("denominators changed or missing");
  const budgets = object(p.budgets, ["calls", "providerTokens", "wallMs", "appliesTo", "unusedCallAllowanceByCondition", "unusedPolicy", "selectionControl", "executorModel", "editorModel", "toolsetAndEnvironment", "parallelAttemptsPerStudy", "cpuWorkers", "gpuDevices", "maxTasksPerStudyStream", "fixtureFileBytes", "protocolFileBytes", "corpusBytes", "perConditionOrderStudy", "actualProviderUsage", "controlReceiptBytes"], "budgets");
  if (budgets.calls !== 8 || budgets.providerTokens !== 8000 || budgets.wallMs !== 60000) fail("matched aggregate budget changed");
  for (const name of ["scope", "authority", "metrics", "thresholds", "costs", "reporting"]) if (!plain(p[name])) fail(`protocol ${name} missing`);
  const costSchema = p.costs as Record<string, unknown>;
  if (!plain(costSchema.fields) || !same(Object.keys(costSchema.fields).sort(), [...COST_FIELDS].sort()) || !same(costSchema.stages, STAGES)) fail("cost stages or dimensions missing");
  const thresholds = p.thresholds as Record<string, unknown>;
  if (thresholds.status !== "proposed-not-measured" || !same(thresholds.faultSuite, {maxAuthorityViolations: 0, maxPrivacyViolations: 0, maxEvaluatorAccessViolations: 0}) || !same(thresholds.guidance, {maxRegressionIncrease: 0, minValidOutcomeGainPercentagePoints: 5, minCostPerAcceptedOutcomeReductionPct: 20, qualityMustNotDecrease: true, comparator: "repeated-base", rule: "no regression increase AND (valid outcome gain OR cost reduction at no lower quality)"}) || !same(thresholds.experience, {heldoutQualityMustNotDecrease: true, minCostPerAcceptedOutcomeReductionPct: 10, comparator: "contrastive-no-library"}) || thresholds.missingEvidence !== "insufficient-evidence") fail("thresholds differ from the proposed issue68 gates");
  if (!Array.isArray(p.stopConditions) || !p.stopConditions.length) fail("stop conditions missing");
  if (!Array.isArray(p.conditions) || p.conditions.length !== CONDITIONS.length) fail("five conditions required");
  const conditions: ConditionPlan[] = p.conditions.map(raw => {
    const row = object(raw, ["id", "stageCalls"], "condition"), stageCalls = object(row.stageCalls, STAGES, "stage opportunity plan");
    if (!(CONDITIONS as readonly unknown[]).includes(row.id) || STAGES.some(stage => !Number.isSafeInteger(stageCalls[stage]) || Number(stageCalls[stage]) < 0) || Object.values(stageCalls).reduce<number>((sum, value) => sum + Number(value), 0) > 8) fail("invalid condition opportunity plan");
    return {id: row.id as Condition, stageCalls: stageCalls as ConditionPlan["stageCalls"]};
  });
  if (new Set(conditions.map(row => row.id)).size !== 5) fail("duplicate condition");
  const indexPath = text(corpus.index, 240); if (!indexPath.startsWith("test/fixtures/harness/")) fail("corpus must use its own synthetic fixture directory");
  const index = object(read(indexPath, DOCUMENT_BYTES), ["v", "cases", "faults"], "corpus index");
  if (index.v !== 1 || !Array.isArray(index.cases) || index.cases.length < 12 || index.cases.length > 16) fail("corpus needs 12..16 cases per study stream");
  const expected: HashFile[] = [], inputs: HashFile[] = [], controls: HashFile[] = [], usedPaths = new Set(files.map(file => file.path));
  const cases: HarnessCase[] = index.cases.map(raw => {
    const row = object(raw, ["id", "family", "split", "input", "expected", "control"], "case"), id = text(row.id, 64), family = text(row.family, 64);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !["learning", "heldout"].includes(String(row.split)) || (row.split === "learning" ? !learning.includes(id) : !heldout.includes(id))) fail("case split/identity mismatch");
    const load = (key: "input" | "expected" | "control") => {const name = text(row[key], 240); if (!name.startsWith("test/fixtures/harness/") || usedPaths.has(name)) fail("fixture paths must be distinct synthetic files"); usedPaths.add(name); const data = read(name, FIXTURE_BYTES); (key === "input" ? inputs : key === "expected" ? expected : controls).push(files.at(-1)!); return data;};
    const input = object(load("input"), ["v", "taskId", "family", "prompt", "data"], "public input");
    if (input.v !== 1 || input.taskId !== id || input.family !== family || !plain(input.data)) fail("public input identity mismatch"); text(input.prompt);
    const oracle = object(load("expected"), ["v", "answer", "rubric", "evaluatorKey"], "private expected fixture"); if (oracle.v !== 1 || typeof oracle.answer !== "string" || !plain(oracle.rubric)) fail("private expected fixture version mismatch"); text(oracle.evaluatorKey);
    const control = object(load("control"), ["v", "taskId", "baseOutputs", "editor", "selection", "reflection"], "prerecorded control");
    const base = strings(control.baseOutputs, 7, "prerecorded base outputs"), editor = object(control.editor, ["proposal", "probeOutput", "composedGuidance", "successorOutput"], "editor fixture"), selection = object(control.selection, ["selectedSlot"], "selection fixture"), reflection = object(control.reflection, ["text"], "reflection fixture");
    if (control.v !== 1 || control.taskId !== id || base.length !== 7 || !Number.isSafeInteger(selection.selectedSlot) || ![0, 1].includes(selection.selectedSlot as number)) fail("prerecorded control identity or slot mismatch");
    for (const value of [...base, ...Object.values(editor), reflection.text]) text(value);
    return {id, family, split: row.split as HarnessCase["split"], input: input as unknown as PublicInput, control: control as unknown as Control, inputSha256: inputs.at(-1)!.sha256};
  });
  if (new Set(cases.map(row => row.id)).size !== cases.length || cases.length !== learning.length + heldout.length || new Set(cases.map(row => row.family)).size < 2 || !cases.some(row => row.split === "heldout" && row.family === corpus.transferFamily) || cases.some(row => row.split === "learning" && row.family === corpus.transferFamily)) fail("task identity partition or reserved family mismatch");
  if (!Array.isArray(p.orders) || p.orders.length < 3 || p.orders.length > 8) fail("at least three bounded order/repetition settings required");
  const orders = p.orders.map(raw => {const row = object(raw, ["id", "repetition", "taskIds"], "order"), taskIds = strings(row.taskIds, 16, "ordered stream"); if (!Number.isSafeInteger(row.repetition) || Number(row.repetition) < 1 || !same([...taskIds].sort(), cases.map(row => row.id).sort()) || taskIds.slice(0, learning.length).some(id => !learning.includes(id))) fail("ordered stream must contain every task once, learning before transfer"); return {id: text(row.id, 64), repetition: row.repetition as number, taskIds};});
  if (new Set(orders.map(row => row.id)).size !== orders.length) fail("duplicate order identity");
  const faultPath = text(index.faults, 240); if (!faultPath.startsWith("test/fixtures/harness/") || usedPaths.has(faultPath)) fail("fault fixture path invalid");
  const faults = object(read(faultPath, FIXTURE_BYTES), ["v", "cases"], "fault fixtures"); if (faults.v !== 1 || !Array.isArray(faults.cases) || faults.cases.length < 5 || faults.cases.length > 64 || faults.cases.some(row => !plain(row))) fail("deterministic fault fixtures missing");
  const doc = readBytesBounded(filePath(root, HARNESS_METHOD), DOCUMENT_BYTES, {noFollow: true}); total += doc.length; if (total > TOTAL_BYTES) fail("source bound exceeded"); files.push({path: HARNESS_METHOD, sha256: sha256(doc), bytes: doc.length});
  const bindings = {protocolSha256: files[0]!.sha256, methodSha256: sha256(doc), corpusSha256: sha256(canonical(index)), inputSha256: sha256(canonical(inputs)), expectedSha256: sha256(canonical(expected)), controlSha256: sha256(canonical(controls)), orderedStreamSha256: sha256(canonical(orders)), learningSourceSha256: sha256(canonical(learning)), thresholdsSha256: sha256(canonical(p.thresholds)), denominatorsSha256: sha256(canonical(p.denominators))};
  const body = {v: 1 as const, status: "preregistered-not-measured" as const, bindings, files};
  return {protocol: p, cases, orders, conditions, learning, heldout, faults: faults.cases as Record<string, unknown>[], seal: {...body, receiptSha256: sha256(canonical(body))}};
}
export function verifyHarnessPreregistration(root: string, receipt = join(root, HARNESS_FROZEN)): HarnessSeal {
  const current = snapshot(resolve(root)).seal, stored = parsed(readTextBounded(receipt, DOCUMENT_BYTES, {noFollow: true}));
  if (!plain(stored) || !plain(stored.bindings)) fail("malformed frozen receipt");
  for (const [key, value] of Object.entries(current.bindings)) if (stored.bindings[key] !== value) fail(`${key} changed since freeze`);
  if (!same(stored, current)) fail("frozen receipt content changed"); return current;
}
export function freezeHarnessPreregistration(root: string, receipt = join(root, HARNESS_FROZEN)): HarnessSeal {
  if (existsSync(receipt)) return verifyHarnessPreregistration(root, receipt);
  return publishEvaluationReceipt(receipt, snapshot(resolve(root)).seal, DOCUMENT_BYTES, () => verifyHarnessPreregistration(root, receipt));
}
const FORBIDDEN = /^(?:expected|rubric|evaluatorKey|judge|futureTask|futureTasks|futureTaskData|credentials|selectedSlot)$/i;
function publicValue(value: unknown, depth = 0): void {
  if (depth > 16) fail("role payload nesting bound");
  if (Array.isArray(value)) {for (const child of value) publicValue(child, depth + 1);}
  else if (plain(value)) for (const [key, child] of Object.entries(value)) {if (FORBIDDEN.test(key)) fail("role evaluator or future-data access denied"); publicValue(child, depth + 1);}
}
const LIBRARIES = new WeakMap<readonly Experience[], {targetId: string; hash: string}>();
export function librarySnapshot(cases: HarnessCase[], order: Order, targetId: string, learning: readonly string[], revoked: readonly string[] = []): readonly Experience[] {
  const position = order.taskIds.indexOf(targetId); if (position < 0) fail("target absent from registered stream");
  if (revoked.some(id => learning.includes(id))) fail("condition invalidated: library policy revoked");
  const entries = order.taskIds.slice(0, position).filter(id => learning.includes(id)).map(id => {const source = cases.find(row => row.id === id); if (!source || source.split !== "learning") return fail("non-learning library source denied"); return {sourceTaskId: id, text: source.control.reflection.text, sha256: sha256(source.control.reflection.text)};});
  const frozen = Object.freeze(entries.map(entry => Object.freeze(entry))); LIBRARIES.set(frozen, {targetId, hash: sha256(canonical(frozen))}); return frozen;
}
const ROLE_FIELDS: Record<Role, readonly string[]> = {proposer: ["guidance", "outputs"], worker: ["guidance"], composer: ["proposal", "outputs"], selector: ["candidates"], reflector: ["guidance", "selectedOutput"]};
export function validateRolePayload(role: Role, raw: unknown): void {
  const value = object(raw, ["v", "role", "taskId", "prompt", "data", "library", "librarySha256", ...ROLE_FIELDS[role]], "role payload");
  if (value.v !== 1 || value.role !== role || !Array.isArray(value.library) || value.librarySha256 !== sha256(canonical(value.library))) fail("role payload identity or library mismatch");
  publicValue(value); if (Buffer.byteLength(canonical(value)) > DOCUMENT_BYTES) fail("role payload byte bound");
}
export function buildRoleInputs(task: HarnessCase, condition: Condition, library: readonly Experience[]): Record<Role, Record<string, unknown>> {
  const registration = LIBRARIES.get(library); if (!registration || registration.targetId !== task.id || registration.hash !== sha256(canonical(library))) fail("unregistered or changed round library");
  const active = ["retrieval-only", "contrastive-prior"].includes(condition) ? library : [], frozen = JSON.parse(canonical(active)) as Experience[], librarySha256 = sha256(canonical(frozen));
  const outputs = task.control.baseOutputs.map((output, index) => ({id: sha256(canonical([task.inputSha256, index])).slice(0, 16), output}));
  const common = {v: 1, taskId: task.id, prompt: task.input.prompt, data: task.input.data, library: frozen, librarySha256};
  const role = (name: Role, fields: Record<string, unknown>) => {const value = JSON.parse(canonical({...common, role: name, ...fields})) as Record<string, unknown>; validateRolePayload(name, value); return value;};
  return {proposer: role("proposer", {guidance: "Frozen synthetic advisory base", outputs: [outputs[0]]}), worker: role("worker", {guidance: condition.startsWith("contrastive-") ? task.control.editor.composedGuidance : "Frozen synthetic advisory base"}), composer: role("composer", {proposal: task.control.editor.proposal, outputs: [{id: sha256("probe" + task.inputSha256).slice(0, 16), output: task.control.editor.probeOutput}]}), selector: role("selector", {candidates: condition === "repeated-base" ? outputs : condition.startsWith("contrastive-") ? [outputs[0], {id: sha256("successor" + task.inputSha256).slice(0, 16), output: task.control.editor.successorOutput}] : [outputs[0]]}), reflector: role("reflector", {guidance: "Frozen synthetic advisory base", selectedOutput: condition.startsWith("contrastive-") && task.control.selection.selectedSlot === 1 ? task.control.editor.successorOutput : task.control.baseOutputs[condition === "repeated-base" ? task.control.selection.selectedSlot : 0]})};
}
export function validateRoundInputs(inputs: Record<Role, Record<string, unknown>>): void {
  for (const role of ROLES) validateRolePayload(role, inputs[role]);
  if (new Set(ROLES.map(role => canonical(inputs[role].library))).size !== 1 || new Set(ROLES.map(role => inputs[role].librarySha256)).size !== 1) fail("within-round library changed");
}
export function requireFixturePolicy(status: unknown): void {if (status !== "allowed") fail("condition invalidated: policy denied or revoked; no replacement");}
export function requireResumeBinding(registered: unknown, resumed: unknown): void {if (typeof registered !== "string" || !/^[a-f0-9]{64}$/.test(registered) || registered !== resumed) fail("resume input hash changed");}
interface FaultObservation {id: string; kind: string; role: Role; outcome: "blocked" | "insufficient-evidence"; cause: string}
function faultControls(source: Snapshot): FaultObservation[] {
  const task = source.cases[0]!, order = source.orders[0]!, library = librarySnapshot(source.cases, order, task.id, source.learning), prepared = buildRoleInputs(task, "contrastive-prior", library);
  return source.faults.map(fault => {
    const row = object(fault, ["id", "kind", "role", "payload"], "fault case"), id = text(row.id, 64), kind = text(row.kind, 64), role = row.role as Role;
    if (!(ROLES as readonly unknown[]).includes(role) || !plain(row.payload)) fail("invalid fault role or payload");
    if (["judge-unavailable", "unknown"].includes(kind)) return {id, kind, role, outcome: "insufficient-evidence", cause: "unmeasured-judge-or-cost"};
    let blocked = false;
    try {
      if (["denied", "policy-revocation"].includes(kind)) requireFixturePolicy(plain(row.payload.policy) ? row.payload.policy.status : undefined);
      else if (kind === "changed-resume") requireResumeBinding(row.payload.registeredInputSha256, row.payload.resumedInputSha256);
      else if (kind === "within-round-library-change") {const changed = JSON.parse(canonical(prepared)) as typeof prepared; changed.composer.librarySha256 = row.payload.compositionLibrarySha256; validateRoundInputs(changed);}
      else validateRolePayload(role, {...prepared[role], ...row.payload});
    } catch {blocked = true;}
    if (!blocked) fail("fault fixture unexpectedly allowed private input or invalid state");
    return {id, kind, role, outcome: "blocked", cause: ["denied", "policy-revocation"].includes(kind) ? "condition-invalidated" : kind === "changed-resume" ? "resume-binding-refusal" : kind === "within-round-library-change" ? "library-mismatch" : "role-boundary-refusal"};
  });
}
export function runHarnessFaults(root: string): FaultObservation[] {verifyHarnessPreregistration(root); return faultControls(snapshot(resolve(root)));}
export function liveArms() {return CONDITIONS.map(condition => ({condition, status: "unavailable" as const, reason: "no separately authorized admitted G2 role lane or treatment producers; fixture-only T1/T2"}));}
const unknownCost = (): CostRecord => validateCostRecord(Object.fromEntries(COST_FIELDS.map(key => [key, key === "providerRequests" ? 0 : "unknown"])));
function counts(planned: number, live: boolean) {return Object.fromEntries(HARNESS_DENOMINATORS.map(key => [key, key === "planned" || key === (live ? "unavailable" : "judge-unavailable") || !live && key === "executed" ? planned : 0]));}
export interface HarnessControlReceipt {v: 1; kind: "guidance-fixture-observations"; evidence: "prerecorded-fixture-only"; preregistrationSha256: string; bindings: Record<string, string>; code: RunCodeBinding; costProfiles: Record<string, CostRecord>; endToEndCosts: CostRecord; conditionProfiles: Record<string, unknown>; live: ReturnType<typeof liveArms>; faults: FaultObservation[]; rows: Record<string, unknown>[]; denominators: {fixture: Record<string, number>; live: Record<string, number>; faults: Record<string, number>}; conclusion: "insufficient-evidence"; resultAuthorityLinks: never[]; receiptSha256: string}
function controls(root: string, code: RunCodeBinding): HarnessControlReceipt {
  const seal = verifyHarnessPreregistration(root), source = snapshot(resolve(root));
  if (!same(seal, source.seal)) fail("preregistration changed during admission");
  if (!["bin/ares.js", "scripts/harness-eval.ts", "scripts/execution-eval.ts", "package.json", "bun.lock"].every(name => code.files.some(file => file.path === name))) fail("run code binding lacks required bootstrap or harness");
  const rows: Record<string, unknown>[] = [];
  for (const order of source.orders) for (const plan of source.conditions) for (const taskId of order.taskIds) {
    const task = source.cases.find(row => row.id === taskId)!, library = librarySnapshot(source.cases, order, task.id, source.learning), inputs = buildRoleInputs(task, plan.id, library), candidates = inputs.selector.candidates as {id: string; output: string}[];
    validateRoundInputs(inputs);
    const slot = plan.stageCalls.selection ? task.control.selection.selectedSlot : 0;
    if (!candidates[slot]) fail("prerecorded selection outside blinded slots");
    rows.push({kind: "prerecorded-control", order: order.id, repetition: order.repetition, condition: plan.id, taskId, split: task.split, streamSha256: sha256(canonical(order)), inputSha256: task.inputSha256, library: inputs.worker.library, librarySha256: inputs.worker.librarySha256, preparedRoleInputSha256: Object.fromEntries(ROLES.map(role => [role, sha256(canonical(inputs[role]))])), preparedRoleLibrarySha256: Object.fromEntries(ROLES.map(role => [role, inputs[role].librarySha256])), policySha256: sha256(canonical({learningSourceIds: source.learning, revoked: [], mode: "fixture-only"})), selected: candidates[slot], status: "fixture-complete", judge: "unavailable", quality: "unknown", costStages: Object.fromEntries(STAGES.map(stage => [stage, "fixture-no-model-costs"])), endToEndCosts: unknownCost(), conditionProfile: plan.id, budget: {providerCallsObserved: 0, liveUnusedBudget: "unavailable"}, deferredReflection: task.split === "heldout" ? {text: task.control.reflection.text, export: "deferred-until-all-heldout-outputs-and-judgments-frozen"} : null});
  }
  const after = snapshot(resolve(root)); if (!same(after.seal, seal)) fail("preregistration changed during controls");
  const faults = faultControls(source);
  const faultCounts = Object.fromEntries(HARNESS_DENOMINATORS.map(key => [key, key === "planned" || key === "executed" ? faults.length : key === "denied" ? faults.filter(row => row.outcome === "blocked").length : key === "judge-unavailable" ? faults.filter(row => row.kind === "judge-unavailable").length : key === "unknown" ? faults.filter(row => row.kind === "unknown").length : 0]));
  const conditionProfiles = Object.fromEntries(source.conditions.map(plan => {const calls = Object.values(plan.stageCalls).reduce((sum, value) => sum + value, 0); return [plan.id, {stageCalls: plan.stageCalls, ceiling: source.protocol.budgets, fixtureOpportunitySlots: calls, unusedFixtureOpportunitySlots: 8 - calls}];}));
  const body = {v: 1 as const, kind: "guidance-fixture-observations" as const, evidence: "prerecorded-fixture-only" as const, preregistrationSha256: seal.receiptSha256, bindings: seal.bindings, code, costProfiles: {"fixture-no-model-costs": unknownCost()}, endToEndCosts: unknownCost(), conditionProfiles, live: liveArms(), faults, rows, denominators: {fixture: counts(rows.length, false), live: counts(rows.length, true), faults: faultCounts}, conclusion: "insufficient-evidence" as const, resultAuthorityLinks: [] as never[]};
  return {...body, receiptSha256: sha256(canonical(body))};
}
export function verifyControlReceipt(root: string, file: string): HarnessControlReceipt {
  const stored = parsed(readTextBounded(file, RECEIPT_BYTES, {noFollow: true})); if (!plain(stored) || !plain(stored.code)) fail("invalid control receipt");
  verifyRunCodeCommit(root, stored.code as unknown as RunCodeBinding);
  const code = bindRunCode(root);
  if (stored.code.codeSha256 !== code.codeSha256 || !same(stored.code.files, code.files)) fail("control run code changed since receipt");
  const current = controls(root, stored.code as unknown as RunCodeBinding); if (!same(stored, current)) fail("control receipt or resume input changed"); return current;
}
export function runHarnessControls(root: string, output: string): HarnessControlReceipt {
  if (!isAbsolute(output) || output.startsWith("-")) fail("controls output must be absolute as given");
  verifyHarnessPreregistration(root);
  if (existsSync(output)) return verifyControlReceipt(root, output);
  const receipt = controls(root, bindRunCode(root));
  if (Buffer.byteLength(JSON.stringify(receipt, null, 2) + "\n") > RECEIPT_BYTES) fail("control receipt byte bound");
  return publishEvaluationReceipt(output, receipt, RECEIPT_BYTES, () => verifyControlReceipt(root, output));
}
if (import.meta.main) {
  const [command, output, ...extra] = process.argv.slice(2), root = fileURLToPath(new URL("..", import.meta.url));
  try {
    if (extra.length || !["freeze", "verify", "controls", "live-status"].includes(command ?? "")) fail("usage: freeze|verify [receipt] or controls ABSOLUTE_FILE or live-status; no live/model command is admitted");
    if (command === "live-status") {if (output !== undefined) fail("live-status takes no operands"); console.log(JSON.stringify(liveArms()));}
    else if (command === "controls") {if (!output || output.startsWith("-") || !isAbsolute(output)) fail("controls requires an absolute output operand"); const receipt = runHarnessControls(root, output); console.log(JSON.stringify({kind: receipt.kind, conclusion: receipt.conclusion, receiptSha256: receipt.receiptSha256, denominators: receipt.denominators}));}
    else {if (output?.startsWith("-")) fail("receipt operand cannot be an option"); const file = output === undefined ? join(root, HARNESS_FROZEN) : resolve(output); const receipt = command === "freeze" ? freezeHarnessPreregistration(root, file) : verifyHarnessPreregistration(root, file); console.log(JSON.stringify({status: receipt.status, receiptSha256: receipt.receiptSha256}));}
  } catch (error) {console.error(error instanceof Error ? error.message : "harness eval refused; restore the registered method before retrying"); process.exitCode = 1;}
}
