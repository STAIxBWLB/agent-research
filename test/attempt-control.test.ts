import { expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { init } from "../src/commands.ts";
import { reconcileAttempts, showAttempt, type Attempt } from "../src/exp/attempts.ts";
import { processEnvironment, type ProcessRunner } from "../src/exp/executor.ts";
import { readLedger } from "../src/study.ts";
import { metricAttempt } from "./metric-fixtures.ts";
import { tempDir } from "./helpers.ts";

const time = Date.parse("2030-01-01T00:00:01Z");
function inspection(attempt: Attempt, stage: "candidate" | "evaluator", running: boolean) {
  const limits = attempt.protocol.limits;
  return {
    Id: stage === "candidate" ? "c".repeat(64) : "e".repeat(64),
    State: { Running: running, ExitCode: 0, StartedAt: "2030-01-01T00:00:00Z", FinishedAt: "2030-01-01T00:00:01Z" },
    Config: { Seed: `ARES_SEED=${attempt.seed}`, Image: attempt.protocol[stage].image, User: "1001:1001", Cmd: attempt.protocol[stage].command,
      Labels: { "ares.study": attempt.studyId, "ares.attempt": attempt.id, "ares.stage": stage } },
    HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Tmpfs: { "/tmp": "" }, Memory: limits.memoryMb * 1024 * 1024, PidsLimit: limits.pidsLimit, NanoCpus: limits.cpus * 1e9, DeviceRequests: [] },
    Mounts: stage === "candidate" ? [
      { Type: "bind", Source: attempt.paths.snapshot, Destination: "/workspace", RW: false },
      { Type: "bind", Source: attempt.paths.output, Destination: "/out", RW: true },
    ] : [
      { Type: "bind", Source: attempt.paths.evaluator, Destination: "/eval", RW: false },
      { Type: "bind", Source: attempt.paths.output, Destination: "/candidate", RW: false },
      { Type: "bind", Source: attempt.paths.result, Destination: "/result", RW: true },
    ],
  };
}
function fixture(candidateRunning = false) {
  const dir = tempDir(), created = init(dir, { question: "Synthetic controller concurrency?", mode: "experiment" }, { actor: { kind: "person" } });
  const attempt = metricAttempt(); attempt.studyId = created.study.id; attempt.stage = "candidate";
  delete attempt.stages.evaluator; delete attempt.stages.candidate!.endedAt; delete attempt.stages.candidate!.exitCode;
  attempt.sealing.evaluatorReadOnly = false; attempt.sealing.separateContainers = false;
  const records = join(dir, "runs", attempt.run, "attempts"); mkdirSync(records, { recursive: true });
  writeFileSync(join(records, `${attempt.id}.json`), JSON.stringify(attempt));
  const launches = join(tempDir(), "launches.txt"), config = join(tempDir(), "worker.json"); writeFileSync(launches, "");
  const data = { dir, id: attempt.id, launches, release: join(tempDir(), "release"), candidate: inspection(attempt, "candidate", candidateRunning), evaluator: inspection(attempt, "evaluator", true), time };
  writeFileSync(config, JSON.stringify(data)); return { ...data, config };
}
function child(config: string, mode: "cli" | "mcp") {
  const worker = fileURLToPath(new URL("./attempt-control-worker.ts", import.meta.url));
  const process = spawn(globalThis.process.execPath, [worker, config, mode], { env: processEnvironment(globalThis.process.env), stdio: ["ignore", "pipe", "pipe"] });
  let output = "", errors = "", signalReady!: () => void, signalWaiting!: () => void;
  const ready = new Promise<void>(resolve => { signalReady = resolve; });
  const waiting = new Promise<void>(resolve => { signalWaiting = resolve; });
  const timer = setTimeout(() => { if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); }, 5000);
  const done = new Promise<{ code: number | null; output: string; errors: string }>((resolve, reject) => {
    process.once("error", reject); process.once("close", code => { clearTimeout(timer); resolve({ code, output, errors }); });
  });
  process.stdout!.on("data", (data: Buffer) => { output += String(data); if (output.length > 16_384) process.kill("SIGKILL"); if (output.includes("control-ready")) signalReady(); if (output.includes("control-waiting")) signalWaiting(); });
  process.stderr!.on("data", (data: Buffer) => { errors += String(data); if (errors.length > 16_384) process.kill("SIGKILL"); });
  return { process, ready, waiting, done };
}
function stop(process: ChildProcess | undefined) { if (process && process.exitCode === null && process.signalCode === null) process.kill("SIGKILL"); }

test("two real CLI/MCP processes reconcile one attempt and launch the evaluator exactly once", async () => {
  const data = fixture(), first = child(data.config, "cli"); let second: ReturnType<typeof child> | undefined;
  try {
    await Promise.race([first.ready, first.done.then(result => { throw new Error(`CLI fixture exited before acquiring control: ${result.errors}`); })]);
    expect(existsSync(join(data.dir, ".ares.control.lock"))).toBe(true);
    second = child(data.config, "mcp");
    await Promise.race([second.waiting, second.done.then(result => { throw new Error(`MCP fixture never retried the held control lock: ${result.errors}`); })]);
    writeFileSync(data.release, "release");
    const results = await Promise.all([first.done, second.done]);
    for (const result of results) { expect(result.errors).toBe(""); expect(result.code).toBe(0); expect(result.output).toContain('"ok":true'); }
    expect(readFileSync(data.launches, "utf8").split("\n").filter(Boolean)).toEqual(["evaluator"]);
    expect(showAttempt(data.dir, data.id)).toMatchObject({ status: "running", stage: "evaluator", sealing: { candidateHasNoEvaluator: true, evaluatorReadOnly: true, separateContainers: true } });
    expect(readLedger(data.dir).filter(event => event.type === "attempt.stage.changed")).toHaveLength(1);
    expect(existsSync(join(data.dir, ".ares.control.lock"))).toBe(false);
  } finally { stop(first.process); stop(second?.process); await Promise.allSettled([first.done, ...(second ? [second.done] : [])]); }
}, 10_000);

test("a momentary controller lock is retried without rewriting a still-running record", async () => {
  const data = fixture(true), lock = join(data.dir, ".ares.control.lock"), record = join(data.dir, "runs", "main", "attempts", `${data.id}.json`);
  const before = readFileSync(record), ledger = readFileSync(join(data.dir, "ledger.jsonl"));
  writeFileSync(lock, "synthetic-brief-controller");
  const release = setTimeout(() => { try { unlinkSync(lock); } catch { /* already cleaned */ } }, 150);
  const runner: ProcessRunner = async request => {
    if (request.command !== "docker" || request.args[0] !== "inspect") throw new Error("synthetic retry test forbids external operations");
    return { exitCode: 0, stdout: JSON.stringify([data.candidate]), stderr: "" };
  };
  try {
    expect(await reconcileAttempts(data.dir, { actor: { kind: "person" }, runner, now: () => time })).toEqual([]);
    expect(readFileSync(record)).toEqual(before); expect(readFileSync(join(data.dir, "ledger.jsonl"))).toEqual(ledger);
    expect(existsSync(lock)).toBe(false);
  } finally { clearTimeout(release); try { unlinkSync(lock); } catch { /* released */ } }
});
