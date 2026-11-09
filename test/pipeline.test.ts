import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { gateDecide, init } from "../src/commands.ts";
import { cancelAttempt, reconcileAttempts, runAttempt, showAttempt, type Attempt, type AttemptContext } from "../src/exp/attempts.ts";
import { setExecutor, spawnRunner, type ProcessRequest, type ProcessResult, type ProcessRunner } from "../src/exp/executor.ts";
import { parseMetrics } from "../src/exp/metrics.ts";
import { setProtocol } from "../src/exp/protocol.ts";
import { retainedOperation } from "../src/exp/retention.ts";
import { readBytesBounded, readLedger, readTextBounded, sha256, withLock } from "../src/study.ts";
import { fakeHttp } from "./helpers.ts";

const pipelineRoots: string[] = [];
afterEach(() => {
  const unlock = (root: string): void => {
    if (!lstatSync(root).isDirectory()) return;
    chmodSync(root, 0o700);
    for (const name of readdirSync(root)) { const child = join(root, name); if (lstatSync(child).isDirectory()) unlock(child); }
  };
  for (const root of pipelineRoots.splice(0)) { unlock(root); rmSync(root, { recursive: true, force: true }); }
});
const actor = { kind: "person" as const };
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
function definition() {
  const stage = { image: `synthetic@sha256:${"a".repeat(64)}`, seed: true, code: "snapshot", needs: [] as string[], env: { MODE: "synthetic" } };
  return { v: 2, method: "synthetic byte-exact serial pipeline", candidate: { stages: [
    { ...stage, name: "prepare", command: ["/synthetic", "prepare"], inputs: { data: { task: "data.txt" } }, outputs: { rows: "rows.txt" } },
    { ...stage, name: "train", command: ["/synthetic", "train"], needs: ["prepare"], inputs: { rows: { stage: "prepare", output: "rows" } }, outputs: { model: "model.txt" } },
    { ...stage, name: "predict", command: ["/synthetic", "predict"], seed: false, needs: ["train"], inputs: { model: { stage: "train", output: "model" } }, outputs: { predictions: "predictions.txt" } },
  ] }, evaluator: { image: `synthetic@sha256:${"b".repeat(64)}`, command: ["/synthetic", "evaluate"] },
  metrics: [{ name: "score", unit: "bytes", direction: "max" }], seeds: [1, 2], network: "none",
  limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 120, gpus: 0 }, budget: { maxAttempts: 5, maxWallHours: 1, maxGpuHours: 0 } };
}
interface Container { id: string; args: string[]; running: boolean; exitCode: number; startedAt: string; finishedAt?: string }
function outputs(root: string): { path: string; sha256: string; bytes: number }[] {
  const result: { path: string; sha256: string; bytes: number }[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const file = join(dir, name), stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else {
        expect(stat.isFile() && !stat.isSymbolicLink()).toBe(true);
        const bytes = readBytesBounded(file, 1024 * 1024);
        result.push({ path: file, sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  }
  walk(root); return result;
}
function runtime() {
  const requests: ProcessRequest[] = [], containers = new Map<string, Container>(), executed: string[] = [];
  const clock = { value: Date.parse("2030-01-01T00:00:00Z") };
  const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
  const mounts = (args: string[]) => args.flatMap((arg, index) => arg === "--mount" ? [args[index + 1]!] : []).map(text => {
    const parts = text.split(","); return { Type: "bind", Source: parts.find(part => part.startsWith("src="))!.slice(4), Destination: parts.find(part => part.startsWith("dst="))!.slice(4), RW: !parts.includes("readonly") };
  });
  const runner: ProcessRunner = async request => {
    requests.push(request);
    const args = request.args;
    if (request.command === "id") return ok("1001");
    if (request.command === "sh" && args.some(arg => arg.includes("nohup"))) return ok();
    if (request.command !== "docker") {
      // The only real processes operate on this test's synthetic private Git/task/retention trees.
      expect(["git", "tar", "python3", "sh"].includes(request.command)).toBe(true);
      return spawnRunner(request);
    }
    if (args[0] === "version") return ok("29.1.3");
    if (args[0] === "image") return ok("sha256:synthetic");
    if (args[0] === "run") {
      const name = value(args, "--name");
      if (containers.has(name)) return { exitCode: 125, stdout: "", stderr: "synthetic name exists" };
      const stage = args.at(-1)!, mounted = mounts(args);
      const source = (target: string) => mounted.find(mount => mount.Destination === target)!.Source;
      const output = stage === "evaluate" ? source("/result") : source("/out");
      mkdirSync(output, { recursive: true });
      if (stage === "prepare") writeFileSync(join(output, "rows.txt"), readTextBounded(join(source("/in"), "data"), 1024) + ":rows");
      else if (stage === "train") writeFileSync(join(output, "model.txt"), readTextBounded(join(source("/in"), "rows"), 1024) + ":model");
      else if (stage === "predict") writeFileSync(join(output, "predictions.txt"), readTextBounded(join(source("/in"), "model"), 1024) + ":predictions");
      else if (stage === "evaluate") {
        const prediction = readTextBounded(join(source("/candidate"), "predict", "predictions.txt"), 1024);
        expect(prediction).toBe("synthetic:rows:model:predictions");
        writeFileSync(join(output, "metrics.json"), JSON.stringify({ score: Buffer.byteLength(prediction) }));
      } else throw new Error("unexpected synthetic stage");
      executed.push(stage);
      const container = { id: sha256(name), args, running: true, exitCode: 0, startedAt: new Date(clock.value).toISOString() };
      containers.set(name, container); return ok(container.id);
    }
    if (args[0] === "kill") {
      const found = [...containers.values()].find(container => container.id === args[1]);
      if (!found) return { exitCode: 1, stdout: "", stderr: "synthetic missing" };
      found.running = false; found.exitCode = 137; found.finishedAt = new Date(clock.value).toISOString(); return ok();
    }
    if (args[0] === "ps") return ok([...containers].filter(([name]) => args.includes(`name=^/${name}$`)).map(([, container]) => container.id).join("\n"));
    if (args[0] === "inspect") {
      const found = containers.get(args.at(-1)!);
      if (!found) return { exitCode: 1, stdout: "", stderr: "synthetic missing" };
      const a = found.args, imageAt = a.findIndex(arg => arg.includes("@sha256:"));
      const labels = Object.fromEntries(a.flatMap((arg, index) => arg === "--label" ? [a[index + 1]!] : []).map(text => { const index = text.indexOf("="); return [text.slice(0, index), text.slice(index + 1)]; }));
      const seed = a.flatMap((arg, index) => arg === "--env" ? [a[index + 1]!] : []).find(text => text.startsWith("ARES_SEED=")) ?? "";
      return ok(JSON.stringify([{ Id: found.id, State: { Running: found.running, ExitCode: found.exitCode, StartedAt: found.startedAt, ...(found.finishedAt ? { FinishedAt: found.finishedAt } : {}) },
        Config: { Seed: seed, Image: a[imageAt], User: value(a, "--user"), Cmd: a.slice(imageAt + 1), Labels: labels },
        HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Tmpfs: { "/tmp": "" }, Memory: Number.parseInt(value(a, "--memory")) * 1024 * 1024, PidsLimit: Number(value(a, "--pids-limit")), NanoCpus: Number(value(a, "--cpus")) * 1e9, DeviceRequests: [] }, Mounts: mounts(a) }]));
    }
    throw new Error(`unexpected synthetic docker operation ${args[0]}`);
  };
  const ctx: AttemptContext = { actor, runner, now: () => clock.value,
    collectStageEvidence: async (attempt, stage) => {
      const log = { path: join(attempt.executor.workdir, "synthetic.log"), sha256: sha256(""), bytes: 0, truncated: false };
      return { logs: { stdout: log, stderr: log }, outputs: outputs(stage === "candidate" ? attempt.paths.output : attempt.paths.result) };
    },
    collectEvaluation: async attempt => ({ metrics: parseMetrics(readBytesBounded(join(attempt.paths.result, "metrics.json"), 65536), attempt.protocol), outputs: outputs(attempt.paths.result) }),
  };
  return { requests, containers, executed, clock, ctx, mounts, finish() {
    const running = [...containers.values()].filter(container => container.running);
    expect(running).toHaveLength(1); clock.value += 1000;
    running[0]!.running = false; running[0]!.exitCode = 0; running[0]!.finishedAt = new Date(clock.value).toISOString();
  } };
}
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ares-pipeline-"))); pipelineRoots.push(root);
  const dir = join(root, "study"), repo = join(root, "repo"), workdir = join(root, "executor");
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(workdir, { mode: 0o700 });
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (result.status !== 0) throw new Error(`synthetic git failed: ${result.stderr}`); return result.stdout.trim();
  };
  git(["init", "-q"]); writeFileSync(join(repo, "code.txt"), "synthetic frozen implementation"); git(["add", "code.txt"]);
  git(["-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Synthetic fixture"]);
  const commit = git(["rev-parse", "HEAD"]);
  init(dir, { question: "Synthetic byte-exact stages?", mode: "experiment" }, { actor });
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeFileSync(join(dir, "task", "data.txt"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic private evaluator");
  await withLock(dir, () => { setProtocol(dir, definition(), actor); setExecutor(dir, { v: 1, kind: "local", workdir }, actor); });
  await gateDecide(dir, "design", "approve", undefined, { actor, http: fakeHttp([]).http });
  return { dir, repo, workdir, commit, fake: runtime() };
}
async function terminateAndReconcile(fixture: Awaited<ReturnType<typeof setup>>, attempt: Attempt) {
  fixture.fake.finish(); await reconcileAttempts(fixture.dir, fixture.fake.ctx); return showAttempt(fixture.dir, attempt.id);
}

test("v2 fake executor runs three fresh stages in order with sealed input hashes and a separate fresh evaluator", async () => {
  const fixture = await setup(), { dir, repo, commit, fake } = fixture;
  let attempt = await runAttempt(dir, { repo, commit, detach: true }, fake.ctx);
  expect(attempt.status).toBe("running"); expect(attempt.pipeline?.index).toBe(0);
  for (let index = 0; index < 3; index++) {
    attempt = await terminateAndReconcile(fixture, attempt);
    expect(attempt.pipeline?.completed).toHaveLength(index + 1);
    const sealed = attempt.pipeline!.completed[index]!;
    const result = await retainedOperation(attempt.executor, { op: "verify", studyId: attempt.studyId, ref: sealed.ref }, fake.ctx.runner!);
    expect(result.manifest?.observed.containerId).toBe(sealed.record.containerId);
    expect(result.manifest?.identity.inputHashes).toBeDefined();
    expect(result.manifest?.identity.codeTree).toBe(attempt.treeId);
  }
  expect(attempt.stage).toBe("evaluator");
  expect(fake.executed).toEqual(["prepare", "train", "predict", "evaluate"]);
  expect(new Set([...fake.containers.values()].map(container => container.id)).size).toBe(4);
  for (const container of fake.containers.values()) {
    const mounted = fake.mounts(container.args);
    expect(mounted.filter(mount => mount.Destination === "/in" || mount.Destination === "/candidate" || mount.Destination === "/workspace" || mount.Destination === "/eval").every(mount => mount.RW === false)).toBe(true);
    if (container.args.at(-1) !== "evaluate") expect(mounted.some(mount => mount.Destination === "/eval")).toBe(false);
  }
  const train = [...fake.containers.values()].find(container => container.args.at(-1) === "train")!;
  const trainInput = fake.mounts(train.args).find(mount => mount.Destination === "/in")!.Source;
  expect(readTextBounded(join(trainInput, "rows"), 1024)).toBe("synthetic:rows");
  const predict = [...fake.containers.values()].find(container => container.args.at(-1) === "predict")!;
  expect(predict.args.some(arg => arg.startsWith("ARES_SEED="))).toBe(false);
  attempt = await terminateAndReconcile(fixture, attempt);
  expect(attempt.status).toBe("succeeded");
  expect(attempt.metrics).toEqual([{ name: "score", unit: "bytes", value: 32, provenance: "ares-observed" }]);
  const before = readLedger(dir);
  await reconcileAttempts(dir, fake.ctx);
  expect(readLedger(dir)).toEqual(before);
  expect(fake.executed).toHaveLength(4);
}, 20_000);

test("v2 missing container becomes unknown without an implicit rerun, and cancellation does not launch descendants", async () => {
  const fixture = await setup(), { dir, repo, commit, fake } = fixture;
  const attempt = await runAttempt(dir, { repo, commit, detach: true }, fake.ctx);
  fake.containers.clear(); await reconcileAttempts(dir, fake.ctx);
  expect(showAttempt(dir, attempt.id).status).toBe("unknown"); expect(fake.executed).toEqual(["prepare"]);
  const fresh = await setup();
  const running = await runAttempt(fresh.dir, { repo: fresh.repo, commit: fresh.commit, detach: true }, fresh.fake.ctx);
  const cancelled = await cancelAttempt(fresh.dir, running.id, "synthetic cancel", fresh.fake.ctx);
  expect(cancelled.status).toBe("cancelled");
  await reconcileAttempts(fresh.dir, fresh.fake.ctx);
  expect(fresh.fake.executed).toEqual(["prepare"]);
}, 20_000);

test("v2 corrupt or missing retained bytes never launch a consumer or create evaluator success", async () => {
  for (const mode of ["corrupt", "missing"] as const) {
    const fixture = await setup(), { dir, repo, commit, fake } = fixture;
    let attempt = await runAttempt(dir, { repo, commit, detach: true }, fake.ctx);
    attempt = await terminateAndReconcile(fixture, attempt);
    const parent = attempt.pipeline!.completed[0]!, file = join(attempt.executor.workdir, attempt.studyId, ".retained", "objects", parent.ref.attemptId, parent.ref.stage, "data", "rows.txt");
    expect(existsSync(file)).toBe(true);
    if (mode === "corrupt") { chmodSync(file, 0o600); writeFileSync(file, "tampered"); }
    else { chmodSync(join(file, ".."), 0o700); unlinkSync(file); }
    // Train already owns a private materialization. Its success may seal, but evaluator must reverify all parents.
    attempt = await terminateAndReconcile(fixture, attempt);
    fake.finish();
    await expect(reconcileAttempts(dir, fake.ctx)).rejects.toThrow();
    expect(fake.executed).toEqual(["prepare", "train", "predict"]);
    expect(showAttempt(dir, attempt.id).metrics).toEqual([]);
  }
}, 20_000);

test("v2 code tampering between stages prevents the next consumer", async () => {
  const f = await setup(), attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx);
  writeFileSync(join(attempt.paths.snapshot, "code.txt"), "tampered frozen implementation");
  f.fake.finish();
  await expect(reconcileAttempts(f.dir, f.fake.ctx)).rejects.toThrow();
  expect(f.fake.executed).toEqual(["prepare"]);
  expect(showAttempt(f.dir, attempt.id).metrics).toEqual([]);
});

test("v2 aggregate deadlines bound verification and reject a slow stopped evaluator", async () => {
  const f = await setup(); let attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx);
  f.fake.clock.value += 110_000;
  attempt = await terminateAndReconcile(f, attempt);
  const verifications = f.fake.requests.filter(request => request.command === "python3" && request.stdin instanceof Uint8Array && JSON.parse(new TextDecoder().decode(request.stdin)).op === "materialize");
  expect(verifications.at(-1)!.timeoutMs).toBeLessThanOrEqual(9000);
  for (let i = 0; i < 2; i++) attempt = await terminateAndReconcile(f, attempt);
  expect(attempt.stage).toBe("evaluator");
  const collector = f.fake.ctx.collectEvaluation!;
  f.fake.ctx.collectEvaluation = async (current, runner) => { const result = await collector(current, runner); f.fake.clock.value += 121_000; return result; };
  attempt = await terminateAndReconcile(f, attempt);
  expect(attempt.status).toBe("failed"); expect(attempt.metrics).toEqual([]);
});

test("v2 failed preparation releases reservations and terminal release can be reconciled", async () => {
  const f = await setup(), original = f.fake.ctx.runner!;
  const failing: AttemptContext = { ...f.fake.ctx, runner: async request => request.command === "docker" && request.args[0] === "version" ? { exitCode: 1, stdout: "", stderr: "synthetic unavailable" } : original(request) };
  const failed = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, failing);
  expect(failed.status).toBe("failed");
  const view = await retainedOperation(failed.executor, { op: "inspect", studyId: failed.studyId }, original);
  expect(view.reservedBytes).toBe(0);
  let attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, retry: failed.id, detach: true }, f.fake.ctx);
  for (let i = 0; i < 3; i++) attempt = await terminateAndReconcile(f, attempt);
  let failRelease = true;
  const interrupted: AttemptContext = { ...f.fake.ctx, runner: async request => {
    const input = request.stdin instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(request.stdin)) : undefined;
    if (failRelease && input?.op === "release") { failRelease = false; return { exitCode: 1, stdout: '{"error":"synthetic response lost"}', stderr: "" }; }
    return original(request);
  } };
  f.fake.finish(); await expect(reconcileAttempts(f.dir, interrupted)).rejects.toThrow("synthetic response lost");
  expect(showAttempt(f.dir, attempt.id).status).toBe("succeeded");
  await reconcileAttempts(f.dir, f.fake.ctx);
  expect((await retainedOperation(attempt.executor, { op: "inspect", studyId: attempt.studyId }, original)).reservedBytes).toBe(0);
}, 20_000);
