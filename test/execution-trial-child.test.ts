import {expect, spyOn, test} from "bun:test";
import * as reuse from "../scripts/execution-trial-reuse.ts";
import * as lineage from "../scripts/execution-lineage.ts";
import {executeTreatmentFixture} from "../scripts/execution-trial-child.ts";
import type {ReuseTrialArmResult} from "../scripts/execution-trial-reuse.ts";
import type {DiagnosticLineageTreatment} from "../scripts/execution-lineage.ts";

const hash = "a".repeat(64), commit = "b".repeat(40);
const diagnosticPayload = {request: "Identify the synthetic producer", study: {selectedHead: commit}, attempts: [{id: "synthetic-attempt", commit, status: "succeeded", seed: 3}], artifact: {producerAttemptId: "synthetic-attempt", present: true}};
const reusePayload = {request: "Compute the synthetic pipeline", workload: {values: [1, 2], seeds: [3]}, currentContext: {method: "synthetic", globalCodeDigest: hash}, source: null};
function armResult(mode: "off" | "eligible"): ReuseTrialArmResult {
  const ref = {attemptId: "a".repeat(16), stage: "prepare", sha256: hash};
  const phase = (wallMs: number, parentCpuSeconds: number) => ({wallMs, parentCpuSeconds, subprocessCpuSeconds: "unknown" as const});
  return {v: 1, kind: "reuse-arm-fixture-instrumentation", authority: "functional-fixture-only", instrumentationOnly: true,
    reuse: mode, seed: 3, status: "succeeded", sourcePopulation: "fixture-rematerialized", fault: "none", injection: "the frozen source declares no fault", changedKeys: [],
    sourceAttemptId: ref.attemptId, currentAttemptId: "b".repeat(16), sourceRefs: [ref],
    sourceObserved: {seed: 3, prepare: 6, transform: 12, evaluate: 147}, currentObserved: {seed: 3, prepare: 6, transform: 12, evaluate: 147}, expected: {seed: 3, prepare: 6, transform: 12, evaluate: 147},
    sourcePayloadDigests: [hash], currentPayloadDigests: [hash], sourceRecordSha256: hash, sourceRecordUnchanged: true,
    sourceMetricsSha256: hash, currentMetricsSha256: hash, sourceEvaluatorId: "c".repeat(64), currentEvaluatorId: "d".repeat(64), evaluatorFresh: true,
    sourceExecuted: ["prepare", "transform", "evaluate", "verify"], currentExecuted: mode === "off" ? ["prepare", "transform", "evaluate", "verify"] : ["transform", "evaluate", "verify"],
    hits: mode === "off" ? [] : [{stage: "prepare", key: hash, source: ref}], misses: mode === "off" ? [] : [{stage: "transform", reason: "missing"}, {stage: "evaluate", reason: "missing"}],
    freshStages: mode === "off" ? ["prepare", "transform", "evaluate"] : ["transform", "evaluate"],
    counts: {sourceExecutedStages: 4, currentExecutedStages: mode === "off" ? 4 : 3, reusedStages: mode === "off" ? 0 : 1, currentIndependentSamples: 0},
    provenanceStatus: "ok", comparisonStatus: "ok", candidateEvidenceSha256: hash,
    instrumentation: {sourceSetup: phase(1, 0.1), current: phase(2, 0.2), total: phase(4, 0.4), wallClock: "performance.now-monotonic", cpuClock: "process.cpuUsage-parent-process", totalIncludesCleanup: true,
      sourceSetupScope: "shared-fixture-setup-and-optional-source-plus-fault", currentScope: "current-edits-execution-and-output-verification"}, limitations: ["synthetic transport only"]};
}

test("both Reuse arms call the shared producer seam with only candidate payload and the correct switch", async () => {
  const called = spyOn(reuse, "runReuseTrialArm").mockImplementation(async (_payload, _seed, mode) => armResult(mode));
  try {
    for (const [arm, mode] of [["baseline", "off"], ["treatment", "eligible"]] as const) {
      const result = await executeTreatmentFixture("reuse", arm, reusePayload, 3, "/private/synthetic-study");
      expect(called.mock.calls.at(-1)).toEqual([reusePayload, 3, mode]);
      expect(result.result).toEqual(armResult(mode).currentObserved);
      const integration = result.integration as Record<string, any>;
      expect(integration.reuse).toBe(mode); expect(integration.hits).toEqual(armResult(mode).hits); expect(integration.misses).toEqual(armResult(mode).misses);
      expect(integration.counts).toEqual(armResult(mode).counts);
      expect(integration.currentEvaluatorId).not.toBe(integration.sourceEvaluatorId); expect(integration.evaluatorFresh).toBe(true);
      expect(integration.sourceRecordUnchanged).toBe(true); expect(integration.currentPayloadDigests).toEqual([hash]);
      expect(integration.instrumentation).toEqual(armResult(mode).instrumentation);
      expect(integration.instrumentation.total.parentCpuSeconds).toBe(0.4);
      expect(integration.physicalIsolation).toBe("not-established"); expect(Object.hasOwn(integration, "expected")).toBe(false);
      expect(JSON.stringify(result)).not.toContain("/private/synthetic-study");
    }
    expect(called).toHaveBeenCalledTimes(2);
  } finally {called.mockRestore();}
});

test("Reuse output keeps source fault evidence and projects out unrelated private fields", async () => {
  const value = {...armResult("off"), fault: "corrupt" as const, injection: "changed the sealed prepare payload so its manifest hash no longer matches", privatePath: "/private/do-not-export", rawLogs: "synthetic private body"};
  const called = spyOn(reuse, "runReuseTrialArm").mockResolvedValue(value);
  try {
    const result = await executeTreatmentFixture("reuse", "baseline", reusePayload, 3, "/private/study");
    expect(result.integration).toMatchObject({fault: "corrupt", injection: value.injection, sourceRecordSha256: hash, candidateEvidenceSha256: hash});
    expect(JSON.stringify(result)).not.toContain("do-not-export"); expect(JSON.stringify(result)).not.toContain("synthetic private body");
  } finally {called.mockRestore();}
});

test("private producer info refuses without echoing the path or underlying exception", async () => {
  const called = spyOn(reuse, "runReuseTrialArm").mockResolvedValue({...armResult("off"), injection: "inspect /private/never-echo"});
  try {
    let message = ""; try {await executeTreatmentFixture("reuse", "baseline", reusePayload, 3, "private");} catch (error) {message = (error as Error).message;}
    expect(message).toContain("producer-output-private-info"); expect(message).not.toContain("never-echo");
    called.mockImplementation(async () => {throw new Error("transport /private/do-not-repeat");});
    try {await executeTreatmentFixture("reuse", "treatment", reusePayload, 3, "private");} catch (error) {message = (error as Error).message;}
    expect(message).toContain("reuse-adapter-unavailable"); expect(message).not.toContain("do-not-repeat");
  } finally {called.mockRestore();}
});

test("Diagnose baseline resolves visible fixture facts without invoking native lineage", async () => {
  const called = spyOn(lineage, "diagnoseTreatment").mockImplementation(() => {throw new Error("must not read native sources");});
  try {
    const result = await executeTreatmentFixture("diagnose", "baseline", diagnosticPayload, 3, "/private/study");
    expect(result.result).toMatchObject({provenance: {attemptId: "synthetic-attempt", head: commit, status: "succeeded", completeness: "complete"}, nextAction: "inspect-terminal-result"});
    expect(result.integration).toMatchObject({nativeProducerRead: false, humanTimeToFind: "unknown", costs: "unknown"});
    expect(called).not.toHaveBeenCalled();
  } finally {called.mockRestore();}
});

test("Diagnose treatment preserves unavailable metadata without manufacturing native records", async () => {
  const adapter: DiagnosticLineageTreatment = {v: 1, kind: "fixture-integration-only", arm: "diagnose-lineage", authority: "harness-observed",
    diagnostic: {provenance: {attemptId: null, head: null, selectedHead: commit, status: "unknown", completeness: "lineage-unavailable"}, nextAction: "inspect-bounded-lineage-source"},
    integration: {state: "unavailable", reason: "native-read-unavailable", producer: null, evidenceSha256: null, producerView: null},
    humanTimeToFind: "unknown", costs: "unknown", resultAuthority: {selection: false, final: false, adoption: false}, limitations: []};
  const called = spyOn(lineage, "diagnoseTreatment").mockReturnValue(adapter);
  try {
    const result = await executeTreatmentFixture("diagnose", "treatment", diagnosticPayload, 3, "/private/study");
    expect(called.mock.calls).toEqual([["/private/study", diagnosticPayload]]); expect(result.result).toEqual(adapter.diagnostic);
    expect(result.integration).toMatchObject({state: "unavailable", reason: "native-read-unavailable", producer: null, lineage: null, comparison: null});
    expect(JSON.stringify(result)).not.toContain("/private/study");
  } finally {called.mockRestore();}
});

test("preflight rejects wrappers, truth, input locators, invalid seeds and active objects before invoking either producer", async () => {
  const called = spyOn(reuse, "runReuseTrialArm").mockImplementation(async () => {throw new Error("producer must not run");});
  let touched = false;
  const getter = {...reusePayload}; Object.defineProperty(getter, "source", {get: () => {touched = true; return null;}, enumerable: true});
  const proxy = new Proxy(reusePayload, {ownKeys: () => {touched = true; return [];}});
  const invalid = [{v: 1, id: "case", trial: "reuse", input: reusePayload}, {...reusePayload, expected: true}, {...reusePayload, studyDir: "/private/locator"}, {...reusePayload, request: "x".repeat(16_385)}, getter, proxy, {...reusePayload, toJSON: () => {touched = true; return reusePayload;}}];
  try {
    for (const payload of invalid) await expect(executeTreatmentFixture("reuse", "treatment", payload, 3, "private")).rejects.toThrow("execution trial child:");
    for (const seed of [NaN, Infinity, 0.5, 1_000_001]) await expect(executeTreatmentFixture("reuse", "baseline", reusePayload, seed, "private")).rejects.toThrow("trial-arm-or-seed-invalid");
    expect(touched).toBe(false); expect(called).not.toHaveBeenCalled();
  } finally {called.mockRestore();}
});
