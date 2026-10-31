import { describe, expect, test } from "bun:test";
import type { Candidate } from "../src/lit/candidates.ts";
import { matchRegistry, verifyCandidates } from "../src/lit/verify.ts";
import { fakeHttp, fixture, ok, status, type Route } from "./helpers.ts";

const at = "2026-11-01T00:00:00.000Z";
const cand = (over: Partial<Candidate>): Candidate => ({ id: over.doi ? `doi:${over.doi}` : `arxiv:${over.arxivId}`, title: "x", authors: [], sources: ["test"], addedAt: at, status: "included", ...over });
const run = (routes: [string, Route][], list: Candidate[]) => {
  const fake = fakeHttp(routes);
  return verifyCandidates(fake.http, list, { now: at, sleep: async () => {} }).then(result => ({ result, requested: fake.requested }));
};
const JRL = cand({ doi: "10.1234/jrl.2024.001", title: "Verified Retrieval for Agentic Literature Review", year: 2024 });
const BUDGET = cand({ doi: "10.5555/budget.2025.7", title: "Budgets for Research Agents", year: 2025 });

describe("AC5 verification", () => {
  test("a matching Crossref record is exists yes, match yes", async () => {
    const { result } = await run([["https://api.crossref.org/works/10.1234/jrl.2024.001", ok(fixture("crossref.json"))]], [JRL]);
    expect(result.get(JRL.id)).toMatchObject({ syntax: "ok", exists: "yes", match: "yes", via: "crossref", registry: { authors: ["Example, Ada", "Sample, Ben"], year: 2024, type: "journal-article" } });
  });
  test("Crossref 404 falls back to DataCite", async () => {
    const { result } = await run([["https://api.crossref.org/", status(404)], ["https://api.datacite.org/dois/10.5555/budget.2025.7", ok(fixture("datacite.json"))]], [BUDGET]);
    expect(result.get(BUDGET.id)).toMatchObject({ exists: "yes", match: "yes", via: "datacite", registry: { venue: "Test Repository" } });
  });
  test("both registries 404 is exists no", async () => {
    const { result } = await run([["https://api.crossref.org/", status(404)], ["https://api.datacite.org/", status(404)]], [BUDGET]);
    expect(result.get(BUDGET.id)).toMatchObject({ exists: "no", match: "unknown" });
  });
  test("a network error or 429 is unknown, never no", async () => {
    const net = await run([["https://api.crossref.org/", "network"]], [JRL]);
    expect(net.result.get(JRL.id)).toMatchObject({ exists: "unknown", error: "api.crossref.org: network" });
    const rate = await run([["https://api.crossref.org/", status(429)]], [JRL]);
    expect(rate.result.get(JRL.id)!.exists).toBe("unknown");
  });
  test("a different title is match no", async () => {
    const wrong = cand({ doi: "10.1234/jrl.2024.001", title: "An Unrelated Paper About Soil Chemistry", year: 2024 });
    const { result } = await run([["https://api.crossref.org/", ok(fixture("crossref.json"))]], [wrong]);
    expect(result.get(wrong.id)).toMatchObject({ exists: "yes", match: "no" });
  });
  test("arXiv ids go in one batched request; a missing id in a valid feed is no", async () => {
    const a = cand({ arxivId: "2502.04321", title: "Cross-Family Review of Generated Papers", year: 2025 });
    const b = cand({ arxivId: "2503.00007", title: "Budgets for Research Agents", year: 2025 });
    const missing = cand({ arxivId: "2599.99999", title: "Nothing", year: 2025 });
    const { result, requested } = await run([["https://export.arxiv.org/api/query?id_list=", ok(fixture("arxiv-search.xml"))]], [a, b, missing]);
    expect(requested).toHaveLength(1);
    expect(requested[0]!.url).toContain("id_list=2502.04321,2503.00007,2599.99999");
    expect(result.get(a.id)).toMatchObject({ exists: "yes", match: "yes", via: "arxiv" });
    expect(result.get(missing.id)).toMatchObject({ exists: "no" });
    const empty = await run([["https://export.arxiv.org/", ok(fixture("arxiv-empty.xml"))]], [missing]);
    expect(empty.result.get(missing.id)!.exists).toBe("no");
    const broken = await run([["https://export.arxiv.org/", ok("<html>maintenance</html>")]], [missing]);
    expect(broken.result.get(missing.id)!.exists).toBe("unknown");
  });
  test("identifiers are syntax-checked before any request", async () => {
    const bad = cand({ doi: "10.12/too-short-prefix" }), none: Candidate = { ...cand({}), id: "title:abc", arxivId: undefined };
    const { result, requested } = await run([], [bad, none]);
    expect(requested).toHaveLength(0);
    expect(result.get(bad.id)!.syntax).toBe("bad");
    expect(result.get(none.id)!.syntax).toBe("none");
  });
  test("year more than one apart downgrades a title match to partial", () => {
    expect(matchRegistry({ title: "A Study of Things", year: 2020 }, { title: "A Study of Things", authors: [], year: 2024 })).toBe("partial");
  });
});
