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
