import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateDecide, init } from "../src/commands.ts";
import { runAttempt, type Attempt } from "../src/exp/attempts.ts";
import { runOnExecutor, setExecutor, spawnRunner, type Executor, type ProcessRunner } from "../src/exp/executor.ts";
import { setProtocol } from "../src/exp/protocol.ts";
import { retainedOperation } from "../src/exp/retention.ts";
import { setSelection } from "../src/exp/selection.ts";
import { readBytesBounded, readTextBounded, sha256, withLock } from "../src/study.ts";
import base from "../test/fixtures/execution-reuse-pilot/protocol.json";

const [host, workdir, count, firstBlockArg] = process.argv.slice(2);
const iterations = Number(count);
const firstBlock = Number(firstBlockArg ?? "1");
assert(Number.isSafeInteger(firstBlock) && firstBlock >= 1 && firstBlock <= 5, "First block must be in 1..5");
assert(host && workdir && Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 1_000_000_000,
  "Pass an SSH alias, a private executor directory, and the frozen calibrated iteration count");
const executor: Executor = { v: 1, kind: "ssh", host, workdir };
const image = base.evaluator.image;
const actor = { kind: "person" as const };
const deny = async () => { throw new Error("Unexpected HTTP request"); };
const context = { actor, http: { json: deny, text: deny, env: {} } };
const fixture = "test/fixtures/execution-reuse-pilot";
const root = mkdtempSync(join(tmpdir(), "ares-sized-reuse-"));
const repo = join(root, "repo");
const frozenFixture = join(repo, fixture);
mkdirSync(frozenFixture, { recursive: true });
for (const file of ["shared.mjs", "stage-normalize.mjs", "stage-bucket.mjs", "stage-summarize.mjs"]) {
  writeFileSync(join(frozenFixture, file), readBytesBounded(join(fixture, file), 8192));
}
const work = `const { pbkdf2Sync } = require("node:crypto");
const digest = pbkdf2Sync("ares-stage-sized-fixture", "ares-stage-sized-salt", ${iterations}, 32, "sha256");
if (digest.length !== 32) throw new Error("Stage-sized work failed");
`;
writeFileSync(join(frozenFixture, "stage-work.cjs"), work);

const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], {
  encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
}).trim();
function commit(message: string): string {
  git("add", ".");
  git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", message);
  return git("rev-parse", "HEAD");
}
git("init", "-q");
const original = commit("Freeze stage-sized synthetic workload");
writeFileSync(join(repo, "code-tree-marker.txt"), "Cold tree control\n");
const changed = commit("Change frozen tree for no-hit controls");

const ids: string[] = [];
const runner: ProcessRunner = async request => {
  const result = await spawnRunner(request);
  if (request.command === "ssh" && request.args[3] === "docker" && request.args[4] === "run") {
    if (result.exitCode !== 0) {
      console.error("Docker launch failed", result.exitCode, result.stderr.trim().slice(0, 300));
    } else {
      const id = result.stdout.trim();
      assert.match(id, /^[a-f0-9]{64}$/);
      ids.push(id);
    }
  }
  return result;
};

type CaseName = "unchanged" | "edit" | "no-hit";
type Arm = "off" | "eligible";
function definition(edited: boolean) {
  return {
    ...base, method: "Stage-sized synthetic execution reuse pilot",
    candidate: { stages: base.candidate.stages.map(stage => ({
      ...stage,
      command: ["node", "--require", `/workspace/${fixture}/stage-work.cjs`, ...stage.command.slice(1),
        ...(edited && stage.name === "bucket" ? ["80"] : [])],
      reuse: { ...stage.reuse, toolchain: {
        description: "Digest-pinned Node, fixed PBKDF2, deterministic integer transforms, stable JSON, network none",
        documentationSha256: sha256(readTextBounded(join(fixture, "toolchain.md"), 8192) + work),
      } },
    })) },
  };
}

async function configure(dir: string, edited: boolean): Promise<void> {
  await withLock(dir, () => {
    const protocol = setProtocol(dir, definition(edited), actor);
    setSelection(dir, { v: 1, run: "investigate", metric: "checksum", baseline: { commit: original }, minSeeds: 1, minDelta: 0 }, protocol, actor);
    if (!edited) setExecutor(dir, executor, actor);
  });
  await gateDecide(dir, "design", "approve", undefined, context);
}

async function inspect(attempt: Attempt, expectedHits: string[], expectedChecksum: number) {
  assert.equal(attempt.status, "succeeded", attempt.error ?? "Pilot attempt failed");
  assert(attempt.endedAt && attempt.pipeline?.completed.length === 3);
  const time = (start: string, end: string) => Date.parse(end) - Date.parse(start);
  const stageFiles = [];
  const stageWallMs: Record<string, number> = {};
  for (const stage of attempt.pipeline.completed) {
    const verified = await retainedOperation(executor, { op: "verify", studyId: attempt.studyId, ref: stage.ref }, runner);
    assert(verified.manifest);
    stageFiles.push({ stage: stage.name, files: verified.manifest.files });
    assert(stage.record.endedAt);
    stageWallMs[stage.name] = time(stage.record.startedAt, stage.record.endedAt);
  }
  const hits = attempt.pipeline.completed.filter(stage => stage.reuse).map(stage => stage.name);
  assert.deepEqual(hits, expectedHits);
  const evaluation = attempt.stages.evaluator;
  assert(evaluation?.containerId && evaluation.exitCode === 0 && attempt.sealing.separateContainers);
  assert.equal(ids.filter(id => id === evaluation.containerId).length, 1);
  for (const hit of attempt.pipeline.completed.filter(stage => stage.reuse)) {
    assert.equal(hit.reuse?.original.cpuSeconds, "unknown");
    assert.equal(attempt.reuse?.stages[hit.name]?.reason, "verified-hit");
    assert.notEqual(hit.reuse?.source.attemptId, attempt.id);
  }
  const metricsHash = attempt.outputs.find(output => output.path === join(attempt.paths.result, "metrics.json"))?.sha256;
  assert(metricsHash);
  assert.deepEqual(Object.fromEntries(attempt.metrics.map(({ name, value }) => [name, value])),
    { checksum: expectedChecksum, coverage: 47 });
  return {
    id: attempt.id, wallMs: time(attempt.startedAt, attempt.endedAt), stageWallMs, hits, stageFiles, metricsHash,
    verificationMs: attempt.reuse?.mode === "eligible" ? attempt.reuse.verificationMs : null,
    materializationMs: attempt.reuse?.mode === "eligible" ? attempt.reuse.materializationMs : null,
    sidecarBytes: attempt.pipeline.sidecarBytes, cpu: "unknown", evaluatorId: evaluation.containerId,
    originalStageWallMs: attempt.pipeline.completed.flatMap(stage => stage.reuse ? [stage.reuse.original.wallSeconds === "unknown" ? "unknown" : stage.reuse.original.wallSeconds * 1000] : []),
  };
}

async function runPair(dir: string, name: CaseName, rep: number, source: string): Promise<void> {
  const order: Arm[] = rep % 2 ? ["off", "eligible"] : ["eligible", "off"];
  let retry = source;
  let reference: Awaited<ReturnType<typeof inspect>> | undefined;
  for (const arm of order) {
    const attempt = await runAttempt(dir, { repo, run: "investigate", commit: name === "no-hit" ? changed : original, seed: 7, reuse: arm, retry }, { actor, runner });
    console.log(JSON.stringify({ event: "terminal", name, rep, arm, id: attempt.id, status: attempt.status, reason: attempt.reason }));
    const hits = arm === "off" || name === "no-hit" ? [] : name === "edit" ? ["normalize"] : ["normalize", "bucket", "summarize"];
    const row = await inspect(attempt, hits, name === "edit" ? 137 : 231);
    if (reference) {
      assert.deepEqual(row.stageFiles, reference.stageFiles);
      assert.equal(row.metricsHash, reference.metricsHash);
      assert.notEqual(row.evaluatorId, reference.evaluatorId);
    }
    console.log(JSON.stringify({ event: "measurement", name, rep, arm, ...row }));
    reference = row;
    retry = attempt.id;
  }
}

async function main(): Promise<void> {
  assert.equal((await runOnExecutor(executor, "docker", ["image", "inspect", image])).exitCode, 0, "Pinned image must be cached");
  console.log(JSON.stringify({ event: "frozen", original, changed, iterations, firstBlock, blocks: 5 }));
  for (let rep = firstBlock; rep <= 5; rep++) {
    const dir = join(root, `study-${rep}`);
    init(dir, { question: "Does stage-sized reuse reduce synthetic execution wall?", mode: "experiment" }, { actor });
    mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
    writeFileSync(join(dir, "task", "workload.json"), readBytesBounded(join(fixture, "workload.json"), 8192));
    writeFileSync(join(dir, "task", "evaluator", "evaluator.mjs"), readBytesBounded(join(fixture, "evaluator.mjs"), 8192));
    await configure(dir, false);
    const source = await runAttempt(dir, { repo, commit: original, seed: 7, run: "investigate", reuse: "eligible" }, { actor, runner });
    console.log(JSON.stringify({ event: "source-terminal", rep, id: source.id, status: source.status, reason: source.reason }));
    console.log(JSON.stringify({ event: "source", rep, ...await inspect(source, [], 231) }));
    await runPair(dir, "unchanged", rep, source.id);
    await configure(dir, true);
    await runPair(dir, "edit", rep, source.id);
    await configure(dir, false);
    await runPair(dir, "no-hit", rep, source.id);
    await cleanContainers();
  }
}

async function cleanContainers(): Promise<void> {
  for (const id of ids.splice(0)) await runOnExecutor(executor, "docker", ["rm", "-f", id]);
}

try { await main(); }
finally {
  await cleanContainers();
  rmSync(root, { recursive: true, force: true });
}
