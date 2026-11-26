import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finalClose, finalSeeds, gateDecide, init, investigateClose, retentionPrune } from "../src/commands.ts";
import { CONTROL_STALE_MS, type Attempt, cancelAttempt, listAttempts, reconcileAttempts, runAttempt, showAttempt } from "../src/exp/attempts.ts";
import { runOnExecutor, setExecutor, spawnRunner, type Executor, type ProcessRunner } from "../src/exp/executor.ts";
import { canonical, setProtocol } from "../src/exp/protocol.ts";
import { RETENTION_RESERVATION, RetentionError, retainedOperation, type RetainedRef, type RetentionRequest } from "../src/exp/retention.ts";
import { setSelection } from "../src/exp/selection.ts";
import { RETENTION_SCRIPT } from "../src/exp/retention-script.ts";
import { readLedger, sha256, withLock, openStudy } from "../src/study.ts";

const [host, workdir, imageArg] = process.argv.slice(2);
assert(host && workdir && imageArg, "Pass an SSH alias, an empty mode-0700 executor directory, and a cached Alpine digest");
const image: string = imageArg;
const executor: Executor = { v: 1, kind: "ssh", host, workdir };
const actor = { kind: "person" as const };
const denyHttp = async () => { throw new Error("Unexpected HTTP request"); };
const ctx = { actor, http: { json: denyHttp, text: denyHttp, env: {} } };
const root = mkdtempSync(join(tmpdir(), "ares-stage-proof-"));
const repo = join(root, "repo");
mkdirSync(repo);
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
git("init", "-q");
writeFileSync(join(repo, "code.txt"), "synthetic");
git("add", "code.txt");
git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Synthetic fixture");
const commit = git("rev-parse", "HEAD");

const containers: string[] = [];
const launches: string[] = [];
const runner: ProcessRunner = async request => {
  const launch = request.command === "ssh" && request.args[3] === "docker" && request.args[4] === "run";
  const result = await spawnRunner(request);
  if (launch && result.exitCode === 0) {
    assert.match(result.stdout.trim(), /^[0-9a-f]{64}$/);
    containers.push(result.stdout.trim());
    const index = request.args.indexOf("--name");
    launches.push(request.args[index + 1] ?? "");
  }
  return result;
};

const command = (script: string) => ["/bin/sh", "-ec", script];
const policyProbe = `test "$(id -u)" -ne 0
test "$(ls /sys/class/net)" = lo
test ! -e /dev/nvidia0
if touch /rootfs-proof 2>/tmp/rootfs-error; then exit 91; fi
grep -q 'Read-only file system' /tmp/rootfs-error
`;
const readOnly = (file: string) => `if (printf corrupt > ${file}) 2>/tmp/input-error; then exit 92; fi
grep -q 'Read-only file system' /tmp/input-error
`;
const stage = { image, seed: true, code: "snapshot", needs: [] };
const protocol = {
  method: "Synthetic live byte transformations",
  evaluator: { image, command: command(policyProbe + "test -r /eval/private; printf '{\"score\":32}' > /result/metrics.json") },
  metrics: [{ name: "score", unit: "bytes", direction: "max" }],
  seeds: [1, 2, 3], network: "none",
  limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 120, gpus: 0 },
  budget: { maxAttempts: 5, maxWallHours: 1, maxGpuHours: 0 },
};

async function main(): Promise<void> {
  assert.equal((await runOnExecutor(executor, "docker", ["image", "inspect", image])).exitCode, 0, "Image must already be cached");
  const dir = join(root, "study");
  init(dir, { question: "Synthetic live stages?", mode: "experiment" }, { actor });
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeFileSync(join(dir, "task", "data.txt"), "synthetic");
  writeFileSync(join(dir, "task", "evaluator", "private"), "synthetic evaluator");
  const stages = [
    {
      ...stage, name: "prepare",
      command: command(policyProbe + "test ! -e /eval/private; case $ARES_SEED in 2|3) sleep 60;; esac; cat /in/data > /out/rows.txt; printf :rows >> /out/rows.txt"),
      inputs: { data: { task: "data.txt" } }, outputs: { rows: "rows.txt" },
    },
    {
      ...stage, name: "train", needs: ["prepare"],
      command: command(policyProbe + readOnly("/in/rows") + "cat /in/rows > /out/model.txt; printf :model >> /out/model.txt"),
      inputs: { rows: { stage: "prepare", output: "rows" } }, outputs: { model: "model.txt" },
    },
    {
      ...stage, name: "predict", needs: ["train"],
      command: command(policyProbe + readOnly("/in/model") + "test ! -e /in/rows; cat /in/model > /out/predictions.txt; printf :predictions >> /out/predictions.txt"),
      inputs: { model: { stage: "train", output: "model" } }, outputs: { predictions: "predictions.txt" },
    },
  ];
  const evaluator = command(policyProbe + readOnly("/candidate/prepare/rows.txt") +
    readOnly("/candidate/train/model.txt") + readOnly("/candidate/predict/predictions.txt") +
    'test -r /eval/private; test "$(cat /candidate/predict/predictions.txt)" = synthetic:rows:model:predictions; printf \'{"score":32}\' > /result/metrics.json');
  const definition = { ...protocol, v: 2, candidate: { stages }, evaluator: { image, command: evaluator } };
  const ledgerBefore = readLedger(dir);
  const refusals = {
    cycle: { needs: ["predict"] },
    path: { outputs: { rows: "../outside" } },
    undeclared: { inputs: { rows: { stage: "prepare", output: "missing" } } },
    image: { image: "alpine:latest" },
    env: { env: { TOKEN: "synthetic" } },
  };
  await withLock(dir, () => {
    for (const [name, change] of Object.entries(refusals)) {
      const stages = definition.candidate.stages.map((item, index) => index === (name === "undeclared" ? 1 : 0) ? { ...item, ...change } : item);
      assert.throws(() => setProtocol(dir, { ...definition, candidate: { stages } }, actor));
      assert.deepEqual(readLedger(dir), ledgerBefore);
    }
    setProtocol(dir, definition, actor);
    setExecutor(dir, executor, actor);
  });
  console.log(JSON.stringify({ case: "protocol refusals before ledger mutation", refused: Object.keys(refusals) }));
  await gateDecide(dir, "design", "approve", undefined, ctx);
  const attempt = await runAttempt(dir, { repo, commit }, { actor, runner });
  console.log(JSON.stringify({ status: attempt.status, reason: attempt.reason, error: attempt.error, launches, containers, metrics: attempt.metrics, completed: attempt.pipeline?.completed.map(({ name, ref }) => ({ name, ref })) }));
  assert.equal(attempt.status, "succeeded");
  const completed = attempt.pipeline!.completed;
  assert.deepEqual(completed.map(item => item.name), ["prepare", "train", "predict"]);
  assert.equal(new Set(containers).size, 4);
  assert.deepEqual(launches.map(name => name.split("-").at(-1)), ["prepare", "train", "predict", "evaluator"]);
  const hashes = [
    { data: sha256(canonical({ files: [{ path: "", bytes: 9, sha256: sha256("synthetic") }], directories: [] })) },
    { rows: completed[0]!.ref.sha256 },
    { model: completed[1]!.ref.sha256 },
  ];
  for (const [index, item] of completed.entries()) {
    const verified = await retainedOperation(executor, { op: "verify", studyId: attempt.studyId, ref: item.ref }, runner);
    assert.equal(verified.manifest?.observed.containerId, containers[index]);
    assert.deepEqual(verified.manifest?.identity.inputHashes, hashes[index]);
    console.log(JSON.stringify({ stage: item.name, inputHashes: hashes[index], manifestSha256: item.ref.sha256 }));
  }
  assert.equal(attempt.metrics[0]?.value, 32);
  const studyId = attempt.studyId;
  const ref = completed[0]!.ref;
  const reserve = { op: "reserve", studyId, capBytes: RETENTION_RESERVATION + 1024 * 1024, reservationBytes: RETENTION_RESERVATION } as const;
  const first = "1000000000000001", second = "1000000000000002";
  const workspace = join(executor.workdir, studyId, first);
  assert.equal((await runOnExecutor(executor, "mkdir", ["-m", "700", workspace], runner)).exitCode, 0);
  const materialize = {
    op: "materialize", studyId, attemptId: first, stage: "consumer",
    target: join(workspace, "inputs"), taskRoot: join(workspace, "task"),
  } as const;
  await retainedOperation(executor, { ...reserve, attemptId: first }, runner);
  try {
    const view = await retainedOperation(executor, { op: "inspect", studyId }, runner);
    assert.equal(view.reservedBytes, RETENTION_RESERVATION);
    await assert.rejects(retainedOperation(executor, { ...reserve, attemptId: second }, runner), /cap full/);
    const after = await retainedOperation(executor, { op: "inspect", studyId }, runner);
    assert.deepEqual(after.reservations, view.reservations);
    console.log(JSON.stringify({ case: "in-flight cap refusal", reservedBytes: view.reservedBytes, capBytes: reserve.capBytes }));
    const receipt = await retainedOperation(executor, { ...materialize, inputs: { rows: { ref, output: "rows" } } }, runner);
    assert.equal(receipt.inputHashes?.rows, ref.sha256);
    await assert.rejects(retainedOperation(executor, { op: "prune", studyId, refs: [ref] }, runner), /active producer or consumer/);
    console.log(JSON.stringify({ case: "active consumer blocks prune", manifestSha256: ref.sha256 }));

    const tampered = completed[1]!.ref;
    const file = join(executor.workdir, studyId, ".retained", "objects", attempt.id, tampered.stage, "data", "model.txt");
    const edit = await runOnExecutor(executor, "sh", ["-ec", 'chmod u+w "$1"; printf corrupt > "$1"', "synthetic-tamper", file], runner);
    assert.equal(edit.exitCode, 0);
    await assert.rejects(retainedOperation(executor, { ...materialize, stage: "tamper", target: join(workspace, "tamper"), inputs: { model: { ref: tampered, output: "model" } } }, runner), /integrity|payload/);
    assert.equal((await runOnExecutor(executor, "test", ["!", "-e", join(workspace, "tamper")], runner)).exitCode, 0);
    console.log(JSON.stringify({ case: "tampered retained payload refused before materialization", manifestSha256: tampered.sha256 }));

    const missing = completed[2]!.ref;
    const directory = join(executor.workdir, studyId, ".retained", "objects", attempt.id, missing.stage, "data");
    const remove = await runOnExecutor(executor, "sh", ["-ec", 'chmod u+w "$1"; rm "$1/predictions.txt"', "synthetic-missing", directory], runner);
    assert.equal(remove.exitCode, 0);
    const missingTarget = join(workspace, "missing");
    await assert.rejects(retainedOperation(executor, { ...materialize, stage: "missing", target: missingTarget, inputs: { predictions: { ref: missing, output: "predictions" } } }, runner), /integrity|payload/);
    assert.equal((await runOnExecutor(executor, "test", ["!", "-e", missingTarget], runner)).exitCode, 0);
    console.log(JSON.stringify({ case: "missing retained payload refused before materialization", manifestSha256: missing.sha256 }));
  } finally {
    await retainedOperation(executor, { op: "release", studyId, attemptId: first }, runner);
  }
  const preview = await retainedOperation(executor, { op: "prune", studyId, refs: [ref] }, runner);
  assert(preview.fingerprint);
  const pruned = await retainedOperation(executor, { op: "prune", studyId, refs: [ref], fingerprint: preview.fingerprint }, runner);
  assert.equal(pruned.pruned, 1);
  const view = await retainedOperation(executor, { op: "inspect", studyId }, runner);
  assert(view.entries?.some(entry => entry.ref.sha256 === ref.sha256 && entry.tombstone));
  console.log(JSON.stringify({ case: "prune tombstone", manifestSha256: ref.sha256 }));

  for (const mode of ["cancelled", "unknown"] as const) {
    const before = containers.length;
    const next = await runAttempt(dir, { repo, commit, seed: mode === "cancelled" ? 2 : 3, detach: true }, { actor, runner });
    assert.equal(next.status, "running");
    assert.equal(containers.length, before + 1);
    const id = containers[before]!;
    if (mode === "cancelled") {
      await cancelAttempt(dir, next.id, "Synthetic cancellation", { actor, runner });
    } else {
      assert.equal((await runOnExecutor(executor, "docker", ["rm", "-f", id], runner)).exitCode, 0);
    }
    await reconcileAttempts(dir, { actor, runner });
    assert.equal(showAttempt(dir, next.id).status, mode);
    assert.equal(containers.length, before + 1);
    console.log(JSON.stringify({ case: mode, launches: 1, descendants: 0 }));
  }

  const legacy = join(root, "legacy");
  init(legacy, { question: "Synthetic v1 regression?", mode: "experiment" }, { actor });
  mkdirSync(join(legacy, "task", "evaluator"), { recursive: true });
  writeFileSync(join(legacy, "task", "evaluator", "private"), "synthetic evaluator");
  await withLock(legacy, () => {
    setProtocol(legacy, { ...protocol, v: 1, seeds: [1, 2], budget: { ...protocol.budget, maxAttempts: 1 },
      candidate: { image, command: command(policyProbe + "printf legacy > /out/legacy.txt") },
      evaluator: { image, command: command(policyProbe + readOnly("/candidate/legacy.txt") +
        'test "$(cat /candidate/legacy.txt)" = legacy; printf \'{"score":6}\' > /result/metrics.json') },
    }, actor);
    setExecutor(legacy, executor, actor);
  });
  await gateDecide(legacy, "design", "approve", undefined, ctx);
  const legacyAttempt = await runAttempt(legacy, { repo, commit }, { actor, runner });
  console.log(JSON.stringify({ case: "v1", status: legacyAttempt.status, error: legacyAttempt.error, metrics: legacyAttempt.metrics }));
  assert.equal(legacyAttempt.status, "succeeded");
  assert.equal(legacyAttempt.metrics[0]?.value, 6);
  assert.equal(new Set(containers).size, 8);
  const beforeBudgetRefusal = readLedger(legacy);
  await assert.rejects(runAttempt(legacy, { repo, commit, seed: 2 }, { actor, runner }), /budget/);
  assert.deepEqual(readLedger(legacy), beforeBudgetRefusal);
  assert.equal(containers.length, 8);
  console.log(JSON.stringify({ case: "v1 budget refusal before launch or ledger mutation" }));
  await verifyOutputRefusals();
}

function writeFiles(count: number): string {
  return `i=0; while [ "$i" -lt ${count} ]; do printf x > "/out/file-$i"; i=$((i+1)); done`;
}

async function verifyOutputRefusals(): Promise<void> {
  const unsafe = { ...stage, name: "unsafe", command: command(policyProbe + "ln -s /tmp/escape /out/file-0"), inputs: {}, outputs: { sample: "file-0" } };
  const batch = { ...unsafe, name: "first", command: command(policyProbe + writeFiles(250)) };
  const unavailable = `localhost:1/ares-stage-proof@sha256:${"0".repeat(64)}`;
  const cases = [
    { name: "unsafe-link", stages: [unsafe], launches: 1, seals: 0 },
    { name: "cumulative-file-cap", stages: [batch, { ...batch, name: "second", needs: ["first"] }], launches: 3, seals: 2 },
    { name: "unavailable-image", stages: [{ ...batch, image: unavailable }], launches: 0, seals: 0 },
  ];
  for (const scenario of cases) {
    const dir = join(root, scenario.name);
    init(dir, { question: "Synthetic refusal?", mode: "experiment" }, { actor });
    mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
    writeFileSync(join(dir, "task", "evaluator", "private"), "synthetic evaluator");
    await withLock(dir, () => {
      setProtocol(dir, { ...protocol, v: 2, candidate: { stages: scenario.stages } }, actor);
      setExecutor(dir, executor, actor);
    });
    await gateDecide(dir, "design", "approve", undefined, ctx);
    const before = containers.length;
    const attempt = await runAttempt(dir, { repo, commit }, { actor, runner });
    const inventory = await retainedOperation(executor, { op: "inspect", studyId: attempt.studyId }, runner);
    console.log(JSON.stringify({ case: scenario.name, status: attempt.status, reason: attempt.reason, error: attempt.error,
      launches: containers.length - before, seals: inventory.entries?.length, reservedBytes: inventory.reservedBytes,
      outputs: attempt.outputs.length, metrics: attempt.metrics.length }));
    assert.equal(attempt.status, "failed");
    assert.equal(containers.length - before, scenario.launches);
    assert.equal(inventory.entries?.length, scenario.seals);
    assert.equal(inventory.reservedBytes, 0);
    assert.equal(attempt.metrics.length, 0);
    if (scenario.name === "unsafe-link") assert.match(attempt.error ?? "", /type|link/);
    if (scenario.name === "cumulative-file-cap") {
      assert.equal(attempt.reason, "artifact-limit");
      assert.equal(attempt.outputs.length, 500);
    }
    if (scenario.name === "unavailable-image") assert.match(attempt.error ?? "", /image pull/);
  }
}

async function verifyFollowUp(): Promise<void> {
  assert.equal((await runOnExecutor(executor, "docker", ["image", "inspect", image])).exitCode, 0);
  const fixture = { ...protocol, v: 2, candidate: { stages: [{
    ...stage, name: "prepare", inputs: {}, outputs: { rows: "rows.txt" },
    command: command(policyProbe + 'score=$(cat /workspace/score.txt 2>/dev/null || printf 1); printf %s "$score" > /out/rows.txt; if [ "$ARES_SEED" = 2 ]; then i=0; while [ "$i" -lt 16 ]; do sleep 1; printf %s "$score" > /out/rows.txt; i=$((i+1)); done; fi'),
  }] }, evaluator: { image, command: command(policyProbe +
    `score=$(cat /candidate/prepare/rows.txt); printf '{"score":%s}' "$score" > /result/metrics.json`) } };

  async function study(name: string, definition: unknown): Promise<string> {
    const dir = join(root, name);
    init(dir, { question: "Synthetic recovery verification?", mode: "experiment" }, { actor });
    mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
    writeFileSync(join(dir, "task", "evaluator", "private"), "synthetic evaluator");
    await withLock(dir, () => {
      setProtocol(dir, definition, actor);
      setExecutor(dir, executor, actor);
    });
    return dir;
  }
  async function prepare(name: string, definition: unknown): Promise<string> {
    const dir = await study(name, definition);
    await gateDecide(dir, "design", "approve", undefined, ctx);
    return dir;
  }
  if (process.argv[6] !== "--final-budget" && process.argv[6] !== "--budget-only") {
    const raceDir = await prepare("races", fixture);
    const source = await runAttempt(raceDir, { repo, commit, seed: 1 }, { actor, runner });
    assert.equal(source.status, "succeeded", source.error ?? "Race source failed");
    if (process.argv[6] === undefined) await raceRetention(source);
    await killRetentionWorkers(raceDir, source);
    await verifyLiveWriter(raceDir);
    if (process.argv[6] === "--retention-only") return;
  }

  if (process.argv[6] !== "--budget-only") {
    const finalDir = await study("first-final", fixture);
    writeFileSync(join(repo, "score.txt"), "2");
    git("add", "score.txt");
    git("-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "Synthetic winner");
    const winner = git("rev-parse", "HEAD");
    await withLock(finalDir, () => {
      const p = setProtocol(finalDir, fixture, actor);
      setSelection(finalDir, { v: 1, run: "investigate", metric: "score", baseline: { commit }, minSeeds: 1, minDelta: 1 }, p, actor);
    });
    await finalSeeds(finalDir, { v: 1, seeds: [2] }, ctx);
    await gateDecide(finalDir, "design", "approve", undefined, ctx);
    for (const candidate of [commit, winner]) {
      const observed = await runAttempt(finalDir, { repo, commit: candidate, seed: 1, run: "investigate" }, { actor, runner });
      assert.equal(observed.status, "succeeded", observed.error ?? "Investigation failed");
    }
    assert.equal((await investigateClose(finalDir, ctx)).winner?.commit, winner);
    await gateDecide(finalDir, "final", "approve", undefined, ctx);
    const first = await runAttempt(finalDir, { repo, commit: winner, run: "final", seed: 2, detach: true }, { actor, runner });
    assert.equal(first.status, "running");
    assert(first.snapshotSha256 && first.stages.candidate?.containerId);
    await cancelAttempt(finalDir, first.id, "Synthetic first final", { actor, runner });
    const retry = await runAttempt(finalDir, { repo, commit: winner, run: "final", seed: 2, retry: first.id }, { actor, runner });
    const baseline = await runAttempt(finalDir, { repo, commit, run: "final", seed: 2 }, { actor, runner });
    for (const [attempt, value] of [[retry, 2], [baseline, 1]] as const) {
      assert.equal(attempt.status, "succeeded", attempt.error ?? "Final failed");
      assert.equal(attempt.metrics[0]?.value, value);
      assert(attempt.snapshotSha256 && attempt.sealing.separateContainers);
      assert.notEqual(attempt.pipeline?.completed[0]?.record.containerId, first.stages.candidate?.containerId);
      assert(attempt.pipeline?.completed.every(item => !item.reuse && item.ref.attemptId === attempt.id));
    }
    const closed = await finalClose(finalDir, ctx);
    assert.equal(closed.status, "not_qualified");
    assert.equal(closed.reason, "cancelled");
    assert(closed.decisive.some(item => item.id === first.id));
    assert(closed.attempts.some(item => item.id === retry.id && item.reason === "later-attempt"));
    console.log(JSON.stringify({ case: "first final", first: first.id, retry: retry.id, baseline: baseline.id, status: closed.status, reason: closed.reason }));
  }

  const budgetDir = await prepare("aggregate-budget", { ...fixture, limits: { ...protocol.limits, wallSeconds: 70 },
    candidate: { stages: [
      { ...fixture.candidate.stages[0]!, command: command(policyProbe + "printf 1 > /out/rows.txt") },
      { ...stage, name: "second", needs: ["prepare"], inputs: { rows: { stage: "prepare", output: "rows" } },
        outputs: { rows: "rows.txt" }, command: command(policyProbe + "cat /in/rows > /out/rows.txt") },
    ] },
    evaluator: { image, command: command(policyProbe + "sleep 60; printf 0 > /result/finished") },
  });
  const start = containers.length;
  const budget = await runAttempt(budgetDir, { repo, commit }, { actor, runner });
  const elapsed = Date.parse(budget.endedAt!) - Date.parse(budget.startedAt);
  const evaluator = budget.stages.evaluator;
  assert(evaluator?.endedAt);
  const stopped = Date.parse(evaluator.endedAt) - Date.parse(budget.startedAt);
  console.log(JSON.stringify({ case: "aggregate wall", status: budget.status, reason: budget.reason, launches: containers.length - start,
    completed: budget.pipeline?.completed.length, elapsed, stopped, evaluatorExit: evaluator.exitCode, metrics: budget.metrics.length }));
  assert.equal(budget.status, "failed");
  assert.equal(budget.reason, "wall-clock");
  assert.equal(containers.length - start, 3);
  assert.equal(budget.metrics.length, 0);
  assert.equal(evaluator.exitCode, 137);
  assert(stopped <= 74_000, `Evaluator stopped after ${stopped} ms`);
}

async function verifyLiveWriter(dir: string): Promise<void> {
  const live = await runAttempt(dir, { repo, commit, seed: 2, detach: true }, { actor, runner });
  assert.equal(live.status, "running");
  const studyId = live.studyId, attemptId = "5000000000000001";
  const writing = await runOnExecutor(executor, "docker", ["inspect", "--format", "{{.State.Running}}", live.stages.candidate!.containerId!], runner);
  assert.equal(writing.stdout.trim(), "true");
  await reconcileAttempts(dir, { actor, runner });
  const state = await retention({ op: "inspect", studyId });
  assert(!state.entries?.some(entry => entry.ref.attemptId === live.id));
  const workspace = join(executor.workdir, studyId, attemptId), target = join(workspace, "inputs");
  assert.equal((await runOnExecutor(executor, "mkdir", ["-m", "700", workspace], runner)).exitCode, 0);
  await retention({ op: "reserve", studyId, attemptId });
  const speculative = { attemptId: live.id, stage: "prepare", sha256: "0".repeat(64) };
  await assert.rejects(retention({ op: "materialize", studyId, attemptId, stage: "consumer", target,
    taskRoot: join(workspace, "task"), inputs: { rows: { ref: speculative, output: "rows" } } }), /retained source missing/);
  assert.equal((await runOnExecutor(executor, "test", ["!", "-e", target], runner)).exitCode, 0);
  await retention({ op: "release", studyId, attemptId });
  const stillWriting = await runOnExecutor(executor, "docker", ["inspect", "--format", "{{.State.Running}}", live.stages.candidate!.containerId!], runner);
  assert.equal(stillWriting.stdout.trim(), "true");
  await cancelAttempt(dir, live.id, "Synthetic live producer", { actor, runner });
  await reconcileAttempts(dir, { actor, runner });
  const cancelled = showAttempt(dir, live.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.pipeline?.completed.length, 0);
  console.log(JSON.stringify({ case: "live producer", running: true, consumerRefused: true, visibleSeals: 0, after: cancelled.status }));
}

async function retention(request: RetentionRequest, transport = runner) {
  return retainedOperation(executor, request, transport);
}
async function retryBusy(request: RetentionRequest) {
  for (let retry = 0; ; retry++) {
    try { return await retention(request); }
    catch (error) {
      if (!(error instanceof RetentionError) || error.code !== "busy" || retry >= 8) throw error;
      await Bun.sleep(100);
    }
  }
}

async function raceRetention(source: Attempt): Promise<void> {
  const studyId = source.studyId;
  const reference = source.pipeline!.completed[0]!.ref;
  const verified = await retention({ op: "verify", studyId, ref: reference });
  assert(verified.manifest);
  const { identity, observed } = verified.manifest;
  const consumer = "3000000000000002";
  const workspace = join(executor.workdir, studyId, consumer);
  const refs: RetainedRef[] = [];
  for (const producer of ["3000000000000001", "3000000000000003"]) {
    const output = join(executor.workdir, studyId, producer, "output");
    const setup = await runOnExecutor(executor, "sh", ["-ec", 'umask 077; mkdir -p "$1" "$2"; printf 1 > "$1/rows.txt"', "race-fixture", output, workspace], runner);
    assert.equal(setup.exitCode, 0);
    await retention({ op: "reserve", studyId, attemptId: producer });
    for (let index = 0; index < 10; index++) {
      const stage = `race-${index}`;
      const sealed = await retention({ op: "seal", studyId, attemptId: producer, stage, source: output, outputs: { rows: "rows.txt" }, identity, observed });
      assert(sealed.sha256);
      refs.push({ attemptId: producer, stage, sha256: sealed.sha256 });
    }
    await retention({ op: "release", studyId, attemptId: producer });
  }
  await retention({ op: "reserve", studyId, attemptId: consumer });
  let pruneWins = 0, consumeWins = 0;
  for (const [index, ref] of refs.entries()) {
    const target = join(workspace, `${ref.attemptId}-${ref.stage}`);
    const preview = await retention({ op: "prune", studyId, refs: [ref] });
    assert(preview.fingerprint);
    const prune: RetentionRequest = { op: "prune", studyId, refs: [ref], fingerprint: preview.fingerprint };
    const consume: RetentionRequest = { op: "materialize", studyId, attemptId: consumer, stage: ref.stage, target,
      taskRoot: join(workspace, "task"), inputs: { rows: { ref, output: "rows" } } };
    const operations = index % 2 ? [prune, consume] : [consume, prune];
    const [first, second] = await Promise.allSettled(operations.map(retryBusy));
    const [pruned, consumed] = index % 2 ? [first, second] : [second, first];
    assert(pruned && consumed);
    if (pruned.status === "fulfilled") {
      assert.equal(pruned.value.pruned, 1);
      assert.equal(consumed.status, "rejected");
      assert.match(String(consumed.reason), /pruned/);
      const state = await retention({ op: "inspect", studyId });
      assert(state.entries?.some(entry => entry.ref.sha256 === ref.sha256 && entry.tombstone));
      assert.equal((await runOnExecutor(executor, "test", ["!", "-e", target], runner)).exitCode, 0);
      pruneWins++;
    } else {
      assert.match(String(pruned.reason), /active producer or consumer/);
      assert.equal(consumed.status, "fulfilled");
      assert.equal(consumed.value.inputHashes?.rows, ref.sha256);
      await retention({ op: "verify", studyId, ref });
      consumeWins++;
    }
  }
  await retention({ op: "release", studyId, attemptId: consumer });
  console.log(JSON.stringify({ case: "prune-consume race", rounds: refs.length, pruneWins, consumeWins }));
}

async function killRetentionWorkers(dir: string, source: Attempt): Promise<void> {
  const studyId = source.studyId, ref = source.pipeline!.completed[0]!.ref;
  const verified = await retention({ op: "verify", studyId, ref });
  assert(verified.manifest);
  const { identity, observed } = verified.manifest;
  async function workerFixture(attemptId: string) {
    const workspace = join(executor.workdir, studyId, attemptId);
    const output = join(workspace, "output");
    const setup = await runOnExecutor(executor, "sh", ["-ec",
      'umask 077; mkdir -p "$1"; printf 1 > "$1/rows.txt"', "kill-fixture", output], runner);
    assert.equal(setup.exitCode, 0);
    await retention({ op: "reserve", studyId, attemptId });
    return { workspace, output };
  }
  async function reconcileWorker() {
    await reconcileAttempts(dir, { actor, runner });
    assert.equal((await retention({ op: "inspect", studyId })).reservedBytes, 0);
  }
  for (const [point, marker, attemptId] of [
    ["seal", "files,dirs,total=inventory(data)", "4000000000000001"],
    ["publication", "state['entries'][k]={'attemptId':aid", "4000000000000002"],
  ] as const) {
    const { output } = await workerFixture(attemptId);
    const stage = `kill-${point}`;
    const request = { op: "seal", studyId, attemptId, stage, source: output, outputs: { rows: "rows.txt" }, identity, observed } as const;
    await killWorker(request, marker, point === "publication" ? "os.rename(tmp,final);syncdir(parent)" : undefined);
    const inventory = await retention({ op: "inspect", studyId });
    assert(!inventory.entries?.some(entry => entry.ref.attemptId === attemptId && entry.ref.stage === stage));
    if (point === "publication") {
      const manifest = join(executor.workdir, studyId, ".retained", "objects", attemptId, stage, "manifest.json");
      const digest = await runOnExecutor(executor, "sha256sum", [manifest], runner);
      assert.equal(digest.exitCode, 0);
      const sha = digest.stdout.split(/\s+/)[0]!;
      assert.match(sha, /^[a-f0-9]{64}$/);
      await assert.rejects(retention({ op: "verify", studyId, ref: { attemptId, stage, sha256: sha } }), /retained source missing/);
    }
    const saved = await retention(request);
    assert(saved.sha256);
    await retention({ op: "verify", studyId, ref: { attemptId, stage, sha256: saved.sha256 } });
    await reconcileWorker();
    console.log(JSON.stringify({ case: "executor SIGKILL", point, visibleBeforeRetry: 0, exactRetryVerified: true, reservedAfterReconcile: 0 }));
  }
  const attemptId = "4000000000000003";
  const { workspace } = await workerFixture(attemptId);
  const target = join(workspace, "kill-consume");
  const consume = { op: "materialize", studyId, attemptId, stage: "kill-consume", target, taskRoot: join(workspace, "task"),
    inputs: { rows: { ref, output: "rows" } } } as const;
  await killWorker(consume, "hashes={};payload_hashes={};total=0;count=0");
  assert.equal((await runOnExecutor(executor, "test", ["!", "-e", target], runner)).exitCode, 0);
  assert.equal((await retention(consume)).inputHashes?.rows, ref.sha256);
  await reconcileWorker();
  console.log(JSON.stringify({ case: "executor SIGKILL", point: "consumption", targetBeforeRetry: false, exactRetryVerified: true, reservedAfterReconcile: 0 }));

  const preview = await retention({ op: "prune", studyId, refs: [ref] });
  assert(preview.fingerprint);
  const pruning = { op: "prune", studyId, refs: [ref], fingerprint: preview.fingerprint } as const;
  await killWorker({ ...pruning, refs: [ref] }, "if os.path.exists(data): writable_remove(data)");
  assert((await retention({ op: "inspect", studyId })).entries?.some(entry => entry.ref.sha256 === ref.sha256 && entry.tombstone));
  await assert.rejects(retention({ op: "verify", studyId, ref }), /pruned/);
  const retry = await retention({ op: "prune", studyId, refs: [ref] });
  assert.equal((await retention({ op: "prune", studyId, refs: [ref], fingerprint: retry.fingerprint! })).pruned, 1);
  await reconcileWorker();
  console.log(JSON.stringify({ case: "executor SIGKILL", point: "prune", tombstoneVisible: true, consumable: false, exactRetryVerified: true, reservedAfterReconcile: 0 }));
}

async function killWorker(request: RetentionRequest, marker: string, previous?: string): Promise<void> {
  const lines = RETENTION_SCRIPT.split("\n");
  const hits = lines.flatMap((line, index) => line.trim().startsWith(marker) &&
    (previous === undefined || lines[index - 1]?.trim() === previous) ? [index + 1] : []);
  assert.equal(hits.length, 1, marker);
  const hook = `import os, signal, sys
def trace(frame, event, arg):
    if event == 'line' and frame.f_code.co_filename == '<retention-fixture>' and frame.f_lineno == ${hits[0]}:
        print('retention kill point reached', flush=True)
        os.kill(os.getpid(), signal.SIGKILL)
    return trace
sys.settrace(trace)
exec(compile(${JSON.stringify(RETENTION_SCRIPT)}, '<retention-fixture>', 'exec'))
`;
  const result = await runOnExecutor(executor, "sh", ["-c", 'python3 -I -S -c "$1" "$2"; exit "$?"', "retention-trace", hook, executor.workdir], runner,
    { stdin: Buffer.from(JSON.stringify(request)), timeoutMs: 30_000 });
  assert.equal(result.stdout.trim(), "retention kill point reached");
  assert.equal(result.exitCode, 137, `Expected remote worker SIGKILL at ${marker}, received ${result.exitCode}: ${result.stderr.slice(0, 200)}`);
}

async function controllerCrashes(): Promise<void> {
  assert.equal((await runOnExecutor(executor, "docker", ["image", "inspect", image])).exitCode, 0);
  const prepare = { ...stage, name: "prepare", inputs: {}, outputs: { rows: "rows.txt" },
    command: command(policyProbe + "printf 1 > /out/rows.txt") };
  const consume = { ...stage, name: "consume", needs: ["prepare"], inputs: { rows: { stage: "prepare", output: "rows" } },
    outputs: { copied: "copy.txt" }, command: command(policyProbe + "cat /in/rows > /out/copy.txt") };
  const evaluator = { image, command: command(policyProbe + 'test "$(cat /candidate/consume/copy.txt)" = 1; printf \'{"score":1}\' > /result/metrics.json') };
  const proof = { ...protocol, v: 2, limits: { ...protocol.limits, wallSeconds: 2300 }, candidate: { stages: [prepare, consume] }, evaluator };
  const childCode = `
import { runAttempt } from "./src/exp/attempts.ts";
import { spawnRunner } from "./src/exp/executor.ts";
import { retentionPrune } from "./src/commands.ts";
const [dir, repo, commit, point, pruneOptions] = process.argv.slice(1);
const runner = async request => {
  const raw = request.args[3] === "python3" && request.stdin instanceof Uint8Array ? JSON.parse(Buffer.from(request.stdin).toString()) : null;
  if ((point === "seal" && raw?.op === "seal") || (point === "consumption" && raw?.op === "materialize" && raw.stage === "consume")) {
    process.kill(process.pid, "SIGKILL");
  }
  const result = await spawnRunner(request);
  if (((point === "publication" && raw?.op === "seal") || (point === "prune" && raw?.op === "prune" && raw.fingerprint)) && result.exitCode === 0) process.kill(process.pid, "SIGKILL");
  return result;
};
const context = { actor: { kind: "person" }, runner };
if (point === "prune") await retentionPrune(dir, JSON.parse(pruneOptions), context);
else await runAttempt(dir, { repo, commit }, context);
`;
  const cleanupStudies: string[] = [];
  const recoveries: Array<{ after: number; run: () => Promise<void> }> = [];
  const claimExpiry = (dir: string, file: string, staleMs: number) => {
    const path = join(dir, file);
    return existsSync(path) ? statSync(path).mtimeMs + staleMs + 1000 : Date.now();
  };
  try {
    for (const point of ["seal", "publication", "consumption", "prune"] as const) {
      const dir = join(root, `controller-${point}`);
      init(dir, { question: "Synthetic controller interruption?", mode: "experiment" }, { actor });
      mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
      writeFileSync(join(dir, "task", "evaluator", "private"), "synthetic evaluator");
      await withLock(dir, () => {
        setProtocol(dir, proof, actor);
        setExecutor(dir, executor, actor);
      });
      await gateDecide(dir, "design", "approve", undefined, ctx);
      const studyId = openStudy(dir).study.id;
      cleanupStudies.push(studyId);
      if (point === "prune") {
        const source = await runAttempt(dir, { repo, commit }, { actor, runner });
        assert.equal(source.status, "succeeded", source.error ?? "Prune source failed");
        const ref = source.pipeline!.completed[0]!.ref;
        const preview = await retentionPrune(dir, { refs: [ref] }, { ...ctx, runner });
        const child = Bun.spawn(["bun", "-e", childCode, dir, repo, commit, point,
          JSON.stringify({ refs: [ref], fingerprint: preview.fingerprint })], { stdout: "inherit", stderr: "inherit" });
        const code = await child.exited;
        assert.equal(child.signalCode, "SIGKILL", `Prune controller exit: ${code}`);
        assert(!readLedger(dir).some(event => event.type === "retention.pruned"));
        const inventory = await retention({ op: "inspect", studyId });
        assert(inventory.entries?.some(entry => entry.ref.sha256 === ref.sha256 && entry.tombstone));
        await assert.rejects(retention({ op: "verify", studyId, ref }), /pruned/);
        await reconcileAttempts(dir, { actor, runner });
        const after = claimExpiry(dir, ".ares.lock", 10 * 60_000);
        await assert.rejects(retentionPrune(dir, { refs: [ref], fingerprint: preview.fingerprint! }, { ...ctx, runner }), /locked/);
        console.log(JSON.stringify({ case: "controller SIGKILL observed", point, visibleTombstone: true, blockedByClaim: true }));
        recoveries.push({ after, run: async () => {
          const refreshed = await retentionPrune(dir, { refs: [ref] }, { ...ctx, runner });
          await retentionPrune(dir, { refs: [ref], fingerprint: refreshed.fingerprint! }, { ...ctx, runner });
          assert(readLedger(dir).some(event => event.type === "retention.pruned"));
          console.log(JSON.stringify({ case: "controller SIGKILL", point, tombstoneVisible: true, consumable: false, auditReceiptRecovered: true }));
        } });
        continue;
      }
      const child = Bun.spawn(["bun", "-e", childCode, dir, repo, commit, point], { stdout: "inherit", stderr: "inherit" });
      const code = await child.exited;
      assert.equal(child.signalCode, "SIGKILL", `Controller exit: ${code}`);
      const before = listAttempts(dir).attempts;
      assert.equal(before.length, 1);
      const interrupted = before[0]!;
      assert.equal(interrupted.status, "running");
      const state = await retention({ op: "inspect", studyId });
      const visible = state.entries?.filter(entry => entry.ref.attemptId === interrupted.id) ?? [];
      assert.equal(visible.length, point === "seal" ? 0 : 1);
      assert.equal(interrupted.pipeline?.completed.length, point === "consumption" ? 1 : 0);
      if (point === "consumption") {
        const target = join(executor.workdir, studyId, interrupted.id, "stages", "consume", "inputs");
        assert.equal((await runOnExecutor(executor, "test", ["!", "-e", target], runner)).exitCode, 0);
      }
      for (const entry of visible) await retention({ op: "verify", studyId, ref: entry.ref });
      const claim = join(dir, ".ares.control.lock");
      const blocked = existsSync(claim);
      const after = claimExpiry(dir, ".ares.control.lock", CONTROL_STALE_MS);
      if (blocked) await assert.rejects(reconcileAttempts(dir, { actor, runner }), /another operation is active/);
      console.log(JSON.stringify({ case: "controller SIGKILL observed", point, visible: visible.length, blockedByClaim: blocked }));
      recoveries.push({ after, run: async () => {
        let current = interrupted;
        for (let retry = 0; retry < 15 && current.status === "running"; retry++) {
          await reconcileAttempts(dir, { actor, runner });
          current = showAttempt(dir, interrupted.id);
          if (current.status === "running") await Bun.sleep(500);
        }
        assert.equal(current.status, "succeeded", current.error ?? "Controller reconciliation failed");
        assert.equal(listAttempts(dir).attempts.length, 1);
        assert.equal(current.pipeline?.completed.length, 2);
        console.log(JSON.stringify({ case: "controller SIGKILL", point, visible: visible.length,
          recordedStages: interrupted.pipeline?.completed.length, reconciled: current.status, metrics: current.metrics[0]?.value }));
      } });
    }
    for (const recovery of recoveries.sort((left, right) => left.after - right.after)) {
      await Bun.sleep(Math.max(0, recovery.after - Date.now()));
      await recovery.run();
    }
  } finally {
    for (const studyId of cleanupStudies) {
      const owned = await runOnExecutor(executor, "docker", ["ps", "-aq", "--filter", `label=ares.study=${studyId}`], runner);
      assert.equal(owned.exitCode, 0);
      for (const id of owned.stdout.trim().split(/\s+/).filter(Boolean)) {
        assert.match(id, /^[a-f0-9]{12,64}$/);
        await runOnExecutor(executor, "docker", ["rm", "-f", id], runner);
      }
    }
  }
}

try { await (process.argv[5] === "--controller-crashes" ? controllerCrashes() : process.argv[5] === "--follow-up" ? verifyFollowUp() : main()); }
finally {
  for (const id of containers) await runOnExecutor(executor, "docker", ["rm", "-f", id]);
  rmSync(root, { recursive: true, force: true });
}
