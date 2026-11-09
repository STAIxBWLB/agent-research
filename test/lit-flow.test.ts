import { expect, test } from "bun:test";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { checkPaper } from "../src/paper/check.ts";
import { loadCandidates, mergeCandidates } from "../src/lit/candidates.ts";
import { readLedger } from "../src/study.ts";
import { fakeHttp, fixture, ok, searchRoutes, status, tempDir } from "./helpers.ts";

const person = { kind: "person" as const };
const SCOPE_CODES = [{ code: "off-topic", label: "Outside the review topic" }, { code: "no-eval", label: "No evaluation reported" }];
async function study(codes = true) {
  const dir = join(tempDir(), "s");
  ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
  const fake = fakeHttp([
    ...searchRoutes(),
    ["https://api.crossref.org/works/10.1234/jrl.2024.001", ok(fixture("crossref.json"))],
    ["https://api.crossref.org/", status(404)],
    ["https://api.datacite.org/dois/10.5555/budget.2025.7", ok(fixture("datacite.json"))],
    ["https://export.arxiv.org/api/query?id_list=", ok(fixture("arxiv-search.xml"))],
  ]);
  const ctx = { actor: person, http: fake.http, sleep: async () => {} };
  await ops.scope(dir, { question: "Q?", yearFrom: 2020, ...(codes ? { exclusionCodes: SCOPE_CODES } : {}) }, ctx);
  return { dir, ctx };
}
async function scripted(codes = true) {
  const s = await study(codes);
  // Two searches over all sources: the second only merges into existing candidates.
  await ops.search(s.dir, "agent review", { yearFrom: 2021 }, s.ctx);
  await ops.search(s.dir, "agent review again", {}, s.ctx);
  await ops.screen(s.dir, ["doi:10.1234/jrl.2024.001", "arxiv:2502.04321", "arxiv:2501.01234"], "include", undefined, s.ctx);
  await ops.screen(s.dir, ["doi:10.5555/budget.2025.7"], "exclude", "off topic", s.ctx, undefined, codes ? "off-topic" : undefined);
  await ops.verify(s.dir, [], s.ctx);
  await ops.card(s.dir, "doi:10.1234/jrl.2024.001", { summary: "Synthetic card." }, s.ctx);
  return s;
}

test("AC1: flow counts match a scripted study", async () => {
  const { dir } = await scripted();
  const flow = ops.flow(dir) as ReturnType<typeof ops.litFlowView>;
  const events = readLedger(dir).filter(e => e.type === "lit.search"), candidates = loadCandidates(dir);
  const returned = events.flatMap(e => e.data.sources as { returned: number }[]).reduce((n, s) => n + s.returned, 0);
  const merged = events.reduce((n, e) => n + (e.data.merged as number) + ((e.data.absorbed as number | undefined) ?? 0), 0);
  expect(returned).toBe(candidates.length + merged + events.reduce((n, e) => n + (e.data.dropped as number), 0));
  expect(flow).toMatchObject({
    records: returned, duplicates: merged, unique: candidates.length,
    screened: 4, excluded: 1, excludedByCode: { "off-topic": 1, "no-eval": 0, uncoded: 0 },
    unscreened: candidates.length - 4, included: 3, verified: 2, cards: 1, screenApproved: false,
  });
  expect(merged).toBeGreaterThan(0);
  expect(flow.window).toMatchObject({ searches: 2, yearFrom: [2021], scopeYearFrom: 2020, firstSearch: events[0]!.at, lastSearch: events[1]!.at });
  expect(Object.keys(flow.sources).sort()).toEqual(["arxiv", "openalex", "s2"]);
  expect(Object.values(flow.sources).every(s => s.searches === 2)).toBe(true);
  // Year-from is recorded only when given.
  expect(events[0]!.data.yearFrom).toBe(2021); expect(Object.hasOwn(events[1]!.data, "yearFrom")).toBe(false);
});

test("AC2: lit.flow placeholders resolve only while the screen gate is approved", async () => {
  const { dir, ctx } = await scripted();
  mkdirSync(join(dir, "paper"));
  const draft = (text: string) => { writeFileSync(join(dir, "paper", "manuscript.md"), text); return checkPaper(dir); };
  const text = "We screened {{n:lit.flow.screened}} records and included {{n:lit.flow.included}}; {{n:lit.flow.excluded.off-topic}} were off topic.\n";
  const before = draft(text);
  expect(before.findings.filter(f => f.code === "unresolved-ref")).toHaveLength(3);
  expect(before.findings[0]!.message).toContain("ares gate approve <dir> screen");
  await ops.gateDecide(dir, "screen", "approve", undefined, ctx);
  const approved = draft(text);
  expect(approved.findings.filter(f => f.severity === "blocking")).toEqual([]);
  expect(approved.rendered).toBe("We screened 4 records and included 3; 1 were off topic.\n");
  expect(approved.placeholders[0]!.source!.file).toBe(join("literature", "candidates.json"));
  // Unknown fields and formats refuse even while approved.
  expect(draft("{{n:lit.flow.excluded.nope}} {{n:lit.flow.bogus}}\n").findings.map(f => f.code)).toEqual(["unresolved-ref", "unresolved-ref"]);
  expect(draft("{{n:lit.flow.included|.2f}}\n").findings.map(f => f.code)).toEqual(["bad-format"]);
  // Changing the included set reopens the gate, and the refs become unresolved again.
  await ops.screen(dir, ["arxiv:2501.01234"], "exclude", undefined, ctx, undefined, "no-eval");
  expect(draft(text).findings.filter(f => f.code === "unresolved-ref")).toHaveLength(3);
});

test("AC3: unknown exclusion codes refuse at screening; studies without codes report one group", async () => {
  const { dir, ctx } = await study();
  await ops.search(dir, "agent review", {}, ctx);
  const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.screen(dir, ["doi:10.5555/budget.2025.7"], "exclude", undefined, ctx, undefined, "nope")).rejects.toThrow(/unknown exclusion code "nope"; declare it in scope.json exclusionCodes \(off-topic, no-eval\)/);
  await expect(ops.screen(dir, ["doi:10.5555/budget.2025.7"], "include", undefined, ctx, undefined, "off-topic")).rejects.toThrow(/--code applies only with --exclude/);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  // Re-including a coded exclusion clears its code.
  await ops.screen(dir, ["doi:10.5555/budget.2025.7"], "exclude", undefined, ctx, undefined, "off-topic");
  await ops.screen(dir, ["doi:10.5555/budget.2025.7"], "include", undefined, ctx);
  expect(loadCandidates(dir).find(c => c.id === "doi:10.5555/budget.2025.7")!.exclusionCode).toBeUndefined();
  for (const bad of [[{ code: "Bad", label: "x" }], [{ code: "uncoded", label: "x" }], [{ code: "a", label: "x" }, { code: "a", label: "y" }], [{ code: "a", label: "has | pipe" }], Array.from({ length: 31 }, (_, i) => ({ code: `c${i}`, label: "x" }))]) {
    await expect(ops.scope(dir, { question: "Q?", exclusionCodes: bad }, ctx)).rejects.toThrow(/scope\.exclusionCodes/);
  }
  const plain = await scripted(false), flow = ops.flow(plain.dir) as { excludedByCode: Record<string, number> };
  expect(flow.excludedByCode).toEqual({ uncoded: 1 });
  await expect(ops.screen(plain.dir, ["doi:10.5555/budget.2025.7"], "exclude", undefined, plain.ctx, undefined, "off-topic")).rejects.toThrow(/none declared/);
});

test("AC4: the markdown table holds only placeholders for numbers and passes paper check", async () => {
  const { dir, ctx } = await scripted();
  await ops.gateDecide(dir, "screen", "approve", undefined, ctx);
  const { markdown } = ops.flowMarkdownView(dir);
  expect(markdown.replace(/{{n:lit\.flow\.[a-z.-]+}}/g, "")).not.toMatch(/\p{Nd}/u);
  expect(markdown).toContain("{{n:lit.flow.excluded.off-topic}}");
  mkdirSync(join(dir, "paper"));
  writeFileSync(join(dir, "paper", "manuscript.md"), `# Method\n\n${markdown}`);
  const report = checkPaper(dir);
  expect(report.ok).toBe(true); expect(report.findings.filter(f => f.severity === "blocking")).toEqual([]);
  // A label with digits is wrapped as a literal so paper check accepts it in experiment studies too.
  await ops.scope(dir, { question: "Q?", yearFrom: 2020, exclusionCodes: [{ code: "old", label: "Published before 2015" }] }, ctx);
  expect(ops.flowMarkdownView(dir).markdown).toContain("{{lit:Published before 2015}}");
});

test("bridging records count every absorbed candidate as a duplicate so the flow reconciles", async () => {
  const doiOnly = { title: "Synthetic bridge paper", authors: ["Ada Example"], year: 2026, doi: "10.1234/bridge", source: "openalex" };
  const arxivOnly = { title: "A different synthetic title", authors: ["Ada Example"], year: 2026, arxivId: "2601.00001", source: "arxiv" };
  const bridge = { title: "Synthetic bridge paper", authors: ["Ada Example"], year: 2026, doi: "10.1234/bridge", arxivId: "2601.00001", source: "s2" };
  const list: Parameters<typeof mergeCandidates>[0] = [];
  expect(mergeCandidates(list, [doiOnly, arxivOnly, bridge], 100)).toEqual({ added: 2, merged: 1, dropped: 0, linked: 0, absorbed: 1 });
  expect(list).toHaveLength(1);
  // Ordinary merges keep the earlier result shape (no absorbed key).
  expect(Object.keys(mergeCandidates(list, [bridge], 100))).toEqual(["added", "merged", "dropped", "linked"]);
  // Through a real search: records = unique + duplicates + dropped.
  const dir = join(tempDir(), "s");
  ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
  const oa = JSON.stringify({ results: [{ id: "https://openalex.org/W1", title: doiOnly.title, doi: "https://doi.org/10.1234/bridge", publication_year: 2026, authorships: [{ author: { display_name: "Ada Example" } }] }] });
  const s2 = JSON.stringify({ total: 1, data: [{ paperId: "p1", title: doiOnly.title, year: 2026, authors: [{ name: "Ada Example" }], externalIds: { DOI: "10.1234/bridge", ArXiv: "2601.00001" } }] });
  const arxiv = fixture("arxiv-empty.xml");
  const http = fakeHttp([["https://api.openalex.org/works", ok(oa)], ["https://api.semanticscholar.org/graph/v1/paper/search", ok(s2)], ["https://export.arxiv.org/api/query?search_query", ok(arxiv)]]).http;
  await ops.scope(dir, { question: "Q?" }, { actor: person, http });
  // Seed an arXiv-only candidate so the S2 record bridges it with the OpenAlex DOI candidate.
  const path = join(dir, "literature", "candidates.json");
  writeFileSync(path, JSON.stringify([{ id: "arxiv:2601.00001", title: arxivOnly.title, authors: ["Ada Example"], year: 2026, arxivId: "2601.00001", sources: ["arxiv"], addedAt: "2030-01-01T00:00:00Z", status: "new" }], null, 1) + "\n");
  await ops.search(dir, "bridge", {}, { actor: person, http });
  const flow = ops.litFlowView(dir), seeded = 1;
  expect(flow.unique).toBe(1);
  expect(flow.records + seeded).toBe(flow.unique + flow.duplicates + flow.dropped);
});

test("AC5: CLI and MCP parity; previous-minor studies produce a flow without codes", async () => {
  const { dir } = await scripted();
  const direct = ops.flow(dir), server = createAresMcp({});
  expect(await server.handlers.ares_lit_flow!({ study: dir })).toEqual(direct);
  expect(await server.handlers.ares_lit_flow!({ study: dir, format: "markdown" })).toEqual(ops.flowMarkdownView(dir));
  const cli = await run(["lit", "flow", dir, "--json"], {});
  expect(JSON.parse(cli.text)).toEqual(JSON.parse(JSON.stringify(direct)));
  expect((await run(["lit", "flow", dir, "--markdown"], {})).text).toBe(ops.flowMarkdownView(dir).markdown.trimEnd());
  // N-1 study: scope without codes, candidates without exclusionCode/firstQuery, searches without yearFrom.
  const old = await scripted(false), path = join(old.dir, "literature", "candidates.json");
  const list = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[];
  for (const c of list) { delete c.firstQuery; delete c.exclusionCode; }
  writeFileSync(path, JSON.stringify(list, null, 1) + "\n");
  const flow = ops.flow(old.dir) as { excludedByCode: Record<string, number>; exclusionCodes: unknown[]; excluded: number };
  expect(flow.exclusionCodes).toEqual([]); expect(flow.excludedByCode).toEqual({ uncoded: 1 }); expect(flow.excluded).toBe(1);
});
