import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { types } from "node:util";
import { canonical, COST_FIELDS, filePath, FROZEN_RECEIPT, PREREGISTRATION, publishEvaluationReceipt, verifyPreregistration, type CostRecord } from "./execution-eval.ts";
import { sourceFault, sourceState, type ReuseFault } from "./execution-reuse.ts";
import { freshValues, numericWorkload } from "./execution-workload.ts";
import { readBytesBounded, readTextBounded, sha256 } from "../src/study.ts";

export const REMATERIALIZATION_RECEIPT = "docs/verification/execution-eval-reuse-rematerialization-frozen.json";
export const REMATERIALIZATION_PROTOCOL = "docs/verification/execution-eval-reuse-rematerialization.md";
const CORPUS = "test/fixtures/execution-eval/corpus.json";
const PARENT_RECEIPT_SHA256 = "72f36f856c2559bf7a626689bca3825ae3cfe49f27c9d8abf544f24bd2778e20";
const PARENT_RAW_SHA256 = "ad2c48aade8fd430727f7c16f90bb33a9283f5fc71593b2fcf8c98f5c58a2d60";
/** The modules whose arithmetic, case selection and fault injection define every rematerialized identity. */
export const SETUP_CODE_FILES = ["scripts/execution-reuse-rematerialize.ts", "scripts/execution-workload.ts", "scripts/execution-reuse.ts"] as const;
const DOCUMENT_BYTES = 65_536, FIXTURE_BYTES = 16_384, TOTAL_BYTES = 3 * 1024 * 1024;
const STAGES = ["prepare", "transform", "evaluate"] as const;
const SCENARIOS = ["local-stage-edit", "global-code-change", "no-hit", "corrupt-artifact", "pruned-artifact", "interrupted-source"] as const;
export type RematerializationReason = "rematerialized" | "no-frozen-source";
export interface RematerializedStage { stage: typeof STAGES[number]; seed: number; value: number; sha256: string; bytes: number }
export interface RematerializedCase {
  caseId: string; scenario: string; state: "rematerialized" | "refused"; reason: RematerializationReason;
  fault: ReuseFault; label: "fixture-rematerialized" | "fixture-rematerialized+injected-fault" | "no-frozen-source";
  sourceStatus: string | null; sourceCodeDigest: string | null; workloadSha256: string | null; stageSha256: string | null;
  hitCapableStages: typeof STAGES[number][]; stages: RematerializedStage[];
}
interface FileHash { path: string; sha256: string; bytes: number }
export interface ReuseSetupIdentity {
  v: 1; status: "preregistered-rematerialization-not-measured";
  amends: { path: typeof FROZEN_RECEIPT; sha256: string; receiptSha256: string };
  bindings: { codeSha256: string; corpusSha256: string; inputSha256: string; workloadSha256: string; stageSha256: string; protocolSha256: string; thresholdsSha256: string; denominatorsSha256: string };
  cases: RematerializedCase[]; files: FileHash[];
}
export interface ReuseSetupResult { identity: ReuseSetupIdentity; setupSha256: string; setupCosts: CostRecord }
export type ReuseSealState = { state: "verified"; receipt: ReuseSetupResult } | { state: "missing" | "changed"; receipt: null };
function fail(cause: string): never {
  throw new Error(`execution reuse rematerialization: ${cause}; restore the approved reuse corpus and the inherited v1 seal, or register a separately reviewed amendment before retrying; no trial is launched`);
}
function object(raw: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail(`${label} requires exactly its closed fields`);
  const keys = Reflect.ownKeys(raw), result: Record<string, unknown> = Object.create(null);
  if (keys.length !== fields.length) fail(`${label} requires exactly its closed fields`);
  for (const key of keys) {
    if (typeof key !== "string" || !fields.includes(key)) fail(`${label} requires exactly its closed fields`);
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(`${label} requires inert JSON fields`);
    result[key] = descriptor.value;
  }
  return result;
}
function text(raw: unknown, bound: number, label: string): string {
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw) > bound || /\p{Cc}/u.test(raw)) fail(`${label} must be bounded nonblank text without controls`);
  return raw;
}
function digest(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) fail(`${label} must be a lowercase sha256 digest`);
  return raw;
}
function slug(raw: unknown, label: string): string {
  const value = text(raw, 64, label);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) fail(`${label} must be a lowercase slug`);
  return value;
}
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder("utf-8", {fatal: true}).decode(bytes); } catch { return fail("source is not valid UTF-8"); }
}
function json(source: string): unknown { try { return JSON.parse(source); } catch { return fail("source is not valid JSON"); } }
/** Retained stage bytes are the producer's own payload: one decimal integer and one newline. */
function payload(value: number): string { return JSON.stringify(value) + "\n"; }
/**
 * Rebuilds one frozen case's source stage outputs from `source.workload` alone. Evaluator labels are never read here, so
 * no label can steer which source is rebuilt or which stage it is able to serve.
 */
export function rematerializeReuseCase(raw: unknown): RematerializedCase {
  const wrapper = object(raw, ["v", "id", "trial", "scenario", "input"], "reuse case wrapper");
  if (wrapper.v !== 1 || wrapper.trial !== "reuse") fail("reuse case wrapper version/trial is unsupported");
  const caseId = slug(wrapper.id, "case id"), scenario = text(wrapper.scenario, 64, "case scenario");
  if (!(SCENARIOS as readonly string[]).includes(scenario)) fail("case scenario is unsupported");
  const input = object(wrapper.input, ["currentContext", "request", "requiredAcceptance", "source", "workload"], "candidate input");
  const context = object(input.currentContext, ["globalCodeDigest", "method", "executorClass"], "current context");
  const currentCode = digest(context.globalCodeDigest, "current global code digest");
  text(context.method, 128, "current method");
  const state = sourceState(input.source);
  const refused = (reason: RematerializationReason): RematerializedCase => ({caseId, scenario, state: "refused", reason, fault: "none", label: "no-frozen-source",
    sourceStatus: null, sourceCodeDigest: null, workloadSha256: null, stageSha256: null, hitCapableStages: [], stages: []});
  if (state.sourceEstablishment === "no-frozen-source") return refused("no-frozen-source");
  const source = object(input.source, ["artifact", "attemptId", "executorClass", "globalCodeDigest", "method", "status", "workload"], "frozen source");
  // A source that its own scenario breaks is rebuilt healthy and then broken the same way, so the reuse path meets the
  // fault instead of the setup quietly removing the case from the trial.
  const fault: ReuseFault = sourceFault(state);
  if (fault === "none" && state.sourceIntegrity !== "valid-opaque") fail("a succeeded source must carry a valid opaque artifact, a corruption or a retention fault");
  const sourceCode = digest(source.globalCodeDigest, "source global code digest");
  const sourceRaw = source.workload, seeds = object(sourceRaw, ["values", "seeds", "stages"], "frozen source workload").seeds;
  if (!Array.isArray(seeds) || !seeds.length) fail("frozen source workload must declare at least one seed");
  const declared = numericWorkload({workload: sourceRaw}, (seeds as number[])[0]!), current = numericWorkload({workload: input.workload}, (seeds as number[])[0]!);
  if (canonical(declared.seeds) !== canonical(current.seeds)) fail("source and current workloads must declare one seed list");
  const chain = (workload: unknown, seed: number) => freshValues({workload}, seed), stages: RematerializedStage[] = [];
  const left: number[][] = [], right: number[][] = [];
  for (const seed of declared.seeds) {
    const at = chain(sourceRaw, seed), to = chain(input.workload, seed);
    left.push(STAGES.map(stage => at[stage])); right.push(STAGES.map(stage => to[stage]));
    for (const stage of STAGES) {
      const value = at[stage], bytes = Buffer.from(payload(value));
      stages.push({stage, seed, value, sha256: sha256(bytes), bytes: bytes.length});
    }
  }
  // A stage can serve a hit only when the code tree and that stage's own declaration and upstream bytes are unchanged.
  const sameCode = sourceCode === currentCode;
  const sameDefinition = [true, declared.multiplier === current.multiplier && declared.offset === current.offset, declared.evaluateOperation === current.evaluateOperation];
  const derived = STAGES.filter((_stage, index) => sameCode && sameDefinition[index] === true && left.every((row, seed) => row[index] === right[seed]![index]));
  // A declared fault is meant to defeat every stage, so it declares none; the admission check holds the reuse path to that.
  const hitCapableStages = fault === "none" ? derived : [];
  return {caseId, scenario, state: "rematerialized", reason: "rematerialized", fault,
    label: fault === "none" ? "fixture-rematerialized" : "fixture-rematerialized+injected-fault",
    sourceStatus: state.sourceStatus, sourceCodeDigest: sourceCode,
    workloadSha256: sha256(canonical(sourceRaw)), stageSha256: sha256(canonical(stages)), hitCapableStages: [...hitCapableStages], stages};
}
/** Destination parents are physical directories inside the supplied fixture root. */
function receiptPath(root: string, receiptFile: string): string {
  const file = resolve(receiptFile), name = relative(root, file);
  if (!name || isAbsolute(name) || name.split(/[\\/]/).some(part => part === ".." || part === ".")) fail("receipt must be inside the fixture root");
  let parent = root;
  for (const part of relative(root, dirname(file)).split(/[\\/]/).filter(Boolean)) {
    parent = join(parent, part);
    let stat; try { stat = lstatSync(parent); } catch { return fail("receipt parent is missing or unreadable"); }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("receipt parent must be a physical directory");
  }
  return file;
}
function identity(rootArg: string): ReuseSetupIdentity {
  const root = resolve(rootArg), parent = verifyPreregistration(root, filePath(root, FROZEN_RECEIPT));
  const files: FileHash[] = []; let total = 0;
  const read = (name: string, bound: number) => {
    let bytes: Buffer;
    try { bytes = readBytesBounded(filePath(root, name), bound, {noFollow: true}); } catch { return fail("required physical source is missing, unreadable or over-bound"); }
    total += bytes.length; if (total > TOTAL_BYTES) fail("sources exceed the aggregate 3 MiB bound");
    const hash = {path: name, sha256: sha256(bytes), bytes: bytes.length}; files.push(hash);
    return {text: decode(bytes), hash};
  };
  const parentSource = read(FROZEN_RECEIPT, DOCUMENT_BYTES);
  if (parent.receiptSha256 !== PARENT_RECEIPT_SHA256 || parentSource.hash.sha256 !== PARENT_RAW_SHA256) fail("parent v1 receipt differs from the approved immutable seal");
  read(PREREGISTRATION, DOCUMENT_BYTES);
  const protocol = read(REMATERIALIZATION_PROTOCOL, DOCUMENT_BYTES), index = read(CORPUS, DOCUMENT_BYTES);
  const corpus = object(json(index.text), ["v", "cases"], "reuse corpus index");
  if (corpus.v !== 1 || !Array.isArray(corpus.cases)) fail("reuse corpus index is unsupported");
  const bound = new Map(parent.inputFiles.map(file => [file.path, file.sha256]));
  if (bound.get(index.hash.path) !== index.hash.sha256) fail("reuse corpus index is not the frozen input of the parent v1 seal");
  const identities = new Set<string>(), paths = new Set<string>([index.hash.path]), counts = new Map<string, number>(), inputs: FileHash[] = [];
  const cases = corpus.cases.flatMap(raw => {
    const row = object(raw, ["id", "trial", "scenario", "input", "expected"], "corpus row"), name = slug(row.id, "case id");
    // Other trials in the same index are the parent seal's business; this amendment reads the Reuse rows only.
    if (row.trial !== "reuse") return [];
    if (identities.has(name)) fail("case identity is duplicated");
    identities.add(name);
    const group = text(row.scenario, 64, "case scenario"); counts.set(group, (counts.get(group) ?? 0) + 1);
    const source = row.input;
    if (typeof source !== "string" || source !== `test/fixtures/execution-eval/${name}.input.json` || paths.has(source)) fail("case input must have a unique exact reuse corpus path");
    paths.add(source);
    const fixture = read(source, FIXTURE_BYTES);
    if (bound.get(source) !== fixture.hash.sha256) fail("case input is not the frozen input of the parent v1 seal");
    inputs.push(fixture.hash);
    const loaded = rematerializeReuseCase(json(fixture.text));
    if (loaded.caseId !== name || loaded.scenario !== group) fail("candidate input does not match its indexed identity");
    return [loaded];
  });
  if (cases.length !== 12) fail("reuse corpus requires exactly twelve cases");
  for (const group of SCENARIOS) if (counts.get(group) !== 2) fail("each reuse scenario requires two cases");
  const code = SETUP_CODE_FILES.map(name => read(name, DOCUMENT_BYTES).hash);
  const rematerialized = cases.filter(row => row.state === "rematerialized"), stageBytes = rematerialized.flatMap(row => row.stages);
  if (!rematerialized.length || !stageBytes.length) fail("no case rematerialized a source stage");
  return { v: 1, status: "preregistered-rematerialization-not-measured",
    amends: {path: FROZEN_RECEIPT, sha256: parentSource.hash.sha256, receiptSha256: parent.receiptSha256},
    bindings: {
      codeSha256: sha256(canonical(code)), corpusSha256: index.hash.sha256, inputSha256: sha256(canonical(inputs)),
      workloadSha256: sha256(canonical(rematerialized.map(row => [row.caseId, row.workloadSha256]))), stageSha256: sha256(canonical(stageBytes)),
      protocolSha256: protocol.hash.sha256, thresholdsSha256: parent.bindings.thresholdsSha256, denominatorsSha256: parent.bindings.denominatorsSha256 },
    cases, files };
}
function costs(cpuSeconds: number, wallElapsedMs: number): CostRecord {
  // Only the materialization dimensions are measured; every other clock stays unknown so no total double counts.
  const unknown = Object.fromEntries(COST_FIELDS.map(field => [field, "unknown"])) as CostRecord;
  return {...unknown, materializationCpuSeconds: cpuSeconds, materializationWallMs: wallElapsedMs};
}
/** Deterministic setup result; the freeze run's own materialization cost sits outside the identity it seals. */
export function rematerializeFrozenReuseSetup(rootArg: string): ReuseSetupResult {
  const started = performance.now(), before = process.cpuUsage(), body = identity(rootArg), used = process.cpuUsage(before);
  return {identity: body, setupSha256: sha256(canonical(body)), setupCosts: costs((used.user + used.system) / 1e6, performance.now() - started)};
}
/** Same workload and code bytes always produce the same identity; labels and measured timings never enter it. */
export function reuseSetupDigest(result: ReuseSetupResult | ReuseSetupIdentity): string {
  return sha256(canonical("identity" in result ? result.identity : result));
}
/**
 * The state answers one question: do the recorded bytes still match these sources? Any mismatch, unreadable receipt or
 * broken frozen source is `changed`; an absent receipt is `missing`. Exact causes stay with `rematerializeFrozenReuseSetup`.
 */
export function verifyReuseRematerializationSeal(rootArg: string, receiptFile = join(resolve(rootArg), REMATERIALIZATION_RECEIPT)): ReuseSealState {
  const root = resolve(rootArg), file = receiptPath(root, receiptFile);
  let stat; try { stat = lstatSync(file); } catch { return {state: "missing", receipt: null}; }
  if (stat.isSymbolicLink() || !stat.isFile()) fail("a receipt path must be a physical regular file");
  let raw: unknown;
  try { raw = json(readTextBounded(file, DOCUMENT_BYTES, {noFollow: true})); } catch { return {state: "changed", receipt: null}; }
  try {
    const receipt = object(raw, ["identity", "setupSha256", "setupCosts"], "rematerialization receipt"), stored = receipt.identity;
    if (digest(receipt.setupSha256, "setup seal") !== sha256(canonical(stored))) return {state: "changed", receipt: null};
    const current = identity(root);
    if (canonical(stored) !== canonical(current)) return {state: "changed", receipt: null};
    const recorded = receipt.setupCosts;
    if (!recorded || typeof recorded !== "object" || Array.isArray(recorded) || types.isProxy(recorded) || Object.keys(recorded).some(key => !(COST_FIELDS as readonly string[]).includes(key))) return {state: "changed", receipt: null};
    for (const key of COST_FIELDS) { const value = (recorded as Record<string, unknown>)[key]; if (value !== "unknown" && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) return {state: "changed", receipt: null}; }
    return {state: "verified", receipt: {identity: current, setupSha256: sha256(canonical(current)), setupCosts: recorded as CostRecord}};
  } catch { return {state: "changed", receipt: null}; }
}
/** First seal creates a private receipt exclusively. Later seals only verify; they never overwrite recorded bytes. */
export function sealReuseRematerialization(rootArg: string, receiptFile = join(resolve(rootArg), REMATERIALIZATION_RECEIPT)): ReuseSealState {
  const root = resolve(rootArg), file = receiptPath(root, receiptFile);
  if (lstatSync(file, {throwIfNoEntry: false})) return verifyReuseRematerializationSeal(root, file);
  const result = rematerializeFrozenReuseSetup(root);
  // A concurrent creator wins the hard link; both paths are read back so the returned costs are the recorded ones.
  publishEvaluationReceipt(file, result, DOCUMENT_BYTES, () => result);
  const sealed = verifyReuseRematerializationSeal(root, file);
  if (sealed.state !== "verified") fail("an existing rematerialization seal does not match these sources");
  return sealed;
}
