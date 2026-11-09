import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { gateDecide, init } from "../src/commands.ts";
import { budgetUsage, cancelAttempt, reconcileAttempts, runAttempt, showAttempt, type Attempt, type AttemptContext } from "../src/exp/attempts.ts";
import { buildContainerArgs, setExecutor, spawnRunner, type ProcessRequest, type ProcessResult, type ProcessRunner } from "../src/exp/executor.ts";
import { parseMetrics } from "../src/exp/metrics.ts";
import { canonical, setProtocol } from "../src/exp/protocol.ts";
import { retainedOperation } from "../src/exp/retention.ts";
import { readBytesBounded, readLedger, readTextBounded, sha256, withLock, writeAtomic } from "../src/study.ts";
import { deferred, fakeHttp } from "./helpers.ts";

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
async function setup(withCodeLink = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ares-pipeline-"))); pipelineRoots.push(root);
  const dir = join(root, "study"), repo = join(root, "repo"), workdir = join(root, "executor");
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(workdir, { mode: 0o700 });
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } });
    if (result.status !== 0) throw new Error(`synthetic git failed: ${result.stderr}`); return result.stdout.trim();
  };
  git(["init", "-q"]); writeFileSync(join(repo, "code.txt"), "synthetic frozen implementation");
  if (withCodeLink) symlinkSync("code.txt", join(repo, "code-link.txt"));
  git(["add", "."]);
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
    const manifestPath = join(attempt.executor.workdir, attempt.studyId, ".retained", "objects", sealed.ref.attemptId, sealed.ref.stage, "manifest.json");
    expect(sha256(readBytesBounded(manifestPath, 256 * 1024))).toBe(sealed.ref.sha256);
    expect(result.sha256).toBe(sealed.ref.sha256);
    if (index === 0) {
      const taskProjection = { files: [{ path: "", bytes: 9, sha256: sha256("synthetic") }], directories: [] };
      expect(result.manifest?.identity.inputHashes.data).toBe(sha256(canonical(taskProjection)));
      expect(attempt.pipeline!.inputHashes.rows).toBe(sealed.ref.sha256);
    } else if (index === 1) {
      expect(result.manifest?.identity.inputHashes.rows).toBe(attempt.pipeline!.completed[0]!.ref.sha256);
      expect(attempt.pipeline!.inputHashes.model).toBe(sealed.ref.sha256);
    } else {
      expect(result.manifest?.identity.inputHashes.model).toBe(attempt.pipeline!.completed[1]!.ref.sha256);
      for (const parent of attempt.pipeline!.completed) expect(attempt.pipeline!.inputHashes[parent.name]).toBe(parent.ref.sha256);
    }
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
    await reconcileAttempts(dir, fake.ctx);
    expect(fake.executed).toEqual(["prepare", "train", "predict"]);
    const failed = showAttempt(dir, attempt.id);
    expect(failed.status).toBe("failed"); expect(failed.reason).toBe("evidence-read"); expect(failed.metrics).toEqual([]);
    expect((await retainedOperation(failed.executor, { op: "inspect", studyId: failed.studyId }, fake.ctx.runner!)).reservedBytes).toBe(0);
  }
}, 20_000);

test("v2 code tampering between stages prevents the next consumer", async () => {
  const f = await setup(), attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx);
  writeFileSync(join(attempt.paths.snapshot, "code.txt"), "tampered frozen implementation");
  f.fake.finish();
  await reconcileAttempts(f.dir, f.fake.ctx);
  expect(f.fake.executed).toEqual(["prepare"]);
  const failed = showAttempt(f.dir, attempt.id);
  expect(failed.status).toBe("failed"); expect(failed.reason).toBe("evidence-read"); expect(failed.metrics).toEqual([]);
  expect((await retainedOperation(failed.executor, { op: "inspect", studyId: failed.studyId }, f.fake.ctx.runner!)).reservedBytes).toBe(0);
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
  expect(attempt.status).toBe("failed"); expect(attempt.reason).toBe("wall-clock"); expect(attempt.metrics).toEqual([]);
  expect((await retainedOperation(attempt.executor, { op: "inspect", studyId: attempt.studyId }, f.fake.ctx.runner!)).reservedBytes).toBe(0);
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

function retentionRequest(request: ProcessRequest): Record<string, unknown> | undefined {
  if (request.command !== "python3" || !(request.stdin instanceof Uint8Array)) return undefined;
  return JSON.parse(new TextDecoder().decode(request.stdin)) as Record<string, unknown>;
}
async function assertNoReservation(f: Awaited<ReturnType<typeof setup>>, attempt: Attempt) {
  expect((await retainedOperation(attempt.executor, { op: "inspect", studyId: attempt.studyId }, f.fake.ctx.runner!)).reservedBytes).toBe(0);
}

test("v2 missing declared output and stopped-stage wall expiry terminate with their causes and release capacity", async () => {
  for (const cause of ["missing-output", "wall-expiry"] as const) {
    const f = await setup();
    const attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx);
    if (cause === "missing-output") unlinkSync(join(attempt.paths.output, "rows.txt"));
    f.fake.finish();
    if (cause === "wall-expiry") f.fake.clock.value += 121_000;
    await reconcileAttempts(f.dir, f.fake.ctx);
    const failed = showAttempt(f.dir, attempt.id);
    expect(failed.status).toBe("failed");
    expect(failed.reason).toBe(cause === "missing-output" ? "evidence-read" : "wall-clock");
    expect(failed.metrics).toEqual([]); expect(f.fake.executed).toEqual(["prepare"]);
    await assertNoReservation(f, failed);
  }
}, 20_000);

test("v2 a negative remaining metadata allowance is a terminal artifact-limit failure", async () => {
  const f = await setup(), attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx);
  // Synthetic persisted metadata represents earlier stage outputs using the shared ceiling.
  // An existing evidence receipt skips recollection and reaches the seal's negative allowance.
  const log = { path: join(f.workdir, "synthetic.log"), sha256: sha256(""), bytes: 0, truncated: false };
  attempt.stages.candidate!.evidence = { logs: { stdout: log, stderr: log }, outputs: [] };
  attempt.outputs = Array.from({ length: 76 }, (_, index) => ({ path: join(f.workdir, `${index}-${"x".repeat(3500)}`), sha256: sha256(""), bytes: 0 }));
  expect(Buffer.byteLength(JSON.stringify(attempt.outputs, null, 2))).toBeGreaterThan(256 * 1024);
  const record = join(f.dir, "runs", attempt.run, "attempts", `${attempt.id}.json`);
  writeAtomic(record, JSON.stringify(attempt, null, 2) + "\n", 1024 * 1024);
  f.fake.finish(); await reconcileAttempts(f.dir, f.fake.ctx);
  const failed = showAttempt(f.dir, attempt.id);
  expect(failed.status).toBe("failed"); expect(failed.reason).toBe("artifact-limit");
  expect(f.fake.executed).toEqual(["prepare"]); await assertNoReservation(f, failed);
});

test("v2 preclaim materialization integrity and budget refusals fail without launching a descendant", async () => {
  for (const cause of ["integrity", "budget"] as const) {
    const f = await setup(), attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx), original = f.fake.ctx.runner!;
    const interrupted: AttemptContext = { ...f.fake.ctx, runner: async request => {
      const operation = retentionRequest(request);
      if (operation?.op === "materialize" && operation.stage === "train") {
        if (cause === "budget") f.fake.clock.value += 121_000;
        return { exitCode: 1, stdout: '{"error":"retained payload integrity mismatch"}', stderr: "" };
      }
      return original(request);
    } };
    f.fake.finish(); await reconcileAttempts(f.dir, interrupted);
    const failed = showAttempt(f.dir, attempt.id);
    expect(failed.status).toBe("failed"); expect(failed.reason).toBe(cause === "integrity" ? "evidence-read" : "wall-clock");
    expect(f.fake.executed).toEqual(["prepare"]); expect(failed.metrics).toEqual([]);
    await assertNoReservation(f, failed);
  }
}, 20_000);

test("v2 postclaim transient materialization refusal stays retryable rather than becoming unknown lost", async () => {
  for (const cause of ["flock", "ssh", "timeout"] as const) {
    const f = await setup(), attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx), original = f.fake.ctx.runner!;
    let trainMaterializations = 0;
    const interrupted: AttemptContext = { ...f.fake.ctx, runner: async request => {
      const operation = retentionRequest(request);
      if (operation?.op === "materialize" && operation.stage === "train" && ++trainMaterializations === 2) {
        if (cause === "ssh") return { exitCode: 255, stdout: "", stderr: "synthetic SSH connection dropped" };
        if (cause === "timeout") return { exitCode: -1, stdout: "", stderr: "", timedOut: true };
        return { exitCode: 1, stdout: '{"error":"retention operation busy; retry after its owner finishes"}', stderr: "" };
      }
      return original(request);
    } };
    f.fake.finish(); await reconcileAttempts(f.dir, interrupted);
    const pending = showAttempt(f.dir, attempt.id);
    expect(trainMaterializations).toBe(2); expect(f.fake.executed).toEqual(["prepare"]);
    expect(pending.status).toBe("running"); expect(pending.reason).toBe("executor-preflight");
    expect(pending.stages.candidate?.launchPending).toBe(true); expect(pending.launching).toBeUndefined();
    expect(pending.error).toBeDefined();
    await reconcileAttempts(f.dir, f.fake.ctx);
    const recovered = showAttempt(f.dir, attempt.id);
    expect(recovered.status).toBe("running"); expect(recovered.reason).not.toBe("lost");
    expect(recovered.stages.candidate?.containerId).toBeDefined();
    expect(recovered.stages.candidate?.launchPending).toBeUndefined();
    expect(f.fake.executed).toEqual(["prepare", "train"]);
    expect(readLedger(f.dir).filter(event => event.type === "attempt.unknown")).toHaveLength(0);
  }
}, 30_000);

test("v2 reservation admission is fenced against concurrent recordless reservation reconciliation", async () => {
  const f = await setup(), original = f.fake.ctx.runner!;
  let concurrent: Promise<Attempt[]> | undefined, releasedWithoutRecord = false;
  const interleaved: AttemptContext = { ...f.fake.ctx, runner: async request => {
    const operation = retentionRequest(request);
    if (operation?.op === "release") {
      const record = join(f.dir, "runs", "main", "attempts", `${String(operation.attemptId)}.json`);
      if (!existsSync(record)) releasedWithoutRecord = true;
    }
    const result = await original(request);
    if (operation?.op === "reserve") {
      expect(existsSync(join(f.dir, ".ares.lock"))).toBe(true);
      // Start the contender without awaiting it while admission owns the study lock.
      concurrent = reconcileAttempts(f.dir, interleaved).catch(error => {
        expect(error instanceof Error).toBe(true);
        expect((error as Error).message).toMatch(/lock|active/);
        return [];
      });
      await Promise.resolve();
    }
    return result;
  } };
  const attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, interleaved);
  await concurrent;
  expect(releasedWithoutRecord).toBe(false); expect(attempt.status).toBe("running");
  const view = await retainedOperation(attempt.executor, { op: "inspect", studyId: attempt.studyId }, original);
  expect(view.reservedBytes).toBeGreaterThan(0); expect(f.fake.executed).toEqual(["prepare"]);
});

test("v2 GPU accounting includes every completed candidate stage and the current evaluator", async () => {
  const f = await setup(); let attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx);
  for (let index = 0; index < 3; index++) attempt = await terminateAndReconcile(f, attempt);
  const synthetic = structuredClone(attempt), start = Date.parse(attempt.startedAt);
  synthetic.pipeline!.completed.forEach((parent, index) => {
    parent.record.startedAt = new Date(start + index * 10_000).toISOString();
    parent.record.endedAt = new Date(start + (index + 1) * 10_000).toISOString();
    parent.record.limits = { ...parent.record.limits, gpus: 2 };
  });
  synthetic.stages.evaluator!.startedAt = new Date(start + 30_000).toISOString();
  synthetic.stages.evaluator!.endedAt = new Date(start + 40_000).toISOString();
  synthetic.stages.evaluator!.limits = { ...synthetic.stages.evaluator!.limits, gpus: 2 };
  synthetic.endedAt = new Date(start + 40_000).toISOString();
  const usage = budgetUsage([synthetic], start + 40_000);
  expect(usage.gpuHours).toBeCloseTo(80 / 3600, 10); expect(usage.wallHours).toBeCloseTo(40 / 3600, 10);
});


test("v2 frozen Git code snapshots hash symlinks as links without following them", async () => {
  const f = await setup(true), attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx);
  expect(attempt.status).toBe("running"); expect(f.fake.executed).toEqual(["prepare"]);
  const link = join(attempt.paths.snapshot, "code-link.txt");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  unlinkSync(link); symlinkSync("other-code.txt", link);
  f.fake.finish(); await reconcileAttempts(f.dir, f.fake.ctx);
  const failed = showAttempt(f.dir, attempt.id);
  expect(failed.status).toBe("failed"); expect(failed.reason).toBe("evidence-read");
  expect(f.fake.executed).toEqual(["prepare"]); await assertNoReservation(f, failed);
});

test("v2 a stale preflight cannot claim or overwrite the next candidate stage", async () => {
  const f = await setup(), initial = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx), original = f.fake.ctx.runner!;
  const trainEntered = deferred(), resumeTrain = deferred(), predictEntered = deferred(), resumePredict = deferred();
  let blockedTrain = false, blockedPredict = false;
  const staleContext: AttemptContext = { ...f.fake.ctx, runner: async request => {
    const result = await original(request), operation = retentionRequest(request);
    if (!blockedTrain && operation?.op === "materialize" && operation.stage === "train") {
      blockedTrain = true; trainEntered.resolve(); await resumeTrain.promise;
    }
    return result;
  } };
  f.fake.finish();
  const oldPreflight = reconcileAttempts(f.dir, staleContext);
  await trainEntered.promise;
  await reconcileAttempts(f.dir, f.fake.ctx);
  expect(f.fake.executed).toEqual(["prepare", "train"]);
  f.fake.finish();
  const nextContext: AttemptContext = { ...f.fake.ctx, runner: async request => {
    const result = await original(request), operation = retentionRequest(request);
    if (!blockedPredict && operation?.op === "materialize" && operation.stage === "predict") {
      blockedPredict = true; predictEntered.resolve(); await resumePredict.promise;
    }
    return result;
  } };
  const nextPreflight = reconcileAttempts(f.dir, nextContext);
  await predictEntered.promise;
  const before = showAttempt(f.dir, initial.id);
  expect(before.pipeline?.index).toBe(2); expect(before.stages.candidate?.launchPending).toBe(true);
  resumeTrain.resolve(); await oldPreflight;
  const after = showAttempt(f.dir, initial.id);
  expect(after.pipeline?.index).toBe(2);
  expect(after.pipeline?.inputHashes).toEqual(before.pipeline!.inputHashes);
  expect(after.pipeline?.preflightRevision).toBe(before.pipeline!.preflightRevision);
  expect(after.stages.candidate?.argv).toEqual(["/synthetic", "predict"]);
  expect(after.stages.candidate?.launchPending).toBe(true);
  expect(f.fake.executed).toEqual(["prepare", "train"]);
  resumePredict.resolve(); await nextPreflight;
  expect(f.fake.executed).toEqual(["prepare", "train", "predict"]);
  expect(showAttempt(f.dir, initial.id).pipeline?.inputHashes.model).toBe(showAttempt(f.dir, initial.id).pipeline!.completed[1]!.ref.sha256);
}, 20_000);

test("v2 a stale integrity error cannot finish a competing uncertain launch", async () => {
  const f = await setup(), initial = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx), original = f.fake.ctx.runner!;
  const entered = deferred(), resume = deferred();
  let blocked = false;
  const staleContext: AttemptContext = { ...f.fake.ctx, runner: async request => {
    const result = await original(request), operation = retentionRequest(request);
    if (!blocked && operation?.op === "materialize" && operation.stage === "train") {
      blocked = true; entered.resolve(); await resume.promise;
      return { exitCode: 1, stdout: '{"error":"retained payload integrity mismatch"}', stderr: "" };
    }
    return result;
  } };
  f.fake.finish();
  const stalePreflight = reconcileAttempts(f.dir, staleContext);
  await entered.promise;
  const pending = showAttempt(f.dir, initial.id);
  expect(pending.pipeline?.index).toBe(1);
  const args = buildContainerArgs({ protocol: pending.protocol, stage: "candidate", studyId: pending.studyId, attemptId: pending.id,
    user: pending.stages.candidate!.user, seed: pending.seed, paths: pending.paths,
    pipeline: { name: "train", inputRoot: join(f.workdir, pending.studyId, pending.id, "stages", "train", "inputs"), seed: true } });
  // Simulate a competing claimed start whose Docker response and follow-up inspection were lost.
  await original({ command: "docker", args });
  await withLock(f.dir, () => {
    const current = showAttempt(f.dir, initial.id);
    current.pipeline!.preflightRevision = (current.pipeline!.preflightRevision ?? 0) + 1;
    current.pipeline!.inputHashes = { rows: current.pipeline!.completed[0]!.ref.sha256 };
    current.reason = "executor-start-uncertain"; current.error = "synthetic start response and inspection unavailable";
    delete current.launching; delete current.stages.candidate!.launchPending; delete current.stages.candidate!.containerId;
    writeAtomic(join(f.dir, "runs", current.run, "attempts", `${current.id}.json`), JSON.stringify(current, null, 2) + "\n", 1024 * 1024);
  });
  resume.resolve(); await stalePreflight;
  const uncertain = showAttempt(f.dir, initial.id);
  expect(uncertain.status).toBe("running"); expect(uncertain.reason).toBe("executor-start-uncertain");
  expect(uncertain.stages.candidate?.launchPending).toBeUndefined();
  expect([...f.fake.containers.values()].filter(container => container.running)).toHaveLength(1);
  expect(f.fake.executed).toEqual(["prepare", "train"]);
  await expect(runAttempt(f.dir, { repo: f.repo, commit: f.commit, seed: 2, detach: true }, f.fake.ctx)).rejects.toThrow("another attempt is running");
  expect((await retainedOperation(uncertain.executor, { op: "inspect", studyId: uncertain.studyId }, original)).reservedBytes).toBeGreaterThan(0);
}, 20_000);

test("v2 crossing the deadline after evidence capture fails as wall-clock before sealing", async () => {
  const f = await setup(), attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx);
  const collect = f.fake.ctx.collectStageEvidence!;
  f.fake.ctx.collectStageEvidence = async (current, stage, runner) => {
    const evidence = await collect(current, stage, runner);
    f.fake.clock.value += 121_000;
    return evidence;
  };
  f.fake.finish(); await reconcileAttempts(f.dir, f.fake.ctx);
  const failed = showAttempt(f.dir, attempt.id);
  expect(failed.status).toBe("failed"); expect(failed.reason).toBe("wall-clock");
  expect(failed.pipeline?.completed).toEqual([]); expect(failed.metrics).toEqual([]);
  expect(f.fake.executed).toEqual(["prepare"]); await assertNoReservation(f, failed);
});

test("v2 a kill acknowledgement without observed termination keeps the attempt and reservation active", async () => {
  const f = await setup(), attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx), original = f.fake.ctx.runner!;
  f.fake.clock.value += 121_000;
  const killAcknowledgedOnly: AttemptContext = { ...f.fake.ctx, runner: request => request.command === "docker" && request.args[0] === "kill"
    ? Promise.resolve({ exitCode: 0, stdout: "", stderr: "" }) : original(request) };
  await expect(reconcileAttempts(f.dir, killAcknowledgedOnly)).rejects.toThrow();
  const live = showAttempt(f.dir, attempt.id);
  expect(live.status).toBe("running"); expect(live.error).toContain("termination is not yet observed");
  expect([...f.fake.containers.values()].some(container => container.running)).toBe(true);
  expect((await retainedOperation(live.executor, { op: "inspect", studyId: live.studyId }, original)).reservedBytes).toBeGreaterThan(0);
  await expect(runAttempt(f.dir, { repo: f.repo, commit: f.commit, seed: 2, detach: true }, f.fake.ctx)).rejects.toThrow("another attempt is running");
  await reconcileAttempts(f.dir, f.fake.ctx);
  const stopped = showAttempt(f.dir, attempt.id);
  expect(stopped.status).toBe("failed"); expect(stopped.reason).toBe("wall-clock");
  expect([...f.fake.containers.values()].some(container => container.running)).toBe(false);
  await assertNoReservation(f, stopped);
});

test("v2 transient seal busy/SSH failures preserve the stopped stage and retry without rerunning it", async () => {
  for (const cause of ["busy", "ssh"] as const) {
    const f = await setup(), initial = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx), original = f.fake.ctx.runner!;
    let failedOnce = false;
    const transient: AttemptContext = { ...f.fake.ctx, runner: request => {
      if (!failedOnce && retentionRequest(request)?.op === "seal") {
        failedOnce = true;
        return Promise.resolve(cause === "busy" ? { exitCode: 1, stdout: '{"error":"retention operation busy; retry after the current owner finishes"}', stderr: "" }
          : { exitCode: 255, stdout: "", stderr: "synthetic SSH unavailable" });
      }
      return original(request);
    } };
    f.fake.finish(); await reconcileAttempts(f.dir, transient);
    const stopped = showAttempt(f.dir, initial.id);
    expect(stopped.status).toBe("running"); expect(stopped.reason).toBe("executor-seal");
    expect(stopped.stages.candidate?.exitCode).toBe(0);
    expect(stopped.stages.candidate?.containerId).toBe(initial.stages.candidate?.containerId);
    expect(stopped.pipeline?.completed).toEqual([]); expect(stopped.metrics).toEqual([]);
    expect(f.fake.executed).toEqual(["prepare"]);
    expect((await retainedOperation(stopped.executor, { op: "inspect", studyId: stopped.studyId }, original)).reservedBytes).toBeGreaterThan(0);
    await reconcileAttempts(f.dir, f.fake.ctx);
    const next = showAttempt(f.dir, initial.id);
    expect(next.status).toBe("running"); expect(next.pipeline?.index).toBe(1);
    expect(next.pipeline?.completed[0]?.record.containerId).toBe(initial.stages.candidate?.containerId);
    expect(next.reason).toBeUndefined(); expect(next.error).toBeUndefined();
    expect(f.fake.executed).toEqual(["prepare", "train"]);
  }
}, 20_000);

test("v2 evaluator task mutation refuses fresh evaluator launch despite having no named task inputs", async () => {
  const f = await setup(); let attempt = await runAttempt(f.dir, { repo: f.repo, commit: f.commit, detach: true }, f.fake.ctx);
  attempt = await terminateAndReconcile(f, attempt); attempt = await terminateAndReconcile(f, attempt);
  expect(f.fake.executed).toEqual(["prepare", "train", "predict"]);
  writeFileSync(join(attempt.paths.evaluator, "run"), "tampered evaluator bytes");
  f.fake.finish(); await reconcileAttempts(f.dir, f.fake.ctx);
  const failed = showAttempt(f.dir, attempt.id);
  expect(failed.status).toBe("failed"); expect(failed.reason).toBe("evidence-read");
  expect(failed.error).toContain("frozen task snapshot integrity mismatch");
  expect(failed.stage).toBe("evaluator"); expect(failed.metrics).toEqual([]);
  expect(f.fake.executed).toEqual(["prepare", "train", "predict"]);
  await assertNoReservation(f, failed);
});
