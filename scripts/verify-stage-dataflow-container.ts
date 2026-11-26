import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateDecide, init } from "../src/commands.ts";
import { cancelAttempt, reconcileAttempts, runAttempt, showAttempt } from "../src/exp/attempts.ts";
import { runOnExecutor, setExecutor, spawnRunner, type Executor, type ProcessRunner } from "../src/exp/executor.ts";
import { canonical, setProtocol } from "../src/exp/protocol.ts";
import { RETENTION_RESERVATION, retainedOperation } from "../src/exp/retention.ts";
import { readLedger, sha256, withLock } from "../src/study.ts";

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

try { await main(); }
finally {
  for (const id of containers) await runOnExecutor(executor, "docker", ["rm", "-f", id]);
  rmSync(root, { recursive: true, force: true });
}
