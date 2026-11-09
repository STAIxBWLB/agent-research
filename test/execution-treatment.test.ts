import { expect, spyOn, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { treatmentCases, validateTreatmentIntegration } from "../scripts/execution-treatment.ts";
import * as lineage from "../scripts/execution-lineage.ts";
import * as reuse from "../scripts/execution-reuse.ts";
import { FROZEN_RECEIPT, verifyPreregistration } from "../scripts/execution-eval.ts";
import { readBytesBounded, sha256 } from "../src/study.ts";
import { join } from "node:path";
import { tempDir } from "./helpers.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
test("treatment adapter inputs retain the frozen ordered denominator without exposing expected truth", () => {
  const { registration, cases } = treatmentCases(root);
  expect(cases).toHaveLength(24);
  expect(cases.filter(row => row.trial === "diagnose")).toHaveLength(12);
  expect(cases.filter(row => row.trial === "reuse")).toHaveLength(12);
  expect(cases[0]!.id).toBe("diagnose-stale-head-old-card");
  expect(cases.every(row => /^[a-f0-9]{64}$/.test(row.inputSha256) && /^[a-f0-9]{64}$/.test(row.expectedSha256))).toBe(true);
  expect(cases.every(row => !Object.hasOwn(row.payload, "expected") && !Object.hasOwn(row.payload, "eligibility") && !Object.hasOwn(row.payload, "freshExecution"))).toBe(true);
  expect(registration.receiptSha256).toBe(verifyPreregistration(root, join(root, FROZEN_RECEIPT)).receiptSha256);
});

test("integration-check binds clean code but never invokes an arm or changes frozen registration", async () => {
  const before = readBytesBounded(join(root, FROZEN_RECEIPT), 65_536);
  const diagnostic = spyOn(lineage, "diagnoseTreatment").mockImplementation(() => { throw new Error("must not execute Diagnose"); });
  const reused = spyOn(reuse, "checkReuseTreatmentFixture").mockImplementation(() => { throw new Error("must not execute Reuse"); });
  try {
    const result = await validateTreatmentIntegration(root);
    expect(result).toMatchObject({ status: "integrated-not-measured", trialExecutions: 0, treatmentObservations: 0, adoptionDecision: null, arms: {diagnose: {cases: 12}, reuse: {cases: 12}, supervision: {status: "pending", fakeShadow: false}} });
    expect(result.code.commit).toMatch(/^[a-f0-9]{40}$/); expect(result.code.codeSha256).toHaveLength(64);
    expect(diagnostic).not.toHaveBeenCalled(); expect(reused).not.toHaveBeenCalled();
    expect(sha256(readBytesBounded(join(root, FROZEN_RECEIPT), 65_536))).toBe(sha256(before));
  } finally { diagnostic.mockRestore(); reused.mockRestore(); }
});

test("check-only CLI refuses trial arguments rather than accepting a treatment launch", () => {
  for (const args of [["integration-check", "--run"], ["treatment"], ["supervision"]]) {
    const home = tempDir();
    const child = Bun.spawnSync([process.execPath, join(root, "scripts/execution-eval.ts"), ...args], {cwd: home, env: {HOME: home, PATH: "/usr/bin:/bin"}, stdout: "pipe", stderr: "pipe", timeout: 5000, maxBuffer: 65_536});
    expect(child.exitCode).not.toBe(0); expect(child.stdout.length).toBe(0);
    expect(child.stderr.toString()).toMatch(/no treatment-run|never launches treatment trials/);
  }
});
