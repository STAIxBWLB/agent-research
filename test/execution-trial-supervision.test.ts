import {expect, spyOn, test} from "bun:test";
import {canonical} from "../scripts/execution-eval.ts";
import {SUPERVISION_PRODUCER_COMMIT} from "../scripts/execution-supervision.ts";
import type {SupervisionAmendmentCase} from "../scripts/execution-supervision-amendment.ts";
import {scoreSupervisionGeneratedRecords, supervisionSlots, type SupervisionTrialBindings, type SupervisionGeneration} from "../scripts/execution-trial-supervision.ts";
import type {ShadowSnapshot} from "../scripts/execution-supervision-records.ts";
import {sha256, writeAtomic} from "../src/study.ts";
import {join, resolve} from "node:path";
import * as codeSource from "../scripts/execution-code-binding.ts";
import * as registration from "../scripts/execution-eval.ts";
import * as amendment from "../scripts/execution-supervision-amendment.ts";
import * as r2 from "../scripts/execution-reuse-rematerialize-r2.ts";
import {scoreSupervisionTrial} from "../scripts/execution-trial-supervision.ts";
import {tempDir} from "./helpers.ts";

// Unit wrappers only: no sealed corpus access, producer, process, network, model, generator or trial execution.
function unit() {
  const cases: SupervisionAmendmentCase[] = Array.from({length: 12}, (_, index) => {
    const task = 900 + index, id = `synthetic-case-${index}`, trigger = index % 2 === 0;
    const payload = {request: "Synthetic format-only input.", facts: {tasks: [{id: task, state: "in_progress" as const, history: [{at: 1, event: "accepted"}]}]}};
    return {id, scenario: trigger ? "true-trigger" : "ordinary-progress", inputSha256: sha256(canonical(payload)), expectedSha256: "b".repeat(64), payload,
      expected: {v: 1, id, trial: "supervision", scenario: trigger ? "true-trigger" : "ordinary-progress", trigger, task, nextAction: trigger ? "escalate" : "none", reason: "synthetic-unit-intent", mustNot: ["execute"]}};
  });
  const codeFiles = [{path: "scripts/synthetic-unit.ts", sha256: "a".repeat(64), bytes: 12}];
  const code = {commit: "c".repeat(40), tree: "d".repeat(40), codeSha256: sha256(JSON.stringify(codeFiles)), files: codeFiles};
  const environment = {os: "linux", osRelease: "unit", arch: "x64", bun: "1.4.2", logicalCpus: 2, cpuLimit: 2, memoryLimitBytes: 256 * 1024 * 1024, pidsLimit: 32, cpuModelsSha256: "e".repeat(64), containerIdentitySha256: "f".repeat(64), imageDigest: `sha256:${"a".repeat(64)}`, sequentialChildren: 1};
  const bindings: SupervisionTrialBindings = {codeCommit: code.commit, codeTree: code.tree, codeSha256: code.codeSha256, v1ReceiptSha256: "1".repeat(64), v2ReceiptSha256: "2".repeat(64), reuseR2ReceiptSha256: "3".repeat(64), inputSha256: "4".repeat(64), methodSha256: "5".repeat(64), producerCommit: SUPERVISION_PRODUCER_COMMIT, producerModuleSha256: "6".repeat(64), generatorSha256: "7".repeat(64), imageDigest: environment.imageDigest, environmentSha256: sha256(canonical(environment))};
  const envelopes = supervisionSlots().map(slot => {
    const c = cases[slot.caseIndex]!, task = c.expected.task;
    const snapshot: ShadowSnapshot = {observations: [], gap: [], evaluated: (["repeated_failure", "deliverable_invalidated_check", "declared_overlap_without_integration"] as const).map(rule => ({rule, task, revision: "1:none"})), counts: {evaluations: 1, observations: 0, deduped: 0, suppressed: 0, gap: 0, evaluatedSuppressed: 0, workerTurns: 0, actionWrites: 0, notifications: 0}};
    return {v: 1, slot, caseId: c.id, inputSha256: c.inputSha256, status: "succeeded" as "succeeded" | "failed" | "unknown", snapshot: snapshot as ShadowSnapshot | null, failure: null as null | "producer-failed" | "producer-unknown" | "case-budget" | "budget-stopped", costs: {wallMs: 1, cpuSeconds: 0.001, memoryRssBytes: 1024} as {wallMs: number; cpuSeconds: number; memoryRssBytes: number} | null};
  });
  const generation: SupervisionGeneration = {wallMs: 250, cpuSeconds: 0.2, containerCpuSeconds: 0.5, containerCpuScope: "admitted-container-cgroup", cpuScope: "generator-parent-process-only", slotCpuScope: "slot-child-process", observeCallsScope: "confirmed-child-receipts", observeCallsUnknown: false, subprocessCpuSeconds: "unknown", observeCalls: 144, freshShadowPerSlot: true, coldInput: "reread-private-bytes", warmInput: "retained-input-bytes-only", coldness: "not-os-or-jit"};
  function batch() {
    const files = envelopes.map((row, index) => ({file: `slot-${String(index).padStart(3, "0")}.json`, text: JSON.stringify(row)}));
    const manifest = {v: 1, kind: "supervision-shadow-generated-records", code, environment, bindings, generation, slots: files.map(file => ({file: file.file, sha256: sha256(file.text)}))};
    return {files, manifest};
  }
  function score() {const b = batch(); return scoreSupervisionGeneratedRecords(b.manifest, b.files, cases, bindings);}
  return {cases, code, environment, bindings, envelopes, generation, batch, score};
}

test("the fixed shadow schedule has twelve cases, all six ABC permutations and cold/warm slots", () => {
  const slots = supervisionSlots(); expect(slots).toHaveLength(144);
  expect(new Set(slots.map(slot => canonical(slot))).size).toBe(144);
  for (let index = 0; index < 12; index++) {
    const rows = slots.filter(slot => slot.caseIndex === index); expect(rows).toHaveLength(12);
    expect(rows.filter(slot => slot.condition === "cold")).toHaveLength(6); expect(rows.filter(slot => slot.condition === "warm")).toHaveLength(6);
    expect(rows.filter(slot => slot.condition === "cold").map(slot => slot.permutation.join(""))).toEqual(["ABC", "ACB", "BAC", "BCA", "CAB", "CBA"]);
    expect(rows.every(slot => slot.permutation[slot.shadowIndex] === "B")).toBe(true);
  }
});

test("source-covered unit records retain full denominators and keep A/C explicitly not executed", () => {
  const fixture = unit(), report = fixture.score();
  expect(report.summary.total).toMatchObject({full: 144, succeeded: 144, failed: 0, unknown: 0, helpful: 0, missed: 72, correctNonTriggers: 72, insufficient: 0});
  expect(report.summary.byCondition.cold.full).toBe(72); expect(report.summary.byCondition.warm.full).toBe(72);
  expect(report.summary.byCase.every(row => row.totals.full === 12)).toBe(true);
  expect(report.arms.A).toEqual({planned: 144, executed: 0, notExecuted: 144, reason: "no-adapter-current-hub-no-outputs"});
  expect(report.arms.C).toEqual({planned: 144, executed: 0, notExecuted: 144, reason: "unauthorized"});
  expect(report.arms.B.executed).toBe(144); expect(report.costs.total).toBe("unknown"); expect(report.costs.sourceGeneration).toEqual(fixture.generation);
  expect(report.E1).toMatchObject({disposition: "retain-shadow", adoption: "insufficient"});
  expect([report.personDecisions, report.workerTurns, report.actionWrites, report.notifications]).toEqual([0, 0, 0, 0]);
});

test("observed helpful proposals and extra wrong actions are scored without creating adoption evidence", () => {
  const fixture = unit();
  for (const row of fixture.envelopes.filter(row => row.slot.caseIndex === 0)) {
    const snapshot = row.snapshot!, task = fixture.cases[0]!.expected.task;
    snapshot.observations = [
      {rule: "repeated_failure", version: 1, task, revision: "1:none", trigger: "failures:check:independent", refs: ["history:1", "history:2"], limits: {records: 3, truncated: false}, action: "escalate", reason: "repeated_failure"},
      {rule: "deliverable_invalidated_check", version: 1, task, revision: "1:none", trigger: "check:d-0123456789ab", refs: ["history:2", "deliverable:d-0123456789ab"], limits: {records: 3, truncated: false}, action: "recheck", reason: "stale_check"},
    ]; snapshot.counts.observations = 2;
  }
  const report = fixture.score();
  expect(report.summary.total).toMatchObject({helpful: 12, wrongAction: 12, falseProposalBudget: 12, missed: 60, correctNonTriggers: 72});
  expect(report.E1.adoption).toBe("insufficient"); expect(report.costs.trialBudgetExceeded).toBe(false);
});

test("failed and unknown slots remain in full-N and cannot be silently removed", () => {
  const fixture = unit();
  fixture.envelopes[0] = {...fixture.envelopes[0]!, status: "failed", snapshot: null, failure: "producer-failed"};
  fixture.envelopes[143] = {...fixture.envelopes[143]!, status: "unknown", snapshot: null, failure: "producer-unknown", costs: null};
  fixture.generation.observeCalls = 142; fixture.generation.observeCallsUnknown = true;
  const report = fixture.score();
  expect(report.summary.total).toMatchObject({full: 144, succeeded: 142, failed: 1, unknown: 1, insufficient: 2});
  expect(report.slots[0]?.score).toBeNull(); expect(report.slots[143]?.score).toBeNull();
  const {manifest, files} = fixture.batch();
  expect(() => scoreSupervisionGeneratedRecords(manifest, files.slice(1), fixture.cases, fixture.bindings)).toThrow("missing or duplicated");
  expect(() => scoreSupervisionGeneratedRecords(manifest, [...files.slice(1), files[1]!], fixture.cases, fixture.bindings)).toThrow("missing or duplicated");
});

test("over-budget cases retain failure and the unexecuted suffix keeps unknown costs", () => {
  const fixture = unit();
  fixture.envelopes[3] = {...fixture.envelopes[3]!, status: "failed", snapshot: null, failure: "case-budget", costs: {wallMs: 60_001, cpuSeconds: 1, memoryRssBytes: 1024}};
  for (let index = 4; index < 144; index++) fixture.envelopes[index] = {...fixture.envelopes[index]!, status: "unknown", snapshot: null, failure: "budget-stopped", costs: null};
  fixture.generation.observeCalls = 3;
  const report = fixture.score();
  expect(report.summary.total).toMatchObject({full: 144, succeeded: 3, failed: 1, unknown: 140, insufficient: 141});
  expect(report.slots.at(-1)?.costs).toBeNull(); expect(report.arms.B.executed).toBe(3);
  fixture.envelopes[143] = {...fixture.envelopes[143]!, status: "succeeded", snapshot: fixture.envelopes[0]!.snapshot, failure: null, costs: {wallMs: 1, cpuSeconds: 0.001, memoryRssBytes: 1024}};
  expect(() => fixture.score()).toThrow();
});

test("identity, input hash, source bindings, closed fields and byte budgets refuse inconsistent wrappers", () => {
  for (const change of [
    (f: ReturnType<typeof unit>) => {f.envelopes[0]!.slot.shadowIndex = 2;},
    (f: ReturnType<typeof unit>) => {f.envelopes[0]!.inputSha256 = "0".repeat(64);},
    (f: ReturnType<typeof unit>) => {f.envelopes[0]!.caseId = f.cases[1]!.id;},
    (f: ReturnType<typeof unit>) => {f.envelopes[0]!.costs!.cpuSeconds = 61;},
    (f: ReturnType<typeof unit>) => {f.environment.cpuLimit = 3;},
    (f: ReturnType<typeof unit>) => {f.code.files[0]!.bytes = 13;},
  ]) {const fixture = unit(); change(fixture); expect(() => fixture.score()).toThrow("execution supervision trial:");}
  const fixture = unit(), b = fixture.batch();
  expect(() => scoreSupervisionGeneratedRecords({...b.manifest, unexpected: true}, b.files, fixture.cases, fixture.bindings)).toThrow("unknown");
  expect(() => scoreSupervisionGeneratedRecords(b.manifest, [{...b.files[0]!, text: b.files[0]!.text + " "}, ...b.files.slice(1)], fixture.cases, fixture.bindings)).toThrow("changed");
  const huge = {...b.files[0]!, text: " ".repeat(65_537)}, manifest = {...b.manifest, slots: [{file: huge.file, sha256: sha256(huge.text)}, ...b.manifest.slots.slice(1)]};
  expect(() => scoreSupervisionGeneratedRecords(manifest, [huge, ...b.files.slice(1)], fixture.cases, fixture.bindings)).toThrow("64 KiB");
});

test("historical source binding is delegated to the committed-history verifier rather than equated with today's HEAD", () => {
  const fixture = unit(), batch = fixture.batch(), dir = tempDir();
  // Private unit wrappers only. No producer or real source history is constructed/executed in this test.
  writeAtomic(join(dir, "manifest.json"), JSON.stringify(batch.manifest), 65_536);
  for (const file of batch.files) writeAtomic(join(dir, file.file), file.text, 65_536);
  const currentCode = {...fixture.code, commit: "e".repeat(40), tree: "f".repeat(40)};
  const captured = spyOn(codeSource, "bindRunCode").mockReturnValue(currentCode);
  const history = spyOn(codeSource, "verifyRunCodeCommit").mockImplementation((_root, binding) => {expect(binding).toEqual(fixture.code);});
  const v1Receipt = {receiptSha256: fixture.bindings.v1ReceiptSha256} as unknown as ReturnType<typeof registration.verifyPreregistration>;
  const v2Receipt = {receiptSha256: fixture.bindings.v2ReceiptSha256, bindings: {inputSha256: fixture.bindings.inputSha256, methodSha256: fixture.bindings.methodSha256}} as unknown as ReturnType<typeof amendment.verifySupervisionAmendment>;
  const r2Receipt = {receiptSha256: fixture.bindings.reuseR2ReceiptSha256} as unknown as Extract<ReturnType<typeof r2.verifyReuseRematerializationR2>, {state: "verified"}>["receipt"];
  const v1 = spyOn(registration, "verifyPreregistration").mockReturnValue(v1Receipt);
  const v2 = spyOn(amendment, "verifySupervisionAmendment").mockReturnValue(v2Receipt);
  const reuse = spyOn(r2, "verifyReuseRematerializationR2").mockReturnValue({state: "verified", receipt: r2Receipt});
  const loaded = spyOn(amendment, "loadSupervisionAmendmentCases").mockReturnValue({receipt: v2Receipt, cases: fixture.cases});
  try {
    const result = scoreSupervisionTrial(resolve(import.meta.dir, ".."), dir);
    expect(result.bindings.codeCommit).toBe(fixture.code.commit); expect(result.bindings.codeCommit).not.toBe(currentCode.commit);
    expect(history).toHaveBeenCalledTimes(2); expect(captured).toHaveBeenCalledTimes(2);
    expect(v1).toHaveBeenCalledTimes(2); expect(v2).toHaveBeenCalledTimes(2); expect(reuse).toHaveBeenCalledTimes(2);
    history.mockImplementation(() => {throw new Error("synthetic ancestry rejection");});
    expect(() => scoreSupervisionTrial(resolve(import.meta.dir, ".."), dir)).toThrow("ancestry rejection");
  } finally {loaded.mockRestore(); reuse.mockRestore(); v2.mockRestore(); v1.mockRestore(); history.mockRestore(); captured.mockRestore();}
});

test("the cgroup CPU budget counter stays separate from parent and child process costs", () => {
  const fixture = unit(); fixture.generation.containerCpuSeconds = 7201;
  const report = fixture.score();
  expect(report.costs.trialBudgetExceeded).toBe(true);
  expect(report.costs.sourceGeneration.containerCpuScope).toBe("admitted-container-cgroup");
  expect(report.costs.sourceGeneration.containerCpuSeconds).toBe(7201);
  expect(report.costs.sourceGeneration.cpuSeconds).toBe(0.2);
  expect(report.slots[0]?.costs?.cpuSeconds).toBe(0.001);
  expect(report.costs.total).toBe("unknown"); expect(report.costs.sourceGeneration.subprocessCpuSeconds).toBe("unknown");
  for (const invalid of [-1, Number.POSITIVE_INFINITY]) {
    fixture.generation.containerCpuSeconds = invalid;
    expect(() => fixture.score()).toThrow("generation clock is invalid");
  }
});


test("successful snapshots cannot bypass per-case wall/CPU/RSS budgets with null costs", () => {
  const fixture = unit(); fixture.envelopes[0]!.costs = null;
  expect(() => fixture.score()).toThrow("observed within-budget wall/CPU/RSS costs");
});


test("a coherently rehashed foreign Bun version cannot replace frozen runtime admission", () => {
  const fixture = unit(); fixture.environment.bun = "1.4.3";
  fixture.bindings.environmentSha256 = sha256(canonical(fixture.environment));
  expect(() => fixture.score()).toThrow("frozen 1.4.2 admission");
});
