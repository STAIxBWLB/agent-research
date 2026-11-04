import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { runAttempt, listAttempts, type AttemptStatus } from "../src/exp/attempts.ts";
import { readProtocol, protocolHash, designBinding } from "../src/exp/protocol.ts";
import { finalResultPath } from "../src/exp/final.ts";
import { appendEvent, openStudy, readLedger } from "../src/study.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), WIN = "b".repeat(40);
let serial = 0;
function attempt(dir: string, commit: string, seed: number, value: number, run = "final", status: AttemptStatus = "succeeded") {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit, seed, protocolHash: protocolHash(protocol), protocol, executor: {}, stages: {}, stage: "evaluator", status, startedAt: "2030-01-01T00:00:00Z", sealBinding: designBinding(dir), metrics: [{ name: "score", value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run, commit, seed }); return id;
}
async function setup(close = false) {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  const image = `fixture@sha256:${"a".repeat(64)}`;
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image, command: ["candidate"] }, evaluator: { image, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1, 2], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  attempt(dir, BASE, 1, 10, "investigate"); attempt(dir, WIN, 1, 12, "investigate"); await ops.investigateClose(dir, ctx);
  await ops.executorSet(dir, { v: 1, kind: "local", workdir: "/private/synthetic" }, ctx);
  await ops.gateDecide(dir, "design", "approve", undefined, ctx); await ops.gateDecide(dir, "final", "approve", undefined, ctx);
  attempt(dir, BASE, 2, 10); attempt(dir, WIN, 2, 12);
  if (close) await ops.finalClose(dir, ctx);
  return dir;
}

test("posthoc start refuses before final.closed on API, CLI and MCP without any process or record", async () => {
  const dir = await setup(), before = readFileSync(join(dir, "ledger.jsonl")); let calls = 0;
  const runner = async () => { calls++; throw new Error("forbidden process"); }, options = { repo: "/synthetic", commit: WIN, seed: 1, run: "posthoc", detach: true };
  await expect(runAttempt(dir, options, { actor, runner })).rejects.toThrow("run ares final close");
  await expect(run(["attempt", "run", dir, "--repo", "/synthetic", "--commit", WIN, "--seed", "1", "--run", "posthoc", "--detach"], {}, { http: ctx.http, runner })).rejects.toThrow("final has not been closed");
  await expect(createAresMcp({}, ctx.http, { runner }).handlers.ares_attempt_run!({ study: dir, repo: "/synthetic", commit: WIN, seed: 1, run: "posthoc" })).rejects.toThrow("final has not been closed");
  expect(calls).toBe(0); expect(listAttempts(dir, { run: "posthoc" }).attempts).toHaveLength(0); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});

test("posthoc start after closure admits exploratory commits but still refuses reserved seeds", async () => {
  const dir = await setup(true), bytes = readFileSync(finalResultPath(dir)); let calls = 0;
  const runtime = { actor, runner: async (request: { command: string; args: string[] }) => {
    calls++;
    if (request.command === "git") return { exitCode: 0, stdout: request.args.includes("cat-file") ? "commit\n" : "c".repeat(40), stderr: "" };
    return { exitCode: 1, stdout: "", stderr: "synthetic executor unavailable" };
  } };
  const result = await runAttempt(dir, { repo: "/synthetic", commit: "d".repeat(40), seed: 1, run: "posthoc", detach: true }, runtime);
  expect(calls).toBeGreaterThan(0); expect(result.run).toBe("posthoc"); expect(listAttempts(dir, { run: "posthoc" }).attempts).toHaveLength(1);
  const before = calls;
  await expect(runAttempt(dir, { repo: "/synthetic", commit: WIN, seed: 2, run: "posthoc", detach: true }, runtime)).rejects.toThrow("reserved for run final");
  expect(calls).toBe(before); expect(readFileSync(finalResultPath(dir))).toEqual(bytes);
});

test("read-only posthoc show labels all statuses and metrics exploratory with CLI/MCP parity", async () => {
  const dir = await setup(true);
  const statuses = ["running", "succeeded", "failed", "cancelled", "unknown"] as const;
  for (const status of statuses) attempt(dir, WIN, 1, 99, "posthoc", status);
  const before = readFileSync(join(dir, "ledger.jsonl")), final = readFileSync(finalResultPath(dir));
  const result = ops.posthocShow(dir); expect(result.label).toBe("exploratory"); expect(result.attempts.map(a => a.status).sort()).toEqual([...statuses].sort());
  expect(result.attempts.every(a => a.label === "exploratory" && a.metrics[0]?.value === 99)).toBe(true);
  expect(JSON.parse((await run(["posthoc", "show", dir, "--json"], {}, { http: ctx.http })).text)).toEqual(result);
  const server = createAresMcp({}, ctx.http); expect(await server.handlers.ares_posthoc_show!({ study: dir })).toEqual(result);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(readFileSync(finalResultPath(dir))).toEqual(final);
});

test("posthoc attempts never change final bytes, close fingerprint or receipt, even when exploratory work runs", async () => {
  const dir = await setup(true), result = await ops.finalClose(dir, ctx), bytes = readFileSync(finalResultPath(dir));
  for (const status of ["running", "succeeded", "failed", "cancelled", "unknown"] as const) attempt(dir, WIN, 1, 1000, "posthoc", status);
  const before = readFileSync(join(dir, "ledger.jsonl")), count = readLedger(dir).filter(e => e.type === "final.closed").length;
  expect(await ops.finalClose(dir, ctx)).toEqual(result); expect(readFileSync(finalResultPath(dir))).toEqual(bytes);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(readLedger(dir).filter(e => e.type === "final.closed")).toHaveLength(count);
});

test("posthoc show can read an empty experiment before close and survey refuses on all paths", async () => {
  const dir = await setup(); expect(ops.posthocShow(dir).attempts).toEqual([]);
  const survey = tempDir(); ops.init(survey, { question: "synthetic" }, ctx); const before = readFileSync(join(survey, "ledger.jsonl"));
  expect(() => ops.posthocShow(survey)).toThrow("experiment");
  await expect(run(["posthoc", "show", survey], {}, { http: ctx.http })).rejects.toThrow("experiment");
  expect(() => createAresMcp({}, ctx.http).handlers.ares_posthoc_show!({ study: survey })).toThrow("experiment");
  expect(readFileSync(join(survey, "ledger.jsonl"))).toEqual(before);
});
