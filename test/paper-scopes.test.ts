import { expect, test } from "bun:test";
import { markdownHeadings } from "../src/paper/headings.ts";
import { paperPlanFindings } from "../src/paper/scopes.ts";
import type { PaperPlan } from "../src/paper/plan.ts";
import { verifySubject, type Candidate } from "../src/lit/candidates.ts";

function reference(key: string): Candidate {
  const candidate: Candidate = {id: `doi:10.1/synthetic-${key}`, doi: `10.1/synthetic-${key}`, title: `Synthetic ${key}`, authors: [], year: 2026, sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status: "included", citekey: key,
    verify: {syntax: "ok", exists: "yes", match: "yes", checkedAt: "2030-01-01T00:00:00Z"}};
  candidate.verify!.subject = verifySubject(candidate); return candidate;
}
const references = [reference("a"), reference("b")];
const plan: PaperPlan = {v: 1 as const, sections: [{id: "intro", heading: "Introduction", cites: ["a"]}, {id: "methods", heading: "Methods", cites: ["b"]}]};
function hidden(text: string, parts: string[]): Uint8Array {
  const mask = new Uint8Array(text.length);
  for (const part of parts) { const start = text.indexOf(part); if (start < 0) throw new Error("synthetic mask span missing"); mask.fill(1, start, start + part.length); }
  return mask;
}
function blank(text: string, mask: Uint8Array): string { return text.split("").map((char, index) => mask[index] && char !== "\r" && char !== "\n" ? " " : char).join(""); }
function findings(text: string, routing = plan, candidates = references) { return paperPlanFindings(text, new Uint8Array(text.length), text, routing, candidates); }

test("planned boundaries alone establish scopes; front matter stays unscoped and each bad citation keeps its original position", () => {
  const text = "Front matter [@b].\n\n## Unplanned front matter\nStill unscoped [@b].\n\n### Introduction\nIn scope [@a]; wrong [@b].\n\n# Methods\nIn scope [@b]; wrong [@a].\n";
  const hits = findings(text), bad = hits.filter(hit => hit.code === "out-of-scope-citation");
  expect(bad).toHaveLength(2); expect(bad.map(hit => hit.sectionId)).toEqual(["intro", "methods"]);
  expect(bad.map(hit => text.slice(hit.start, hit.end))).toEqual(["@b", "@a"]);
  expect(bad[0]!.start).toBe(text.indexOf("wrong [@b]") + "wrong [".length);
  expect(bad.every(hit => hit.severity === "blocking" && hit.message.includes(";"))).toBe(true);
  const warning = hits.find(hit => hit.code === "unplanned-section")!;
  expect(warning.severity).toBe("warning"); expect(warning.start).toBe(text.indexOf("## Unplanned"));
});

test("unplanned headings never clear a prior scope; repeated matching headings reset the matching id without order rules", () => {
  const text = "# Introduction\n[@a]\n\n## Unplanned\n[@b]\n\n# Methods\n[@b]\n\n#### Introduction\n[@b]\n\n# Another unplanned heading\n[@b]\n";
  const hits = findings(text), bad = hits.filter(hit => hit.code === "out-of-scope-citation");
  expect(bad.map(hit => hit.sectionId)).toEqual(["intro", "intro", "intro"]);
  expect(bad[0]!.section).toEqual(["Introduction", "Unplanned"]);
  expect(hits.filter(hit => hit.code === "unplanned-section")).toHaveLength(1);
  const missing = findings("# Introduction\n[@a]\n");
  expect(missing).toEqual([]);
});

test("heading extraction retains legacy normalized text/path while rawText preserves internal whitespace Unicode and CRLF", () => {
  const text = "# 문서\r\n\r\n## Same   heading ###  \r\n\r\n## Same heading\r\n\r\nFirst  line\r\nSecond\tline\r\n---\r\n";
  const heads = markdownHeadings(text, new Uint8Array(text.length));
  expect(heads.map(head => [head.level, head.text, head.parent, head.path])).toEqual([
    [1, "문서", -1, ["문서"]], [2, "Same heading", 0, ["문서", "Same heading"]], [2, "Same heading", 0, ["문서", "Same heading"]], [2, "First line Second line", 0, ["문서", "First line Second line"]],
  ]);
  expect(heads[1]!.rawText).toBe("Same   heading"); expect(heads[3]!.rawText).toBe("First  line\r\nSecond\tline");
  expect(heads[3]!.start).toBe(text.indexOf("First  line")); expect(heads[3]!.end).toBe(text.indexOf("---") + 3);
});

test("ATX and multiline Setext scopes match exact raw Markdown content without collapsing spaces or line endings", () => {
  const text = "🧪 front [@b]\r\n\r\n## 방법  연구 ##\r\n[@b]\r\n\r\nMultiple  lines\r\nand\ttabs\r\n---\r\n[@a]\r\n";
  const routing: PaperPlan = {v: 1 as const, sections: [{id: "method", heading: "방법  연구", cites: ["a"]}, {id: "multi", heading: "Multiple  lines\r\nand\ttabs", cites: ["b"]}]};
  const hits = findings(text, routing), bad = hits.filter(hit => hit.code === "out-of-scope-citation");
  expect(bad.map(hit => hit.sectionId)).toEqual(["method", "multi"]);
  expect(bad[0]!.start).toBe(text.indexOf("[@b]", text.indexOf("## 방법")) + 1);
  expect(text.slice(bad[0]!.start, bad[0]!.end)).toBe("@b"); expect(bad[0]!.section).toEqual(["방법 연구"]);
  const normalizedWrong = findings("## 방법 연구\n[@b]\n", routing);
  expect(normalizedWrong.filter(hit => hit.code === "out-of-scope-citation")).toEqual([]);
  expect(normalizedWrong.filter(hit => hit.code === "unplanned-section")).toHaveLength(1);
});

test("block/comment masks hide fake headings and citations; an unplanned visible H2 keeps the earlier scope", () => {
  const fence = "```\n## Hidden\n[@b]\n```", comment = "<!--\n## Also hidden\n[@b]\n-->";
  const text = `# Introduction\n[@a]\n\n${fence}\n\n${comment}\n\n## Visible unplanned\n[@b]\n`, mask = hidden(text, [fence, comment]);
  expect(markdownHeadings(text, mask).map(head => head.rawText)).toEqual(["Introduction", "Visible unplanned"]);
  const hits = paperPlanFindings(text, mask, blank(text, mask), plan, references);
  expect(hits.filter(hit => hit.code === "unplanned-section")).toHaveLength(1);
  expect(hits.filter(hit => hit.code === "out-of-scope-citation")).toMatchObject([{sectionId: "intro", start: text.lastIndexOf("@b")}]);
});

test("inline-code heading content is literal scope text while citation destinations/code spans respect citationText masking", () => {
  const text = "`Inline  heading`\n---\n\n[@a]\n`[@b]` [link](https://synthetic.test/[@b])\n";
  const routing: PaperPlan = {v: 1 as const, sections: [{id: "inline", heading: "`Inline  heading`", cites: ["a"]}]};
  const citationMask = hidden(text, ["`[@b]`", "https://synthetic.test/[@b]"]);
  expect(markdownHeadings(text, new Uint8Array(text.length))[0]!.rawText).toBe("`Inline  heading`");
  expect(paperPlanFindings(text, new Uint8Array(text.length), blank(text, citationMask), routing, [reference("a")])).toEqual([]);
  // Passing legacy inline-code hiding still retains the old hygiene scanner's behavior.
  const legacyHidden = hidden(text, ["`Inline  heading`"]);
  expect(markdownHeadings(text, legacyHidden)).toEqual([]);
});

test("unrouted warnings are once per included reference, including missing keys and unverified references", () => {
  const a = reference("a"), b = reference("b"), unkeyed = reference("no-key"), unverified = reference("d"), excluded = reference("e");
  delete unkeyed.citekey; unverified.verify!.exists = "unknown"; excluded.status = "excluded";
  const routing: PaperPlan = {v: 1 as const, sections: [{id: "intro", heading: "Introduction", cites: ["a", "d"]}]};
  const hits = findings("# Introduction\n[@a] [@b] [@b]\n", routing, [a, b, b, unkeyed, unverified, excluded]);
  const warnings = hits.filter(hit => hit.code === "unrouted-reference");
  expect(warnings).toHaveLength(3); expect(warnings.every(hit => hit.severity === "warning" && hit.start === 0 && hit.end === 0 && hit.message.includes(";"))).toBe(true);
  for (const name of ["b", unkeyed.id, "d"]) expect(warnings.some(hit => hit.message.includes(name))).toBe(true);
  expect(warnings.some(hit => hit.message.includes("synthetic-e"))).toBe(false);
});

test("citationText must preserve source offsets instead of silently moving finding positions", () => {
  expect(() => paperPlanFindings("# Introduction\n[@b]\n", new Uint8Array(1), "[@b]", plan, references)).toThrow("pass offset-preserving citationText");
});
