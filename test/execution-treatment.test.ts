import { expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { treatmentCases, validateTreatmentIntegration } from "../scripts/execution-treatment.ts";
import * as lineage from "../scripts/execution-lineage.ts";
import * as reuse from "../scripts/execution-reuse.ts";
import * as supervision from "../scripts/execution-supervision.ts";
import * as records from "../scripts/execution-supervision-records.ts";
import { FROZEN_RECEIPT, verifyPreregistration } from "../scripts/execution-eval.ts";
import { readBytesBounded, readJsonFile, plain, sha256 } from "../src/study.ts";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
test("treatment adapter inputs retain the frozen ordered denominator without exposing expected truth", () => {
  const { registration, cases } = treatmentCases(root);
  expect(cases).toHaveLength(36);
  expect(cases.filter(row => row.trial === "diagnose")).toHaveLength(12);
  expect(cases.filter(row => row.trial === "reuse")).toHaveLength(12);
  expect(cases.filter(row => row.trial === "supervision")).toHaveLength(12);
  expect(treatmentCases(root).supervisionCases).toBe(12);
  expect(cases[0]!.id).toBe("diagnose-stale-head-old-card");
  expect(cases.every(row => /^[a-f0-9]{64}$/.test(row.inputSha256) && /^[a-f0-9]{64}$/.test(row.expectedSha256))).toBe(true);
  expect(cases.every(row => !Object.hasOwn(row.payload, "expected") && !Object.hasOwn(row.payload, "eligibility") && !Object.hasOwn(row.payload, "freshExecution"))).toBe(true);
  expect(registration.receiptSha256).toBe(verifyPreregistration(root, join(root, FROZEN_RECEIPT)).receiptSha256);
});

function immutableSources() {
  const registration = verifyPreregistration(root, join(root, FROZEN_RECEIPT));
  const sealed = [...registration.methodFiles, ...registration.inputFiles, ...registration.expectedFiles].map(file => [file.path, file.sha256, file.bytes]);
  const baseline = "docs/verification/execution-eval-baseline/baseline-3f8f373", manifestPath = join(root, baseline, "manifest.json"), manifestBytes = readBytesBounded(manifestPath, 1024 * 1024);
  const manifest: unknown = readJsonFile(manifestPath, 1024 * 1024);
  if (!plain(manifest) || !Array.isArray(manifest.files) || manifest.files.length > 64) throw new Error("bounded synthetic baseline manifest required");
  let total = 0;
  const baselineHashes = manifest.files.map(file => {
    if (!plain(file) || typeof file.path !== "string" || !/^[a-z0-9-]+\.json$/.test(file.path) || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 || (file.bytes as number) > 256 * 1024) throw new Error("bounded synthetic baseline file required");
    total += file.bytes as number; if (total > 2 * 1024 * 1024) throw new Error("baseline preservation hash snapshot exceeds 2 MiB");
    // Hash only: never parse baseline observations or treat them as T3 controls.
    const bytes = readBytesBounded(join(root, baseline, file.path), file.bytes as number), digest = sha256(bytes);
    expect(bytes.length).toBe(file.bytes as number); expect(digest).toBe(file.sha256);
    return [file.path, digest];
  });
  return { seal: sha256(readBytesBounded(join(root, FROZEN_RECEIPT), 65_536)), sealed, baselineManifest: sha256(manifestBytes), baselineHashes };
}

test("integration-check binds clean code but never invokes an arm or changes frozen registration", async () => {
  const before = immutableSources();
  const diagnostic = spyOn(lineage, "diagnoseTreatment").mockImplementation(() => { throw new Error("must not execute Diagnose"); });
  const reused = spyOn(reuse, "checkReuseTreatmentFixture").mockImplementation(() => { throw new Error("must not execute Reuse"); });
  const reader = spyOn(records, "readShadowSnapshot").mockImplementation(() => { throw new Error("must not score or read producer unit records here"); });
  const scorer = spyOn(supervision, "scoreSupervisionRecords").mockImplementation(() => { throw new Error("must not score supervision truth here"); });
  const classify = spyOn(supervision, "classifySupervisionFixture");
  try {
    const result = await validateTreatmentIntegration(root);
    expect(result).toMatchObject({ status: "integrated-not-measured", trialExecutions: 0, treatmentObservations: 0, adoptionDecision: null, arms: {diagnose: {cases: 12}, reuse: {cases: 12}, supervision: {status: "integrated-record-reader", dependency: "agent-hub#1221", producerCommit: "bc6f46b077dd3a255debaee8152fa17f1f13b79c", cases: 12, fakeShadow: false, helpful: null, false: null, missed: null, personDecisions: 0, coverage: { covered: 0, unsupported: 12 }}} });
    expect(result.code.commit).toMatch(/^[a-f0-9]{40}$/); expect(result.code.codeSha256).toHaveLength(64);
    expect(diagnostic).not.toHaveBeenCalled(); expect(reused).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled(); expect(scorer).not.toHaveBeenCalled();
    const rows = treatmentCases(root).cases.filter(row => row.trial === "supervision");
    expect(classify).toHaveBeenCalledTimes(12);
    expect(classify.mock.calls.map(call => call[0])).toEqual(rows.map(row => row.payload));
    expect(result.arms.supervision.coverage.rows).toEqual(rows.map(row => ({ id: row.id, inputSha256: row.inputSha256, expectedSha256: row.expectedSha256, state: "unsupported", reason: "task-state-not-admitted-rule-facts" })));
    expect(immutableSources()).toEqual(before);
  } finally { diagnostic.mockRestore(); reused.mockRestore(); reader.mockRestore(); scorer.mockRestore(); classify.mockRestore(); }
});

test("check-only CLI refuses trial arguments rather than accepting a treatment launch", () => {
  for (const args of [["integration-check", "--run"], ["treatment"], ["supervision"]]) {
    const home = tempDir();
    const child = Bun.spawnSync([process.execPath, join(root, "scripts/execution-eval.ts"), ...args], {cwd: home, env: {HOME: home, PATH: "/usr/bin:/bin"}, stdout: "pipe", stderr: "pipe", timeout: 5000, maxBuffer: 65_536});
    expect(child.exitCode).not.toBe(0); expect(child.stdout.length).toBe(0);
    expect(child.stderr.toString()).toMatch(/no treatment-run|never launches treatment trials/);
  }
});
