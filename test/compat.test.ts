import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { ATTEMPT_BYTES, budgetUsage } from "../src/exp/attempts.ts";
import { appendEvent, openStudy, readLedger, readTextBounded, writeAtomic, sha256, STUDY_BYTES } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
import { metricAttempt, metricProtocol } from "./metric-fixtures.ts";

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
  expect(() => budgetUsage([saved])).toThrow("budget: unsupported attempt stage kind");
  expect(budgetUsage([knownOnly]).attempts).toBe(1);
  expect(ops.attemptList(dir).totals.cancelled).toBe(1);
  expect(ops.attemptShow(dir, attempt.id)).toEqual(saved);
});

test("unsupported study, ledger and attempt semantics refuse safely without rewriting newer data", async () => {
  const dir = tempDir(), created = ops.init(dir, { question: "Synthetic future?", mode: "experiment" }, ctx);
  const studyPath = join(dir, "study.json"), originalStudy = readTextBounded(studyPath, STUDY_BYTES);
  const futureStudy = JSON.stringify({ ...created.study, v: 3, extension: true });
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
  for (const extension of [{ v: 4 }, { status: "future-status" }, { stage: "future-stage" }]) {
    const newer = JSON.stringify({ ...attempt, ...extension, opaque: true }); writeAtomic(file, newer, ATTEMPT_BYTES);
    const runner = async () => { throw new Error("unsupported records must never reach the executor"); };
    await expect(ops.attemptCancel(dir, attempt.id, undefined, { ...ctx, runner })).rejects.toThrow("use an ares version");
    expect(readTextBounded(file, ATTEMPT_BYTES)).toBe(newer);
    expect(readTextBounded(ledgerPath, 64 * 1024 * 1024)).toBe(originalLedger);
  }
});

test("newer billable stage remains readable but blocks budget-gated starts without a write or executor call", async () => {
  const dir = tempDir(); ops.init(dir, { question: "Synthetic newer accounting?", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeAtomic(join(dir, "task", "task.md"), "synthetic task", 65_536);
  await ops.protocol(dir, metricProtocol(), ctx);
  await ops.executorSet(dir, { v: 1, kind: "local", workdir: "/private/synthetic" }, ctx);
  await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  const attempt = metricAttempt(); attempt.studyId = openStudy(dir).study.id; attempt.status = "succeeded"; attempt.endedAt = "2030-01-02T00:00:00Z";
  const root = `/private/synthetic/${attempt.studyId}/${attempt.id}`;
  attempt.paths.snapshot = `${root}/snapshot`;
  const emptyLog = { path: `${root}/logs/candidate.stdout.log`, sha256: sha256(""), bytes: 0, truncated: false };
  attempt.stages.candidate!.evidence = { outputs: [], logs: { stdout: emptyLog, stderr: { ...emptyLog, path: `${root}/logs/candidate.stderr.log` } } };
  const record = { ...attempt, stages: { ...attempt.stages, futureStage: { startedAt: "2030-01-01T00:00:00Z", endedAt: "2030-01-02T00:00:00Z", limits: { gpus: 64 } } } };
  const folder = join(dir, "runs", attempt.run, "attempts"), file = join(folder, `${attempt.id}.json`), ledger = join(dir, "ledger.jsonl");
  mkdirSync(folder, { recursive: true }); writeAtomic(file, JSON.stringify(record), ATTEMPT_BYTES);
  const beforeRecord = readTextBounded(file, ATTEMPT_BYTES), beforeLedger = readTextBounded(ledger, 64 * 1024 * 1024);
  expect(ops.attemptShow(dir, attempt.id)).toEqual(record);
  expect(ops.attemptList(dir).totals.succeeded).toBe(1);
  const logs = await ops.attemptLogs(dir, attempt.id, { stage: "candidate", stream: "stdout" }, { ...ctx, runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
  expect(logs.logs[0]!.text).toBe("");
  const calls: string[] = [];
  await expect(ops.attemptRun(dir, { repo: tempDir(), commit: "a".repeat(40), detach: true }, { ...ctx, runner: async request => {
    calls.push(`${request.command} ${request.args.join(" ")}`);
    if (request.command === "git" && request.args.includes("cat-file")) return { exitCode: 0, stdout: "commit", stderr: "" };
    if (request.command === "git" && request.args.includes("rev-parse")) return { exitCode: 0, stdout: "b".repeat(40), stderr: "" };
    throw new Error("budget refusal must precede archive or executor work");
  } })).rejects.toThrow("budget: unsupported attempt stage kind");
  expect(calls.length).toBe(2);
  expect(readTextBounded(file, ATTEMPT_BYTES)).toBe(beforeRecord);
  expect(readTextBounded(ledger, 64 * 1024 * 1024)).toBe(beforeLedger);
  expect(ops.attemptList(dir).totals.succeeded).toBe(1);
});
