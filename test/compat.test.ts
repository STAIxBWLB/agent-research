import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { ATTEMPT_BYTES, budgetUsage } from "../src/exp/attempts.ts";
import { appendEvent, openStudy, readLedger, readTextBounded, writeAtomic, STUDY_BYTES } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
import { metricAttempt } from "./metric-fixtures.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
test("older study and ledger readers retain additive fields and unknown event kinds across an append", async () => {
  const dir = tempDir(), created = ops.init(dir, { question: "Synthetic newer writer?" }, ctx);
  const study = { ...created.study, future: { owner: "synthetic", options: [1, 2] } };
  writeAtomic(join(dir, "study.json"), JSON.stringify(study) + "\n", STUDY_BYTES);
  const future = { v: 1, at: "2030-01-01T00:00:00Z", actor: { kind: "future-agent", extension: true }, type: "future.evidence", data: { opaque: ["synthetic"] }, extension: { enabled: true } };
  const oldLedger = readTextBounded(join(dir, "ledger.jsonl"), 64 * 1024 * 1024) + JSON.stringify(future) + "\n";
  writeAtomic(join(dir, "ledger.jsonl"), oldLedger, 64 * 1024 * 1024);
  expect(openStudy(dir).study).toEqual(study);
  expect(readLedger(dir).at(-1) as unknown).toEqual(future);
  expect(ops.status(dir).events).toBe(2);
  appendEvent(dir, actor, "compat.checked", {});
  expect(readTextBounded(join(dir, "ledger.jsonl"), 64 * 1024 * 1024).startsWith(oldLedger)).toBe(true);
  expect(readLedger(dir)[1] as unknown).toEqual(future);
  expect(JSON.parse(readTextBounded(join(dir, "study.json"), STUDY_BYTES))).toEqual(study);
});

test("older attempt reader preserves newer additive fields during a real cancellation transition", async () => {
  const dir = tempDir(); ops.init(dir, { question: "Synthetic attempt?", mode: "experiment" }, ctx);
  const attempt = metricAttempt(), record = { ...attempt, extension: { version: 2, opaque: ["synthetic"] }, stages: { ...attempt.stages, futureStage: { opaque: true }, evaluator: { ...attempt.stages.evaluator!, future: [1, 2] } } };
  const folder = join(dir, "runs", attempt.run, "attempts"), file = join(folder, `${attempt.id}.json`);
  mkdirSync(folder, { recursive: true }); writeAtomic(file, JSON.stringify(record), ATTEMPT_BYTES);
  expect(ops.attemptShow(dir, attempt.id)).toEqual(record);
  const result = await ops.attemptCancel(dir, attempt.id, "synthetic stop", { ...ctx, runner: async request => ({ exitCode: request.args[0] === "inspect" ? 1 : 0, stdout: "", stderr: "" }) });
  expect(result.status).toBe("cancelled");
  const saved = JSON.parse(readTextBounded(file, ATTEMPT_BYTES));
  expect(saved.extension).toEqual(record.extension); expect(saved.stages.futureStage).toEqual(record.stages.futureStage); expect(saved.stages.evaluator.future).toEqual([1, 2]);
  const knownOnly = { ...saved, stages: { candidate: saved.stages.candidate, evaluator: saved.stages.evaluator } };
  expect(budgetUsage([saved])).toEqual(budgetUsage([knownOnly]));
  expect(budgetUsage([saved]).attempts).toBe(1);
});

test("unsupported study, ledger and attempt semantics refuse safely without rewriting newer data", async () => {
  const dir = tempDir(), created = ops.init(dir, { question: "Synthetic future?", mode: "experiment" }, ctx);
  const studyPath = join(dir, "study.json"), originalStudy = readTextBounded(studyPath, STUDY_BYTES);
  const futureStudy = JSON.stringify({ ...created.study, v: 2, extension: true });
  writeAtomic(studyPath, futureStudy, STUDY_BYTES);
  expect(() => ops.status(dir)).toThrow("use an ares version");
  expect(readTextBounded(studyPath, STUDY_BYTES)).toBe(futureStudy);
  writeAtomic(studyPath, originalStudy, STUDY_BYTES);
  const ledgerPath = join(dir, "ledger.jsonl"), originalLedger = readTextBounded(ledgerPath, 64 * 1024 * 1024);
  const newerLedger = originalLedger + JSON.stringify({ v: 2, type: "gate.approve", data: {}, actor: {} }) + "\n";
  writeAtomic(ledgerPath, newerLedger, 64 * 1024 * 1024);
  await expect(ops.gateDecide(dir, "scope", "approve", undefined, ctx)).rejects.toThrow("use an ares version");
  expect(readTextBounded(ledgerPath, 64 * 1024 * 1024)).toBe(newerLedger);
  writeAtomic(ledgerPath, originalLedger, 64 * 1024 * 1024);
  const attempt = metricAttempt(), folder = join(dir, "runs", attempt.run, "attempts"), file = join(folder, `${attempt.id}.json`);
  mkdirSync(folder, { recursive: true });
  for (const extension of [{ v: 2 }, { status: "future-status" }, { stage: "future-stage" }]) {
    const newer = JSON.stringify({ ...attempt, ...extension, opaque: true }); writeAtomic(file, newer, ATTEMPT_BYTES);
    const runner = async () => { throw new Error("unsupported records must never reach the executor"); };
    await expect(ops.attemptCancel(dir, attempt.id, undefined, { ...ctx, runner })).rejects.toThrow("use an ares version");
    expect(readTextBounded(file, ATTEMPT_BYTES)).toBe(newer);
    expect(readTextBounded(ledgerPath, 64 * 1024 * 1024)).toBe(originalLedger);
  }
});
