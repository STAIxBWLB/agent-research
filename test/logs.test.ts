import { executionView } from "../src/exp/pipeline.ts";
import { validateStageProtocol } from "../src/exp/stages.ts";
import { protocolHash } from "../src/exp/protocol.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { init } from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { readAttemptLogs } from "../src/exp/logs.ts";
import { sha256 } from "../src/study.ts";
import type { ProcessRunner } from "../src/exp/executor.ts";
import { metricAttempt } from "./metric-fixtures.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

function fixture() {
  const dir = tempDir(), workdir = realpathSync(tempDir()), created = init(dir, { question: "Synthetic?", mode: "experiment" }, { actor: { kind: "person" } }), attempt = metricAttempt();
  attempt.studyId = created.study.id; attempt.executor.workdir = workdir;
  const root = posix.join(workdir, attempt.studyId, attempt.id), logsDir = join(root, "logs");
  mkdirSync(logsDir, { recursive: true, mode: 0o700 });
  attempt.paths = { snapshot: posix.join(root, "snapshot"), output: posix.join(root, "output"), evaluator: posix.join(root, "task", "evaluator"), result: posix.join(root, "result") };
  const body = "synthetic line\nGET https://example.test/private\n";
  for (const stage of ["candidate", "evaluator"] as const) {
    const log = (stream: "stdout" | "stderr") => { const path = join(logsDir, `${stage}.${stream}.log`); writeFileSync(path, body, { mode: 0o600 }); return { path, sha256: sha256(body), bytes: Buffer.byteLength(body), truncated: stage === "candidate" }; };
    attempt.stages[stage]!.evidence = { logs: { stdout: log("stdout"), stderr: log("stderr") }, outputs: [] };
  }
  const recordPath = join(dir, "runs", attempt.run, "attempts", `${attempt.id}.json`); mkdirSync(join(dir, "runs", attempt.run, "attempts"), { recursive: true });
  const save = () => writeFileSync(recordPath, JSON.stringify(attempt)); save();
  return { dir, attempt, recordPath, body, save };
}
test("read-only logs verify host hash/size and return bounded selected tails without any study write", async () => {
  const { dir, attempt, recordPath, body } = fixture(), record = readFileSync(recordPath), ledger = readFileSync(join(dir, "ledger.jsonl")), modified = statSync(recordPath, { bigint: true }).mtimeNs;
  const logs = await readAttemptLogs(dir, attempt.id, { stage: "candidate", stream: "stdout", tailBytes: 5 });
  expect(logs.logs).toHaveLength(1); expect(logs.logs[0]!.text).toBe(Buffer.from(body).subarray(-5).toString()); expect(logs.logs[0]!.tailBytes).toBe(5); expect(logs.logs[0]!.truncated).toBe(true);
  const zero = await readAttemptLogs(dir, attempt.id, { stage: "candidate", stream: "stdout", tailBytes: 0 }); expect(zero.logs[0]!.text).toBe("");
  expect((await readAttemptLogs(dir, attempt.id)).logs).toHaveLength(4);
  expect(readFileSync(recordPath)).toEqual(record); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger); expect(statSync(recordPath, { bigint: true }).mtimeNs).toBe(modified);
  const cli = await run(["attempt", "logs", dir, attempt.id, "--stage", "candidate", "--stream", "stdout", "--tail", "5"], {}, { http: fakeHttp([]).http });
  expect(cli.text).toContain("candidate stdout, truncated copy"); expect(cli.text).toContain("vate"); expect(readFileSync(recordPath)).toEqual(record);
});
test("invalid log options and forged metadata refuse before any executor request", async () => {
  const { dir, attempt, save } = fixture(); let called = 0;
  const noProcess: ProcessRunner = async () => { called++; throw new Error("unexpected executor call"); };
  for (const options of [{ stage: "other" }, { stream: "other" }, { tailBytes: -1 }, { tailBytes: 65_537 }]) await expect(readAttemptLogs(dir, attempt.id, options, noProcess)).rejects.toThrow("attempt logs:");
  attempt.stages.candidate!.evidence!.logs.stdout.path = "/private/unrelated-file"; save();
  await expect(readAttemptLogs(dir, attempt.id, { stage: "candidate", stream: "stdout" }, noProcess)).rejects.toThrow("invalid log receipt or path"); expect(called).toBe(0);
});
test("changed host logs and symlink targets never return bytes as a matching recorded receipt", async () => {
  const { dir, attempt, body, save } = fixture(), path = attempt.stages.candidate!.evidence!.logs.stdout.path;
  writeFileSync(path, body.replace("synthetic", "different"));
  await expect(readAttemptLogs(dir, attempt.id, { stage: "candidate", stream: "stdout" })).rejects.toThrow("host log differs from the recorded hash or size");
  const target = join(tempDir(), "unrelated"); writeFileSync(target, "synthetic private content"); unlinkSync(path); symlinkSync(target, path);
  attempt.stages.candidate!.evidence!.logs.stdout.sha256 = sha256("synthetic private content"); attempt.stages.candidate!.evidence!.logs.stdout.bytes = Buffer.byteLength("synthetic private content"); save();
  await expect(readAttemptLogs(dir, attempt.id, { stage: "candidate", stream: "stdout" })).rejects.toThrow("log read failed");
});
test("available-stream defaults skip stages that have no collected logs and name the recovery for explicit requests", async () => {
  const { dir, attempt, save } = fixture(); delete attempt.stages.evaluator!.evidence; save();
  expect((await readAttemptLogs(dir, attempt.id)).logs).toHaveLength(2);
  await expect(readAttemptLogs(dir, attempt.id, { stage: "evaluator" })).rejects.toThrow("reconcile after the stage finishes");
});


function pipelineFixture(count = 2, bodyBytes = 0) {
  const f = fixture(), { attempt } = f, evaluator = structuredClone(attempt.stages.evaluator!), base = structuredClone(attempt.stages.candidate!);
  const names = Array.from({ length: count }, (_, i) => count === 2 ? ["prepare", "train"][i]! : `step-${i}`);
  const definition = validateStageProtocol({ ...attempt.protocol, v: 2, candidate: { stages: names.map(name => ({ name, ...attempt.protocol.candidate, seed: true, code: "snapshot", needs: [], inputs: {}, outputs: {} })) } });
  const logsDir = posix.join(attempt.executor.workdir, attempt.studyId, attempt.id, "logs");
  const records = names.map(name => {
    const record = structuredClone(base);
    const log = (stream: "stdout" | "stderr") => {
      const body = bodyBytes ? "x".repeat(bodyBytes) : `${name} synthetic ${stream}\n`, path = posix.join(logsDir, `candidate-${name}.${stream}.log`);
      writeFileSync(path, body, { mode: 0o600 });
      return { path, sha256: sha256(body), bytes: Buffer.byteLength(body), truncated: false };
    };
    record.evidence = { logs: { stdout: log("stdout"), stderr: log("stderr") }, outputs: [] };
    return record;
  });
  const completed = names.slice(0, -1).map((name, i) => ({ name, record: records[i]!, ref: { attemptId: attempt.id, stage: name, sha256: "a".repeat(64) } }));
  attempt.v = 2; attempt.stage = "candidate"; attempt.protocol = executionView(definition, count - 1); attempt.protocolHash = protocolHash(definition);
  attempt.pipeline = { definition, index: count - 1, completed, inputHashes: {}, taskTreeHash: "b".repeat(64) };
  attempt.stages = { candidate: records.at(-1)! }; f.save();
  return { ...f, names, records, finish() {
    const name = names.at(-1)!;
    attempt.pipeline!.completed.push({ name, record: records.at(-1)!, ref: { attemptId: attempt.id, stage: name, sha256: "a".repeat(64) } });
    attempt.stage = "evaluator"; attempt.stages = { evaluator }; f.save();
  } };
}

test("named current and completed pipeline logs are available through shared CLI/MCP reads without study writes", async () => {
  const f = pipelineFixture();
  expect((await readAttemptLogs(f.dir, f.attempt.id, { stage: "candidate" })).logs.map(row => row.candidateStage)).toEqual(["prepare", "prepare", "train", "train"]);
  expect((await readAttemptLogs(f.dir, f.attempt.id, { candidateStage: "train", stream: "stdout" })).logs[0]!.text).toBe("train synthetic stdout\n");
  f.finish();
  const before = readFileSync(f.recordPath), ledger = readFileSync(join(f.dir, "ledger.jsonl"));
  const expected = await readAttemptLogs(f.dir, f.attempt.id, { candidateStage: "prepare", stream: "stdout", tailBytes: 10 });
  expect(expected.logs[0]!.candidateStage).toBe("prepare"); expect(expected.logs[0]!.text).toBe("ic stdout\n");
  expect((await readAttemptLogs(f.dir, f.attempt.id)).logs).toHaveLength(6);
  const http = fakeHttp([]).http, mcp = createAresMcp({}, http);
  expect(await mcp.handlers.ares_attempt_logs!({ study: f.dir, id: f.attempt.id, candidateStage: "prepare", stream: "stdout", tailBytes: 10 })).toEqual(expected);
  const cli = await run(["attempt", "logs", f.dir, f.attempt.id, "--candidate-stage", "prepare", "--stream", "stdout", "--tail", "10", "--json"], {}, { http });
  expect(JSON.parse(cli.text)).toEqual(expected);
  expect(readFileSync(f.recordPath)).toEqual(before); expect(readFileSync(join(f.dir, "ledger.jsonl"))).toEqual(ledger);
});

test("named log selectors and forged completed-stage paths refuse before transport", async () => {
  const f = pipelineFixture(); f.finish(); let called = 0;
  const noProcess: ProcessRunner = async () => { called++; throw new Error("synthetic unexpected transport"); };
  for (const options of [{ candidateStage: "unknown" }, { candidateStage: "../prepare" }, { stage: "evaluator", candidateStage: "prepare" }]) await expect(readAttemptLogs(f.dir, f.attempt.id, options, noProcess)).rejects.toThrow("invalid candidate stage");
  f.attempt.pipeline!.completed[0]!.record.evidence!.logs.stdout.path = "/private/unrelated"; f.save();
  await expect(readAttemptLogs(f.dir, f.attempt.id, { candidateStage: "prepare", stream: "stdout" }, noProcess)).rejects.toThrow("invalid log receipt or path");
  expect(called).toBe(0);
});

test("all named logs share an aggregate tail bound while explicit oversized tails refuse before transport", async () => {
  const f = pipelineFixture(16, 9000); let called = 0;
  await expect(readAttemptLogs(f.dir, f.attempt.id, { tailBytes: 65536 }, async () => { called++; throw new Error("unexpected synthetic transport"); })).rejects.toThrow("combined tail bound");
  expect(called).toBe(0);
  const result = await readAttemptLogs(f.dir, f.attempt.id);
  expect(result.logs).toHaveLength(32); expect(result.logs.every(row => row.tailBytes === 8192)).toBe(true);
  expect(result.logs.reduce((sum, row) => sum + row.tailBytes, 0)).toBe(256 * 1024);
}, 20_000);
