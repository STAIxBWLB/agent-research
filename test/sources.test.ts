import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { cleanRaw, mergeCandidates, type Candidate } from "../src/lit/candidates.ts";
import { parseArxiv, parseOpenAlex, parseS2, sourceUrl } from "../src/lit/sources.ts";
import { fakeHttp, fixture, searchRoutes, status, tempDir, type Route } from "./helpers.ts";

const person = { kind: "person" as const };
function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? files(p) : [p]; });
}

describe("source parsing", () => {
  test("OpenAlex: inverted abstract rebuilt, DOI URL stripped, arXiv DOI mapped to the arXiv id", () => {
    const [journal, preprint] = parseOpenAlex(JSON.parse(fixture("openalex.json"))).map(r => cleanRaw(r)!);
    expect(journal).toMatchObject({ doi: "10.1234/jrl.2024.001", year: 2024, venue: "Journal of Test Studies", abstract: "We verify references automatically.", authors: ["Ada Example", "Ben Sample"] });
    expect(preprint!.doi).toBeUndefined();
    expect(preprint!.arxivId).toBe("2501.01234");
  });
  test("Semantic Scholar and arXiv records normalize; arXiv versions and entities are cleaned", () => {
    expect(parseS2(JSON.parse(fixture("s2.json")))[1]).toMatchObject({ arxivId: "2502.04321", authors: ["Dan Muster"] });
    const feed = parseArxiv(fixture("arxiv-search.xml"));
    expect(feed.total).toBe(2);
    expect(feed.entries[0]).toMatchObject({ arxivId: "2502.04321", title: "Cross-Family Review of Generated Papers", year: 2025, abstract: "Reviewers from another model family catch more errors & omissions." });
    expect(feed.entries[1]).toMatchObject({ doi: "10.5555/budget.2025.7", venue: "Proc. Test Conf. 2025" });
  });
  test("AC4: the same paper from several sources merges into one record with all sources", () => {
    const list: Candidate[] = [];
    const counts = mergeCandidates(list, [...parseOpenAlex(JSON.parse(fixture("openalex.json"))), ...parseS2(JSON.parse(fixture("s2.json"))), ...parseArxiv(fixture("arxiv-search.xml")).entries], 100);
    expect(counts).toEqual({ added: 4, merged: 2, dropped: 0, linked: 0 });
    expect(list.find(c => c.id === "doi:10.1234/jrl.2024.001")!.sources).toEqual(["openalex", "s2"]);
    expect(list.find(c => c.id === "arxiv:2502.04321")!.sources).toEqual(["s2", "arxiv"]);
    expect(list.find(c => c.id === "arxiv:2501.01234")).toBeDefined();
  });
  test("the candidate limit drops new records but still merges known ones", () => {
    const list: Candidate[] = [];
    const counts = mergeCandidates(list, [...parseOpenAlex(JSON.parse(fixture("openalex.json"))), ...parseS2(JSON.parse(fixture("s2.json")))], 1);
    expect(counts).toEqual({ added: 1, merged: 1, dropped: 2, linked: 0 });
  });
});

describe("search", () => {
  async function approved(env: NodeJS.ProcessEnv, s2?: Route) {
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
    const fake = fakeHttp(searchRoutes(s2), env);
    const ctx = { actor: person, http: fake.http };
    await ops.scope(dir, { question: "Q?", yearFrom: 2020 }, ctx);
    return { dir, ctx, fake };
  }
  test("AC4: a 429 from one source is reported for that source and the others still return", async () => {
    const { dir, ctx } = await approved({}, status(429));
    const result = await ops.search(dir, "agent review", {}, ctx);
    expect(result.sources).toEqual([
      { source: "openalex", ok: true, returned: 2 },
      { source: "s2", ok: false, returned: 0, error: "api.semanticscholar.org: rate 429" },
      { source: "arxiv", ok: true, returned: 2 },
    ]);
    expect(result.candidates).toBe(4);
  });
  test("AC10: API keys are sent but never written into the study", async () => {
    const { dir, ctx, fake } = await approved({ OPENALEX_API_KEY: "oa-secret-123", S2_API_KEY: "s2-secret-456" });
    await ops.search(dir, "agent review", {}, ctx);
    expect(fake.requested.some(r => r.url.includes("api_key=oa-secret-123"))).toBe(true);
    expect(fake.requested.some(r => r.headers["x-api-key"] === "s2-secret-456")).toBe(true);
    for (const file of files(dir)) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain("oa-secret-123");
      expect(text).not.toContain("s2-secret-456");
    }
  });
  test("year bounds from the scope reach every source", () => {
    expect(sourceUrl("openalex", "a b", { limit: 5, yearFrom: 2020, yearTo: 2024 }, {})).toContain("filter=from_publication_date:2020-01-01,to_publication_date:2024-12-31");
    expect(sourceUrl("s2", "a b", { limit: 5, yearFrom: 2020 }, {})).toContain("&year=2020-");
    expect(decodeURIComponent(sourceUrl("arxiv", "deep research", { limit: 5, yearFrom: 2020 }, {}))).toContain("all:deep AND all:research AND submittedDate:[202001010000 TO 210012312359]");
  });
});
