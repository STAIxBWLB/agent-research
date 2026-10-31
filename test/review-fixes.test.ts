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
