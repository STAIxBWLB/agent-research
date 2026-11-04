import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { protocolHash, readProtocol } from "../src/exp/protocol.ts";
import { investigateResultPath } from "../src/exp/investigate.ts";
import { appendEvent, openStudy, readLedger } from "../src/study.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import type { AttemptStatus } from "../src/exp/attempts.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const BASE = "a".repeat(40), BETTER = "b".repeat(40), OTHER = "c".repeat(40);
const protocol = (direction = "max") => ({ v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction }], seeds: [1, 2, 3], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } });
const rule = (minSeeds = 2, minDelta = 1) => ({ v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds, minDelta });
async function setup(direction = "max", minSeeds = 2, minDelta = 1) {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, protocol(direction), ctx); await ops.selection(dir, rule(minSeeds, minDelta), ctx); return dir;
}
let serial = 0;
function attempt(dir: string, commit: string, seed: number, value: number, options: { status?: AttemptStatus; hash?: string; run?: string; start?: boolean; provenance?: string } = {}) {
  const id = (++serial).toString(16).padStart(16, "0"), selectedRun = options.run ?? "investigate", p = readProtocol(dir)!;
  const record = { v: 1, id, studyId: openStudy(dir).study.id, run: selectedRun, protocolHash: options.hash ?? protocolHash(p), commit, seed, status: options.status ?? "succeeded", stage: "evaluator", stages: {}, protocol: p, executor: { v: 1, kind: "local", workdir: "/synthetic" }, startedAt: "2030-01-01T00:00:00.000Z", endedAt: "2030-01-01T00:00:01.000Z", metrics: [{ name: "score", unit: "points", value, provenance: options.provenance ?? "ares-observed" }], outputs: [] };
  const folder = join(dir, "runs", selectedRun, "attempts"); mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, `${id}.json`), JSON.stringify(record));
  if (options.start !== false) appendEvent(dir, actor, "attempt.started", { id, run: selectedRun, commit, seed, treeId: "d".repeat(40) });
  return id;
}
function baseline(dir: string, values = [10, 20]) { return values.map((v, i) => attempt(dir, BASE, i + 1, v)); }

test("winner uses paired seeds and earliest successful attempt, with all failed/excluded statuses retained", async () => {
  const dir = await setup(); baseline(dir);
  const first = attempt(dir, BETTER, 1, 13), second = attempt(dir, BETTER, 2, 23);
  const duplicate = attempt(dir, BETTER, 1, 999);
  attempt(dir, BETTER, 2, 0, { status: "failed" }); attempt(dir, BETTER, 2, 0, { status: "cancelled" }); attempt(dir, BETTER, 2, 0, { status: "unknown" });
  const foreign = attempt(dir, OTHER, 1, 100, { hash: "f".repeat(64) });
  const missing = attempt(dir, OTHER, 2, 100, { start: false });
  attempt(dir, OTHER, 1, 999, { run: "elsewhere" });
  const result = ops.investigateShow(dir);
  expect(result.winner).toEqual({ commit: BETTER, attempts: [first, second], mean: 18, delta: 3 });
  expect(result.totals).toMatchObject({ attempts: 10, byStatus: { succeeded: 7, failed: 1, cancelled: 1, unknown: 1 }, countedSuccesses: 4, excluded: 3 });
  expect(result.excluded.find(a => a.id === duplicate)?.reasons).toEqual(["later-success"]);
  expect(result.excluded.find(a => a.id === foreign)?.reasons).toContain("other-protocol");
  expect(result.excluded.find(a => a.id === missing)?.reasons).toContain("missing-start-event");
});

test("ledger order defines the cutoff even when timestamps are identical; a new selection excludes earlier starts", async () => {
  const dir = await setup(); baseline(dir); attempt(dir, BETTER, 1, 13); attempt(dir, BETTER, 2, 23);
  await ops.selection(dir, rule(2, 2), ctx);
  baseline(dir); attempt(dir, BETTER, 1, 14); attempt(dir, BETTER, 2, 24);
  const ledgerFile = join(dir, "ledger.jsonl");
  writeFileSync(ledgerFile, readLedger(dir).map(e => JSON.stringify({ ...e, at: "2030-01-01T00:00:00.000Z" })).join("\n") + "\n");
  const result = ops.investigateShow(dir);
  expect(result.winner?.mean).toBe(19); expect(result.excluded.filter(a => a.reasons.includes("before-selection"))).toHaveLength(4);
  const before = result.inputsSha256; await ops.selection(dir, rule(2, 2), ctx);
  expect(ops.investigateShow(dir).inputsSha256).toBe(before);
});

test("all no-winner outcomes and min direction have deterministic named results", async () => {
  const noBase = await setup(); attempt(noBase, BETTER, 1, 100); expect(ops.investigateShow(noBase).reason).toBe("no-baseline");
  const short = await setup(); baseline(short, [10]); expect(ops.investigateShow(short).reason).toBe("baseline-seeds");
  const noCandidate = await setup(); baseline(noCandidate); expect(ops.investigateShow(noCandidate).reason).toBe("no-candidate");
  const below = await setup(); baseline(below); attempt(below, BETTER, 1, 10.5); attempt(below, BETTER, 2, 20.5); expect(ops.investigateShow(below).reason).toBe("below-margin");
  const zero = await setup("max", 2, 0); baseline(zero); attempt(zero, BETTER, 1, 10); attempt(zero, BETTER, 2, 20); expect(ops.investigateShow(zero).reason).toBe("below-margin");
  const tied = await setup(); baseline(tied); for (const commit of [BETTER, OTHER]) { attempt(tied, commit, 1, 13); attempt(tied, commit, 2, 23); } expect(ops.investigateShow(tied).reason).toBe("tie");
  const lower = await setup("min"); baseline(lower); attempt(lower, BETTER, 1, 7); attempt(lower, BETTER, 2, 17); expect(ops.investigateShow(lower).winner?.delta).toBe(3);
});

test("candidate means pair only common seeds, and an under-seeded candidate is ineligible", async () => {
  const dir = await setup(); baseline(dir, [10, 20, 1000]);
  attempt(dir, BETTER, 1, 12); attempt(dir, BETTER, 2, 22); attempt(dir, OTHER, 3, 10000);
  const result = ops.investigateShow(dir);
  expect(result.winner?.commit).toBe(BETTER); expect(result.candidates.find(c => c.commit === BETTER)?.baselineMean).toBe(15);
  expect(result.candidates.find(c => c.commit === OTHER)?.reason).toBe("candidate-seeds");
});

test("show is lock-free and unchanged close writes no result timestamp or second event", async () => {
  const dir = await setup(); baseline(dir); attempt(dir, BETTER, 1, 13); attempt(dir, BETTER, 2, 23);
  const result = await ops.investigateClose(dir, ctx), file = investigateResultPath(dir, "investigate"), bytes = readFileSync(file), events = readFileSync(join(dir, "ledger.jsonl"));
  expect(JSON.stringify(result)).not.toContain("2030-01-01");
  expect(await ops.investigateClose(dir, ctx)).toEqual(result);
  expect(readFileSync(file)).toEqual(bytes); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(events);
  writeFileSync(join(dir, ".ares.lock"), "live"); expect(ops.investigateShow(dir)).toEqual(result);
});

test("close refuses any running attempt in the run, including excluded ones, and changed input writes a new result", async () => {
  const dir = await setup(); baseline(dir); attempt(dir, BETTER, 1, 13); attempt(dir, BETTER, 2, 23);
  const first = await ops.investigateClose(dir, ctx);
  const id = attempt(dir, OTHER, 1, 0, { status: "running", hash: "f".repeat(64) });
  const before = readFileSync(investigateResultPath(dir, "investigate")), ledger = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.investigateClose(dir, ctx)).rejects.toThrow("attempt reconcile");
  expect(readFileSync(investigateResultPath(dir, "investigate"))).toEqual(before); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  const file = join(dir, "runs", "investigate", "attempts", `${id}.json`), record = JSON.parse(readFileSync(file, "utf8")); record.status = "failed"; writeFileSync(file, JSON.stringify(record));
  const second = await ops.investigateClose(dir, ctx); expect(second.inputsSha256).not.toBe(first.inputsSha256);
  expect(readLedger(dir).filter(e => e.type === "investigate.closed")).toHaveLength(2);
});

test("unknown result versions and invalid observed metrics refuse with file/ledger unchanged", async () => {
  const dir = await setup(); baseline(dir); const id = attempt(dir, BETTER, 1, 13, { provenance: "model" });
  const before = readFileSync(join(dir, "ledger.jsonl"));
  expect(() => ops.investigateShow(dir)).toThrow("unvalidated"); await expect(ops.investigateClose(dir, ctx)).rejects.toThrow("unvalidated");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  const file = join(dir, "runs", "investigate", "attempts", `${id}.json`), record = JSON.parse(readFileSync(file, "utf8")); record.metrics[0].provenance = "ares-observed"; writeFileSync(file, JSON.stringify(record));
  await ops.investigateClose(dir, ctx); const resultFile = investigateResultPath(dir, "investigate"), unknown = '{"v":99,"future":"keep"}'; writeFileSync(resultFile, unknown);
  const ledger = readFileSync(join(dir, "ledger.jsonl"));
  expect(() => ops.investigateShow(dir)).toThrow("supports this result"); await expect(ops.investigateClose(dir, ctx)).rejects.toThrow("supports this result");
  expect(readFileSync(resultFile, "utf8")).toBe(unknown); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
});

test("CLI and MCP share deterministic show/close and start no process/network", async () => {
  const dir = await setup(); baseline(dir); const forbidden = async () => { throw new Error("investigate must not execute"); };
  const server = createAresMcp({}, ctx.http, { runner: forbidden });
  const shown = await server.handlers.ares_investigate_show!({ study: dir });
  expect(JSON.parse((await run(["investigate", "show", dir, "--json"], {}, { http: ctx.http, runner: forbidden })).text)).toEqual(shown);
  expect(await server.handlers.ares_investigate_close!({ study: dir })).toEqual(shown);
  expect(readLedger(dir).filter(e => e.type === "investigate.closed")).toHaveLength(1);
});

test("survey and missing rule/receipt refuse without result writes", async () => {
  const survey = tempDir(); ops.init(survey, { question: "synthetic" }, ctx);
  expect(() => ops.investigateShow(survey)).toThrow("experiment"); await expect(ops.investigateClose(survey, ctx)).rejects.toThrow("experiment");
  const dir = await setup(); writeFileSync(join(dir, "design", "selection.json"), JSON.stringify(rule(2, 9)));
  expect(() => ops.investigateShow(dir)).toThrow("selection.set receipt");
  expect(existsSync(investigateResultPath(dir, "investigate"))).toBe(false);
});

test("an earlier failure does not displace the first success, and undeclared seeds remain excluded", async () => {
  const dir = await setup(); baseline(dir);
  const failed = attempt(dir, BETTER, 1, 0, { status: "failed" }), first = attempt(dir, BETTER, 1, 13);
  const second = attempt(dir, BETTER, 2, 23), extra = attempt(dir, OTHER, 99, 999);
  const result = ops.investigateShow(dir);
  expect(result.winner?.attempts).toEqual([first, second]); expect(result.candidates.find(c => c.commit === BETTER)?.attempts.failed).toContain(failed);
  expect(result.excluded.find(a => a.id === extra)?.reasons).toContain("undeclared-seed");
});

test("finite extreme means remain finite, and overflowing deltas refuse instead of writing non-finite JSON", async () => {
  const dir = await setup("max", 2, 0); baseline(dir, [1e308, 1e308]); attempt(dir, BETTER, 1, 1.1e308); attempt(dir, BETTER, 2, 1.1e308);
  expect(Number.isFinite(ops.investigateShow(dir).winner!.mean)).toBe(true);
  const bad = await setup("max", 2, 0); baseline(bad, [-1e308, -1e308]); attempt(bad, BETTER, 1, 1e308); attempt(bad, BETTER, 2, 1e308);
  const before = readFileSync(join(bad, "ledger.jsonl"));
  await expect(ops.investigateClose(bad, ctx)).rejects.toThrow("delta overflows");
  expect(readFileSync(join(bad, "ledger.jsonl"))).toEqual(before); expect(existsSync(investigateResultPath(bad, "investigate"))).toBe(false);
});


test("different paired seed sets rank by direction-adjusted delta, and equal deltas tie even with different means", async () => {
  for (const direction of ["max", "min"]) {
    const dir = await setup(direction, 1, 1); baseline(dir, direction === "max" ? [100, 0, 50] : [0, 100, 50]);
    attempt(dir, BETTER, 1, direction === "max" ? 101 : -1);
    attempt(dir, OTHER, 2, direction === "max" ? 2 : 98);
    const result = ops.investigateShow(dir);
    expect(result.winner?.commit).toBe(OTHER); expect(result.winner?.delta).toBe(2);
  }
  const tied = await setup("max", 1, 1); baseline(tied, [100, 0]);
  attempt(tied, BETTER, 1, 101); attempt(tied, OTHER, 2, 1);
  expect(ops.investigateShow(tied).reason).toBe("tie"); expect(ops.investigateShow(tied).winner).toBeNull();
});
