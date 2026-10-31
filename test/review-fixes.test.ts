import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { createHttp, HttpError } from "../src/http.ts";
import { isVerified, loadCandidates, mergeCandidates, saveCandidates } from "../src/lit/candidates.ts";
import { checkCitations } from "../src/lit/cite.ts";
import { matchRegistry } from "../src/lit/verify.ts";
import { fakeHttp, fixture, ok, searchRoutes, tempDir } from "./helpers.ts";

const person = { kind: "person" as const };

describe("PR #3 review fixes", () => {
  test("a merge that adds a DOI to an arXiv-verified candidate makes the verification stale", async () => {
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
    const fake = fakeHttp([...searchRoutes(), ["https://export.arxiv.org/api/query?id_list=", ok(fixture("arxiv-search.xml"))]]);
    const ctx = { actor: person, http: fake.http, sleep: async () => {} };
    await ops.scope(dir, { question: "Q?" }, ctx);
    await ops.search(dir, "agent review", {}, ctx);
    await ops.screen(dir, ["arxiv:2502.04321"], "include", undefined, ctx);
    await ops.verify(dir, ["arxiv:2502.04321"], ctx);
    expect(isVerified(loadCandidates(dir).find(c => c.id === "arxiv:2502.04321")!)).toBe(true);
    const list = loadCandidates(dir);
    mergeCandidates(list, [{ source: "openalex", title: "Cross-Family Review of Generated Papers", authors: [], year: 2025, doi: "10.7777/unchecked.1", arxivId: "2502.04321" }], 100);
    saveCandidates(dir, list);
    const merged = loadCandidates(dir).find(c => c.id === "arxiv:2502.04321")!;
    expect(merged.doi).toBe("10.7777/unchecked.1");
    expect(isVerified(merged)).toBe(false);
    const out = await ops.bib(dir, ctx);
    expect(out.entries).toBe(0);
  });
  test("a missing year on either side is at most a partial match", () => {
    expect(matchRegistry({ title: "A Study of Things" }, { title: "A Study of Things", authors: [], year: 2024 })).toBe("partial");
    expect(matchRegistry({ title: "A Study of Things", year: 2024 }, { title: "A Study of Things", authors: [] })).toBe("partial");
  });
  test("one-character citation keys are checked", () => {
    const report = checkCitations("See [@x] and [@y; @ab].", []);
    expect(report).toMatchObject({ ok: false, citations: 3, unknown: ["x", "y", "ab"] });
  });
  test("an oversize HTTP body is cancelled while streaming, not buffered whole", async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled++; if (pulled > 20) controller.close(); else controller.enqueue(chunk); } });
    const http = createHttp({}, async () => new Response(body, { status: 200 }));
    await expect(http.text("https://example.org/big")).rejects.toBeInstanceOf(HttpError);
    expect(pulled).toBeLessThanOrEqual(7);
  });
});

describe("PR #3 review fixes, round 2", () => {
  async function autoStudy() {
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
    const ctx = { actor: person, http: fakeHttp(searchRoutes()).http, sleep: async () => {} };
    await ops.scope(dir, { question: "Q?" }, ctx);
    return { dir, ctx };
  }
  test("a scope whose stored form would be unreadable is refused and the study stays readable", async () => {
    const { dir, ctx } = await autoStudy();
    const long = (n: number) => Array.from({ length: n }, (_, i) => `${i}`.padEnd(500, "x"));
    await expect(ops.scope(dir, { question: "Q?", include: long(50), exclude: long(50), subquestions: Array.from({ length: 30 }, () => "y".repeat(1000)) }, ctx)).rejects.toThrow("would exceed");
    expect(ops.status(dir).scope.set).toBe(true);
    await ops.scope(dir, { question: "Q2?" }, ctx);
  });
  test("--file refuses special files before reading them", async () => {
    const { run } = await import("../src/cli.ts");
    const { dir } = await autoStudy();
    await expect(run(["scope", dir, "--file", "/dev/zero"], {}, {})).rejects.toThrow("not a regular file");
  });
  test("the default verify batch advances past final results", async () => {
    const { dir, ctx } = await autoStudy();
    const list = Array.from({ length: 201 }, (_, i) => ({ id: `title:${i}`, title: `Paper ${i}`, authors: [], year: 2024, sources: ["t"], addedAt: "", status: "included" as const }));
    saveCandidates(dir, list);
    const first = await ops.verify(dir, [], ctx);
    expect(first).toMatchObject({ checked: 200, noIdentifier: 200, remaining: 1 });
    const second = await ops.verify(dir, [], ctx);
    expect(second).toMatchObject({ checked: 1, remaining: 0, final: 201 });
  });
  test("invalid arguments are refused before an auto gate approval is recorded", async () => {
    const { dir, ctx } = await autoStudy();
    const { readLedger } = await import("../src/study.ts");
    await expect(ops.search(dir, "q", { yearFrom: 999 }, ctx)).rejects.toThrow("--year-from");
    await expect(ops.verify(dir, ["doi:10.1/unknown"], ctx)).rejects.toThrow("unknown candidate");
    await expect(ops.screen(dir, ["doi:10.1/unknown"], "include", undefined, ctx)).rejects.toThrow("unknown candidate");
    expect(readLedger(dir).some(e => e.type === "gate.approve")).toBe(false);
  });
});

describe("PR #3 review fixes, round 3", () => {
  const errorFeed = `<?xml version='1.0' encoding='UTF-8'?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/api/errors#incorrect_id_format</id><title>Error</title><summary>incorrect id format</summary></entry></feed>`;
  test("an arXiv error entry makes the batch unknown, not missing", async () => {
    const { verifyCandidates } = await import("../src/lit/verify.ts");
    const fake = fakeHttp([["https://export.arxiv.org/", ok(errorFeed)]]);
    const c = { id: "arxiv:2502.04321", arxivId: "2502.04321", title: "x", year: 2025, authors: [], sources: ["t"], addedAt: "", status: "included" as const };
    const result = await verifyCandidates(fake.http, [c], { sleep: async () => {} });
    expect(result.get(c.id)).toMatchObject({ exists: "unknown", error: "arxiv: error response" });
  });
  test("an arXiv error entry in a search is a failed source", async () => {
    const { searchSource } = await import("../src/lit/sources.ts");
    const fake = fakeHttp([["https://export.arxiv.org/", ok(errorFeed)]]);
    expect(await searchSource(fake.http, "arxiv", "q", { limit: 5 })).toMatchObject({ ok: false, error: "arxiv: query error" });
  });
});

describe("PR #3 review fixes, round 4", () => {
  const cand = (over: Partial<import("../src/lit/candidates.ts").Candidate> & { id: string; title: string }) => ({ authors: [], year: 2025, sources: ["t"], addedAt: "", status: "new" as const, ...over });
  test("a truncated or short arXiv feed is unknown, never missing", async () => {
    const { verifyCandidates } = await import("../src/lit/verify.ts");
    const head = `<?xml version='1.0'?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">`;
    const truncated = `${head}<opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2502.04321v1</id><title>Cross`;
    const short = `${head}<opensearch:totalResults>2</opensearch:totalResults><entry><id>http://arxiv.org/abs/2502.04321v1</id><title>A</title><published>2025-01-01</published></entry></feed>`;
    const c = { id: "arxiv:2503.00007", arxivId: "2503.00007", title: "x", year: 2025, authors: [], sources: ["t"], addedAt: "", status: "included" as const };
    for (const body of [truncated, short]) {
      const result = await verifyCandidates(fakeHttp([["https://export.arxiv.org/", ok(body)]]).http, [c], { sleep: async () => {} });
      expect(result.get(c.id)).toMatchObject({ exists: "unknown", error: "arxiv: incomplete response" });
    }
  });
  test("a record linking two unscreened candidates folds them into one", () => {
    const list = [cand({ id: "doi:10.1/a", title: "Published Title", doi: "10.1/a" }), cand({ id: "arxiv:2501.00001", title: "Preprint Title", arxivId: "2501.00001" })];
    const counts = mergeCandidates(list, [{ source: "s2", title: "Published Title", authors: [], year: 2025, doi: "10.1/a", arxivId: "2501.00001" }], 100);
    expect(list).toHaveLength(1);
    expect(list[0]!.arxivId).toBe("2501.00001");
    expect(counts.linked).toBe(0);
  });
  test("screened twins are flagged, and bib refuses while both are included", async () => {
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
    const ctx = { actor: person, http: fakeHttp([]).http };
    await ops.scope(dir, { question: "Q?" }, ctx);
    const list = [cand({ id: "doi:10.1/a", title: "Published Title", doi: "10.1/a", status: "included" }), cand({ id: "arxiv:2501.00001", title: "Preprint Title", arxivId: "2501.00001", status: "included" })];
    expect(mergeCandidates(list, [{ source: "s2", title: "x", authors: [], doi: "10.1/a", arxivId: "2501.00001" }], 100).linked).toBe(1);
    saveCandidates(dir, list);
    expect(loadCandidates(dir).map(c => c.duplicates)).toEqual([["arxiv:2501.00001"], ["doi:10.1/a"]]);
    await expect(ops.bib(dir, ctx)).rejects.toThrow("same work");
  });
  test("a write larger than its reader's bound is refused and leaves no file", async () => {
    const { writeAtomic } = await import("../src/study.ts");
    const { existsSync, readdirSync } = await import("node:fs");
    const dir = tempDir(), path = join(dir, "f.json");
    expect(() => writeAtomic(path, "x".repeat(11), 10)).toThrow("would exceed 10 bytes");
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("PR #3 review fixes, round 5", () => {
  test("bib refuses included candidates that share an identifier, whatever the stored links say", async () => {
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
    const ctx = { actor: person, http: fakeHttp([]).http };
    await ops.scope(dir, { question: "Q?" }, ctx);
    const base = { authors: [], year: 2025, sources: ["t"], addedAt: "", status: "included" as const };
    saveCandidates(dir, [{ ...base, id: "doi:10.1/a", title: "One Title", doi: "10.1/a" }, { ...base, id: "title:abc", title: "Another Title", doi: "10.1/a" }]);
    await expect(ops.bib(dir, ctx)).rejects.toThrow("doi:10.1/a = title:abc");
  });
  test("absorbing a candidate moves its duplicate links to the survivor", () => {
    const base = { authors: [], year: 2025, sources: ["t"], addedAt: "" };
    const list: import("../src/lit/candidates.ts").Candidate[] = [
      { ...base, id: "doi:10.1/c", title: "Paper C", doi: "10.1/c", status: "included" as const },
      { ...base, id: "arxiv:2501.00001", title: "Paper A", arxivId: "2501.00001", status: "new" as const, duplicates: ["doi:10.1/b"] },
      { ...base, id: "doi:10.1/b", title: "Paper B", doi: "10.1/b", status: "included" as const, duplicates: ["arxiv:2501.00001"] },
    ];
    mergeCandidates(list, [{ source: "s2", title: "Paper C", authors: [], year: 2025, doi: "10.1/c", arxivId: "2501.00001" }], 100);
    expect(list.map(c => c.id)).toEqual(["doi:10.1/c", "doi:10.1/b"]);
    expect(list[0]!.duplicates).toEqual(["doi:10.1/b"]);
    expect(list[1]!.duplicates).toEqual(["doi:10.1/c"]);
  });
  test("a FIFO without a writer is refused without blocking", async () => {
    const dir = tempDir(), fifo = join(dir, "pipe");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const { readTextBounded } = await import("../src/study.ts");
    expect(() => readTextBounded(fifo, 100)).toThrow("not a regular file");
  }, 2000);
});

describe("PR #3 review fixes, round 6", () => {
  test("a duplicate chain through an excluded candidate still blocks bib", async () => {
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
    const ctx = { actor: person, http: fakeHttp([]).http };
    await ops.scope(dir, { question: "Q?" }, ctx);
    const base = { authors: [], year: 2025, sources: ["t"], addedAt: "" };
    saveCandidates(dir, [
      { ...base, id: "doi:10.1/a", title: "Title A", doi: "10.1/a", status: "included", duplicates: ["doi:10.1/b"] },
      { ...base, id: "doi:10.1/b", title: "Title B", doi: "10.1/b", status: "excluded", duplicates: ["doi:10.1/a", "doi:10.1/c"] },
      { ...base, id: "doi:10.1/c", title: "Title C", doi: "10.1/c", status: "included", duplicates: ["doi:10.1/b"] },
    ]);
    await expect(ops.bib(dir, ctx)).rejects.toThrow("doi:10.1/a = doi:10.1/c");
  });
  test("a command that fails after its gate check records no auto approval", async () => {
    const { readLedger } = await import("../src/study.ts");
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
    const ctx = { actor: person, http: fakeHttp(searchRoutes()).http };
    await ops.scope(dir, { question: "Q?" }, ctx);
    await ops.search(dir, "agent review", {}, ctx);
    await ops.screen(dir, ["doi:10.1234/jrl.2024.001"], "include", undefined, ctx);
    await ops.scope(dir, { question: "Changed?" }, ctx);
    const approvals = () => readLedger(dir).filter(e => e.type === "gate.approve").length;
    const before = approvals();
    const big = { summary: "s".repeat(4000), claims: Array.from({ length: 50 }, () => "c".repeat(1000)), methods: "m".repeat(4000), findings: "f".repeat(4000), limitations: "l".repeat(4000), relevance: "r".repeat(4000) };
    await expect(ops.card(dir, "doi:10.1234/jrl.2024.001", big, ctx)).rejects.toThrow("would exceed");
    expect(approvals()).toBe(before);
  });
});

describe("PR #3 review fixes, round 7", () => {
  async function autoStudy(routes: Parameters<typeof fakeHttp>[0] = searchRoutes()) {
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
    const ctx = { actor: person, http: fakeHttp(routes).http };
    await ops.scope(dir, { question: "Q?" }, ctx);
    return { dir, ctx };
  }
  const approvals = async (dir: string) => (await import("../src/study.ts")).readLedger(dir).filter(e => e.type === "gate.approve").length;
  test("a screen whose event would be too large changes no candidate and records no approval", async () => {
    const { dir, ctx } = await autoStudy();
    const base = { authors: [], year: 2025, sources: ["t"], addedAt: "", status: "new" as const };
    const ids = Array.from({ length: 200 }, (_, i) => `doi:10.1/${"가".repeat(130)}${i}`);
    saveCandidates(dir, ids.map((id, i) => ({ ...base, id, title: `T${i}` })));
    await expect(ops.screen(dir, ids, "include", undefined, ctx)).rejects.toThrow("exceeds 65536 bytes");
    expect(loadCandidates(dir).every(c => c.status === "new")).toBe(true);
    expect(await approvals(dir)).toBe(0);
  });
  test("a search where every source failed records the search but no approval", async () => {
    const { dir, ctx } = await autoStudy([["https://", "network"]]);
    const out = await ops.search(dir, "q", {}, ctx);
    expect(out.sources.every(s => !s.ok)).toBe(true);
    expect(await approvals(dir)).toBe(0);
    const { readLedger } = await import("../src/study.ts");
    expect(readLedger(dir).some(e => e.type === "lit.search")).toBe(true);
  });
  test("a commit that would push the ledger past its read limit writes nothing", async () => {
    const { commit } = await import("../src/study.ts");
    const { existsSync, truncateSync, writeFileSync } = await import("node:fs");
    const dir = tempDir(), ledger = join(dir, "ledger.jsonl"), file = join(dir, "out.json");
    writeFileSync(ledger, "");
    truncateSync(ledger, 64 * 1024 * 1024 - 10);
    expect(() => commit(dir, [[file, "{}\n", 100]], [{ actor: person, type: "t", data: {} }])).toThrow("would exceed");
    expect(existsSync(file)).toBe(false);
  });
});
