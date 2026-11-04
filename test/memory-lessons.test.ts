import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { foldIdeas } from "../src/exp/ideas.ts";
import { protocolHash, readProtocol, designBinding } from "../src/exp/protocol.ts";
import { finalGateBinding, requireFinalInputs, finalResultPath } from "../src/exp/final.ts";
import { investigateResultPath } from "../src/exp/investigate.ts";
import { appendEvent, openStudy, readLedger, type LedgerEvent } from "../src/study.ts";
import { deriveLessons, readLessonSources, type LessonSources } from "../src/memory/lessons.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), WIN = "b".repeat(40);
const event = (type: string, data: Record<string, unknown>): LedgerEvent => ({ v: 1, at: "2030-01-01T00:00:00Z", actor, type, data });
const sources = (events: LedgerEvent[] = []): LessonSources => ({ study: { id: "synthetic", question: "Does it improve?" }, events });
const pivotEvents = (extra: Record<string, unknown> = {}, attempts: string[] = []): LedgerEvent[] => [
  event("idea.added", { idea: { id: "candidate", title: "Synthetic title", hypothesis: "Synthetic hypothesis", ...(attempts.length ? { commit: BASE } : {}) } }),
  event("idea.decided", { id: "candidate", decision: "pivot", reason: "Synthetic failed direction", attempts, ...extra }),
];

async function study(protocol = false) {
  const dir = tempDir(); ops.init(dir, { question: "Synthetic question", mode: "experiment" }, ctx);
  if (protocol) {
    mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
    writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
    await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] },
      metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1, 2], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
    await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx);
    await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  }
  return dir;
}
let serial = 0;
function attempt(dir: string, frozen: string, run = "investigate", value = 10) {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, seed = run === "final" ? 2 : 1;
  const folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
  const binding = run === "final" ? finalGateBinding(dir) : undefined;
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit: frozen, seed, protocolHash: protocolHash(protocol), protocol,
    executor: {}, stages: {}, stage: "evaluator", status: "succeeded", startedAt: "2030-01-01T00:00:00Z", sealBinding: designBinding(dir),
    ...(binding ? { finalBinding: binding, finalWinner: requireFinalInputs(dir).winner } : {}), metrics: [{ name: "score", value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run, commit: frozen, seed }); return id;
}

test("pivots derive literal fail fields and old journals use not recorded without invention", () => {
  const ids = ["a".repeat(16), "b".repeat(16)];
  const old = deriveLessons(sources(pivotEvents({}, ids)));
  expect(old).toEqual([{ kind: "fail", title: "Synthetic title", text: "synthetic: Does it improve?\nPivot candidate: Synthetic failed direction",
    approach: "Synthetic title\nSynthetic hypothesis", symptom: "Synthetic failed direction", cause: "not recorded", retryWhen: "not recorded",
    evidence: ids.map(id => `ares:synthetic/attempt:${id}`) }]);
  expect(deriveLessons(sources(pivotEvents({ cause: "Measured cause", retryWhen: "New data" })))[0]).toMatchObject({ cause: "Measured cause", retryWhen: "New data" });
  expect(deriveLessons(sources([pivotEvents()[0]!]))).toEqual([]);
});

test("evidence chunks are stable, bounded and preserve every cited attempt", () => {
  const ids = Array.from({ length: 35 }, (_, i) => i.toString(16).padStart(16, "0"));
  const input = sources(pivotEvents({}, ids)), before = JSON.stringify(input), notes = deriveLessons(input);
  expect(notes.map(note => note.evidence!.length)).toEqual([16, 16, 3]);
  expect(notes.flatMap(note => note.evidence!)).toEqual(ids.map(id => `ares:synthetic/attempt:${id}`));
  expect(deriveLessons(input)).toEqual(notes); expect(JSON.stringify(input)).toBe(before);
});

test("pivot fields accept inclusive UTF-8 bounds; refine and oversized fields preserve the ledger", async () => {
  const dir = await study(); await ops.ideaAdd(dir, { id: "candidate", title: "Synthetic", hypothesis: "Synthetic" }, ctx);
  const before = readFileSync(join(dir, "ledger.jsonl"));
  for (const field of ["cause", "retryWhen"]) {
    await expect(ops.ideaDecide(dir, "candidate", { decision: "refine", reason: "why", commit: BASE, [field]: "cause" }, ctx)).rejects.toThrow("pivot-only");
    await expect(ops.ideaDecide(dir, "candidate", { decision: "pivot", reason: "why", [field]: "한".repeat(667) }, ctx)).rejects.toThrow("2000 bytes");
    expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  }
  const cause = "한".repeat(666) + "ab";
  const idea = await ops.ideaDecide(dir, "candidate", { decision: "pivot", reason: "why", cause, retryWhen: "x".repeat(2000) }, ctx);
  expect(idea.decisions[0]).toMatchObject({ cause, retryWhen: "x".repeat(2000) });
  expect(foldIdeas(readLedger(dir))).toEqual([idea]);
  expect(foldIdeas(pivotEvents({ commit: BASE }))[0]!.decisions[0]!.commit).toBe(BASE);
});

test("CLI and MCP forward pivot context and refuse refine context before writes", async () => {
  const dir = await study();
  for (const id of ["cli", "mcp", "refine"]) await ops.ideaAdd(dir, { id, title: "Synthetic", hypothesis: "Synthetic" }, ctx);
  expect((await run(["idea", "decide", dir, "cli", "pivot", "--reason", "why", "--cause", "cause", "--retry-when", "retry", "--json"])).code).toBe(0);
  const mcp = createAresMcp({}, ctx.http);
  await mcp.handlers.ares_idea_decide!({ study: dir, id: "mcp", decision: "pivot", reason: "why", cause: "cause", retryWhen: "retry" });
  const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(run(["idea", "decide", dir, "refine", "refine", "--reason", "why", "--commit", BASE, "--cause", "cause"])).rejects.toThrow("pivot-only");
  await expect(mcp.handlers.ares_idea_decide!({ study: dir, id: "refine", decision: "refine", reason: "why", commit: BASE, retryWhen: "retry" })).rejects.toThrow("pivot-only");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  for (const id of ["cli", "mcp"]) expect(foldIdeas(readLedger(dir)).find(idea => idea.id === id)!.decisions[0]).toMatchObject({ cause: "cause", retryWhen: "retry" });
});

test("open contradictions stay private; resolved contradictions name the original finding and resolution", () => {
  const report = { v: 1, reviewer: { id: "synthetic", modelFamily: "synthetic" }, buildSha256: "a".repeat(64),
    checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings: [
      { id: "open", kind: "contradiction", location: "Synthetic section", text: "Unresolved contradiction", blocking: true },
      { id: "closed", kind: "contradiction", location: "Synthetic section", text: "Synthetic contradiction", blocking: true },
    ] };
  const events = [event("review.added", { id: "review-one", review: report }), event("review.resolved", { reviewId: "review-one", findingId: "closed", buildSha256: report.buildSha256, reason: "Corrected the synthetic denominator" })];
  const notes = deriveLessons(sources(events));
  expect(notes).toHaveLength(1); expect(notes[0]!.text).toContain("resolution: Corrected the synthetic denominator");
  expect(JSON.stringify(notes)).not.toContain("Unresolved contradiction");
});

test("source loader exports no open investigation, then closed no-winner with named reason", async () => {
  const dir = await study(true), before = readFileSync(join(dir, "ledger.jsonl"));
  const decisions = deriveLessons(readLessonSources(dir));
  expect(decisions.map(note => note.kind)).toEqual(["decision", "decision"]);
  expect(decisions[0]!.text).toContain('"minSeeds":1'); expect(decisions[1]!.text).toContain("Final seeds: [2]");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  await ops.investigateClose(dir, ctx);
  const notes = deriveLessons(readLessonSources(dir));
  expect(notes[0]!.text).toContain("no winner; reason no-baseline");
  expect(notes[0]!.evidence).toEqual([`ares:${openStudy(dir).study.id}/run:investigate`]);
});

test("closed winner and positive/negative finals carry actual commit, delta, seeds and evidence", async () => {
  for (const value of [12, 10]) {
    const dir = await study(true); attempt(dir, BASE); const winnerAttempt = attempt(dir, WIN, "investigate", 12);
    await ops.investigateClose(dir, ctx);
    await ops.gateDecide(dir, "design", "approve", undefined, ctx); await ops.gateDecide(dir, "final", "approve", undefined, ctx);
    attempt(dir, BASE, "final"); const finalAttempt = attempt(dir, WIN, "final", value); await ops.finalClose(dir, ctx);
    const input = readLessonSources(dir), before = readFileSync(join(dir, "ledger.jsonl")), notes = deriveLessons(input);
    expect(notes[0]!.text).toContain(`winner ${WIN}; paired delta 2; seeds [1]`);
    expect(notes[0]!.evidence).toContain(`ares:${input.study.id}/attempt:${winnerAttempt}`);
    expect(notes[1]!.text).toContain(value === 12 ? "Final qualified" : "Final not_qualified");
    expect(notes[1]!.text).toContain(value === 12 ? "reason qualified" : "reason below-margin");
    expect(notes[1]!.evidence).toContain(`ares:${input.study.id}/attempt:${finalAttempt}`);
    expect(notes.every(note => note.text.startsWith(`${input.study.id}: ${input.study.question}\n`))).toBe(true);
    expect(deriveLessons(readLessonSources(dir))).toEqual(notes); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
    const file = finalResultPath(dir); writeFileSync(file, readFileSync(file, "utf8") + " ");
    expect(() => readLessonSources(dir)).toThrow("latest close receipt");
  }
});

test("hand-edited design and stale closed results refuse rather than creating lessons", async () => {
  const dir = await study(true); await ops.investigateClose(dir, ctx);
  const result = investigateResultPath(dir, "investigate"), original = readFileSync(result, "utf8");
  writeFileSync(result, original + " "); expect(() => readLessonSources(dir)).toThrow("close receipt"); writeFileSync(result, original);
  attempt(dir, BASE); expect(() => readLessonSources(dir)).toThrow("stale inputs");
  const selection = join(dir, "design", "selection.json"); writeFileSync(selection, readFileSync(selection, "utf8") + " ");
  expect(() => readLessonSources(dir)).toThrow("matching receipt");
});
