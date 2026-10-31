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
