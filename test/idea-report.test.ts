import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp, ARES_TOOLS } from "../src/mcp-tools.ts";
import { foldIdeas } from "../src/exp/ideas.ts";
import { protocolHash, readProtocol } from "../src/exp/protocol.ts";
import { appendEvent, openStudy, readLedger } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
import type { AttemptStatus } from "../src/exp/attempts.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const BASE = "a".repeat(40), sha = (n: number) => n.toString(16).padStart(40, "c");
async function setup() {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] },
    metrics: [{ name: "score", unit: "points", direction: "max" }, { name: "secs", unit: "s", direction: "min" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  attempt(dir, BASE, 10, 100); return dir;
}
let serial = 0;
function attempt(dir: string, frozen: string, score: number, secs = 100, status: AttemptStatus = "succeeded") {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, runName = "investigate";
  const folder = join(dir, "runs", runName, "attempts"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run: runName, protocolHash: protocolHash(protocol), commit: frozen, seed: 1, status, stage: "evaluator", stages: {}, protocol, executor: {}, startedAt: "2030-01-01T00:00:00Z",
    metrics: [{ name: "score", unit: "points", value: score, provenance: "ares-observed" }, { name: "secs", unit: "s", value: secs, provenance: "ares-observed" }], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run: runName, commit: frozen, seed: 1 }); return id;
}
const idea = (id: string, commit: string, extra: Record<string, unknown> = {}) => ({ id, title: "Synthetic", hypothesis: "Synthetic direction", commit, ...extra });

test("AC1: an idea without the new fields is stored and folded exactly as before", async () => {
  const dir = await setup(); const plain = idea("plain", sha(1));
  const stored = await ops.ideaAdd(dir, plain, ctx);
  expect(readLedger(dir).find(e => e.type === "idea.added")!.data.idea).toEqual(plain);
  expect(Object.keys(stored).sort()).toEqual(["commits", "decisions", "hypothesis", "id", "state", "title"]);
});

test("planning fields validate before any write and decide cannot add predictions", async () => {
  const dir = await setup(), before = readFileSync(join(dir, "ledger.jsonl"));
  for (const [extra, message] of [
    [{ bundle: 0 }, "bundle"], [{ bundle: 17 }, "bundle"], [{ predicts: [] }, "predicts"], [{ predicts: Array(5).fill({ metric: "score", expect: "improve" }) }, "predicts"],
    [{ predicts: [{ metric: "score", expect: "up" }] }, "expect"], [{ predicts: [{ metric: "score", expect: "improve", minDelta: -1 }] }, "minDelta"],
    [{ predicts: [{ metric: "missing", expect: "improve" }] }, "score, secs"], [{ predicts: [{ metric: "score", expect: "improve" }, { metric: "score", expect: "regress" }] }, "one prediction"],
    [{ category: "../x" }, "category"],
    [{ predicts: [{ metric: "secs", expect: "no-change" }] }, "predicts secs: no-change on a non-primary metric needs minDelta; add minDelta in that metric's unit"],
  ] as [Record<string, unknown>, string][]) {
    await expect(ops.ideaAdd(dir, idea("bad", sha(1), extra), ctx)).rejects.toThrow(message);
    expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  }
  expect((await ops.ideaAdd(dir, idea("primary", sha(5), { predicts: [{ metric: "score", expect: "no-change" }] }), ctx)).predicts).toHaveLength(1);
  await ops.ideaAdd(dir, idea("ok", sha(1)), ctx); const evidence = attempt(dir, sha(1), 11);
  await expect(ops.ideaDecide(dir, "ok", { decision: "pivot", reason: "why", attempts: [evidence], predicts: [{ metric: "score", expect: "improve" }] }, ctx)).rejects.toThrow("unknown field");
});

test("AC5: a declared vocabulary refuses unknown categories by name, and untried lists unmeasured ones", async () => {
  const dir = await setup();
  const set = await ops.ideaCategories(dir, { v: 1, categories: ["data", "optimizer", "arch"] }, ctx);
  expect(set.changed).toBe(true); expect(existsSync(join(dir, "design", "idea-categories.json"))).toBe(true);
  expect((await ops.ideaCategories(dir, { v: 1, categories: ["data", "optimizer", "arch"] }, ctx)).changed).toBe(false);
  expect(readLedger(dir).filter(e => e.type === "idea.categories.set")).toHaveLength(1);
  const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.ideaAdd(dir, idea("x", sha(1), { category: "loss" }), ctx)).rejects.toThrow("use one of data, optimizer, arch");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  await ops.ideaAdd(dir, idea("d", sha(1), { category: "data" }), ctx); attempt(dir, sha(1), 12);
  await ops.ideaAdd(dir, idea("o", sha(2), { category: "optimizer" }), ctx);
  expect(ops.ideaReport(dir).search.untried).toEqual(["optimizer", "arch"]);
  await expect(ops.ideaCategories(dir, { v: 1, categories: ["a", "a"] }, ctx)).rejects.toThrow("duplicate");
  writeFileSync(join(dir, "design", "idea-categories.json"), "{broken");
  await expect(ops.ideaAdd(dir, idea("y", sha(3), { category: "data" }), ctx)).rejects.toThrow("invalid JSON");
  expect((await ops.ideaCategories(dir, { v: 1, categories: ["data"] }, ctx)).changed).toBe(true);
  expect((await ops.ideaAdd(dir, idea("y", sha(3), { category: "data" }), ctx)).category).toBe("data");
  await expect(ops.ideaCategories(dir, { v: 1, categories: Array.from({ length: 33 }, (_, i) => `c${i}`) }, ctx)).rejects.toThrow("1..32");
});

test("AC2 and AC3: prospective hits match investigate deltas; predictions after the first attempt are post-hoc and unscored", async () => {
  const dir = await setup();
  await ops.ideaAdd(dir, idea("early", sha(1), { category: "data", predicts: [{ metric: "score", expect: "improve", minDelta: 1 }, { metric: "secs", expect: "no-change", minDelta: 5 }] }), ctx);
  attempt(dir, sha(1), 13, 120);
  attempt(dir, sha(2), 9, 100);
  await ops.ideaAdd(dir, idea("late", sha(2), { category: "data", predicts: [{ metric: "score", expect: "regress" }] }), ctx);
  const report = ops.ideaReport(dir), shown = ops.investigateShow(dir);
  const early = report.ideas.find(i => i.id === "early")!, late = report.ideas.find(i => i.id === "late")!;
  for (const row of report.ideas) expect(row.primaryDelta).toBe(shown.candidates.find(c => c.commit === row.measuredCommit)!.delta);
  expect(early.timing).toBe("prospective");
  expect(early.predictions).toEqual([{ metric: "score", expect: "improve", minDelta: 1, delta: 3, outcome: "hit" }, { metric: "secs", expect: "no-change", minDelta: 5, delta: -20, outcome: "miss" }]);
  expect(early.unpredictedRegressions).toEqual(["secs"]);
  expect(late.timing).toBe("post-hoc"); expect(late.predictions[0]!.outcome).toBeUndefined(); expect(late.predictions[0]!.delta).toBe(-1);
  expect(report.categories).toEqual([{ name: "data", ideas: 2, measured: 2, hits: 1, bestRecentDelta: 3, noRecentGain: false }]);
});

test("AC4: a bundle above one is confounded and changes no category count", async () => {
  const dir = await setup();
  await ops.ideaAdd(dir, idea("single", sha(1), { category: "data" }), ctx); attempt(dir, sha(1), 9);
  const without = ops.ideaReport(dir);
  await ops.ideaAdd(dir, idea("bundled", sha(2), { category: "data", bundle: 3, predicts: [{ metric: "score", expect: "improve" }] }), ctx); attempt(dir, sha(2), 20);
  const report = ops.ideaReport(dir);
  expect(report.confounded).toEqual(["bundled"]); expect(report.ideas.find(i => i.id === "bundled")!.confounded).toBe(true);
  expect(report.categories).toEqual(without.categories); expect(report.search).toEqual(without.search);
});

test("AC6: stalled and noRecentGain follow the window over measured ideas in ledger order", async () => {
  const dir = await setup();
  const deltas = [4, 1, -1, 0, 2, 3];
  for (const [i, delta] of deltas.entries()) { await ops.ideaAdd(dir, idea(`i${i}`, sha(i + 1), { category: i < 2 ? "gain" : "flat" }), ctx); attempt(dir, sha(i + 1), 10 + delta); }
  await ops.ideaAdd(dir, idea("unmeasured", sha(99), { category: "flat" }), ctx); attempt(dir, sha(99), 0, 100, "failed");
  const w5 = ops.ideaReport(dir, { window: 5 });
  // Eligible deltas need >= minDelta 1: last five best is 3, earlier best is 4.
  expect(w5.search).toEqual({ measured: 6, bestDelta: 4, stalled: true, untried: [] });
  expect(w5.ideas.find(i => i.id === "unmeasured")!.attempts.failed).toBe(1);
  expect(ops.ideaReport(dir, { window: 6 }).search.stalled).toBe(false);
  expect(ops.ideaReport(dir, { window: 7 }).search.stalled).toBe(false);
  const w2 = ops.ideaReport(dir, { window: 2 }).categories;
  expect(w2.find(c => c.name === "flat")).toEqual({ name: "flat", ideas: 5, measured: 4, hits: 0, bestRecentDelta: 3, noRecentGain: false });
  const w3 = ops.ideaReport(dir, { window: 3 });
  expect(w3.search.stalled).toBe(true);
  await ops.ideaAdd(dir, idea("i6", sha(7), { category: "worse" }), ctx); attempt(dir, sha(7), 8);
  expect(ops.ideaReport(dir, { window: 1 }).categories.find(c => c.name === "worse")).toEqual({ name: "worse", ideas: 1, measured: 1, hits: 0, bestRecentDelta: -2, noRecentGain: true });
});

test("AC7: the report writes nothing and CLI and MCP return the same object; bad options refuse", async () => {
  const dir = await setup();
  await ops.ideaAdd(dir, idea("x", sha(1), { category: "data", predicts: [{ metric: "score", expect: "improve" }] }), ctx); attempt(dir, sha(1), 12);
  const ledger = readFileSync(join(dir, "ledger.jsonl")), forbidden = async () => { throw new Error("report must not execute"); };
  const cli = JSON.parse((await run(["idea", "report", dir, "--window", "3", "--json"], {}, { http: ctx.http, runner: forbidden })).text);
  const mcp = await createAresMcp({}, ctx.http, { runner: forbidden }).handlers.ares_idea_report!({ study: dir, window: 3 });
  expect(cli).toEqual(JSON.parse(JSON.stringify(mcp))); expect(cli).toEqual(JSON.parse(JSON.stringify(ops.ideaReport(dir, { window: 3 }))));
  expect(cli.advisory).toBe(true); expect(cli.window).toBe(3); expect(ops.ideaReport(dir).window).toBe(5);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  expect(existsSync(join(dir, "runs", "investigate", "investigate.json"))).toBe(false);
  const tool = ARES_TOOLS.find(t => t.name === "ares_idea_report")!;
  expect(tool.annotations.readOnlyHint).toBe(true); expect(ops.manifest().mcp.tools).toContainEqual({ name: "ares_idea_report", readOnly: true });
  const zero = await run(["idea", "report", dir, "--window", "0"], {}, { http: ctx.http }).catch(e => e);
  expect(String(zero)).toContain("--window"); expect(zero.code ?? zero.exitCode ?? 2).toBe(2);
  expect(() => ops.ideaReport(dir, { run: "other" })).toThrow("selection run investigate");
  const human = await run(["idea", "report", dir], { LANG: "C", COLUMNS: "80" }, { http: ctx.http });
  expect(human.text).toContain("Search"); expect(human.text).toContain("x");
});

test("older idea events replay unchanged next to the new optional fields", async () => {
  const dir = await setup();
  appendEvent(dir, actor, "idea.added", { idea: { id: "legacy", title: "Old", hypothesis: "Old" } });
  appendEvent(dir, actor, "idea.added", { idea: { id: "new", title: "New", hypothesis: "New", category: "data", bundle: 2, predicts: [{ metric: "score", expect: "improve" }] } });
  const [legacy, fresh] = foldIdeas(readLedger(dir));
  expect(Object.keys(legacy!)).not.toContain("category"); expect(fresh!.bundle).toBe(2);
});
