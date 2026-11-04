import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { rankLessons } from "../src/memory/lessons.ts";
import type { AmemHit } from "../src/memory/amem.ts";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { fakeRunner, tempDir } from "./helpers.ts";
const now = Date.parse("2030-01-01T00:00:00Z"), day = 86_400_000;
const hit = (n: number, age: number, relevance = 1, kind: AmemHit["kind"] = "finding"): AmemHit => ({ id: n.toString(16).padStart(32, "0"), kind, title: `Synthetic ${n}`, at: new Date(now - age * day).toISOString(), about: [], relevance });
const response = (data: unknown) => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: "private diagnostic" });
const searchRow = (row: AmemHit) => ({ id: row.id, kind: row.kind, title: row.title, at: row.at, about: row.about, scoreDetails: { finalScore: row.relevance / 2, recencyFactor: 0.5 } });
async function study() {
  const dir = tempDir(); ops.init(dir, { question: "Synthetic project question" }, { actor: { kind: "person" } }); return dir;
}

test("half-life ranking uses an explicit fixed clock and only one recency decay", () => {
  const hits = [hit(1, 0, 1), hit(2, 180, 3), hit(3, 360, 4)], before = JSON.stringify(hits);
  expect(rankLessons(hits, now)).toEqual([
    { id: hits[1]!.id, kind: "finding", title: "Synthetic 2", age: 180, score: 3, rank: 1.5 },
    { id: hits[0]!.id, kind: "finding", title: "Synthetic 1", age: 0, score: 1, rank: 1 },
    { id: hits[2]!.id, kind: "finding", title: "Synthetic 3", age: 360, score: 4, rank: 1 },
  ]);
  expect(JSON.stringify(hits)).toBe(before);
  expect(rankLessons([hit(1, 1.5)], now, { halfLife: 1.5 })[0]!.rank).toBe(0.5);
});

test("equal ranks put fail first, then lexical id independently of input order", () => {
  const hits = [hit(3, 0, 1), hit(2, 0, 1, "fail"), hit(1, 0, 1, "decision"), hit(4, 180, 2, "fail")];
  const order = [hits[1]!.id, hits[3]!.id, hits[2]!.id, hits[0]!.id];
  expect(rankLessons(hits, now).map(row => row.id)).toEqual(order);
  expect(rankLessons([...hits].reverse(), now).map(row => row.id)).toEqual(order);
});

test("fractional age is days and future timestamps do not boost relevance", () => {
  expect(rankLessons([hit(1, 0.5)], now, { halfLife: 1 })[0]!.rank).toBeCloseTo(Math.SQRT1_2);
  expect(rankLessons([{ ...hit(2, -1), title: null }], now)[0]).toMatchObject({ title: null, age: 0, score: 1, rank: 1 });
  expect(rankLessons([hit(3, 100_000)], now, { halfLife: 1 })[0]!.rank).toBe(0);
});

test("defaults and inclusive bounds cap the sorted output at 50", () => {
  const hits = Array.from({ length: 60 }, (_, i) => hit(i, 0, i + 1));
  expect(rankLessons(hits, now)).toHaveLength(50);
  expect(rankLessons(hits, now, { halfLife: 3650, limit: 1 })[0]!.score).toBe(60);
  expect(rankLessons([], now, { halfLife: 1, limit: 50 })).toEqual([]);
  for (const halfLife of [0, -1, 3651, NaN, Infinity]) expect(() => rankLessons(hits, now, { halfLife })).toThrow("half-life");
  for (const limit of [0, -1, 51, 1.5, NaN, Infinity]) expect(() => rankLessons(hits, now, { limit })).toThrow("limit");
  expect(() => rankLessons(hits, NaN)).toThrow("clock");
  for (const row of [{ ...hit(1, 0), at: "invalid" }, { ...hit(1, 0), relevance: NaN }, { ...hit(1, 0), relevance: -1 }]) expect(() => rankLessons([row], now)).toThrow("score unavailable");
});

test("lessons searches in the study project with injected identity and clock, without writes", async () => {
  const dir = await study(), before = readFileSync(join(dir, "ledger.jsonl")), files = readdirSync(dir), row = hit(1, 180, 2);
  const fake = fakeRunner([response([searchRow(row)])]); let clocks = 0;
  const result = await ops.lessons(dir, {}, { runner: fake.runner, now: () => { clocks++; return now; } }, { CODEX_THREAD_ID: "synthetic", ANTHROPIC_API_KEY: "secret" });
  expect(result).toEqual({ lessons: [{ id: row.id, kind: row.kind, title: row.title, age: 180, score: 2, rank: 1 }] });
  expect(clocks).toBe(1); expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]!.command).toBe("amem"); expect(fake.requests[0]!.cwd).toBe(dir);
  expect(fake.requests[0]!.args).toEqual(["search", "Synthetic project question", "--json", "--explain", "--limit", "100"]);
  expect(fake.requests[0]!.env).toEqual({ CODEX_THREAD_ID: "synthetic" });
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(readdirSync(dir)).toEqual(files); expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
});

test("--for adds the typed brief and CLI forwards ranking options with no ledger changes", async () => {
  const dir = await study(), before = readFileSync(join(dir, "ledger.jsonl"));
  const brief = { brief: "Synthetic phase context", bytes: 23, truncated: false, state: "known" };
  const fake = fakeRunner([response({ engine: "fts5", hits: [hit(2, 180, 2), hit(1, 0, 1, "fail")].map(row => ({ source: "curated", view: row, scoreDetails: searchRow(row).scoreDetails })) }), response(brief)]);
  const output = await run(["lessons", dir, "--for", "investigate phase", "--half-life", "180", "--limit", "1", "--json"], {}, { runner: fake.runner, now: () => now });
  expect(output.code).toBe(0); expect(JSON.parse(output.text)).toEqual({ lessons: [{ id: hit(1, 0).id, kind: "fail", title: "Synthetic 1", age: 0, score: 1, rank: 1 }], brief });
  expect(fake.requests[1]!.args).toEqual(["brief", "--for", "investigate phase", "--json", "--bytes", "2048"]);
  expect(fake.requests.every(request => request.cwd === dir)).toBe(true); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});

test("invalid command options refuse before any amem read", async () => {
  const dir = await study(), fake = fakeRunner([]), ctx = { runner: fake.runner, now: () => now };
  for (const options of [{ halfLife: 0 }, { limit: 51 }, { for: "" }, { for: "bad\0intent" }, { for: "x".repeat(1001) }]) await expect(ops.lessons(dir, options, ctx)).rejects.toThrow("lessons");
  await expect(run(["lessons", dir, "--half-life", "invalid"], {}, ctx)).rejects.toThrow("half-life");
  await expect(run(["lessons", dir, "--limit", "1.5"], {}, ctx)).rejects.toThrow("integer");
  expect(fake.requests).toEqual([]);
});

test("amem failure classes propagate without diagnostic text or study writes", async () => {
  const dir = await study(), before = readFileSync(join(dir, "ledger.jsonl"));
  for (const script of [[{ exitCode: 2, stdout: "private diagnostic", stderr: "private diagnostic" }],
    [response([]), { exitCode: 2, stdout: "private diagnostic", stderr: "private diagnostic" }]]) {
    const fake = fakeRunner(script);
    try { await ops.lessons(dir, { for: "phase" }, { runner: fake.runner, now: () => now }); throw new Error("expected rejection"); }
    catch (error) { expect((error as Error).message).toContain("nonzero exit"); expect((error as Error).message).not.toContain("private diagnostic"); }
    expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  }
});
