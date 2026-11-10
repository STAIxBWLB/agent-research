import {join} from "node:path";
import {gateDecide} from "../src/commands.ts";
import {runAttempt, showAttempt, type Attempt} from "../src/exp/attempts.ts";
import {setProtocol} from "../src/exp/protocol.ts";
import {setSelection} from "../src/exp/selection.ts";
import type {RetainedRef} from "../src/exp/retention.ts";
import {attemptReuseView, compareLineage, readProvenance} from "../src/provenance.ts";
import {plain, readBytesBounded, readLedger, sha256, withLock, writeAtomic} from "../src/study.ts";
import {canonical} from "./execution-eval.ts";
import {attemptBytes, completeProducer, injectDeclaredFault, producerValues, sourceFault, sourceState, syntheticProtocol, withProducerFixture, type ReuseFault} from "./execution-reuse.ts";
import {freshValues, numericWorkload, type FreshValues} from "./execution-workload.ts";

const BYTES = 16_384;
export interface ReuseArmPhaseInstrumentation {
  wallMs: number;
  parentCpuSeconds: number;
  subprocessCpuSeconds: "unknown";
}
export interface ReuseTrialArmResult {
  v: 1; kind: "reuse-arm-fixture-instrumentation"; authority: "functional-fixture-only"; instrumentationOnly: true;
  reuse: "off" | "eligible"; seed: number; status: "succeeded";
  sourcePopulation: "fixture-rematerialized" | "none"; fault: ReuseFault; injection: string | null; changedKeys: string[];
  sourceAttemptId: string | null; currentAttemptId: string; sourceRefs: RetainedRef[];
  sourceObserved: FreshValues | null; currentObserved: FreshValues; expected: FreshValues;
  sourcePayloadDigests: string[]; currentPayloadDigests: string[];
  sourceRecordSha256: string | null; sourceRecordUnchanged: true | null;
  sourceMetricsSha256: string | null; currentMetricsSha256: string;
  sourceEvaluatorId: string | null; currentEvaluatorId: string; evaluatorFresh: true;
  sourceExecuted: string[]; currentExecuted: string[];
  hits: {stage: string; key: string; source: RetainedRef}[]; misses: {stage: string; reason: string}[]; freshStages: string[];
  counts: {sourceExecutedStages: number; currentExecutedStages: number; reusedStages: number; currentIndependentSamples: number};
  provenanceStatus: string; comparisonStatus: string; candidateEvidenceSha256: string;
  instrumentation: {
    sourceSetup: ReuseArmPhaseInstrumentation; current: ReuseArmPhaseInstrumentation; total: ReuseArmPhaseInstrumentation;
    wallClock: "performance.now-monotonic"; cpuClock: "process.cpuUsage-parent-process"; totalIncludesCleanup: true;
    sourceSetupScope: "shared-fixture-setup-and-optional-source-plus-fault";
    currentScope: "current-edits-execution-and-output-verification";
  };
  limitations: string[];
}
function fail(cause: string): never {throw new Error(`execution reuse arm: ${cause}; restore the bounded declared fixture input and shared producer backend before retrying instrumentation`);}
function phase(wall: number, cpu: NodeJS.CpuUsage): ReuseArmPhaseInstrumentation {
  const elapsed = process.cpuUsage(cpu), wallMs = performance.now() - wall;
  const parentCpuSeconds = (elapsed.user + elapsed.system) / 1_000_000;
  if (!Number.isFinite(wallMs) || wallMs < 0 || !Number.isFinite(parentCpuSeconds) || parentCpuSeconds < 0) fail("clock reading is invalid");
  return {wallMs, parentCpuSeconds, subprocessCpuSeconds: "unknown"};
}
const offlineHttp = {env: {}, json: async () => fail("network is outside this synthetic backend"), text: async () => fail("network is outside this synthetic backend")};

/** Shared-backend arm instrumentation only. It neither launches a registered trial nor writes a measurement receipt. */
export async function runReuseTrialArm(input: unknown, seed: number, reuse: "off" | "eligible"): Promise<ReuseTrialArmResult> {
  const totalWall = performance.now(), totalCpu = process.cpuUsage();
  if (reuse !== "off" && reuse !== "eligible") fail("reuse must be off or eligible");
  if (!plain(input) || Buffer.byteLength(JSON.stringify(input)) > BYTES || !plain(input.currentContext)) fail("input must be bounded and declare currentContext");
  numericWorkload(input, seed);
  const currentContext = input.currentContext, source = input.source;
  const declared = sourceState(source), hasSource = source !== null && source !== undefined;
  if (hasSource && (!plain(source) || !plain(source.workload) || typeof source.globalCodeDigest !== "string" || !/^[a-f0-9]{64}$/.test(source.globalCodeDigest))) fail("declared source needs its own workload and code digest");
  const currentCode = currentContext.globalCodeDigest, method = currentContext.method;
  if (typeof currentCode !== "string" || !/^[a-f0-9]{64}$/.test(currentCode) || typeof method !== "string" || !method.trim() || method.length > 128) fail("current code digest or method is invalid");
  const sourceInput: Record<string, unknown> = hasSource && plain(source) ? {...input, workload: source.workload, currentContext: {...currentContext, globalCodeDigest: source.globalCodeDigest}} : input;
  const result = await withProducerFixture(sourceInput, seed, hasSource ? 2 : 1, async fixture => {
    const {dir, repo, commit, fake} = fixture;
    let sourceAttempt: Attempt | undefined, sourceObserved: FreshValues | null = null;
    let sourcePayloadDigests: string[] = [], sourceRefs: RetainedRef[] = [], sourceRecord: Buffer | undefined;
    let sourceMetrics: string | undefined, sourceEvaluatorId: string | null = null, injection: string | null = null;
    const fault = hasSource ? sourceFault(declared) : "none";
    if (hasSource) {
      // Identical eligible source establishment in both arms; only current execution receives the arm switch.
      sourceAttempt = await completeProducer(fixture, await runAttempt(dir, {repo, commit, seed, run: "investigate", reuse: "eligible", detach: true}, fake.ctx));
      if (fake.executed.join(",") !== "prepare,transform,evaluate,verify" || sourceAttempt.pipeline!.completed.some(parent => parent.reuse)) fail("shared source was not freshly established");
      const values = await producerValues(fixture, sourceAttempt);
      if (canonical(values.observed) !== canonical(freshValues(sourceInput, seed))) fail("source output differs from its declared workload");
      sourceObserved = values.observed; sourcePayloadDigests = values.payloadDigests;
      sourceRefs = sourceAttempt.pipeline!.completed.map(parent => ({...parent.ref}));
      injection = await injectDeclaredFault(fixture, sourceAttempt, sourceRefs, fault, declared.sourceStatus, sourceObserved);
      sourceRecord = attemptBytes(fixture, sourceAttempt); sourceMetrics = canonical(sourceAttempt.metrics);
      sourceEvaluatorId = sourceAttempt.stages.evaluator?.containerId ?? null;
      if (!sourceEvaluatorId) fail("source evaluator receipt is missing");
    }
    const sourceExecuted = [...fake.executed], sourceSetup = phase(totalWall, totalCpu);
    const currentWall = performance.now(), currentCpu = process.cpuUsage(), changedKeys: string[] = [];
    let currentCommit = commit;
    if (hasSource && plain(source)) {
      if (currentCode !== source.globalCodeDigest) {changedKeys.push("code-tree"); currentCommit = await fixture.commitFile("global-code-digest.txt", currentCode + "\n");}
      if (canonical(input.workload) !== canonical(source.workload)) {
        changedKeys.push("candidate-stage-edit");
        writeAtomic(join(dir, "task", "evaluator", "policy.json"), JSON.stringify({workload: input.workload}) + "\n", BYTES, 0o600);
        await withLock(dir, () => {const protocol = setProtocol(dir, syntheticProtocol(numericWorkload(input, seed), method, 2), fake.ctx.actor); setSelection(dir, {v: 1, run: "investigate", metric: "score", baseline: {commit}, minSeeds: 1, minDelta: 0}, protocol, fake.ctx.actor);});
        await gateDecide(dir, "design", "approve", undefined, {actor: fake.ctx.actor, http: offlineHttp});
      }
    }
    const current = await completeProducer(fixture, await runAttempt(dir, {repo, commit: currentCommit, seed, run: "investigate", reuse, ...(sourceAttempt ? {retry: sourceAttempt.id} : {}), detach: true}, fake.ctx));
    const values = await producerValues(fixture, current), expected = freshValues(input, seed), completed = current.pipeline!.completed;
    if (canonical(values.observed) !== canonical(expected)) fail("current output differs from its declared workload");
    const hits = completed.flatMap(parent => parent.reuse ? [{stage: parent.name, key: parent.reuse.key, source: {...parent.reuse.source}}] : []);
    const freshStages = completed.filter(parent => !parent.reuse).map(parent => parent.name);
    const misses = Object.entries(current.reuse?.stages ?? {}).filter(([, value]) => value.outcome !== "reused").map(([stage, value]) => ({stage, reason: value.reason}));
    if (hits.length + freshStages.length !== 3 || reuse === "off" && hits.length || fault !== "none" && hits.length) fail("current stage decisions contradict shared-source admission");
    for (const [index, parent] of completed.entries()) if (parent.reuse && sha256(readBytesBounded(join(current.paths.output, parent.name, "value.json"), BYTES)) !== sourcePayloadDigests[index]) fail("reused materialization differs from source bytes");
    const currentEvaluatorId = current.stages.evaluator?.containerId;
    if (!currentEvaluatorId || currentEvaluatorId === sourceEvaluatorId) fail("current evaluator is not fresh");
    if (sourceAttempt) {
      const after = showAttempt(dir, sourceAttempt.id);
      if (!sourceRecord!.equals(attemptBytes(fixture, after)) || canonical(after.metrics) !== sourceMetrics) fail("current arm changed original source record or metrics");
    }
    const view = attemptReuseView(current, readLedger(dir));
    if (!view || view.executedStages !== freshStages.length + 1 || view.reusedCandidateStages !== hits.length) fail("current stage accounting is inconsistent");
    const currentExecuted = fake.executed.slice(sourceExecuted.length), page = readProvenance(dir), comparison = compareLineage(dir, {attempts: [current.id]});
    const evidence = {reuse, seed, fault, changedKeys, sourceAttemptId: sourceAttempt?.id ?? null, currentAttemptId: current.id, sourceRefs, hits, misses, freshStages,
      sourceObserved, currentObserved: values.observed, expected, sourcePayloadDigests, currentPayloadDigests: values.payloadDigests,
      sourceRecordSha256: sourceRecord ? sha256(sourceRecord) : null, sourceMetricsSha256: sourceMetrics ? sha256(sourceMetrics) : null,
      currentMetricsSha256: sha256(canonical(current.metrics)), sourceEvaluatorId, currentEvaluatorId,
      counts: {sourceExecutedStages: sourceExecuted.length, currentExecutedStages: view.executedStages, reusedStages: hits.length, currentIndependentSamples: view.independentSamples}};
    return {...evidence, injection, sourceRecordUnchanged: sourceAttempt ? true as const : null, sourceExecuted, currentExecuted,
      sourcePopulation: hasSource ? "fixture-rematerialized" as const : "none" as const,
      candidateEvidenceSha256: sha256(canonical(evidence)), provenanceStatus: page.status, comparisonStatus: comparison.status,
      sourceSetup, current: phase(currentWall, currentCpu)};
  });
  // withProducerFixture's finally has now completed; total includes unlocking and deleting private fixture storage.
  const total = phase(totalWall, totalCpu), {sourceSetup, current, ...evidence} = result;
  return {v: 1, kind: "reuse-arm-fixture-instrumentation", authority: "functional-fixture-only", instrumentationOnly: true, status: "succeeded", ...evidence,
    instrumentation: {sourceSetup, current, total, wallClock: "performance.now-monotonic", cpuClock: "process.cpuUsage-parent-process", totalIncludesCleanup: true,
      sourceSetupScope: "shared-fixture-setup-and-optional-source-plus-fault", currentScope: "current-edits-execution-and-output-verification"},
    limitations: ["test instrumentation only; no registered treatment trial, benchmark result, native container proof or adoption decision",
      "Docker/container transport is fake; Git/tar/Python and producer APIs are real private fixture operations",
      "parent process CPU excludes subprocess CPU and can include concurrent work; subprocess CPU remains unknown",
      "source setup and current execution use identical backend and fault helpers in both arms; total includes fixture cleanup"]};
}
