import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { assignCitekeys, escapeBib } from "../src/lit/bibtex.ts";
import { loadCandidates, saveCandidates, type Candidate } from "../src/lit/candidates.ts";
import { fakeHttp, fixture, ok, searchRoutes, status, tempDir } from "./helpers.ts";

const person = { kind: "person" as const };

async function ready() {
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
  await ops.scope(dir, { question: "Q?" }, ctx);
  await ops.search(dir, "agent review", {}, ctx);
  return { dir, ctx };
}

describe("AC6 bibliography", () => {
  test("only included and verified candidates are written", async () => {
    const { dir, ctx } = await ready();
    await ops.screen(dir, ["doi:10.1234/jrl.2024.001", "arxiv:2502.04321", "arxiv:2501.01234"], "include", undefined, ctx);
    await ops.screen(dir, ["doi:10.5555/budget.2025.7"], "exclude", "off topic", ctx);
    const v = await ops.verify(dir, [], ctx);
    expect(v).toMatchObject({ checked: 3, verified: 2, notFound: 1 }); // 2501.01234 is not in the arXiv fixture
    const out = await ops.bib(dir, ctx);
    expect(out.entries).toBe(2);
    expect(out.notInBib).toEqual([{ id: "arxiv:2501.01234", verify: "ok/no/unknown" }]);
    const text = readFileSync(join(dir, "refs", "references.bib"), "utf8");
    expect(text).toContain("@article{example2024verified,");
    expect(text).toContain("  author = {Example, Ada and Sample, Ben}");
    expect(text).toContain("  journal = {Journal of Test Studies}");
    expect(text).toContain("@misc{muster2025crossfamily,");
    expect(text).toContain("  eprint = {2502.04321}");
    expect(text).not.toContain("budget");
  });
  test("citekeys are stable when a colliding entry is added later", () => {
    const base = (id: string, title: string): Candidate => ({ id, title, authors: ["Ada Example"], year: 2024, sources: ["t"], addedAt: "", status: "included" });
    const first = base("doi:10.1/b", "Verified Things"), second = base("doi:10.1/a", "Verified Stuff");
    const list = [first];
    assignCitekeys(list, [first]);
    expect(first.citekey).toBe("example2024verified");
    list.push(second);
    assignCitekeys(list, [first, second]);
    expect(first.citekey).toBe("example2024verified");
    expect(second.citekey).toBe("example2024verifieda");
  });
  test("special characters are escaped", () => {
    expect(escapeBib("A & B 50% $x$ #1 a_b {c} \\d ~e ^f")).toBe("A \\& B 50\\% \\$x\\$ \\#1 a\\_b \\{c\\} \\textbackslash{}d \\textasciitilde{}e \\textasciicircum{}f");
  });
  test("non-ASCII author names fold to ASCII keys, and keys never start without letters", () => {
    const c: Candidate = { id: "doi:10.1/k", title: "연구 에이전트", authors: ["홍길동"], year: 2025, sources: ["t"], addedAt: "", status: "included" };
    const d: Candidate = { id: "doi:10.1/e", title: "Études", authors: ["Chloé Exemple"], year: 2025, sources: ["t"], addedAt: "", status: "included" };
    assignCitekeys([c, d], [c, d]);
    expect(c.citekey).toBe("ref2025");
    expect(d.citekey).toBe("exemple2025etudes");
  });
});

describe("AC7 citation check", () => {
  test("unknown and no-longer-verified keys fail; a clean draft passes", async () => {
    const { dir, ctx } = await ready();
    await ops.screen(dir, ["doi:10.1234/jrl.2024.001", "arxiv:2502.04321"], "include", undefined, ctx);
    await ops.verify(dir, [], ctx);
    await ops.bib(dir, ctx);
    const draft = join(dir, "draft.md");
    writeFileSync(draft, "Agents check references [@example2024verified; see @muster2025crossfamily, p. 3].\n");
    expect(ops.cite(dir, draft)).toMatchObject({ ok: true, citations: 2, unknown: [], notVerified: [] });
    writeFileSync(draft, "Claim [@example2024verified] and [@made2023up]. Email a@b.c is not a citation.\n");
    expect(ops.cite(dir, draft)).toMatchObject({ ok: false, unknown: ["made2023up"] });
    await ops.screen(dir, ["arxiv:2502.04321"], "exclude", "duplicate", ctx);
    writeFileSync(draft, "[@muster2025crossfamily]\n");
    expect(ops.cite(dir, draft)).toMatchObject({ ok: false, notVerified: ["muster2025crossfamily"] });
  });
});
