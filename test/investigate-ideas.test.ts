import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp, ARES_TOOLS } from "../src/mcp-tools.ts";
import { foldIdeas, MAX_IDEAS } from "../src/exp/ideas.ts";
import { protocolHash, readProtocol } from "../src/exp/protocol.ts";
import { appendEvent, commit, openStudy, readLedger } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
import type { AttemptStatus } from "../src/exp/attempts.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), NEXT = "b".repeat(40), OTHER = "c".repeat(40);
const idea = (id = "root", frozen = BASE) => ({ id, title: "Synthetic hypothesis", hypothesis: "Synthetic direction with measured evidence", commit: frozen });
async function setup() {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 10, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx); return dir;
}
let serial = 0;
function attempt(dir: string, frozen = BASE, status: AttemptStatus = "succeeded", value = 10) {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, run = "investigate";
  const folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, protocolHash: protocolHash(protocol), commit: frozen, seed: 1, status, stage: "evaluator", stages: {}, protocol, executor: {}, startedAt: "2030-01-01T00:00:00Z", metrics: [{ name: "score", unit: "points", value, provenance: "ares-observed" }], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run, commit: frozen, seed: 1 }); return id;
}

test("idea add is ledger-only, parent links survive replay and unknown event kinds are kept", async () => {
  const dir = await setup(); appendEvent(dir, actor, "future.event", { keep: true });
  const root = await ops.ideaAdd(dir, idea(), ctx); const child = await ops.ideaAdd(dir, { ...idea("child", NEXT), parent: root.id }, ctx);
  expect(child.parent).toBe("root"); expect(child.commits).toEqual([NEXT]);
  expect(foldIdeas(readLedger(dir)).map(i => i.id)).toEqual(["root", "child"]);
  expect(readLedger(dir).some(e => e.type === "future.event")).toBe(true);
  expect(readLedger(dir).filter(e => e.type === "idea.added")).toHaveLength(2);
});

test("duplicate ids, missing parents, malformed ids/commits and unknown fields refuse before a write", async () => {
  const dir = await setup(); await ops.ideaAdd(dir, idea(), ctx); const before = readFileSync(join(dir, "ledger.jsonl"));
  for (const [raw, message] of [
    [idea(), "duplicate id"], [{ ...idea("child"), parent: "missing" }, "parent missing"],
    [idea("../escape"), "id:"], [idea("x".repeat(65)), "id:"],
    [{ ...idea("short"), commit: "abc" }, "40-hex"], [{ ...idea("extra"), surprise: true }, "unknown field"],
  ] as [unknown, string][]) { await expect(ops.ideaAdd(dir, raw, ctx)).rejects.toThrow(message); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); }
});

test("1000 ideas is inclusive and the next add refuses without dropping journal data", async () => {
  const dir = await setup();
  commit(dir, [], Array.from({ length: MAX_IDEAS }, (_, i) => ({ actor, type: "idea.added", data: { idea: idea(`idea-${i}`) } })));
  expect(foldIdeas(readLedger(dir))).toHaveLength(1000);
  const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.ideaAdd(dir, idea("extra"), ctx)).rejects.toThrow("1000"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});

test("refine adds the commit, accepts terminal statuses and pivot closes further decisions", async () => {
  const dir = await setup(); await ops.ideaAdd(dir, idea(), ctx);
  const failed = attempt(dir, BASE, "failed");
  const refined = await ops.ideaDecide(dir, "root", { decision: "refine", reason: "Synthetic improvement", attempts: [failed], commit: NEXT }, ctx);
  expect(refined.commits).toEqual([BASE, NEXT]);
  const unknown = attempt(dir, NEXT, "unknown"), pivoted = await ops.ideaDecide(dir, "root", { decision: "pivot", reason: "Synthetic abandoned direction", attempts: [unknown] }, ctx);
  expect(pivoted.state).toBe("pivoted"); expect(pivoted.decisions).toHaveLength(2);
  const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.ideaDecide(dir, "root", { decision: "refine", reason: "Too late", attempts: [failed], commit: OTHER }, ctx)).rejects.toThrow("pivoted");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  expect((await ops.ideaAdd(dir, { ...idea("child", OTHER), parent: "root" }, ctx)).parent).toBe("root");
});

test("decisions require existing terminal own-commit attempts, refine commit, and bounded byte reasons", async () => {
  const dir = await setup(); await ops.ideaAdd(dir, idea(), ctx);
  const ok = attempt(dir), running = attempt(dir, BASE, "running"), foreign = attempt(dir, NEXT);
  const before = readFileSync(join(dir, "ledger.jsonl"));
  const cases: [string, unknown, string][] = [
    ["missing", { decision: "pivot", reason: "why", attempts: [ok] }, "unknown id"],
    ["root", { decision: "pivot", reason: "why", attempts: ["f".repeat(16)] }, "does not exist"],
    ["root", { decision: "pivot", reason: "why", attempts: [running] }, "running"],
    ["root", { decision: "pivot", reason: "why", attempts: [foreign] }, "foreign commit"],
    ["root", { decision: "refine", reason: "why", attempts: [ok] }, "requires --commit"],
    ["root", { decision: "refine", reason: "why", attempts: [ok], commit: "abc" }, "40-hex"],
    ["root", { decision: "pivot", reason: "한".repeat(667), attempts: [ok] }, "2000 bytes"],
    ["root", { decision: "pivot", reason: "why", attempts: [] }, "attempts"],
    ["root", { decision: "pivot", reason: "why", attempts: [ok], extra: true }, "unknown field"],
  ];
  for (const [id, raw, message] of cases) { await expect(ops.ideaDecide(dir, id, raw, ctx)).rejects.toThrow(message); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); }
  expect((await ops.ideaDecide(dir, "root", { decision: "refine", reason: "한".repeat(666) + "ab", attempts: [ok], commit: NEXT }, ctx)).decisions[0]!.reason).toHaveLength(668);
});

test("commit and winner idea annotations change the deterministic result input fingerprint", async () => {
  const dir = await setup(); attempt(dir, BASE, "succeeded", 10); attempt(dir, NEXT, "succeeded", 12);
  const before = await ops.investigateClose(dir, ctx); expect(before.winner?.idea).toBeUndefined();
  await ops.ideaAdd(dir, idea("winner-idea", NEXT), ctx);
  const shown = ops.investigateShow(dir); expect(shown.candidates.find(c => c.commit === NEXT)?.idea).toBe("winner-idea"); expect(shown.winner?.idea).toBe("winner-idea"); expect(shown.inputsSha256).not.toBe(before.inputsSha256);
  await ops.investigateClose(dir, ctx); const ledger = readFileSync(join(dir, "ledger.jsonl"));
  await ops.investigateClose(dir, ctx); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
});

test("CLI and MCP idea operations share validation, journal state and agent attribution without execution", async () => {
  const dir = await setup(), other = await setup(), forbidden = async () => { throw new Error("idea operations must not execute"); };
  await run(["idea", "add", dir, "--file", "-"], { CODEX_THREAD_ID: "synthetic" }, { http: ctx.http, runner: forbidden, readStdin: async () => JSON.stringify(idea()) });
  const server = createAresMcp({}, ctx.http, { runner: forbidden }); await server.handlers.ares_idea_add!({ study: other, idea: idea() });
  const a = attempt(dir), b = attempt(other);
  const cli = JSON.parse((await run(["idea", "decide", dir, "root", "refine", "--reason", "synthetic", "--attempts", a, "--commit", NEXT, "--json"], { CODEX_THREAD_ID: "synthetic" }, { http: ctx.http, runner: forbidden })).text);
  const mcp = await server.handlers.ares_idea_decide!({ study: other, id: "root", decision: "refine", reason: "synthetic", attempts: [b], commit: NEXT });
  expect(cli.commits).toEqual((mcp as { commits: string[] }).commits);
  for (const root of [dir, other]) expect(readLedger(root).find(e => e.type === "idea.decided")!.actor.kind).toBe("agent");
  expect(ARES_TOOLS.find(t => t.name === "ares_idea_decide")!.annotations.openWorldHint).toBe(false);
});

test("survey refuses every idea command and experiment ideas can be recorded before any protocol", async () => {
  const survey = tempDir(); ops.init(survey, { question: "synthetic" }, ctx); const before = readFileSync(join(survey, "ledger.jsonl"));
  await expect(ops.ideaAdd(survey, idea(), ctx)).rejects.toThrow("experiment");
  await expect(ops.ideaDecide(survey, "root", { decision: "pivot", reason: "why", attempts: [] }, ctx)).rejects.toThrow("experiment");
  expect(readFileSync(join(survey, "ledger.jsonl"))).toEqual(before);
  const experiment = tempDir(); ops.init(experiment, { question: "synthetic", mode: "experiment" }, ctx);
  expect((await ops.ideaAdd(experiment, { id: "concept", title: "Synthetic", hypothesis: "Not frozen yet" }, ctx)).commits).toEqual([]);
});
