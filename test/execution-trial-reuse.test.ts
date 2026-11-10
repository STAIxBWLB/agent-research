import {expect, test} from "bun:test";
import {canonical} from "../scripts/execution-eval.ts";
import {runReuseTrialArm, type ReuseTrialArmResult} from "../scripts/execution-trial-reuse.ts";
import {freshValues} from "../scripts/execution-workload.ts";
import {sha256} from "../src/study.ts";

// Independent synthetic instrumentation inputs; no frozen receipt, trial launch, hub, model or native Docker.
const seed = 5;
function input(withSource = true) {
  const workload = {values: [1, 2, 3], seeds: [seed], stages: [
    {id: "prepare", operation: "sum-input-plus-seed"},
    {id: "transform", operation: "multiply-plus-offset", multiplier: 4, offset: 7},
    {id: "evaluate", operation: "square-plus-two-seeds"},
  ]};
  const code = sha256("independent-arm-instrumentation-code"), payload = {synthetic: "opaque-source-declaration"};
  return {id: "independent-arm-instrumentation", workload, currentContext: {method: "independent-arm-instrumentation", globalCodeDigest: code},
    source: withSource ? {status: "succeeded", globalCodeDigest: code, workload: structuredClone(workload), artifact: {present: true, payload, digest: sha256(canonical(payload))}} as Record<string, unknown> : null};
}
function instrumentation(result: ReuseTrialArmResult) {
  expect(result.authority).toBe("functional-fixture-only"); expect(result.instrumentationOnly).toBe(true);
  expect(result.kind).toBe("reuse-arm-fixture-instrumentation"); expect(result.evaluatorFresh).toBe(true);
  expect(result.instrumentation).toMatchObject({wallClock: "performance.now-monotonic", cpuClock: "process.cpuUsage-parent-process", totalIncludesCleanup: true,
    sourceSetupScope: "shared-fixture-setup-and-optional-source-plus-fault", currentScope: "current-edits-execution-and-output-verification"});
  for (const phase of [result.instrumentation.sourceSetup, result.instrumentation.current, result.instrumentation.total]) {
    expect(Number.isFinite(phase.wallMs)).toBe(true); expect(phase.wallMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(phase.parentCpuSeconds)).toBe(true); expect(phase.parentCpuSeconds).toBeGreaterThanOrEqual(0);
    expect(phase.subprocessCpuSeconds).toBe("unknown");
  }
  expect(result.instrumentation.total.wallMs).toBeGreaterThanOrEqual(result.instrumentation.sourceSetup.wallMs + result.instrumentation.current.wallMs);
  expect(result.instrumentation.total.parentCpuSeconds).toBeGreaterThanOrEqual(result.instrumentation.sourceSetup.parentCpuSeconds);
  expect(result.instrumentation.total.parentCpuSeconds).toBeGreaterThanOrEqual(result.instrumentation.current.parentCpuSeconds);
  expect(result.currentPayloadDigests).toHaveLength(3); expect(result.currentPayloadDigests.every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  expect(result.currentMetricsSha256).toMatch(/^[a-f0-9]{64}$/); expect(result.candidateEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.limitations.some(value => value.includes("subprocess CPU remains unknown"))).toBe(true);
}
async function arms(value: ReturnType<typeof input>) {
  const before = canonical(value), off = await runReuseTrialArm(value, seed, "off"), eligible = await runReuseTrialArm(value, seed, "eligible");
  expect(canonical(value)).toBe(before); instrumentation(off); instrumentation(eligible);
  expect(off.currentObserved).toEqual(freshValues(value, seed)); expect(eligible.currentObserved).toEqual(off.currentObserved);
  expect(eligible.currentPayloadDigests).toEqual(off.currentPayloadDigests); expect(eligible.currentMetricsSha256).toBe(off.currentMetricsSha256);
  expect(off.sourceExecuted).toEqual(eligible.sourceExecuted); expect(off.fault).toBe(eligible.fault); expect(off.injection).toBe(eligible.injection);
  return {off, eligible};
}

test("both no-source arms use the shared backend and independently execute the full fresh pipeline", async () => {
  const {off, eligible} = await arms(input(false));
  for (const result of [off, eligible]) {
    expect(result.sourcePopulation).toBe("none"); expect(result.sourceAttemptId).toBeNull(); expect(result.sourceRefs).toEqual([]);
    expect(result.sourceObserved).toBeNull(); expect(result.sourceRecordUnchanged).toBeNull(); expect(result.sourceRecordSha256).toBeNull();
    expect(result.sourceExecuted).toEqual([]); expect(result.currentExecuted).toEqual(["prepare", "transform", "evaluate", "verify"]);
    expect(result.counts).toEqual({sourceExecutedStages: 0, currentExecutedStages: 4, reusedStages: 0, currentIndependentSamples: 1});
    expect(result.hits).toEqual([]); expect(result.freshStages).toEqual(["prepare", "transform", "evaluate"]);
  }
}, 60_000);

test("source setup is identical eligible-fresh work while only the current arm switch changes admission", async () => {
  const {off, eligible} = await arms(input());
  for (const result of [off, eligible]) {
    expect(result.sourceExecuted).toEqual(["prepare", "transform", "evaluate", "verify"]);
    expect(result.sourcePopulation).toBe("fixture-rematerialized"); expect(result.sourceRecordUnchanged).toBe(true);
    expect(result.sourceRecordSha256).toMatch(/^[a-f0-9]{64}$/); expect(result.sourceRefs).toHaveLength(3);
    expect(result.sourceAttemptId).not.toBe(result.currentAttemptId); expect(result.sourceEvaluatorId).not.toBe(result.currentEvaluatorId);
    expect(result.sourceMetricsSha256).toBe(result.currentMetricsSha256); expect(result.counts.currentIndependentSamples).toBe(0);
  }
  expect(off.currentExecuted).toEqual(["prepare", "transform", "evaluate", "verify"]); expect(off.hits).toEqual([]);
  expect(off.counts.currentExecutedStages).toBe(4);
  expect(eligible.currentExecuted).toEqual(["verify"]); expect(eligible.counts.currentExecutedStages).toBe(1); expect(eligible.counts.reusedStages).toBe(3);
  expect(eligible.hits.map(row => row.source)).toEqual(eligible.sourceRefs);
  expect(eligible.currentPayloadDigests).toEqual(eligible.sourcePayloadDigests);
}, 60_000);

test("current code changes apply symmetrically and force eligible misses without mutating source evidence", async () => {
  const value = input(); value.currentContext.globalCodeDigest = sha256("independent-current-code-change");
  const {off, eligible} = await arms(value);
  for (const result of [off, eligible]) {
    expect(result.changedKeys).toEqual(["code-tree"]); expect(result.sourceRecordUnchanged).toBe(true);
    expect(result.hits).toEqual([]); expect(result.currentExecuted).toEqual(["prepare", "transform", "evaluate", "verify"]);
  }
}, 60_000);

test("current stage edits apply in both arms and verify current byte output rather than source output", async () => {
  const value = input(); value.workload.stages[1]!.offset = 9;
  const {off, eligible} = await arms(value);
  for (const result of [off, eligible]) {
    expect(result.changedKeys).toEqual(["candidate-stage-edit"]); expect(result.sourceRecordUnchanged).toBe(true);
    expect(result.currentObserved).not.toEqual(result.sourceObserved);
    expect(result.counts.currentExecutedStages + result.counts.reusedStages).toBe(4);
    expect(result.currentExecuted.at(-1)).toBe("verify");
  }
  expect(off.hits).toEqual([]);
}, 60_000);

test("both arms retain the same declared corrupt, pruned and interrupted source setup", async () => {
  for (const fault of ["corrupt", "pruned", "cancelled", "unknown"] as const) {
    const value = input(), source = value.source!;
    if (fault === "corrupt") source.artifact = {...source.artifact as Record<string, unknown>, digest: "0".repeat(64)};
    else if (fault === "pruned") source.artifact = {present: false, retention: "pruned"};
    else source.status = fault;
    const {off, eligible} = await arms(value);
    for (const result of [off, eligible]) {
      expect(result.fault).toBe(fault === "cancelled" || fault === "unknown" ? "interrupted" : fault);
      expect(result.sourceExecuted).toEqual(["prepare", "transform", "evaluate", "verify"]);
      expect(result.sourceRecordUnchanged).toBe(true); expect(result.hits).toEqual([]);
      expect(result.currentExecuted).toEqual(["prepare", "transform", "evaluate", "verify"]);
      expect(result.counts.currentIndependentSamples).toBe(0);
    }
  }
}, 120_000);

test("arm and input preflight refuse invalid controls or undeclared workload before fixture execution", async () => {
  await expect(runReuseTrialArm(input(), seed, "other" as "off")).rejects.toThrow("reuse must be off or eligible");
  await expect(runReuseTrialArm(null, seed, "off")).rejects.toThrow("input must be bounded");
  await expect(runReuseTrialArm(input(), 999, "eligible")).rejects.toThrow("seed is not declared");
  const value = input(); value.currentContext.globalCodeDigest = "../not-a-code-digest";
  await expect(runReuseTrialArm(value, seed, "off")).rejects.toThrow("current code digest");
});
