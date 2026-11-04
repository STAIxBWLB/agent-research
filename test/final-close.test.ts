import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { readProtocol, protocolHash, designBinding } from "../src/exp/protocol.ts";
import { finalGateBinding, requireFinalInputs, finalResultPath } from "../src/exp/final.ts";
import { investigateResultPath } from "../src/exp/investigate.ts";
import { ablateResultPath } from "../src/exp/ablate.ts";
import { runAttempt, type AttemptStatus } from "../src/exp/attempts.ts";
import { appendEvent, openStudy, readLedger } from "../src/study.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), WIN = "b".repeat(40), ABL = "c".repeat(40);
let serial = 0;
function attempt(dir: string, frozen: string, seed: number, value: number, options: {run?:string;status?:AttemptStatus;binding?:string;retryOf?:string;seal?:string} = {}) {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, run = options.run ?? "final", folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
  const finalBinding = options.binding ?? (run === "final" ? finalGateBinding(dir) : undefined);
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit: frozen, seed, protocolHash: protocolHash(protocol), protocol, executor: {}, stages: {}, stage: "evaluator", status: options.status ?? "succeeded", startedAt: "2030-01-01T00:00:00Z", sealBinding: options.seal ?? designBinding(dir), ...(finalBinding ? { finalBinding, finalWinner: requireFinalInputs(dir).winner } : {}), ...(options.retryOf ? { retryOf: options.retryOf } : {}), metrics: [{ name: "score", value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run, commit: frozen, seed }); return id;
}
async function setup(direction = "max", ablate = false) {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction }], seeds: [1, 2, 3, 4], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [3, 4] }, ctx);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 2, minDelta: 1 }, ctx);
  for (const seed of [1, 2]) { attempt(dir, BASE, seed, 10, { run: "investigate" }); attempt(dir, WIN, seed, direction === "max" ? 12 : 8, { run: "investigate" }); }
  await ops.investigateClose(dir, ctx);
  if (ablate) await ops.ablateAdd(dir, { id: "without", commit: ABL, removes: "Synthetic component" }, ctx);
  return dir;
}
async function approve(dir: string) { await ops.gateDecide(dir, "design", "approve", undefined, ctx); await ops.gateDecide(dir, "final", "approve", undefined, ctx); }
function decisive(dir: string, values = [12, 12], status: AttemptStatus = "succeeded") { for (const [i, seed] of [3, 4].entries()) { attempt(dir, BASE, seed, 10); attempt(dir, WIN, seed, values[i]!, { status }); } }

test("final gate requires current closed winner and declared ablate close; content/design changes reopen it", async () => {
  const dir = await setup("max", true);
  await expect(ops.gateDecide(dir, "final", "approve", undefined, ctx)).rejects.toThrow("not closed");
  await ops.ablateClose(dir, ctx); await approve(dir); expect(ops.gateList(dir).find(g => g.gate === "final")!.state).toBe("approved");
  decisive(dir); expect((await ops.finalClose(dir, ctx)).ablateSha256).toBeDefined();
  const inv = investigateResultPath(dir, "investigate"), original = readFileSync(inv, "utf8"); writeFileSync(inv, original + " ");
  expect(ops.gateList(dir).find(g => g.gate === "final")!.state).toBe("pending"); await expect(ops.gateDecide(dir, "final", "approve", undefined, ctx)).rejects.toThrow("close receipt");
  writeFileSync(inv, original); const ab = ablateResultPath(dir), atext = readFileSync(ab, "utf8"); writeFileSync(ab, atext + " ");
  expect(ops.gateList(dir).find(g => g.gate === "final")!.state).toBe("pending"); writeFileSync(ab, atext);
  writeFileSync(join(dir, "task", "task.md"), "changed task"); expect(ops.gateList(dir).find(g => g.gate === "final")!.state).toBe("pending");
});

test("qualified finals need every reserved winner/baseline success and direction-adjusted delta; repeat close is a no-op", async () => {
  for (const direction of ["max", "min"]) {
    const dir = await setup(direction); await approve(dir); decisive(dir, direction === "max" ? [12, 12] : [8, 8]);
    const result = await ops.finalClose(dir, ctx); expect(result.status).toBe("qualified"); expect(result.delta).toBe(2); expect(result.decisive).toHaveLength(4);
    const file = finalResultPath(dir), bytes = readFileSync(file), before = readFileSync(join(dir, "ledger.jsonl"));
    expect(JSON.stringify(result)).not.toContain("2030-01-01"); expect(await ops.finalClose(dir, ctx)).toEqual(result);
    expect(readFileSync(file)).toEqual(bytes); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  }
});

test("below-margin and failed/cancelled/unknown first attempts remain not_qualified despite successful retries", async () => {
  const low = await setup(); await approve(low); decisive(low, [10.5, 10.5]); expect((await ops.finalClose(low, ctx)).reason).toBe("below-margin");
  for (const status of ["failed", "cancelled", "unknown"] as const) {
    const dir = await setup(); await approve(dir);
    for (const seed of [3, 4]) { attempt(dir, BASE, seed, 10); const first = attempt(dir, WIN, seed, 0, { status }); attempt(dir, WIN, seed, 100, { retryOf: first }); }
    const result = await ops.finalClose(dir, ctx); expect(result.status).toBe("not_qualified"); expect(result.reason).toBe(status);
    expect(result.attempts.filter(a => a.reason === "later-attempt")).toHaveLength(2); expect(result.decisive.filter(a => a.status === status)).toHaveLength(2);
  }
});

test("running and missing decisive attempts refuse with result and ledger unchanged", async () => {
  const dir = await setup(); await approve(dir); attempt(dir, BASE, 3, 10);
  let before = readFileSync(join(dir, "ledger.jsonl")); await expect(ops.finalClose(dir, ctx)).rejects.toThrow("missing decisive attempt"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  attempt(dir, WIN, 3, 12, { status: "running" }); before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.finalClose(dir, ctx)).rejects.toThrow("attempt reconcile"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(existsSync(finalResultPath(dir))).toBe(false);
});

test("old binding tags alone never change fixed valid final attempts and every attempt stays visible", async () => {
  const dir = await setup(); await approve(dir);
  for (const seed of [3, 4]) { attempt(dir, BASE, seed, 10); attempt(dir, WIN, seed, 12, { binding: "old-inputs" }); }
  attempt(dir, ABL, 1, 1000);
  const result = await ops.finalClose(dir, ctx); expect(result.status).toBe("qualified"); expect(result.attempts).toHaveLength(5);
});

test("final attempt preflight rejects gate, commit and seed errors before any process/record", async () => {
  const dir = await setup(); await ops.executorSet(dir, { v: 1, kind: "local", workdir: "/private/synthetic" }, ctx);
  let calls = 0; const runtime = { actor, runner: async () => { calls++; throw new Error("forbidden process"); } };
  const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(runAttempt(dir, { repo: "/synthetic", commit: WIN, run: "final", seed: 3 }, runtime)).rejects.toThrow("gate final is pending");
  await approve(dir);
  await expect(runAttempt(dir, { repo: "/synthetic", commit: ABL, run: "final", seed: 3 }, runtime)).rejects.toThrow("neither");
  await expect(runAttempt(dir, { repo: "/synthetic", commit: WIN, run: "final", seed: 1 }, runtime)).rejects.toThrow("not reserved");
  expect(calls).toBe(0); expect(readLedger(dir).filter(e => e.type === "attempt.started" && e.data.run === "final")).toHaveLength(0);
  expect(readFileSync(join(dir, "ledger.jsonl")).length).toBeGreaterThan(before.length);
});

test("unknown final result versions preserve bytes, CLI/MCP share close and survey refuses", async () => {
  const dir = await setup(); await approve(dir); decisive(dir);
  const server = createAresMcp({}, ctx.http), result = await server.handlers.ares_final_close!({ study: dir });
  expect(JSON.parse((await run(["final", "close", dir, "--json"], {}, { http: ctx.http })).text)).toEqual(result);
  const file = finalResultPath(dir), unknown = '{"v":99,"future":"keep"}'; writeFileSync(file, unknown); const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.finalClose(dir, ctx)).rejects.toThrow("supports it"); expect(readFileSync(file, "utf8")).toBe(unknown); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  const survey = tempDir(); ops.init(survey, { question: "synthetic" }, ctx); await expect(ops.finalClose(survey, ctx)).rejects.toThrow("experiment"); await expect(ops.gateDecide(survey, "final", "approve", undefined, ctx)).rejects.toThrow("experiment");
});


test("partial successful decisive pairs remain reported without overriding a failed first attempt", async () => {
  const dir = await setup(); await approve(dir);
  attempt(dir, BASE, 3, 10); const failed = attempt(dir, WIN, 3, 0, { status: "failed" }); attempt(dir, WIN, 3, 100, { retryOf: failed });
  attempt(dir, BASE, 4, 10); attempt(dir, WIN, 4, 12);
  const result = await ops.finalClose(dir, ctx);
  expect(result.status).toBe("not_qualified"); expect(result.reason).toBe("failed"); expect(result.pairs.map(p => p.seed)).toEqual([4]); expect(result.delta).toBe(2);
});


test("idea-note input changes require re-approval rather than disqualifying fixed final data", async () => {
  const dir = await setup(); await approve(dir); decisive(dir); const original = await ops.finalClose(dir, ctx);
  await ops.ideaAdd(dir, { id: "note", title: "Synthetic note", hypothesis: "Interpret existing evidence" }, ctx); await ops.investigateClose(dir, ctx);
  expect(ops.gateList(dir).find(g => g.gate === "final")!.state).toBe("pending");
  const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.finalClose(dir, ctx)).rejects.toThrow("not currently approved"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  await ops.gateDecide(dir, "final", "approve", undefined, ctx);
  const after = await ops.finalClose(dir, ctx); expect(after.status).toBe("qualified"); expect(after.decisive.map(a => a.id)).toEqual(original.decisive.map(a => a.id));
});

test("changed evaluation protocol yields protocol-changed after re-approval without replacing decisive attempts", async () => {
  const dir = await setup(); await approve(dir); decisive(dir);
  const p = readProtocol(dir)!; await ops.protocol(dir, { ...p, method: "Changed evaluation protocol" }, ctx);
  for (const seed of [1, 2]) { attempt(dir, BASE, seed, 10, { run: "investigate" }); attempt(dir, WIN, seed, 12, { run: "investigate" }); }
  await ops.investigateClose(dir, ctx); await approve(dir);
  const result = await ops.finalClose(dir, ctx); expect(result.status).toBe("not_qualified"); expect(result.reason).toBe("protocol-changed");
});

test("winner changes cannot buy a new final even after only baseline attempts", async () => {
  for (const baselineOnly of [false, true]) {
    const dir = await setup(); await approve(dir);
    if (baselineOnly) for (const seed of [3, 4]) attempt(dir, BASE, seed, 10); else decisive(dir);
    for (const seed of [1, 2]) attempt(dir, ABL, seed, 20, { run: "investigate" });
    await ops.investigateClose(dir, ctx); await approve(dir); await ops.executorSet(dir, { v: 1, kind: "local", workdir: "/private/synthetic" }, ctx);
    const before = readFileSync(join(dir, "ledger.jsonl")); let calls = 0;
    await expect(runAttempt(dir, { repo: "/synthetic", commit: ABL, seed: 3, run: "final", detach: true }, { actor, runner: async () => { calls++; throw new Error("must not execute"); } })).rejects.toThrow("winner changed after a final attempt");
    expect(calls).toBe(0); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
    const result = await ops.finalClose(dir, ctx); expect(result.status).toBe("not_qualified"); expect(result.reason).toBe("winner-changed");
  }
});
