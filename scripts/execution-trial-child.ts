import { join, resolve } from "node:path";
import {mkdirSync, mkdtempSync, realpathSync, rmSync} from "node:fs";
import {fileURLToPath} from "node:url";
import * as diagnosticSetup from "./execution-diagnose-setup.ts";
import { types } from "node:util";
import { plain, readBytesBounded, readTextBounded, sha256, writeAtomic } from "../src/study.ts";
import { resolveDiagnosticFixture, type DiagnosticObservation } from "./execution-diagnose.ts";
import { diagnoseTreatment, type DiagnosticLineageTreatment } from "./execution-lineage.ts";
import * as reuseAdapter from "./execution-trial-reuse.ts";
import type { ReuseTrialArmResult } from "./execution-trial-reuse.ts";

const INPUT_BYTES = 16_384, OUTPUT_BYTES = 65_536;
type Trial = "diagnose" | "reuse";
type Arm = "baseline" | "treatment";
class TrialChildError extends Error {
  constructor(cause: string, next: string) { super(`execution trial child: ${cause}; ${next}`); }
}
function fail(cause: string, next = "restore a bounded candidate-only payload and retry through the admitted parent harness"): never { throw new TrialChildError(cause, next); }
/** Inspect inert JSON without running accessors, proxies or toJSON hooks from an in-process caller. */
function inert(raw: unknown, depth = 0, budget = {bytes: 0, nodes: 0}): unknown {
  if (depth > 24) fail("candidate-input-depth");
  if (++budget.nodes > 4096) fail("candidate-input-bound");
  const add = (bytes: number) => { budget.bytes += bytes; if (budget.bytes > INPUT_BYTES) fail("candidate-input-bound"); };
  if (raw === null || typeof raw === "boolean" || typeof raw === "string") {
    if (typeof raw === "string" && Buffer.byteLength(raw) > INPUT_BYTES) fail("candidate-input-bound");
    add(Buffer.byteLength(JSON.stringify(raw)));
    return raw;
  }
  if (typeof raw === "number") { if (!Number.isFinite(raw)) fail("candidate-input-number"); add(Buffer.byteLength(JSON.stringify(raw))); return raw; }
  if (!raw || typeof raw !== "object" || types.isProxy(raw)) fail("candidate-input-json");
  if (Array.isArray(raw)) {
    const length = Object.getOwnPropertyDescriptor(raw, "length");
    if (Object.getPrototypeOf(raw) !== Array.prototype || !length || !("value" in length) || length.value > 128 || Reflect.ownKeys(raw).length !== length.value + 1) fail("candidate-input-array");
    add(2 + Math.max(0, length.value - 1));
    return Array.from({length: length.value}, (_, index) => {
      const item = Object.getOwnPropertyDescriptor(raw, String(index));
      if (!item || !("value" in item) || !item.enumerable) fail("candidate-input-json");
      return inert(item.value, depth + 1, budget);
    });
  }
  if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail("candidate-input-json");
  const keys = Reflect.ownKeys(raw), result: Record<string, unknown> = {};
  if (keys.length > 128) fail("candidate-input-object");
  add(2 + Math.max(0, keys.length - 1));
  for (const key of keys) {
    if (typeof key !== "string" || Buffer.byteLength(key) > 256) fail("candidate-input-key");
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (!field || !("value" in field) || !field.enumerable) fail("candidate-input-json");
    add(Buffer.byteLength(JSON.stringify(key)) + 1);
    // A data descriptor preserves ordinary JSON objects without invoking __proto__ setters.
    Object.defineProperty(result, key, {value: inert(field.value, depth + 1, budget), enumerable: true, writable: true, configurable: true});
  }
  return result;
}
function candidatePayload(trial: Trial, raw: unknown): Record<string, unknown> {
  const value = inert(raw);
  if (!plain(value) || Buffer.byteLength(JSON.stringify(value)) > INPUT_BYTES) fail("candidate-input-bound");
  const allowed = trial === "diagnose" ? ["request", "study", "attempts", "artifact", "events", "surface", "delivery", "retryRequests", "source"] : ["request", "workload", "currentContext", "source", "requiredAcceptance"];
  if (Object.keys(value).some(key => !allowed.includes(key)) || typeof value.request !== "string" || !value.request.trim() || Buffer.byteLength(value.request) > 4000) fail("candidate-only-payload-required", "pass only the frozen input object, excluding its wrapper and evaluator labels, through the admitted parent harness");
  return value;
}
function token(raw: unknown, maximum = 256): string {
  if (typeof raw !== "string" || raw.length > maximum || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw)) fail("producer-output-token", "inspect the source-owned bounded adapter contract before retrying; do not expose raw producer paths");
  return raw;
}
function digest(raw: string | null): string | null {
  if (raw !== null && !/^[a-f0-9]{64}$/.test(raw)) fail("producer-output-digest");
  return raw;
}
function head(raw: string | null): string | null {
  if (raw !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw)) fail("producer-output-head");
  return raw;
}
function diagnosticResult(value: DiagnosticObservation): DiagnosticObservation {
  return { provenance: {attemptId: value.provenance.attemptId === null ? null : token(value.provenance.attemptId), head: head(value.provenance.head), selectedHead: head(value.provenance.selectedHead),
    status: token(value.provenance.status), completeness: token(value.provenance.completeness)}, nextAction: token(value.nextAction),
    ...(value.retryOf === undefined ? {} : {retryOf: token(value.retryOf)}), ...(value.independentSamples === undefined ? {} : {independentSamples: value.independentSamples}) };
}
function diagnosticIntegration(value: DiagnosticLineageTreatment) {
  const integration = value.integration, view = integration.producerView;
  return {v: value.v, kind: value.kind, arm: value.arm, authority: value.authority,
    state: integration.state, reason: integration.reason, evidenceSha256: digest(integration.evidenceSha256),
    producer: integration.producer === null ? null : {tool: "ares", kind: "attempt", id: token(integration.producer.id), projectKeySha256: sha256(integration.producer.projectKey)},
    lineage: view === null ? null : {status: token(view.lineage.status), sourceSha256: digest(view.lineage.sourceSha256), ledgerPosition: view.lineage.ledgerPosition, nodes: view.lineage.nodes.length, edges: view.lineage.edges.length},
    comparison: view === null ? null : {status: token(view.comparison.status), sourceSha256: digest(view.comparison.sourceSha256), ledgerPosition: view.comparison.ledgerPosition, rows: view.comparison.rows.length},
    humanTimeToFind: "unknown", costs: "unknown", resultAuthority: {selection: false, final: false, adoption: false}, physicalIsolation: "not-established"};
}
function number(raw: number): number { if (!Number.isFinite(raw) || raw < 0) fail("producer-output-number"); return raw; }
function info(raw: string | null): string | null {
  if (raw !== null && (Buffer.byteLength(raw) > 1024 || /\p{Cc}/u.test(raw) || /(?:^|\s)(?:\/|[A-Za-z]:[\\/]|\\\\)|[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw))) fail("producer-output-private-info");
  return raw;
}
function values(raw: ReuseTrialArmResult["currentObserved"]) {
  if (![raw.seed, raw.prepare, raw.transform, raw.evaluate].every(Number.isSafeInteger)) fail("producer-output-values");
  return {seed: raw.seed, prepare: raw.prepare, transform: raw.transform, evaluate: raw.evaluate};
}
function reuseIntegration(value: ReuseTrialArmResult) {
  const reference = (ref: ReuseTrialArmResult["sourceRefs"][number]) => ({attemptId: token(ref.attemptId), stage: token(ref.stage), sha256: digest(ref.sha256)});
  const phase = (row: ReuseTrialArmResult["instrumentation"]["current"]) => {
    if (row.subprocessCpuSeconds !== "unknown") fail("producer-output-subprocess-clock");
    return {wallMs: number(row.wallMs), parentCpuSeconds: number(row.parentCpuSeconds), subprocessCpuSeconds: "unknown"};
  };
  if (value.sourceRefs.length > 3 || value.hits.length > 3 || value.misses.length > 3 || value.freshStages.length > 3 || value.sourceExecuted.length > 4 || value.currentExecuted.length > 4 || value.changedKeys.length > 2 || value.sourcePayloadDigests.length > 3 || value.currentPayloadDigests.length > 3 || value.limitations.length > 16) fail("producer-output-stage-bound");
  return {v: value.v, kind: token(value.kind), authority: token(value.authority), instrumentationOnly: true, status: token(value.status), reuse: token(value.reuse), seed: value.seed,
    sourcePopulation: token(value.sourcePopulation), fault: token(value.fault), injection: info(value.injection), changedKeys: value.changedKeys.map(key => token(key)),
    sourceAttemptId: value.sourceAttemptId === null ? null : token(value.sourceAttemptId), currentAttemptId: token(value.currentAttemptId), sourceRefs: value.sourceRefs.map(reference),
    sourceObserved: value.sourceObserved === null ? null : values(value.sourceObserved), currentObserved: values(value.currentObserved),
    sourcePayloadDigests: value.sourcePayloadDigests.map(hash => digest(hash)), currentPayloadDigests: value.currentPayloadDigests.map(hash => digest(hash)),
    sourceRecordSha256: digest(value.sourceRecordSha256), sourceRecordUnchanged: value.sourceRecordUnchanged,
    sourceMetricsSha256: digest(value.sourceMetricsSha256), currentMetricsSha256: digest(value.currentMetricsSha256),
    sourceEvaluatorId: value.sourceEvaluatorId === null ? null : token(value.sourceEvaluatorId), currentEvaluatorId: token(value.currentEvaluatorId), evaluatorFresh: value.evaluatorFresh,
    sourceExecuted: value.sourceExecuted.map(stage => token(stage)), currentExecuted: value.currentExecuted.map(stage => token(stage)),
    hits: value.hits.map(hit => ({stage: token(hit.stage), key: digest(hit.key), source: reference(hit.source)})), misses: value.misses.map(miss => ({stage: token(miss.stage), reason: token(miss.reason)})), freshStages: value.freshStages.map(stage => token(stage)),
    counts: {sourceExecutedStages: number(value.counts.sourceExecutedStages), currentExecutedStages: number(value.counts.currentExecutedStages), reusedStages: number(value.counts.reusedStages), currentIndependentSamples: number(value.counts.currentIndependentSamples)},
    provenanceStatus: token(value.provenanceStatus), comparisonStatus: token(value.comparisonStatus), candidateEvidenceSha256: digest(value.candidateEvidenceSha256),
    instrumentation: {sourceSetup: phase(value.instrumentation.sourceSetup), current: phase(value.instrumentation.current), total: phase(value.instrumentation.total),
      wallClock: token(value.instrumentation.wallClock), cpuClock: token(value.instrumentation.cpuClock), totalIncludesCleanup: value.instrumentation.totalIncludesCleanup,
      sourceSetupScope: token(value.instrumentation.sourceSetupScope), currentScope: token(value.instrumentation.currentScope)},
    limitations: value.limitations.map(item => info(item)), physicalIsolation: "not-established"};
}
function diagnosticClock(wall: number, cpu: NodeJS.CpuUsage) {
  const elapsed = process.cpuUsage(cpu);
  return {wallMs: performance.now() - wall, parentCpuSeconds: (elapsed.user + elapsed.system) / 1_000_000, subprocessCpuSeconds: "unknown" as const};
}
async function executeDiagnostic(arm: Arm, input: Record<string, unknown>, parent: string) {
  const wall = performance.now(), cpu = process.cpuUsage(), baseline = resolveDiagnosticFixture(input);
  const helperSha256 = sha256(readBytesBounded(fileURLToPath(new URL("./execution-diagnose-setup.ts", import.meta.url)), OUTPUT_BYTES, {noFollow: true}));
  const fixtureFactorySha256 = sha256(readBytesBounded(fileURLToPath(new URL("./execution-native-fixtures.ts", import.meta.url)), OUTPUT_BYTES, {noFollow: true}));
  let nativeRoot: string | undefined;
  try {
    let dir = parent;
    const skipped = baseline.provenance.attemptId === null;
    if (!skipped) {
      nativeRoot = mkdtempSync(join(realpathSync(parent), "native-scaffold-"));
      dir = join(nativeRoot, "study"); const work = join(nativeRoot, "executor");
      mkdirSync(dir, {mode: 0o700}); mkdirSync(work, {mode: 0o700});
      await diagnosticSetup.bootstrapVisibleDiagnosticStudy(input, dir, work);
    }
    const setup = diagnosticClock(wall, cpu), currentWall = performance.now(), currentCpu = process.cpuUsage();
    const output = arm === "baseline"
      ? {result: diagnosticResult(resolveDiagnosticFixture(input)), integration: {v: 1, kind: "diagnostic-fixture-baseline", authority: "harness-observed", nativeProducerRead: false, humanTimeToFind: "unknown", costs: "unknown", physicalIsolation: "not-established"}}
      : (() => {const value = diagnoseTreatment(dir, input); return {result: diagnosticResult(value.diagnostic), integration: diagnosticIntegration(value)};})();
    const current = diagnosticClock(currentWall, currentCpu);
    return {...output, integration: {...output.integration, scaffolding: {v: 1, kind: "synthetic-native-scaffolding", authority: "harness-observed", source: "visible-facts-only", independentPhysicalAttestation: false,
      state: skipped ? "skipped" : "materialized", reason: skipped ? "no-visible-producer" : null, helperSha256, fixtureFactorySha256, setup, current,
      clockScope: "child-parent-process-only", components: "setup and current are subsets of scheduled process totals, never added again"}}};
  } finally {if (nativeRoot) rmSync(nativeRoot, {recursive: true, force: true});}
}
/** Candidate-only child boundary; studyDir is a private parent binding, never a payload locator. */
export async function executeTreatmentFixture(trial: Trial, arm: Arm, payload: unknown, seed: number, studyDir: string): Promise<{result: unknown; integration: unknown}> {
  if (!["diagnose", "reuse"].includes(trial) || !["baseline", "treatment"].includes(arm) || !Number.isSafeInteger(seed) || Math.abs(seed) > 1_000_000) fail("trial-arm-or-seed-invalid");
  const input = candidatePayload(trial, payload);
  let output: {result: unknown; integration: unknown};
  try {
    if (trial === "reuse") {
      const value = await reuseAdapter.runReuseTrialArm(input, seed, arm === "baseline" ? "off" : "eligible");
      output = {result: values(value.currentObserved), integration: reuseIntegration(value)};
    }
    else output = await executeDiagnostic(arm, input, studyDir);
  } catch (error) { if (error instanceof TrialChildError) throw error; return fail(`${trial}-adapter-unavailable`, "inspect the admitted private study and frozen candidate payload, then retry without fabricating producer records"); }
  if (Buffer.byteLength(JSON.stringify(output)) > OUTPUT_BYTES) fail("producer-output-bound");
  return output;
}
if (import.meta.main) {
  void (async () => {
    try {
      const [trial, arm, inputFile, outputFile, rawSeed, ...extra] = process.argv.slice(2);
      const mapped = arm === "baseline" || arm === "treatment" ? arm : trial === "diagnose" && arm === "current-workflow" || trial === "reuse" && arm === "fresh" ? "baseline"
        : trial === "diagnose" && arm === "H1-A1-C1-lineage-view" || trial === "reuse" && arm === "eligible-reuse" ? "treatment" : undefined;
      if (!inputFile || !outputFile || !rawSeed || !mapped || extra.length || !/^-?\d{1,7}$/.test(rawSeed) || !["diagnose", "reuse"].includes(trial ?? "") || resolve(inputFile) === resolve(outputFile)) fail("arguments-invalid", "use execution-trial-child.ts TRIAL ARM INPUT OUTPUT SEED in the parent-owned private study cwd");
      let payload: unknown;
      try {payload = JSON.parse(readTextBounded(resolve(inputFile), INPUT_BYTES, {noFollow: true}));} catch {return fail("candidate-input-unreadable", "restore a physical bounded UTF-8 JSON candidate input file and retry through the parent harness");}
      const result = await executeTreatmentFixture(trial as Trial, mapped, payload, Number(rawSeed), process.cwd());
      try {writeAtomic(resolve(outputFile), JSON.stringify(result) + "\n", OUTPUT_BYTES, 0o600);} catch {return fail("output-unavailable", "use an owned writable private output directory and retry through the parent harness");}
    } catch (error) {
      console.error(error instanceof TrialChildError ? error.message : "execution trial child: adapter-unavailable; inspect the admitted fixture adapter before retrying");
      process.exitCode = 1;
    }
  })();
}
