import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp, ARES_TOOLS } from "../src/mcp-tools.ts";
import { ablateResultPath, MAX_ABLATIONS } from "../src/exp/ablate.ts";
import { investigateResultPath, pairSamples } from "../src/exp/investigate.ts";
import { readProtocol, protocolHash } from "../src/exp/protocol.ts";
import { appendEvent, commit, openStudy, readLedger } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
import type { AttemptStatus } from "../src/exp/attempts.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const BASE = "a".repeat(40), WIN = "b".repeat(40), ABL = "c".repeat(40), EMPTY = "d".repeat(40), FOREIGN = "e".repeat(40);
let serial = 0;
function attempt(dir: string, frozen: string, seed: number, value: number, options: {run?: string;status?:AttemptStatus;hash?:string;start?:boolean;provenance?:string} = {}) {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, run = options.run ?? "ablate", folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit: frozen, seed, protocolHash: options.hash ?? protocolHash(protocol), protocol, executor: {}, stages: {}, stage: "evaluator", status: options.status ?? "succeeded", startedAt: "2030-01-01T00:00:00Z", metrics: [{ name: "score", value, unit: "points", provenance: options.provenance ?? "ares-observed" }], outputs: [] }));
  if (options.start !== false) appendEvent(dir, actor, "attempt.started", { id, run, commit: frozen, seed }); return id;
}
async function study(direction = "max", winner = true) {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction }], seeds: [1, 2, 3, 4], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 2, minDelta: 1 }, ctx);
  for (const seed of [1, 2]) { attempt(dir, BASE, seed, seed * 10, { run: "investigate" }); if (winner) attempt(dir, WIN, seed, seed * 10 + (direction === "max" ? 2 : -2), { run: "investigate" }); }
  await ops.investigateClose(dir, ctx); return dir;
}
const declaration = (id = "without-module", frozen = ABL) => ({ id, commit: frozen, removes: "Synthetic module" });

test("ablate declarations are unique, bounded and cannot claim winner or baseline commits", async () => {
  const dir = await study(); await ops.ablateAdd(dir, declaration(), ctx); const before = readFileSync(join(dir, "ledger.jsonl"));
  for (const [raw, message] of [
    [declaration(), "duplicate id"], [declaration("other"), "duplicate commit"], [declaration("winner", WIN), "winner or selection baseline"], [declaration("baseline", BASE), "winner or selection baseline"],
    [{ ...declaration("extra", EMPTY), extra: true }, "unknown field"], [{ ...declaration("long", EMPTY), removes: "한".repeat(667) }, "2000 bytes"],
    [declaration("../escape", EMPTY), "run name"], [declaration("bad", "abc"), "40-hex"],
  ] as [unknown, string][]) { await expect(ops.ablateAdd(dir, raw, ctx)).rejects.toThrow(message); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); }
  const added = await ops.ablateAdd(dir, { ...declaration("boundary", EMPTY), removes: "한".repeat(666) + "ab" }, ctx); expect(Buffer.byteLength(added.removes)).toBe(2000);
});

test("all 200 declarations are allowed and the next is refused without a write", async () => {
  const dir = await study();
  commit(dir, [], Array.from({ length: MAX_ABLATIONS }, (_, i) => ({ actor, type: "ablation.added", data: { ablation: declaration(`ablation-${i}`, (i + 1).toString(16).padStart(40, "0")) } })));
  expect(ops.ablateShow(dir).ablations).toHaveLength(200); const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.ablateAdd(dir, declaration("overflow"), ctx)).rejects.toThrow("200 declarations"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});

test("every declaration stays in order, including no-data rows; pairing uses fresh winner ablate samples without ranking", async () => {
  const dir = await study(); await ops.ablateAdd(dir, declaration("first"), ctx); await ops.ablateAdd(dir, declaration("no-data", EMPTY), ctx);
  attempt(dir, ABL, 1, 25); attempt(dir, ABL, 2, 35);
  expect(ops.ablateShow(dir).ablations[0]!.reason).toBe("reference-seeds");
  attempt(dir, WIN, 1, 30); attempt(dir, WIN, 2, 40);
  const result = ops.ablateShow(dir); expect(result.ablations.map(a => a.id)).toEqual(["first", "no-data"]);
  expect(result.ablations[0]!.paired).toMatchObject({ pairedSeeds: [1, 2], mean: 30, referenceMean: 35, delta: -5 });
  expect(result.ablations[1]!.reason).toBe("no-data"); expect(result.ablations[1]!.paired.delta).toBeNull();
  expect(Object.hasOwn(result, "winner")).toBe(false);
});

test("shared pairing respects min direction and leaves unmatched seeds descriptive only", async () => {
  const dir = await study("min"); await ops.ablateAdd(dir, declaration(), ctx);
  attempt(dir, WIN, 1, 8); attempt(dir, WIN, 2, 18); attempt(dir, ABL, 1, 11); attempt(dir, ABL, 3, 1000);
  expect(ops.ablateShow(dir).ablations[0]!.paired).toMatchObject({ pairedSeeds: [1], mean: 11, referenceMean: 8, delta: -3 });
  expect(pairSamples([{ seed: 1, attempt: "candidate", value: 11 }], [{ seed: 1, attempt: "reference", value: 8 }], "min", ABL).delta).toBe(-3);
});

test("all statuses and exclusions remain in totals; reserved and later successes never enter paired values", async () => {
  const dir = await study(); await ops.ablateAdd(dir, declaration(), ctx);
  attempt(dir, WIN, 1, 30); const first = attempt(dir, ABL, 1, 25), later = attempt(dir, ABL, 1, 999);
  const reserved = attempt(dir, ABL, 4, 999), other = attempt(dir, ABL, 2, 999, { hash: "f".repeat(64) }), missing = attempt(dir, ABL, 3, 999, { start: false });
  const unknownCommit = attempt(dir, FOREIGN, 1, 100), undeclared = attempt(dir, ABL, 99, 100);
  for (const status of ["failed", "cancelled", "unknown"] as const) attempt(dir, ABL, 2, 0, { status });
  const result = ops.ablateShow(dir);
  expect(result.totals).toMatchObject({ attempts: 11, byStatus: { succeeded: 8, failed: 1, cancelled: 1, unknown: 1 }, countedSuccesses: 2, excluded: 6 });
  for (const [id, reason] of [[later, "later-success"], [reserved, "reserved-seed"], [other, "other-protocol"], [missing, "missing-start-event"], [unknownCommit, "undeclared-ablation"], [undeclared, "undeclared-seed"]] as const) expect(result.excluded.find(e => e.id === id)?.reasons).toContain(reason);
  expect(result.ablations[0]!.perSeed[0]!.attempt).toBe(first);
});

test("close is timestamp-free and idempotent, changed inputs write once, and running even excluded work refuses", async () => {
  const dir = await study(); await ops.ablateAdd(dir, declaration(), ctx); attempt(dir, WIN, 1, 30); attempt(dir, ABL, 1, 25);
  const first = await ops.ablateClose(dir, ctx), file = ablateResultPath(dir), bytes = readFileSync(file), events = readFileSync(join(dir, "ledger.jsonl"));
  expect(JSON.stringify(first)).not.toContain("2030-01-01"); expect(await ops.ablateClose(dir, ctx)).toEqual(first);
  expect(readFileSync(file)).toEqual(bytes); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(events);
  const id = attempt(dir, FOREIGN, 1, 0, { status: "running", hash: "f".repeat(64) }), before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.ablateClose(dir, ctx)).rejects.toThrow("attempt reconcile"); expect(readFileSync(file)).toEqual(bytes); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  const attemptFile = join(dir, "runs", "ablate", "attempts", `${id}.json`), data = JSON.parse(readFileSync(attemptFile, "utf8")); data.status = "failed"; writeFileSync(attemptFile, JSON.stringify(data));
  expect((await ops.ablateClose(dir, ctx)).inputsSha256).not.toBe(first.inputsSha256); expect(readLedger(dir).filter(e => e.type === "ablate.closed")).toHaveLength(2);
});

test("a no-winner or stale/edited investigation cannot drive ablations, without result writes", async () => {
  const none = await study("max", false); await expect(ops.ablateClose(none, ctx)).rejects.toThrow("no winner"); expect(existsSync(ablateResultPath(none))).toBe(false);
  const stale = await study(); attempt(stale, WIN, 3, 100, { run: "investigate" });
  expect(() => ops.ablateShow(stale)).toThrow("stale inputs"); await expect(ops.ablateAdd(stale, declaration(), ctx)).rejects.toThrow("stale inputs");
  const edited = await study(), file = investigateResultPath(edited, "investigate"); writeFileSync(file, readFileSync(file, "utf8") + " ");
  await expect(ops.ablateClose(edited, ctx)).rejects.toThrow("close receipt"); expect(existsSync(ablateResultPath(edited))).toBe(false);
});

test("unknown result version preserves original bytes, and show stays lock-free", async () => {
  const dir = await study(); await ops.ablateAdd(dir, declaration(), ctx); await ops.ablateClose(dir, ctx);
  const file = ablateResultPath(dir), text = '{"v":99,"future":"keep"}'; writeFileSync(file, text); const before = readFileSync(join(dir, "ledger.jsonl"));
  expect(() => ops.ablateShow(dir)).toThrow("supports it"); await expect(ops.ablateClose(dir, ctx)).rejects.toThrow("supports it");
  expect(readFileSync(file, "utf8")).toBe(text); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  writeFileSync(file, '{"v":1}'); writeFileSync(join(dir, ".ares.lock"), "live"); expect(ops.ablateShow(dir).ablations).toHaveLength(1);
});

test("CLI and MCP share declarations/show/close with no executor calls, and survey refuses", async () => {
  const dir = await study(), forbidden = async () => { throw new Error("ablate never executes"); };
  await run(["ablate", "add", dir, "--file", "-"], {}, { http: ctx.http, runner: forbidden, readStdin: async () => JSON.stringify(declaration()) });
  const server = createAresMcp({}, ctx.http, { runner: forbidden });
  expect(await server.handlers.ares_ablate_show!({ study: dir })).toEqual(JSON.parse((await run(["ablate", "show", dir, "--json"], {}, { http: ctx.http })).text));
  await server.handlers.ares_ablate_close!({ study: dir }); expect(ARES_TOOLS.find(t => t.name === "ares_ablate_close")!.annotations.openWorldHint).toBe(false);
  expect(ops.manifest().formats.ablateResult).toBe(1);
  const survey = tempDir(); ops.init(survey, { question: "synthetic" }, ctx); const before = readFileSync(join(survey, "ledger.jsonl"));
  await expect(ops.ablateAdd(survey, declaration(), ctx)).rejects.toThrow("experiment"); expect(() => ops.ablateShow(survey)).toThrow("experiment"); await expect(ops.ablateClose(survey, ctx)).rejects.toThrow("experiment");
  expect(readFileSync(join(survey, "ledger.jsonl"))).toEqual(before);
});


test("stored legacy selections using reserved phase runs fail closed for every ablate operation", async () => {
  for (const name of ["ablate", "final", "posthoc"]) {
    const dir = await study(), selection = join(dir, "design", "selection.json"), legacy = JSON.parse(readFileSync(selection, "utf8"));
    legacy.run = name; const text = JSON.stringify(legacy); writeFileSync(selection, text);
    const ledger = readFileSync(join(dir, "ledger.jsonl")), result = readFileSync(investigateResultPath(dir, "investigate"));
    await expect(ops.ablateAdd(dir, declaration(), ctx)).rejects.toThrow(`${name} is a reserved phase run`);
    expect(() => ops.ablateShow(dir)).toThrow("reserved phase run");
    await expect(ops.ablateClose(dir, ctx)).rejects.toThrow("reserved phase run");
    expect(readFileSync(selection, "utf8")).toBe(text); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
    expect(readFileSync(investigateResultPath(dir, "investigate"))).toEqual(result); expect(existsSync(ablateResultPath(dir))).toBe(false);
  }
});
