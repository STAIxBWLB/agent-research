import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkReuseTreatmentFixture, checkProducerReuseUnitFixture } from "../scripts/execution-reuse.ts";
import { freshValues } from "../scripts/execution-workload.ts";
import { COST_FIELDS } from "../scripts/execution-eval.ts";
import { readTextBounded, sha256 } from "../src/study.ts";

const fixtureRoot = resolve(import.meta.dir, "fixtures", "execution-eval");
const inputs = readdirSync(fixtureRoot).filter(name => name.startsWith("reuse-") && name.endsWith(".input.json")).sort();
test("all frozen reuse cases remain conservative fresh checks without invented source establishment", async () => {
  expect(inputs).toHaveLength(12);
  for (const name of inputs) {
    const file = join(fixtureRoot, name), before = readTextBounded(file, 16_384), candidate = JSON.parse(before), expected = JSON.parse(readTextBounded(join(fixtureRoot, name.replace(".input.json", ".expected.json")), 16_384));
    const seed = candidate.input.workload.seeds[0] as number;
    const result = await checkReuseTreatmentFixture(candidate.input, seed);
    expect(result.kind).toBe("reuse-fixture-integration-check"); expect(result.authority).toBe("functional-fixture-only");
    expect(result.sourcePopulation).toBe("none"); expect(result.reusedStages).toEqual([]); expect(result.sourceRefs).toEqual([]);
    expect(result.freshStages).toEqual(["prepare", "transform", "evaluate"]); expect(result.evaluatorFresh).toBe(true);
    expect(result.observed).toEqual(expected.freshExecution.outputs.find((row: { seed: number }) => row.seed === seed));
    expect(result.observed).toEqual(freshValues(candidate.input, seed));
    expect(result.sourceEstablishment).toBe((candidate.input.source === null || candidate.input.source === undefined) ? "no-frozen-source" : "unavailable-opaque-frozen-artifact");
    expect(result.producerMisses).toHaveLength(3); expect(result.producerMisses.every(row => row.reason !== "verified-hit")).toBe(true);
    expect(result.chain.attemptId).toMatch(/^[a-f0-9]{16}$/); expect(result.chain.retainedManifestDigests).toHaveLength(3); expect(result.chain.artifactDigests).toHaveLength(4);
    expect(result.chain.provenanceStatus).toBe("ok"); expect(result.chain.comparisonStatus).toBe("ok");
    expect(result.chain.evidenceCandidate).toBe("unreviewed-functional-fixture");
    expect(result.candidateEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(result.costs).sort()).toEqual([...COST_FIELDS].sort()); expect(Object.values(result.costs).every(value => value === "unknown")).toBe(true);
    expect(sha256(readTextBounded(file, 16_384))).toBe(sha256(before));
  }
}, 60_000);

test("reuse functional checks refuse malformed/unbounded input and undeclared seeds before creating producer state", async () => {
  const first = JSON.parse(readTextBounded(join(fixtureRoot, inputs[0]!), 16_384)).input;
  await expect(checkReuseTreatmentFixture(null, 1)).rejects.toThrow("bounded frozen input");
  await expect(checkReuseTreatmentFixture({ ...first, padding: "x".repeat(16_384) }, first.workload.seeds[0])).rejects.toThrow("exceeds bound");
  await expect(checkReuseTreatmentFixture(first, 999_999)).rejects.toThrow("seed is not declared");
  await expect(checkReuseTreatmentFixture({ ...first, currentContext: { ...first.currentContext, globalCodeDigest: "../outside" } }, first.workload.seeds[0])).rejects.toThrow("current context");
});


test("separate non-frozen producer unit exercises actual reuse hits through the treatment adapter backend", async () => {
  const result = await checkProducerReuseUnitFixture();
  expect(result.sourcePopulation).toBe("separate-unit-fixture"); expect(result.frozenCorpus).toBe(false);
  expect(result.authority).toBe("functional-fixture-only"); expect(result.kind).toBe("producer-reuse-unit-check");
  expect(result.sourceAttemptId).not.toBe(result.currentAttemptId);
  expect(result.sourceRefs).toHaveLength(3); expect(result.reusedRefs).toEqual(result.sourceRefs);
  expect(result.sourceRefs.every(ref => ref.attemptId === result.sourceAttemptId)).toBe(true);
  expect(result.sourceObserved).toEqual({ seed: 5, prepare: 11, transform: 51, evaluate: 2611 });
  expect(result.currentObserved).toEqual(result.sourceObserved);
  expect(result.currentPayloadDigests).toEqual(result.sourcePayloadDigests);
  expect(result.sourceRecordUnchanged).toBe(true); expect(result.sourceRecordSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.sourceMetricsSha256).toBe(result.currentMetricsSha256);
  expect(result.sourceEvaluatorId).not.toBe(result.currentEvaluatorId); expect(result.evaluatorFresh).toBe(true);
  expect(result.pinsHeldBeforeEvaluation).toBe(true); expect(result.pinsReleased).toBe(true);
  expect(result.executed).toEqual(["prepare", "transform", "evaluate", "verify", "verify"]);
  expect(result.counts).toEqual({ sourceExecutedStages: 4, currentExecutedStages: 1, reusedStages: 3, currentIndependentSamples: 0 });
  expect(Object.values(result.costs).every(value => value === "unknown")).toBe(true);
  expect(result.candidateEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
}, 20_000);
