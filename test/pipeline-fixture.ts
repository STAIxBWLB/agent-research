import { mkdtempSync, rmSync, chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { expect } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { gateDecide, init } from "../src/commands.ts";
import { reconcileAttempts, showAttempt, type Attempt, type AttemptContext } from "../src/exp/attempts.ts";
import { setExecutor, spawnRunner, type ProcessRequest, type ProcessResult, type ProcessRunner } from "../src/exp/executor.ts";
import { parseMetrics } from "../src/exp/metrics.ts";
import { setProtocol } from "../src/exp/protocol.ts";
import { validateStageProtocol } from "../src/exp/stages.ts";
import { setSelection } from "../src/exp/selection.ts";
import { readBytesBounded, readTextBounded, sha256, withLock } from "../src/study.ts";
import { fakeHttp } from "./helpers.ts";

const pipelineRoots: string[] = [];
export function cleanupPipelineFixtures() {
  const unlock = (root: string): void => {
    if (!lstatSync(root).isDirectory()) return;
    chmodSync(root, 0o700);
    for (const name of readdirSync(root)) { const child = join(root, name); if (lstatSync(child).isDirectory()) unlock(child); }
  };
  for (const root of pipelineRoots.splice(0)) { unlock(root); rmSync(root, { recursive: true, force: true }); }
}
export const actor = { kind: "person" as const };
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
export function definition() {
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
export function outputs(root: string): { path: string; sha256: string; bytes: number }[] {
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
export function runtime() {
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
      else if (stage === "train") writeFileSync(join(output, "model.txt"), readTextBounded(join(source("/in"), "rows"), 1024) + ":model" + (args.includes("--revised-tool-option") ? ":revised" : ""));
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
export interface PipelineFixtureOptions { withCodeLink?: boolean; reuse?: boolean; maxAttempts?: number }
export async function setup(options: boolean | PipelineFixtureOptions = false) {
  const configured = typeof options === "boolean" ? { withCodeLink: options } : options;
  const withCodeLink = configured.withCodeLink ?? false;
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
  await withLock(dir, () => {
    const protocol = validateStageProtocol(definition());
    if (configured.maxAttempts !== undefined) protocol.budget.maxAttempts = configured.maxAttempts;
    if (configured.reuse) for (const stage of protocol.candidate.stages) stage.reuse = {
      v: 1, kind: "pure-artifact", inputs: "declared-only", externalState: "none", writableState: "fresh-output-only", modelOutputs: "forbidden", determinism: "byte-exact",
      toolchain: { description: "Synthetic deterministic byte transformer", documentationSha256: "d".repeat(64) },
    };
    setProtocol(dir, protocol, actor); setExecutor(dir, { v: 1, kind: "local", workdir }, actor);
    if (configured.reuse) setSelection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit }, minSeeds: 1, minDelta: 0 }, protocol, actor);
  });
  await gateDecide(dir, "design", "approve", undefined, { actor, http: fakeHttp([]).http });
  return { dir, repo, workdir, commit, fake: runtime() };
}
export async function terminateAndReconcile(fixture: Awaited<ReturnType<typeof setup>>, attempt: Attempt) {
  fixture.fake.finish(); await reconcileAttempts(fixture.dir, fixture.fake.ctx); return showAttempt(fixture.dir, attempt.id);
}

