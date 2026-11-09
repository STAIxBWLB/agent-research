import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { validatePlan } from "../src/plan/definition.ts";
import { loadCandidates } from "../src/lit/candidates.ts";
import { readLedger } from "../src/study.ts";
import { fakeHttp, fixture, ok, searchRoutes, tempDir } from "./helpers.ts";

const person = { kind: "person" as const };
const EMPTY_OA = JSON.stringify({ results: [] });
async function ready() {
  const dir = join(tempDir(), "s");
  ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
  const fake = fakeHttp(searchRoutes()), ctx = { actor: person, http: fake.http, sleep: async () => {} };
  await ops.scope(dir, { question: "Q?" }, ctx);
  return { dir, ctx };
}
const searches = (dir: string) => readLedger(dir).filter(e => e.type === "lit.search");

test("AC1: intent validates against three values and is recorded; omitting it keeps the event shape", async () => {
  const { dir, ctx } = await ready();
  await ops.search(dir, "agent review", {}, ctx);
  expect(Object.keys(searches(dir)[0]!.data)).toEqual(["query", "sources", "added", "merged", "dropped", "linked"]);
  const out = await ops.search(dir, "agent review", { intent: "semantic" }, ctx);
  expect(out.intent).toBe("semantic"); expect(searches(dir)[1]!.data.intent).toBe("semantic");
  const ledger = readFileSync(join(dir, "ledger.jsonl"));
  for (const intent of ["Lexical", "keyword", ""]) await expect(ops.search(dir, "agent review", { intent }, ctx)).rejects.toThrow(/--intent: unknown query intent; use lexical, semantic, background or omit it/);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  // Plan steps accept and validate the same intent.
  const plan = (intent: unknown) => ({ v: 1, nodes: [{ id: "s", kind: "step", command: "lit.search", args: { query: "q", intent } }], edges: [] });
  expect(validatePlan(plan("background")).nodes[0]).toMatchObject({ args: { intent: "background" } });
  expect(() => validatePlan(plan("dense"))).toThrow(/args\.intent: unknown query intent/);
  // MCP passes intent through.
  await createAresMcp({}, ctx.http).handlers.ares_lit_search!({ study: dir, query: "agent review", intent: "lexical" });
  expect(searches(dir).at(-1)!.data.intent).toBe("lexical");
});

test("AC2: firstQuery is set only when a search creates a candidate, never overwritten by later merges", async () => {
  const { dir, ctx } = await ready();
  const first = await ops.search(dir, "agent review", { intent: "lexical" }, ctx);
  expect(first.added).toBeGreaterThan(0);
  const created = loadCandidates(dir);
  expect(created.every(c => c.firstQuery === "search-1")).toBe(true);
  const second = await ops.search(dir, "agent review again", { intent: "semantic" }, ctx);
  expect(second.added).toBe(0); expect(second.merged).toBeGreaterThan(0);
  expect(loadCandidates(dir).map(c => [c.id, c.firstQuery])).toEqual(created.map(c => [c.id, "search-1"]));
});

test("AC3: lit queries yields match a scripted ledger of searches and screening, CLI and MCP alike", async () => {
  const dir = join(tempDir(), "s");
  ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
  // Search 1 (lexical) sees only OpenAlex; search 2 (background) adds the S2/arXiv records; search 3 adds nothing.
  const only = (oa: string, s2: string, arxiv: string) => fakeHttp([
    ["https://api.openalex.org/works", ok(oa)], ["https://api.semanticscholar.org/graph/v1/paper/search", ok(s2)], ["https://export.arxiv.org/api/query?search_query", ok(arxiv)],
  ]).http;
  const emptyS2 = JSON.stringify({ total: 0, data: [] }), emptyArxiv = fixture("arxiv-empty.xml");
  await ops.scope(dir, { question: "Q?" }, { actor: person, http: only(EMPTY_OA, emptyS2, emptyArxiv) });
  await ops.search(dir, "exact terms", { intent: "lexical" }, { actor: person, http: only(fixture("openalex.json"), emptyS2, emptyArxiv) });
  const fromOne = loadCandidates(dir).map(c => c.id);
  await ops.search(dir, "adjacent foundations", { intent: "background" }, { actor: person, http: only(fixture("openalex.json"), fixture("s2.json"), fixture("arxiv-search.xml")) });
  const fromTwo = loadCandidates(dir).map(c => c.id).filter(id => !fromOne.includes(id));
  await ops.search(dir, "nothing new", {}, { actor: person, http: only(EMPTY_OA, emptyS2, emptyArxiv) });
  expect(fromOne.length).toBeGreaterThan(0); expect(fromTwo.length).toBeGreaterThan(1);
  const screenCtx = { actor: person, http: only(EMPTY_OA, emptyS2, emptyArxiv) };
  await ops.screen(dir, [fromOne[0]!], "include", undefined, screenCtx);
  await ops.screen(dir, [fromTwo[0]!], "exclude", "synthetic", screenCtx);
  await ops.screen(dir, [fromTwo[1]!], "include", undefined, screenCtx);
  const report = ops.queries(dir);
  expect(report.queries.map(q => [q.id, q.intent, q.included, q.excluded, q.new])).toEqual([
    ["search-1", "lexical", 1, 0, fromOne.length - 1],
    ["search-2", "background", 1, 1, fromTwo.length - 2],
    ["search-3", "unspecified", 0, 0, 0],
  ]);
  expect(report.byIntent.lexical).toMatchObject({ queries: 1, included: 1 });
  expect(report.byIntent.semantic).toMatchObject({ queries: 0, included: 0 });
  expect(report.byIntent.unspecified).toMatchObject({ queries: 1, added: 0 });
  expect(report.zeroIncluded).toEqual([{ id: "search-3", intent: "unspecified", added: 0 }]);
  expect(report.unattributed).toBe(0);
  expect(await createAresMcp({}).handlers.ares_lit_queries!({ study: dir })).toEqual(report);
  const cli = await run(["lit", "queries", dir, "--json"], {});
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toEqual(JSON.parse(JSON.stringify(report)));
});

test("AC4: the export bundle carries intent and counts but no query text", async () => {
  const { dir, ctx } = await ready();
  await ops.search(dir, "SecretQueryWords lexical", { intent: "lexical" }, ctx);
  await ops.search(dir, "OtherHiddenPhrase", {}, ctx);
  const out = join(tempDir(), "bundle"), manifest = await ops.studyExport(dir, { bundle: out }) as { counts: { litQueries: Record<string, { queries: number; added: number }> } };
  expect(manifest.counts.litQueries.lexical!.queries).toBe(1); expect(manifest.counts.litQueries.unspecified!.queries).toBe(1);
  expect(manifest.counts.litQueries.lexical!.added).toBeGreaterThan(0);
  const ledger = readFileSync(join(out, "ledger.jsonl"), "utf8");
  expect(ledger).toContain('"intent":"lexical"');
  for (const name of ["manifest.json", "ledger.jsonl", "reviews.jsonl"]) {
    const text = readFileSync(join(out, name), "utf8");
    expect(text).not.toContain("SecretQueryWords"); expect(text).not.toContain("OtherHiddenPhrase");
  }
});

test("AC5: studies written by the previous minor line read and report as unspecified", async () => {
  const { dir, ctx } = await ready();
  await ops.search(dir, "agent review", {}, ctx);
  // Simulate an N-1 study: candidates without firstQuery and an older lit.search event without intent.
  const path = join(dir, "literature", "candidates.json"), list = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
  for (const c of list) delete c.firstQuery;
  writeFileSync(path, JSON.stringify(list, null, 1) + "\n");
  const report = ops.queries(dir);
  expect(report.queries).toHaveLength(1); expect(report.queries[0]).toMatchObject({ id: "search-1", intent: "unspecified", included: 0, new: 0 });
  expect(report.unattributed).toBe(list.length); expect(report.byIntent.unspecified.queries).toBe(1);
  // A later search still attributes only the candidates it creates.
  await ops.search(dir, "agent review", { intent: "semantic" }, ctx);
  expect(loadCandidates(dir).every(c => c.firstQuery === undefined)).toBe(true);
});
