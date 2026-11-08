import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { autonomySet, init, gateDecide, gateList, planSet, planControl, planShow, planRun, finalSeeds, selection, investigateClose } from "../src/commands.ts";
import { attemptId, budgetUsage, cancelAttempt, CONTROL_STALE_MS, CONTROL_FUTURE_SKEW_MS, listAttempts, reconcileAttempts, runAttempt, showAttempt, type AttemptContext, type Evaluation } from "../src/exp/attempts.ts";
import { setExecutor, type ProcessRequest, type ProcessResult, type ProcessRunner } from "../src/exp/executor.ts";
import { protocolHash, setProtocol, type Protocol } from "../src/exp/protocol.ts";
import { finalGateBinding } from "../src/exp/final.ts";
import { readTextBounded, readLedger, sha256, withLock, appendEvent, openStudy } from "../src/study.ts";
import { deferred, fakeHttp, tempDir } from "./helpers.ts";
import { logCaptureFixtureRunner, metricLogTar, metricTar } from "./metric-fixtures.ts";
import { collectStageEvidence, EvidenceError, LOG_COPY_BYTES } from "../src/exp/metrics.ts";

const actor = { kind: "person" as const }, commitSha = "a".repeat(40), treeId = "b".repeat(40);
function protocol(): Protocol {
  const image = `fixture@sha256:${"a".repeat(64)}`;
  return { v: 1, method: "synthetic", candidate: { image, command: ["/candidate"] }, evaluator: { image, command: ["/evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1, 2, 3, 4, 5, 6], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 10, maxWallHours: 1, maxGpuHours: 0 } };
}
interface FakeContainer { id: string; args: string[]; running: boolean; exitCode: number; startedAt: string; finishedAt?: string }
function runtime(dir: string) {
  const requests: ProcessRequest[] = [], containers = new Map<string, FakeContainer>();
  const clock = { value: Date.parse("2030-01-01T00:00:00Z") };
  let beforeResolve: (() => Promise<void>) | undefined, runFailure = false, daemonDown = false, lostStartResponse = false, versionFailure = false;
  let inputHash = "a".repeat(64);
  let metricsPayload: string | null = '{"score":7}';
  const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
  const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;
  const runner: ProcessRunner = async request => {
    expect(existsSync(join(dir, ".ares.lock"))).toBe(false); requests.push(request);
    const args = request.args;
    if (request.command === "python3") return ok(args.at(-1)!.startsWith("/") ? JSON.stringify({ sha256: inputHash, files: 2, bytes: 123 }) : "");
    if (request.command === "git") {
      if (args.includes("cat-file")) { const hook = beforeResolve; beforeResolve = undefined; await hook?.(); return ok("commit"); }
      if (args.includes("rev-parse")) return ok(treeId);
      if (args.includes("archive")) { await request.stdoutSink!(Buffer.from([0, 255, 1])); return ok(); }
    }
    if (request.command === "tar") {
      if (request.stdoutSink) await request.stdoutSink(Buffer.from([0, 128, 2]));
      else for await (const _chunk of request.stdin as AsyncIterable<Uint8Array>) { /* consume without real extraction */ }
      return ok();
    }
    if (request.command === "sh") {
      if (request.stdoutSink) {
        const stage = args.join(" ").includes("candidate.stdout.log") ? "candidate" : "evaluator";
        await request.stdoutSink(metricLogTar(stage, `${stage} score=999\nGET https://api.example.test/private?query=sensitive\n{"body":"synthetic-response-body","API_KEY":"synthetic-key-value"}\n`));
      }
      return ok();
    }
    if (request.command === "id") return ok("1001");
    if (request.command === "docker") {
      if (daemonDown && ["ps", "inspect"].includes(args[0]!)) return { exitCode: 1, stdout: "", stderr: "synthetic daemon unavailable" };
      if (args[0] === "version") return versionFailure ? { exitCode: 1, stdout: "", stderr: "synthetic-sensitive-version-error" } : ok("29.1.3");
      if (args[0] === "image") return ok("sha256:synthetic");
      if (args[0] === "cp") {
        const entries = args[1]!.endsWith(":/result/.") ? (metricsPayload === null ? [] : [{ path: "metrics.json", data: metricsPayload }]) : [{ path: "candidate.txt", data: "candidate score=999" }];
        await request.stdoutSink!(metricTar(entries)); return ok();
      }
      if (args[0] === "run") {
        const name = value(args, "--name");
        if (runFailure || containers.has(name)) return { exitCode: 125, stdout: "", stderr: "synthetic error must stay private" };
        const container = { id: sha256(name + args.join("|")), args, running: true, exitCode: 0, startedAt: new Date(clock.value).toISOString() };
        containers.set(name, container);
        if (lostStartResponse) { lostStartResponse = false; throw new Error("synthetic dropped response"); }
        return ok(container.id);
      }
      if (args[0] === "kill") {
        const target = args[1]!, found = containers.get(target) ?? [...containers.values()].find(c => c.id === target);
        if (!found) return { exitCode: 1, stdout: "", stderr: "missing" };
        found.running = false; found.exitCode = 137; found.finishedAt = new Date(clock.value).toISOString(); return ok();
      }
      if (args[0] === "inspect") {
        const found = containers.get(args.at(-1)!); if (!found) return { exitCode: 1, stdout: "", stderr: "missing" };
        const a = found.args, imageAt = a.findIndex(x => x.includes("@sha256:"));
        const mounts = a.flatMap((x, i) => x === "--mount" ? [a[i + 1]!] : []).map(text => {
          const parts = text.split(","); return { Type: "bind", Source: parts.find(x => x.startsWith("src="))!.slice(4), Destination: parts.find(x => x.startsWith("dst="))!.slice(4), RW: !parts.includes("readonly") };
        });
        const labels = Object.fromEntries(a.flatMap((x, i) => x === "--label" ? [a[i + 1]!] : []).map(x => { const index = x.indexOf("="); return [x.slice(0, index), x.slice(index + 1)]; }));
        const seed = a.flatMap((x, i) => x === "--env" ? [a[i + 1]!] : []).find(x => x.startsWith("ARES_SEED="));
        return ok(JSON.stringify([{ Id: found.id, State: { Running: found.running, ExitCode: found.exitCode, StartedAt: found.startedAt, ...(found.finishedAt ? { FinishedAt: found.finishedAt } : {}) }, Config: { Seed: seed, Image: a[imageAt], User: value(a, "--user"), Cmd: a.slice(imageAt + 1), Labels: labels }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Tmpfs: { "/tmp": "" }, Memory: Number.parseInt(value(a, "--memory")) * 1024 * 1024, PidsLimit: Number(value(a, "--pids-limit")), NanoCpus: Number(value(a, "--cpus")) * 1e9, DeviceRequests: a.includes("--gpus") ? [{ Count: Number(value(a, "--gpus")), Capabilities: [["gpu"]] }] : [] }, Mounts: mounts }]));
      }
      if (args[0] === "ps") return ok([...containers.entries()].filter(([name]) => args.includes(`name=^/${name}$`)).map(([, c]) => c.id).join("\n"));
    }
    throw new Error(`unscripted synthetic process ${request.command}`);
  };
  const ctx: AttemptContext = { actor, runner, now: () => clock.value, collectEvaluation: async () => ({ metrics: [{ name: "score", unit: "points", value: 7, provenance: "ares-observed" }], outputs: [] }), collectStageEvidence: async (_attempt, stage) => {
    const log = { path: `/synthetic/${stage}.log`, sha256: sha256(""), bytes: 0, truncated: false };
    return { logs: { stdout: log, stderr: log }, outputs: [] };
  } };
  return { requests, containers, clock, ctx, inputHash: (hash: string) => { inputHash = hash; }, resolveHook: (hook: () => Promise<void>) => { beforeResolve = hook; }, failRun: () => { runFailure = true; }, failVersion: () => { versionFailure = true; }, daemonDown: () => { daemonDown = true; }, loseStartResponse: () => { lostStartResponse = true; }, setMetrics: (payload: string | null) => { metricsPayload = payload; } };
}
async function setup(p = protocol(), autonomy = "gates", approved = true) {
  const dir = tempDir(); init(dir, { question: "Synthetic?", mode: "experiment", autonomy }, { actor });
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await withLock(dir, () => { setProtocol(dir, p, actor); setExecutor(dir, { v: 1, kind: "local", workdir: "/private/synthetic-executor" }, actor); });
  if (approved) await gateDecide(dir, "design", "approve", undefined, { actor, http: fakeHttp([]).http });
  return { dir, fake: runtime(dir) };
}
const request = { repo: "/synthetic/repo", commit: commitSha, detach: true };
const running = (fake: ReturnType<typeof runtime>, stage: string) => [...fake.containers.entries()].find(([name]) => name.endsWith(`-${stage}`))![1];

test("AC5: identity binds protocol, commit, tree, seed, run and retry; duplicate delivery creates once", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
  expect(first.status).toBe("running"); expect(first.snapshotSha256).toBe(sha256(Buffer.from([0, 255, 1])));
  const again = await runAttempt(dir, request, fake.ctx); expect(again.id).toBe(first.id);
  expect(fake.requests.filter(r => r.command === "docker" && r.args[0] === "run")).toHaveLength(1);
  expect(fake.requests.some(r => r.command === "sh" && r.args.join(" ").includes(`docker kill ${first.stages.candidate!.containerId}`))).toBe(true);
  expect(fake.requests.filter(r => r.args[0] === "inspect").every(r => r.args.includes("--format") && !r.args.join(" ").includes("{{json .Config.Env}}"))).toBe(true);
  expect(readLedger(dir).filter(e => e.type === "attempt.started")).toHaveLength(1);
  expect(first.id).toBe(attemptId(protocolHash(protocol()), commitSha, treeId, 1, "main"));
  for (const args of [["changed", commitSha, treeId, 1, "main"], [first.protocolHash, "c".repeat(40), treeId, 1, "main"], [first.protocolHash, commitSha, "c".repeat(40), 1, "main"], [first.protocolHash, commitSha, treeId, 2, "main"], [first.protocolHash, commitSha, treeId, 1, "other"]] as const) expect(attemptId(args[0], args[1], args[2], args[3], args[4])).not.toBe(first.id);
  await expect(runAttempt(dir, { ...request, seed: 2 }, fake.ctx)).rejects.toThrow("another attempt is running");
});

test("AC5: restart with a missing container becomes unknown lost and starts nothing; retry links a new attempt", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx), before = fake.requests.length;
  fake.containers.clear(); await reconcileAttempts(dir, fake.ctx);
  expect(showAttempt(dir, first.id).status).toBe("unknown"); expect(showAttempt(dir, first.id).reason).toBe("lost");
  expect(fake.requests.slice(before).some(r => r.args[0] === "run")).toBe(false);
  const retry = await runAttempt(dir, { ...request, retry: first.id }, fake.ctx);
  expect(retry.id).not.toBe(first.id); expect(retry.retryOf).toBe(first.id);
  expect((await runAttempt(dir, { ...request, retry: first.id }, fake.ctx)).id).toBe(retry.id);
});

test("candidate success starts a distinct evaluator, validated metrics alone succeed, completed reconcile is idempotent", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
  const candidate = running(fake, "candidate"); candidate.running = false; candidate.exitCode = 0; candidate.finishedAt = new Date(fake.clock.value + 1000).toISOString(); fake.clock.value += 1000;
  await reconcileAttempts(dir, fake.ctx);
  const middle = showAttempt(dir, first.id); expect(middle.stage).toBe("evaluator"); expect(middle.sealing).toEqual({ separateContainers: true, evaluatorReadOnly: true, candidateHasNoEvaluator: true, verifiedBy: "ares-observed" });
  const evaluator = running(fake, "evaluator"); evaluator.running = false; evaluator.finishedAt = new Date(fake.clock.value + 1000).toISOString(); fake.clock.value += 1000;
  await reconcileAttempts(dir, fake.ctx); const done = showAttempt(dir, first.id);
  expect(done.status).toBe("succeeded"); expect(done.metrics[0]?.value).toBe(7);
  const count = fake.requests.length; expect(await reconcileAttempts(dir, fake.ctx)).toEqual([]); expect(fake.requests).toHaveLength(count);
});

test("evaluator cannot succeed without a validated metrics collector", async () => {
  const { dir, fake } = await setup(); delete fake.ctx.collectEvaluation; fake.setMetrics(null);
  const first = await runAttempt(dir, request, fake.ctx); running(fake, "candidate").running = false;
  await reconcileAttempts(dir, fake.ctx); running(fake, "evaluator").running = false;
  await reconcileAttempts(dir, fake.ctx); expect(showAttempt(dir, first.id).reason).toBe("missing-metrics"); expect(showAttempt(dir, first.id).metrics).toEqual([]);
});

test("AC7: reconcile kills a running stage after its deadline and records wall-clock", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx); fake.clock.value += 60_001;
  await reconcileAttempts(dir, fake.ctx); const done = showAttempt(dir, first.id);
  expect(done.status).toBe("failed"); expect(done.reason).toBe("wall-clock");
  expect(fake.requests.some(r => r.args[0] === "kill" && r.args[1] === running(fake, "candidate").id)).toBe(true);
});

test("AC7: watchdog-killed stages remain wall-clock failures when observed after exit", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx), candidate = running(fake, "candidate");
  fake.clock.value += 60_000; candidate.running = false; candidate.exitCode = 137; candidate.finishedAt = new Date(fake.clock.value).toISOString();
  await reconcileAttempts(dir, fake.ctx); expect(showAttempt(dir, first.id).reason).toBe("wall-clock");
});

test("AC7: cancel kills running stage, records cancelled and repeated cancel creates no event", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
  expect((await cancelAttempt(dir, first.id, "synthetic stop", fake.ctx)).status).toBe("cancelled");
  expect(running(fake, "candidate").running).toBe(false); const count = readLedger(dir).length;
  await cancelAttempt(dir, first.id, undefined, fake.ctx); expect(readLedger(dir)).toHaveLength(count);
});

test("AC5/AC7: failed, cancelled and unknown records appear in totals and exhaust maxAttempts", async () => {
  const p = protocol(); p.budget.maxAttempts = 3;
  const { dir, fake } = await setup(p), first = await runAttempt(dir, request, fake.ctx);
  running(fake, "candidate").running = false; running(fake, "candidate").exitCode = 2;
  await reconcileAttempts(dir, fake.ctx); expect(showAttempt(dir, first.id).status).toBe("failed");
  const second = await runAttempt(dir, { ...request, seed: 2 }, fake.ctx); await cancelAttempt(dir, second.id, undefined, fake.ctx);
  const third = await runAttempt(dir, { ...request, seed: 3 }, fake.ctx); fake.containers.clear(); await reconcileAttempts(dir, fake.ctx);
  expect(showAttempt(dir, third.id).status).toBe("unknown");
  expect(listAttempts(dir, { status: "failed" }).totals).toEqual({ running: 0, succeeded: 0, failed: 1, cancelled: 1, unknown: 1 });
  await expect(runAttempt(dir, { ...request, seed: 4 }, fake.ctx)).rejects.toThrow("budget maxAttempts: exhausted");
});

test("AC7: wall and GPU budgets include terminal attempts and refuse before a new start", async () => {
  for (const gpu of [false, true]) {
    const p = protocol(); if (gpu) { p.limits.gpus = 2; p.budget.maxGpuHours = 0.001; } else p.budget.maxWallHours = 0.001;
    const { dir, fake } = await setup(p), first = await runAttempt(dir, request, fake.ctx); fake.clock.value += 5000;
    await cancelAttempt(dir, first.id, undefined, fake.ctx);
    await expect(runAttempt(dir, { ...request, seed: 2 }, fake.ctx)).rejects.toThrow(`budget ${gpu ? "maxGpuHours" : "maxWallHours"}: exhausted`);
  }
});

test("wall usage includes failed preparation even when no stage was created", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
  const synthetic = { ...first, stages: {}, status: "failed" as const, endedAt: new Date(fake.clock.value + 7200000).toISOString() };
  expect(budgetUsage([synthetic]).wallHours).toBe(2); expect(budgetUsage([synthetic]).attempts).toBe(1);
});

test("gate or invalid seed refuses before attempt event; a concurrent protocol change cannot bind stale bytes", async () => {
  const { dir, fake } = await setup(protocol(), "gates", false), initial = readLedger(dir).length;
  await expect(runAttempt(dir, request, fake.ctx)).rejects.toThrow("gate design is pending"); expect(readLedger(dir)).toHaveLength(initial);
  await expect(runAttempt(dir, { ...request, seed: 99 }, fake.ctx)).rejects.toThrow("seed: undeclared");
  await gateDecide(dir, "design", "approve", undefined, { actor, http: fakeHttp([]).http });
  fake.resolveHook(async () => { await withLock(dir, () => setProtocol(dir, { ...protocol(), method: "changed" }, actor)); await gateDecide(dir, "design", "approve", undefined, { actor, http: fakeHttp([]).http }); });
  await expect(runAttempt(dir, request, fake.ctx)).rejects.toThrow("changed while resolving the snapshot");
  expect(listAttempts(dir).attempts).toEqual([]);
});

test("name collision never kills another study's container", async () => {
  const { dir, fake } = await setup(); fake.failRun(); const first = await runAttempt(dir, request, fake.ctx);
  expect(first.status).toBe("failed"); expect(fake.requests.some(r => r.args[0] === "kill")).toBe(false);
});

test("daemon failure is not confirmed absence and does not free the active attempt", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx); fake.daemonDown();
  await expect(reconcileAttempts(dir, fake.ctx)).rejects.toThrow("executor local: reconcile failed");
  expect(showAttempt(dir, first.id).status).toBe("running");
  await expect(runAttempt(dir, { ...request, seed: 2 }, fake.ctx)).rejects.toThrow("another attempt is running");
});

test("a dropped Docker start response adopts the verified owned container instead of starting twice", async () => {
  const { dir, fake } = await setup(); fake.loseStartResponse();
  const first = await runAttempt(dir, request, fake.ctx);
  expect(first.status).toBe("running"); expect(first.stages.candidate?.containerId).toBe(running(fake, "candidate").id);
  expect(fake.requests.filter(r => r.args[0] === "run")).toHaveLength(1);
  expect(fake.requests.filter(r => r.args[0] === "kill")).toHaveLength(0);
});

test("GPU usage ends at observed stage finish, rather than delayed reconciliation", async () => {
  const p = protocol(); p.limits.gpus = 1; p.budget.maxGpuHours = 1;
  const { dir, fake } = await setup(p), first = await runAttempt(dir, request, fake.ctx), candidate = running(fake, "candidate");
  candidate.running = false; candidate.finishedAt = new Date(fake.clock.value + 1000).toISOString(); fake.clock.value += 7200000;
  await reconcileAttempts(dir, fake.ctx);
  const stage = showAttempt(dir, first.id).stages.candidate!;
  expect(Date.parse(stage.endedAt!) - Date.parse(stage.startedAt)).toBe(1000);
  expect(budgetUsage([showAttempt(dir, first.id)], fake.clock.value).gpuHours).toBeCloseTo(1 / 3600);
});

test("unchanged running polls leave both ledger and attempt file untouched", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
  const path = join(dir, "runs", first.run, "attempts", `${first.id}.json`), record = readFileSync(path), ledger = readFileSync(join(dir, "ledger.jsonl")), modified = statSync(path, { bigint: true }).mtimeNs;
  for (let i = 0; i < 50; i++) expect(await reconcileAttempts(dir, fake.ctx)).toEqual([]);
  expect(readFileSync(path)).toEqual(record); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  expect(statSync(path, { bigint: true }).mtimeNs).toBe(modified);
  expect(existsSync(join(dir, ".ares.control.lock"))).toBe(false);
});

test("expired launch owners recover despite a reused current PID or a foreign hostname", async () => {
  for (const host of [hostname(), "previous-controller-host"]) {
    const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
    first.launching = { pid: process.pid, host, token: "synthetic-stale-claim", claimedAt: new Date(fake.clock.value - CONTROL_STALE_MS - 1000).toISOString(), expiresAt: new Date(fake.clock.value - 1000).toISOString() };
    writeFileSync(join(dir, "runs", first.run, "attempts", `${first.id}.json`), JSON.stringify(first));
    fake.containers.clear(); await reconcileAttempts(dir, fake.ctx);
    expect(showAttempt(dir, first.id).status).toBe("unknown"); expect(showAttempt(dir, first.id).reason).toBe("lost");
    expect((await runAttempt(dir, { ...request, retry: first.id }, fake.ctx)).status).toBe("running");
  }
});

test("foreground waiting backs off from one to thirty seconds and resets at a stage transition", async () => {
  const p = protocol(); p.limits.wallSeconds = 3600;
  const { dir, fake } = await setup(p), delays: number[] = [];
  fake.ctx.sleep = async ms => {
    delays.push(ms); fake.clock.value += ms;
    if (delays.length === 7 || delays.length === 8) {
      const container = running(fake, delays.length === 7 ? "candidate" : "evaluator");
      container.running = false; container.finishedAt = new Date(fake.clock.value).toISOString();
    }
  };
  expect((await runAttempt(dir, { ...request, detach: false }, fake.ctx)).status).toBe("succeeded");
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 1000]);
});

test("T4 collector errors fail closed without copying raw diagnostics into the record", async () => {
  const { dir, fake } = await setup(); fake.ctx.collectEvaluation = async () => { throw new Error("synthetic-sensitive-evaluator-error"); };
  const first = await runAttempt(dir, request, fake.ctx); running(fake, "candidate").running = false;
  await reconcileAttempts(dir, fake.ctx); running(fake, "evaluator").running = false;
  await reconcileAttempts(dir, fake.ctx); const record = showAttempt(dir, first.id);
  expect(record.status).toBe("failed"); expect(record.stage).toBe("evaluator"); expect(record.reason).toBe("invalid-metrics");
  expect(record.metrics).toEqual([]); expect(JSON.stringify(record)).not.toContain("synthetic-sensitive");
});

test("an expired controller cannot overwrite a cancellation after its delayed collector returns", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
  running(fake, "candidate").running = false; await reconcileAttempts(dir, fake.ctx); running(fake, "evaluator").running = false;
  let ready!: () => void, release!: (value: Evaluation) => void;
  const entered = new Promise<void>(resolve => { ready = resolve; });
  fake.ctx.collectEvaluation = async () => { ready(); return new Promise<Evaluation>(resolve => { release = resolve; }); };
  const oldController = reconcileAttempts(dir, fake.ctx);
  await entered;
  const expired = new Date(Date.now() - CONTROL_STALE_MS - 1000); utimesSync(join(dir, ".ares.control.lock"), expired, expired);
  await cancelAttempt(dir, first.id, "new controller cancellation", fake.ctx);
  release({ metrics: [{ name: "score", unit: "points", value: 1, provenance: "ares-observed" }], outputs: [] });
  await expect(oldController).rejects.toThrow("ownership expired or changed");
  expect(showAttempt(dir, first.id).status).toBe("cancelled"); expect(showAttempt(dir, first.id).metrics).toEqual([]);
});

test("selected seeds reach both executed stages rather than only attempt metadata", async () => {
  const { dir, fake } = await setup();
  for (const seed of [1, 2]) {
    const attempt = await runAttempt(dir, { ...request, seed }, fake.ctx), candidate = fake.containers.get(`ares-${attempt.id}-candidate`)!;
    expect(attempt.status).toBe("running"); expect(candidate.args).toContain(`ARES_SEED=${seed}`);
    candidate.running = false; candidate.finishedAt = new Date(fake.clock.value).toISOString(); await reconcileAttempts(dir, fake.ctx);
    expect(fake.containers.get(`ares-${attempt.id}-evaluator`)!.args).toContain(`ARES_SEED=${seed}`);
    await cancelAttempt(dir, attempt.id, undefined, fake.ctx);
  }
});

test("auto design approval waits for verified candidate start and is absent after preparation/start failure", async () => {
  for (const failure of ["version", "run"] as const) {
    const { dir, fake } = await setup(protocol(), "auto", false);
    if (failure === "version") fake.failVersion(); else fake.failRun();
    expect((await runAttempt(dir, request, fake.ctx)).status).toBe("failed");
    expect(readLedger(dir).filter(e => e.type === "gate.approve")).toEqual([]);
    expect(gateList(dir).find(g => g.gate === "design")?.state).toBe("pending");
  }
  const { dir, fake } = await setup(protocol(), "auto", false);
  const result = await runAttempt(dir, request, fake.ctx), events = readLedger(dir), approval = events.findIndex(e => e.type === "gate.approve");
  expect(result.status).toBe("running"); expect(approval).toBeGreaterThan(events.findIndex(e => e.type === "attempt.started"));
  expect(events[approval + 1]?.type).toBe("attempt.stage.started"); expect(events[approval + 1]?.at).toBe(events[approval]?.at);
  expect(gateList(dir).find(g => g.gate === "design")?.state).toBe("approved");
});

test("interrupted running and exited stages recover complete receipts through succeeded", async () => {
  for (const exitedBeforeRecovery of [false, true]) {
    const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
    for (const stage of ["candidate", "evaluator"] as const) {
      const record = showAttempt(dir, first.id), container = fake.containers.get(`ares-${first.id}-${stage}`)!;
      delete record.stages[stage]!.containerId;
      record.stages[stage]!.startedAt = new Date(fake.clock.value - 1000).toISOString();
      if (stage === "candidate") record.sealing.candidateHasNoEvaluator = false;
      else { record.sealing.evaluatorReadOnly = false; record.sealing.separateContainers = false; }
      record.launching = { pid: process.pid, host: hostname(), token: "interrupted-launch", claimedAt: new Date(fake.clock.value - CONTROL_STALE_MS - 1000).toISOString(), expiresAt: new Date(fake.clock.value - 1).toISOString() };
      writeFileSync(join(dir, "runs", record.run, "attempts", `${record.id}.json`), JSON.stringify(record));
      if (exitedBeforeRecovery) { container.running = false; container.finishedAt = new Date(fake.clock.value).toISOString(); }
      await reconcileAttempts(dir, fake.ctx);
      const recovered = showAttempt(dir, first.id);
      expect(recovered.stages[stage]!.containerId).toBe(container.id); expect(recovered.stages[stage]!.startedAt).toBe(container.startedAt);
      if (!exitedBeforeRecovery) {
        container.running = false; container.finishedAt = new Date(fake.clock.value).toISOString(); await reconcileAttempts(dir, fake.ctx);
      }
    }
    const done = showAttempt(dir, first.id);
    expect(done.status).toBe("succeeded"); expect(done.stages.candidate?.containerId).not.toBe(done.stages.evaluator?.containerId);
    expect(done.sealing).toEqual({ separateContainers: true, evaluatorReadOnly: true, candidateHasNoEvaluator: true, verifiedBy: "ares-observed" });
  }
});

test("AC6: default collector records only evaluator metrics and complete stage/output evidence", async () => {
  const { dir, fake } = await setup(); delete fake.ctx.collectEvaluation; delete fake.ctx.collectStageEvidence;
  const first = await runAttempt(dir, request, fake.ctx); running(fake, "candidate").running = false;
  await reconcileAttempts(dir, fake.ctx); running(fake, "evaluator").running = false;
  await reconcileAttempts(dir, fake.ctx); const done = showAttempt(dir, first.id);
  expect(done.status).toBe("succeeded"); expect(done.metrics).toEqual([{ name: "score", unit: "points", value: 7, provenance: "ares-observed" }]);
  for (const stage of ["candidate", "evaluator"] as const) {
    const record = done.stages[stage]!; expect(record.containerId).toHaveLength(64); expect(record.exitCode).toBe(0); expect(record.endedAt).toBeDefined();
    expect(Object.keys(record.evidence!.logs.stdout).sort()).toEqual(["bytes", "path", "sha256", "truncated"]); expect(record.evidence!.logs.stdout.sha256).toHaveLength(64);
    expect(record.evidence!.logs.stdout.path).toContain(`/logs/${stage}.stdout.log`); expect(record.evidence!.logs.stdout.bytes).toBeGreaterThan(0);
    expect(record.evidence!.logs.stdout.truncated).toBe(false);
  }
  expect(done.outputs).toHaveLength(2); expect(done.outputs.every(file => file.sha256.length === 64 && Number.isSafeInteger(file.bytes))).toBe(true);
  expect(done.sealing).toEqual({ separateContainers: true, evaluatorReadOnly: true, candidateHasNoEvaluator: true, verifiedBy: "ares-observed" });
  for (const content of ["https://api.example.test", "synthetic-response-body", "synthetic-key-value", "score=999"]) expect(JSON.stringify(done)).not.toContain(content);
});

test("AC6: evaluator validation failures retain evaluator stage, named reason and no unvalidated numbers", async () => {
  for (const [payload, reason] of [[null, "missing-metrics"], ["synthetic-private-response-body", "malformed-metrics"], ['{"score":1,"extra":9}', "undeclared-metric"], ['{"score":1e999}', "nonfinite-metric"]] as const) {
    const { dir, fake } = await setup(); delete fake.ctx.collectEvaluation; fake.setMetrics(payload);
    const first = await runAttempt(dir, request, fake.ctx); running(fake, "candidate").running = false; await reconcileAttempts(dir, fake.ctx); running(fake, "evaluator").running = false;
    await reconcileAttempts(dir, fake.ctx); const done = showAttempt(dir, first.id);
    expect(done.status).toBe("failed"); expect(done.stage).toBe("evaluator"); expect(done.reason).toBe(reason); expect(done.metrics).toEqual([]);
    expect(done.error).toContain("write /result/metrics.json"); expect(JSON.stringify(done)).not.toContain("synthetic-private-response-body");
  }
});
test("evidence failure preserves observed exit and finish time instead of charging delayed GPU time", async () => {
  const p = protocol(); p.limits.gpus = 1; p.budget.maxGpuHours = 1;
  const { dir, fake } = await setup(p), first = await runAttempt(dir, request, fake.ctx), candidate = running(fake, "candidate");
  candidate.running = false; candidate.exitCode = 0; candidate.finishedAt = new Date(fake.clock.value + 1000).toISOString(); fake.clock.value += 7_200_000;
  fake.ctx.collectStageEvidence = async () => { throw new EvidenceError("invalid-artifact", "stage evidence: unsafe output; remove the link and retry"); };
  await reconcileAttempts(dir, fake.ctx); const done = showAttempt(dir, first.id);
  expect(done.status).toBe("failed"); expect(done.reason).toBe("invalid-artifact");
  expect(done.stages.candidate!.exitCode).toBe(0); expect(done.stages.candidate!.endedAt).toBe(candidate.finishedAt);
  expect(budgetUsage([done], fake.clock.value).gpuHours).toBeCloseTo(1 / 3600);
});
test("oversized stage logs are capped and marked truncated without failing a successful attempt", async () => {
  const { dir, fake } = await setup(), root = tempDir();
  await withLock(dir, () => setExecutor(dir, { v: 1, kind: "local", workdir: root }, actor));
  delete fake.ctx.collectEvaluation;
  fake.ctx.collectStageEvidence = async (attempt, stage, runner) => {
    mkdirSync(dirname(attempt.paths.snapshot), { recursive: true, mode: 0o700 });
    return collectStageEvidence(attempt, stage, logCaptureFixtureRunner(runner));
  };
  const first = await runAttempt(dir, request, fake.ctx); running(fake, "candidate").running = false;
  await reconcileAttempts(dir, fake.ctx);
  expect(showAttempt(dir, first.id)).toMatchObject({ status: "running", stage: "evaluator" });
  running(fake, "evaluator").running = false;
  await reconcileAttempts(dir, fake.ctx); const done = showAttempt(dir, first.id);
  expect(done.status).toBe("succeeded"); expect(done.metrics[0]?.value).toBe(7);
  for (const stage of ["candidate", "evaluator"] as const) {
    expect(done.stages[stage]!.evidence!.logs.stdout.bytes).toBe(LOG_COPY_BYTES);
    expect(done.stages[stage]!.evidence!.logs.stdout.truncated).toBe(true);
    expect(Object.keys(done.stages[stage]!.evidence!.logs.stdout).sort()).toEqual(["bytes", "path", "sha256", "truncated"]);
  }
}, 10_000);


test("plan cancellation uses attempt cancel, commits its receipt with the terminal record, and replays without executor access", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
  const ctx = { ...fake.ctx, http: fakeHttp([]).http };
  await planSet(dir, { v: 1, nodes: [{ id: "work", kind: "step", command: "attempt.run", args: { repo: request.repo, commit: request.commit } }], edges: [] }, ctx);
  appendEvent(dir, actor, "node.intent", { revision: 1, node: "work", dispatchId: "work-1", attemptId: first.id });
  const input = { action: "cancel" as const, node: "work", commandId: "cancel-work", expectedRevision: 1 };
  const result = await planControl(dir, input, ctx);
  expect(result.status).toBe("cancelled"); expect(showAttempt(dir, first.id).status).toBe("cancelled");
  expect(running(fake, "candidate").running).toBe(false);
  expect(listAttempts(dir, {}).totals.cancelled).toBe(1);
  const requests = fake.requests.length, events = readLedger(dir);
  expect(events.filter(e => e.type === "plan.control")).toHaveLength(1);
  expect(events.find(e => e.type === "plan.control")!.at).toBe(events.find(e => e.type === "attempt.cancelled")!.at);
  expect(await planControl(dir, input, ctx)).toEqual(result);
  expect(fake.requests).toHaveLength(requests); expect(readLedger(dir)).toEqual(events);
  expect(planShow(dir).nodes[0]!.status).toBe("cancelled");
});

test("failed plan cancellation records no control receipt; a later cancel can complete", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
  const ctx = { ...fake.ctx, http: fakeHttp([]).http };
  await planSet(dir, { v: 1, nodes: [{ id: "work", kind: "step", command: "attempt.run", args: { repo: request.repo, commit: request.commit } }], edges: [] }, ctx);
  appendEvent(dir, actor, "node.intent", { revision: 1, node: "work", dispatchId: "work-1", attemptId: first.id });
  const input = { action: "cancel" as const, node: "work", commandId: "cancel-work", expectedRevision: 1 };
  const badCtx = { ...ctx, runner: async () => { throw new Error("synthetic unreachable executor"); } };
  await expect(planControl(dir, input, badCtx)).rejects.toThrow();
  expect(readLedger(dir).filter(e => e.type === "plan.control")).toHaveLength(0);
  expect(planShow(dir).nodes[0]!.status).toBe("dispatched");
  expect((await planControl(dir, input, ctx)).status).toBe("cancelled");
});


test("plan retry passes the previous attempt id and creates a child instead of reusing the terminal attempt", async () => {
  const { dir, fake } = await setup(), first = await runAttempt(dir, request, fake.ctx);
  await cancelAttempt(dir, first.id, undefined, fake.ctx);
  const ctx = { ...fake.ctx, http: fakeHttp([]).http };
  await planSet(dir, { v: 1, nodes: [{ id: "work", kind: "step", command: "attempt.run", args: { repo: request.repo, commit: request.commit } }], edges: [] }, ctx);
  appendEvent(dir, actor, "node.intent", { revision: 1, node: "work", dispatchId: "work-1", attemptId: first.id });
  appendEvent(dir, actor, "node.observed", { revision: 1, node: "work", dispatchId: "work-1", status: "cancelled" });
  await planControl(dir, { action: "retry", node: "work", commandId: "retry-work", expectedRevision: 1 }, ctx);
  const node = planShow(dir).nodes[0]!;
  expect(node.retryOf).toBe(first.id);
  const child = await runAttempt(dir, { ...request, retry: node.retryOf! }, fake.ctx);
  expect(child.id).not.toBe(first.id); expect(child.retryOf).toBe(first.id);
  expect(child.status).toBe("running"); expect(listAttempts(dir).totals).toMatchObject({ running: 1, cancelled: 1 });
});


test("plan controller commits expected attempt id, always detaches and reconciles the recorded attempt", async () => {
  const { dir, fake } = await setup();
  const ctx = { ...fake.ctx, http: fakeHttp([]).http };
  await planSet(dir, { v: 1, nodes: [{ id: "work", kind: "step", command: "attempt.run", args: { repo: request.repo, commit: request.commit } }], edges: [] }, ctx);
  let resumed = false, intentSeen = false;
  const original = fake.ctx.runner!;
  const state = await planRun(dir, {}, { ...ctx,
    runner: async r => {
      if (r.command === "docker" && r.args[0] === "run") {
        const intent = readLedger(dir).find(e => e.type === "node.intent")!;
        expect(intent.data.attemptId).toMatch(/^[a-f0-9]{16}$/); intentSeen = true;
      }
      return original(r);
    },
    sleep: async () => {
      if (!resumed) { resumed = true; await planControl(dir, { action: "resume", commandId: "resume-controller", expectedRevision: 1 }, ctx); }
      for (const container of fake.containers.values()) { container.running = false; container.exitCode = 0; }
      await Bun.sleep(1);
    },
  });
  expect(state.state).toBe("done"); expect(intentSeen).toBe(true);
  expect(state.nodes[0]!.output).toMatchObject({ attemptId: readLedger(dir).find(e => e.type === "node.intent")!.data.attemptId });
});

test("expected attempt identity drift refuses before creating an attempt", async () => {
  const { dir, fake } = await setup();
  const before = readLedger(dir);
  await expect(runAttempt(dir, { ...request, expectedId: "0".repeat(16) }, fake.ctx)).rejects.toThrow("changed since plan intent");
  expect(listAttempts(dir).attempts).toHaveLength(0); expect(readLedger(dir)).toEqual(before);
  expect(fake.requests.some(r => r.command === "docker")).toBe(false);
});


test("controller retry of a predicted but uncreated attempt launches without a nonexistent parent", async () => {
  const { dir, fake } = await setup(protocol(), "gates", false);
  const ctx = { ...fake.ctx, http: fakeHttp([]).http };
  await planSet(dir, { v: 1, nodes: [{ id: "work", kind: "step", command: "attempt.run", args: { repo: request.repo, commit: request.commit } }], edges: [] }, ctx);
  const stop = new AbortController(); let resumed = false;
  const first = await planRun(dir, {}, { ...ctx, signal: stop.signal,
    sleep: async () => {
      if (!resumed) { resumed = true; await planControl(dir, { action: "resume", commandId: "resume-missing", expectedRevision: 1 }, ctx); }
      if (planShow(dir).nodes[0]!.status === "uncertain") stop.abort();
      await Bun.sleep(1);
    },
  });
  const predicted = first.nodes[0]!.attemptId!;
  expect(first.nodes[0]!.status).toBe("uncertain"); expect(listAttempts(dir).attempts).toHaveLength(0);
  await gateDecide(dir, "design", "approve", undefined, ctx);
  await planControl(dir, { action: "retry", node: "work", commandId: "retry-uncreated", expectedRevision: 1 }, ctx);
  expect(planShow(dir).nodes[0]!.retryOf).toBe(predicted);
  resumed = false;
  const second = await planRun(dir, {}, { ...ctx,
    sleep: async () => {
      if (!resumed) { resumed = true; await planControl(dir, { action: "resume", commandId: "resume-after-retry", expectedRevision: 1 }, ctx); }
      for (const container of fake.containers.values()) { container.running = false; container.exitCode = 0; }
      await Bun.sleep(1);
    },
  });
  expect(second.state).toBe("done");
  const attempt = showAttempt(dir, second.nodes[0]!.attemptId!);
  expect(attempt.id).toBe(predicted); expect(attempt.retryOf).toBeUndefined();
});


async function finalReady(autonomy = "gates", approved = true) {
  const p = protocol(), { dir, fake } = await setup(p, autonomy, false), ctx = { ...fake.ctx, http: fakeHttp([]).http }, winner = "e".repeat(40);
  await finalSeeds(dir, { v: 1, seeds: [5] }, ctx);
  await selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: commitSha }, minSeeds: 1, minDelta: 1 }, ctx);
  const folder = join(dir, "runs", "investigate", "attempts"); mkdirSync(folder, { recursive: true });
  for (const [n, commit, value] of [[1, commitSha, 1], [2, winner, 2]] as const) {
    const id = `f${String(n).padStart(15, "0")}`;
    writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run: "investigate", commit, seed: 1, protocolHash: protocolHash(p), protocol: p, executor: {}, stages: {}, stage: "evaluator", status: "succeeded", startedAt: "2030-01-01T00:00:00Z", metrics: [{ name: "score", value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
    appendEvent(dir, actor, "attempt.started", { id, run: "investigate", commit, seed: 1 });
  }
  await investigateClose(dir, ctx);
  if (approved) { await gateDecide(dir, "design", "approve", undefined, ctx); await gateDecide(dir, "final", "approve", undefined, ctx); }
  return { dir, fake, ctx, winner };
}

test("final auto approval is committed only with the verified candidate start", async () => {
  const { dir, fake, winner } = await finalReady("auto", false), original = fake.ctx.runner!;
  const first = await runAttempt(dir, { ...request, commit: winner, run: "final", seed: 5 }, { ...fake.ctx, runner: async r => {
    if (r.command === "docker" && r.args[0] === "run") expect(readLedger(dir).some(e => e.type === "gate.approve" && e.data.gate === "final")).toBe(false);
    return original(r);
  } });
  expect(first.status).toBe("running"); expect(first.finalBinding).toBe(finalGateBinding(dir)); expect(first.pendingFinalApproval).toBeUndefined();
  const approval = readLedger(dir).find(e => e.type === "gate.approve" && e.data.gate === "final")!;
  expect(approval.actor.kind).toBe("auto"); expect(approval.at).toBe(readLedger(dir).find(e => e.type === "attempt.stage.started" && e.data.id === first.id)!.at);
});

test("failed final preparation records no auto final approval and a rejected gate starts nothing", async () => {
  const { dir, fake, winner } = await finalReady("auto", false); fake.failVersion();
  expect((await runAttempt(dir, { ...request, commit: winner, run: "final", seed: 5 }, fake.ctx)).status).toBe("failed");
  expect(readLedger(dir).filter(e => e.type === "gate.approve" && e.data.gate === "final")).toHaveLength(0);
  const second = await finalReady("auto", false); await gateDecide(second.dir, "final", "reject", "Synthetic refusal", second.ctx);
  await expect(runAttempt(second.dir, { ...request, commit: second.winner, run: "final", seed: 5 }, second.fake.ctx)).rejects.toThrow("rejected");
  expect(second.fake.requests).toHaveLength(0);
});

test("changed final design during snapshot resolution refuses before final record or container", async () => {
  const { dir, fake, winner } = await finalReady();
  fake.resolveHook(async () => { writeFileSync(join(dir, "task", "task.md"), "new final inputs"); });
  await expect(runAttempt(dir, { ...request, commit: winner, run: "final", seed: 5 }, fake.ctx)).rejects.toThrow("gate final is pending");
  expect(readLedger(dir).some(e => e.type === "attempt.started" && e.data.run === "final")).toBe(false);
  expect(fake.requests.some(r => r.command === "docker")).toBe(false);
});

test("an autonomy change during snapshot resolution cannot use a cached auto policy", async () => {
  const { dir, fake } = await setup(protocol(), "auto", false);
  fake.resolveHook(() => autonomySet(dir, "gates", undefined, { actor }).then(() => {}));
  await expect(runAttempt(dir, request, fake.ctx)).rejects.toThrow("pending");
  expect(listAttempts(dir).attempts).toEqual([]);
  expect(readLedger(dir).some(event => event.type === "gate.approve")).toBe(false);
});

test("verified starts do not autoapprove a phase changed to gates after admission", async () => {
  const { dir, fake } = await setup(protocol(), "gates", false);
  await autonomySet(dir, "auto", "design", { actor });
  const original = fake.ctx.runner!;
  fake.ctx.runner = async req => {
    const response = await original(req);
    if (req.command === "docker" && req.args[0] === "run") await autonomySet(dir, "gates", "design", { actor });
    return response;
  };
  const result = await runAttempt(dir, request, fake.ctx);
  expect(result.status).toBe("running");
  expect(readLedger(dir).some(event => event.type === "gate.approve")).toBe(false);
  expect(gateList(dir).find(gate => gate.gate === "design")!.state).toBe("pending");
});

test("overlapping identical plan cancels replay the first receipt after the dispatch is cleared", async () => {
  const { dir, fake } = await setup(), firstAttempt = await runAttempt(dir, request, fake.ctx), entered = deferred(), release = deferred(), waiting = deferred();
  const original = fake.ctx.runner!;
  let kills = 0;
  const ctx = { ...fake.ctx, http: fakeHttp([]).http, runner: async (req: ProcessRequest) => {
    if (req.command === "docker" && req.args[0] === "kill" && ++kills === 1) { entered.resolve(); await release.promise; }
    return original(req);
  } };
  await autonomySet(dir, "step", undefined, ctx);
  await planSet(dir, { v: 1, nodes: [{ id: "work", kind: "step", command: "attempt.run", args: { repo: request.repo, commit: request.commit } }, { id: "next", kind: "step", command: "lit.bib", args: {} }], edges: [] }, ctx);
  await planControl(dir, { action: "resume", commandId: "start", expectedRevision: 1 }, ctx);
  appendEvent(dir, actor, "node.intent", { revision: 1, node: "work", dispatchId: "work-overlap", attemptId: firstAttempt.id });
  const input = { action: "cancel" as const, node: "work", commandId: "same-cancel", expectedRevision: 1 };
  let opens = 0, one: ReturnType<typeof planControl> | undefined, two: ReturnType<typeof planControl> | undefined;
  const open = fs.openSync;
  const spy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
    if (String(file) === join(dir, ".ares.control.lock") && ++opens === 2) waiting.resolve();
    return open(file, flags, mode);
  }) as typeof fs.openSync);
  try {
    one = planControl(dir, input, ctx);
    await Promise.race([entered.promise, one.then(() => { throw new Error("first cancel did not reach the synthetic kill barrier"); })]);
    two = planControl(dir, input, ctx);
    await Promise.race([waiting.promise, two.then(() => { throw new Error("second cancel did not overlap the first"); })]);
    release.resolve();
    const first = await one, second = await two;
    expect(first).toEqual(second); expect(first.state).toBe("paused"); expect(first.status).toBe("cancelled");
    expect(kills).toBe(1);
    const events = readLedger(dir);
    expect(events.filter(event => event.type === "plan.control" && (event.data.request as { commandId: string }).commandId === input.commandId)).toHaveLength(1);
    expect(events.filter(event => event.type === "plan.paused" && event.data.reason === "step")).toHaveLength(1);
    expect(events.filter(event => event.type === "attempt.cancelled")).toHaveLength(1);
  } finally {
    release.resolve(); await Promise.allSettled([one, two].filter((value): value is ReturnType<typeof planControl> => value !== undefined)); spy.mockRestore();
  }
});

for (const [label, skew, reclaimed] of [["slightly future", 1000, false], ["far future", CONTROL_FUTURE_SKEW_MS + 1000, true]] as const) test(`attempt control ${reclaimed ? "reclaims" : "respects"} a ${label} lock`, async () => {
  const { dir, fake } = await setup(), attempt = await runAttempt(dir, request, fake.ctx), lock = join(dir, ".ares.control.lock"), token = "synthetic-lock-owner";
  writeFileSync(lock, token); const baseline = Date.now(), future = new Date(baseline + skew); utimesSync(lock, future, future);
  const now = spyOn(Date, "now").mockReturnValue(baseline), calls = fake.requests.length;
  let pending: ReturnType<typeof cancelAttempt> | undefined;
  try {
    pending = cancelAttempt(dir, attempt.id, "synthetic cancellation", fake.ctx);
    expect(readFileSync(lock, "utf8") !== token).toBe(reclaimed);
    expect(fake.requests.length > calls).toBe(reclaimed);
    if (!reclaimed) fs.unlinkSync(lock); // The test owner releases it; the waiter must not do so.
    expect((await pending).status).toBe("cancelled");
    expect(existsSync(lock)).toBe(false);
  } finally {
    if (existsSync(lock) && readFileSync(lock, "utf8") === token) fs.unlinkSync(lock);
    if (pending) await Promise.allSettled([pending]); now.mockRestore();
  }
});

const inputProtocol = (): Protocol => ({ ...protocol(), inputs: {
  train: { path: "/synthetic/private-training", sha256: "a".repeat(64), mount: { candidate: "/in/train" } },
  heldout: { path: "/synthetic/private-heldout", sha256: "a".repeat(64), mount: { evaluator: "/in/heldout" } },
} });
test("sealed inputs mismatch refuses before any container or attempt record", async () => {
  const { dir, fake } = await setup(inputProtocol()); fake.inputHash("b".repeat(64));
  const before = readTextBounded(join(dir, "ledger.jsonl"), 1024 * 1024);
  await expect(runAttempt(dir, request, fake.ctx)).rejects.toThrow("executor input train: manifest hash mismatch");
  expect(fake.containers.size).toBe(0); expect(fake.requests.some(r => r.command === "docker")).toBe(false);
  expect(listAttempts(dir).attempts).toHaveLength(0);
  expect(readTextBounded(join(dir, "ledger.jsonl"), 1024 * 1024)).toBe(before);
});
test("input attempts persist verified identities without locators and survive stage transitions", async () => {
  const { dir, fake } = await setup(inputProtocol());
  const first = await runAttempt(dir, request, fake.ctx);
  expect(first.verifiedInputs).toEqual({ train: "a".repeat(64), heldout: "a".repeat(64) });
  const text = readTextBounded(join(dir, "runs", "main", "attempts", `${first.id}.json`), 1024 * 1024);
  expect(text).not.toContain("/synthetic/private-training"); expect(text).not.toContain("/synthetic/private-heldout");
  expect(first.protocol.inputs?.train).not.toHaveProperty("path");
  expect(running(fake, "candidate").args.join(" ")).toContain("/in/train,readonly");
  expect(running(fake, "candidate").args.join(" ")).not.toContain("/synthetic/private-heldout");
  running(fake, "candidate").running = false;
  await reconcileAttempts(dir, fake.ctx);
  expect(running(fake, "evaluator").args.join(" ")).toContain("/in/heldout,readonly");
  expect(running(fake, "evaluator").args.join(" ")).not.toContain("/synthetic/private-training");
  running(fake, "evaluator").running = false; await reconcileAttempts(dir, fake.ctx);
  expect(showAttempt(dir, first.id).status).toBe("succeeded");
  const { exportBundle } = await import("../src/study-export.ts"), target = join(tempDir(), "bundle");
  await exportBundle(dir, { bundle: target });
  const exported = readTextBounded(join(target, "attempts.jsonl"), 1024 * 1024);
  expect(JSON.parse(exported).inputs).toEqual(first.verifiedInputs);
  expect(exported).not.toContain("/synthetic/private");
});
test("input identity drift on restart refuses with restore guidance before a new stage", async () => {
  const p = inputProtocol(), { dir, fake } = await setup(p), first = await runAttempt(dir, request, fake.ctx);
  running(fake, "candidate").running = false;
  await withLock(dir, () => setProtocol(dir, { ...p, inputs: { ...p.inputs, heldout: { ...p.inputs!.heldout!, sha256: "b".repeat(64) } } }, actor));
  await expect(reconcileAttempts(dir, fake.ctx)).rejects.toThrow("restore the matching input names, hashes and mounts");
  expect(showAttempt(dir, first.id).stage).toBe("candidate");
  expect(fake.containers.size).toBe(1);
});

test("same-identity locator relocation during a running candidate remains reconcilable", async () => {
  const p = inputProtocol(), { dir, fake } = await setup(p), first = await runAttempt(dir, request, fake.ctx);
  await withLock(dir, () => setProtocol(dir, { ...p, inputs: { ...p.inputs, train: { ...p.inputs!.train!, path: "/synthetic/relocated-training" } } }, actor));
  expect((await reconcileAttempts(dir, fake.ctx))).toEqual([]);
  expect(showAttempt(dir, first.id).status).toBe("running");
  running(fake, "candidate").running = false; await reconcileAttempts(dir, fake.ctx);
  running(fake, "evaluator").running = false; await reconcileAttempts(dir, fake.ctx);
  expect(showAttempt(dir, first.id).status).toBe("succeeded");
});
test("an evaluator launch blocked by input verification retries after restore without becoming lost", async () => {
  const { dir, fake } = await setup(inputProtocol()), first = await runAttempt(dir, request, fake.ctx);
  running(fake, "candidate").running = false; fake.inputHash("b".repeat(64));
  await expect(reconcileAttempts(dir, fake.ctx)).rejects.toThrow("manifest hash mismatch");
  let current = showAttempt(dir, first.id);
  expect(current.status).toBe("running"); expect(current.stage).toBe("evaluator"); expect(current.stages.evaluator?.launchPending).toBe(true);
  expect(current.stages.evaluator?.containerId).toBeUndefined(); expect(fake.containers.size).toBe(1);
  await expect(reconcileAttempts(dir, fake.ctx)).rejects.toThrow("manifest hash mismatch");
  expect(showAttempt(dir, first.id).status).toBe("running");
  fake.inputHash("a".repeat(64)); await reconcileAttempts(dir, fake.ctx);
  current = showAttempt(dir, first.id); expect(current.stages.evaluator?.launchPending).toBeUndefined(); expect(fake.containers.size).toBe(2);
  running(fake, "evaluator").running = false; await reconcileAttempts(dir, fake.ctx);
  expect(showAttempt(dir, first.id).status).toBe("succeeded");
  expect(readLedger(dir).some(e => e.type === "attempt.unknown")).toBe(false);
});
for (const source of ["relative/input", "/synthetic/private-heldout/", "/private/synthetic-executor/"]) test(`observed input mounts refuse unsafe source ${source}`, async () => {
  const { dir, fake } = await setup(inputProtocol()); await runAttempt(dir, request, fake.ctx);
  const candidate = running(fake, "candidate"), index = candidate.args.findIndex(arg => arg.includes("dst=/in/train,"));
  candidate.args[index] = `type=bind,src=${source},dst=/in/train,readonly`;
  await expect(reconcileAttempts(dir, fake.ctx)).rejects.toThrow("reconcile");
});
