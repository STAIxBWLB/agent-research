import { expect, spyOn, test } from "bun:test";
import { paperPointFindings, POINT_CODES } from "../src/paper/points.ts";
import type { PaperPlan, PaperPoint } from "../src/paper/plan.ts";
import * as pointEvidence from "../src/paper/point-evidence.ts";

const point = (id = "p", requires = ["a"]): PaperPoint => ({id, claim: "A synthetic sentence that need never occur in the prose.", requires});
function plan(points = [point()]): PaperPlan { return {v: 2, sections: [{id: "a-section", heading: "A", cites: ["a", "b"], points}]}; }
function masks(text: string, codeParts: string[] = [], destinations: string[] = []) {
  const code = new Uint8Array(text.length), heading = new Uint8Array(text.length), citation = new Uint8Array(text.length);
  const hide = (mask: Uint8Array, part: string) => {
    let cursor = 0, found = false;
    for (let start = text.indexOf(part, cursor); start >= 0; start = text.indexOf(part, cursor)) { found = true; mask.fill(1, start, start + part.length); cursor = start + part.length; }
    if (!found) throw new Error("synthetic mask span missing");
  };
  for (const part of codeParts) { hide(code, part); hide(heading, part); hide(citation, part); }
  for (const comment of text.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) { heading.fill(1, comment.index, comment.index + comment[0].length); citation.fill(1, comment.index, comment.index + comment[0].length); }
  for (const part of destinations) hide(citation, part);
  return {code, heading, citationText: text.split("").map((char, index) => citation[index] && char !== "\r" && char !== "\n" ? " " : char).join("")};
}
function check(text: string, routing = plan(), codeParts: string[] = [], destinations: string[] = []) {
  const m = masks(text, codeParts, destinations);
  return paperPointFindings("/synthetic/unused-study", text, m.code, m.heading, m.citationText, routing);
}

test("points require an exact own-section anchor, not claim wording or a front-matter/wrong-section copy", () => {
  const text = "front <!-- point:p --> [@a]\n\n## A\nA synthetic sentence that need never occur in the prose. [@a]\n\n## B\n<!-- point:p --> [@a]\n";
  const routing = plan(); routing.sections.push({id: "b-section", heading: "B", cites: ["a"]});
  const hits = check(text, routing);
  expect(hits).toHaveLength(1); expect(hits[0]).toMatchObject({code: "missing-point", severity: "blocking", pointId: "p", sectionId: "a-section", start: text.indexOf("## A")});
  expect(hits[0]!.message).toContain("; add an exact");
  const absent = check("# Elsewhere\n", routing);
  expect(absent[0]).toMatchObject({code: "missing-point", start: 0, end: 0, pointId: "p"});
});

test("every repeated point occurrence satisfies its own window and no duplicate finding is invented", () => {
  for (const text of ["## A\n<!-- point:p --> missing\n<!-- point:p --> [@a]\n", "## A\n<!-- point:p --> [@a]\n<!-- point:p --> missing\n"]) {
    const hits = check(text), missing = hits.filter(hit => hit.code === "missing-required-citation");
    expect(missing).toHaveLength(1); expect(hits.some(hit => hit.code === "missing-point")).toBe(false);
    expect(missing[0]!.start).toBe(text.indexOf("missing") < text.lastIndexOf("<!--") ? text.indexOf("<!--") : text.lastIndexOf("<!--"));
    expect(missing[0]).toMatchObject({pointId: "p", sectionId: "a-section", severity: "blocking"});
  }
  const both = check("## A\n<!-- point:p -->\n<!-- point:p -->\n", plan([point("p", ["a", "b"])]));
  expect(both).toHaveLength(4); expect(both.every(hit => hit.code === "missing-required-citation")).toBe(true);
  expect(POINT_CODES).toEqual(["missing-point", "missing-required-citation", "unresolved-point-evidence"]);
});

test("unknown and wrong-section well-formed anchors end the preceding requirement window", () => {
  const text = "## A\n<!-- point:p -->\n<!-- point:unknown --> [@a]\n";
  expect(check(text)).toMatchObject([{code: "missing-required-citation", pointId: "p", start: text.indexOf("<!-- point:p") }]);
  const routing = plan(); routing.sections.push({id: "b-section", heading: "B", cites: ["b"], points: [point("q", ["b"])]});
  const wrong = "## A\n<!-- point:p --> [@a]\n## B\n<!-- point:q -->\n<!-- point:p --> [@b]\n";
  expect(check(wrong, routing)).toMatchObject([{code: "missing-required-citation", pointId: "q", sectionId: "b-section", start: wrong.indexOf("<!-- point:q") }]);
});

test("only planned literal headings end sections; unplanned H2 persists and repeated planned boundaries still end old windows", () => {
  expect(check("## A\n<!-- point:p -->\n## Unplanned\n[@a]\n")).toEqual([]);
  const routing = plan(); routing.sections.push({id: "b-section", heading: "B", cites: ["a"]});
  const changed = "## A\n<!-- point:p -->\n# B\n[@a]\n";
  expect(check(changed, routing)).toMatchObject([{code: "missing-required-citation", pointId: "p"}]);
  const repeated = "## A\n<!-- point:p -->\n### A\n<!-- point:p --> [@a]\n";
  const hits = check(repeated); expect(hits).toHaveLength(1); expect(hits[0]!.start).toBe(repeated.indexOf("<!--"));
});

test("comments are whole tokens: normal, malformed, nested and unclosed text cannot supply an anchor", () => {
  for (const fake of ["<!-- normal point:p -->", "<!-- outer <!-- point:p --> -->", "<!-- point:p extra -->", "<!-- point: p -->", "<!-- point:p"]) {
    expect(check(`## A\n${fake}\n[@a]\n`)[0]!.code).toBe("missing-point");
  }
  expect(check("## A\n<!--\r\n \tpoint:p \r\n --> [@a]\n")).toEqual([]);
  // An ordinary comment does not cut a real point's window.
  expect(check("## A\n<!-- point:p -->\n<!-- ordinary --> [@a]\n")).toEqual([]);
});

test("fenced and inline-code anchor lookalikes are skipped, and masked citations never satisfy requires", () => {
  const fence = "```\n<!-- point:p --> [@a]\n## B\n```", inline = "`<!-- point:unknown -->`";
  const text = `## A\n${fence}\n`;
  expect(check(text, plan(), [fence])).toMatchObject([{code: "missing-point", pointId: "p"}]);
  expect(check(`## A\n<!-- point:p -->\n${inline} [@a]\n`, plan(), [inline])).toEqual([]);
  const destination = "https://synthetic.test/[@a]", citedCode = "`[@a]`", hiddenCitation = "## A\n<!-- point:p --> <!-- ordinary [@a] -->\n" + citedCode + " [link](" + destination + ")\n";
  expect(check(hiddenCitation, plan(), [citedCode], [destination])).toMatchObject([{code: "missing-required-citation", pointId: "p"}]);
});

test("claim content is never read and alternate prose does not change deterministic anchor/key checks", () => {
  const declared = point(); Object.defineProperty(declared, "claim", {get: () => { throw new Error("checker must not inspect claim wording"); }});
  expect(check("## A\n<!-- point:p --> Arbitrary unrelated wording [@a].\n", plan([declared]))).toEqual([]);
  const hits = check("## A\n<!-- point:p --> A synthetic sentence that need never occur in the prose.\n");
  expect(hits).toHaveLength(1); expect(hits[0]!.code).toBe("missing-required-citation");
  expect(hits[0]!.message).not.toContain("A synthetic sentence"); expect(hits[0]!.message).not.toContain("supports");
});

test("each unique evidence reference resolves once per check rather than per duplicate anchor, including missing anchors", () => {
  const declared = {...point(), evidence: ["attempt:aaaaaaaaaaaaaaaa", "card:doi:10.1/synthetic"]};
  const resolve = spyOn(pointEvidence, "resolvePointEvidence").mockImplementation((_dir, ref) => ({resolved: ref.startsWith("attempt:")}));
  try {
    const text = "## A\n<!-- point:p --> [@a]\n<!-- point:p --> [@a]\n", hits = check(text, plan([declared]));
    expect(resolve).toHaveBeenCalledTimes(2); expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({code: "unresolved-point-evidence", pointId: "p", sectionId: "a-section", start: text.indexOf("<!--")});
    resolve.mockClear();
    const missing = check("## A\n", plan([declared])); expect(resolve).toHaveBeenCalledTimes(2);
    expect(missing.map(hit => hit.code).sort()).toEqual(["missing-point", "unresolved-point-evidence"]);
    expect(missing.every(hit => hit.start === 0)).toBe(true);
  } finally { resolve.mockRestore(); }
});

test("no points returns no findings and performs no evidence resolution or new mask validation", () => {
  const resolve = spyOn(pointEvidence, "resolvePointEvidence").mockImplementation(() => { throw new Error("unexpected evidence IO"); });
  try {
    expect(paperPointFindings("/unused", "# A\n", new Uint8Array(), new Uint8Array(), "short", {v: 1, sections: [{id: "a", heading: "A", cites: []}]})).toEqual([]);
    expect(resolve).not.toHaveBeenCalled();
  } finally { resolve.mockRestore(); }
});

test("raw inline/Setext heading matching and CRLF Unicode offsets remain original source positions", () => {
  const heading = "`방법  연구`", text = `🧪 앞말\r\n\r\n${heading}\r\n---\r\n<!-- point:p -->\r\n내용 [@b]\r\n`;
  const routing: PaperPlan = {v: 2, sections: [{id: "method", heading, cites: ["a", "b"], points: [point()]}]};
  const hits = check(text, routing); expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({code: "missing-required-citation", pointId: "p", sectionId: "method", start: text.indexOf("<!--"), end: text.indexOf("-->") + 3});
  expect(text.slice(hits[0]!.start, hits[0]!.end)).toBe("<!-- point:p -->");
  expect(hits[0]!.section).toEqual(["`방법 연구`"]);
});


test("an unclosed comment-looking opener in masked code cannot swallow a later real anchor", () => {
  for (const code of ["```\n<!-- not closed\n```", "`<!--` literal code"]) {
    const text = `## A\n${code}\n<!-- point:p --> [@a]\n`;
    expect(check(text, plan(), [code])).toEqual([]);
  }
  // A real unclosed prose comment still owns its whole token, including anchor-looking inner text.
  expect(check("## A\n<!-- real prose opener\n<!-- point:p --> [@a]\n")).toMatchObject([{code: "missing-point", pointId: "p"}]);
});


test("Markdown-escaped comment openers cannot anchor or truncate a real point window", () => {
  for (const count of [1, 3]) {
    const prefix = "\\".repeat(count), escaped = `## A\n${prefix}<!-- point:p --> [@a]\n`;
    expect(check(escaped)).toMatchObject([{code: "missing-point", pointId: "p"}]);
    expect(check(`## A\n<!-- point:p -->\n${prefix}<!-- point:unknown --> [@a]\n`)).toEqual([]);
  }
  expect(check("## A\n" + "\\".repeat(2) + "<!-- point:p --> [@a]\n")).toEqual([]);
  expect(check("## A\n\\<!-- an escaped unclosed opener\n<!-- point:p --> [@a]\n")).toEqual([]);
});

test("only 1..64-character point slugs form anchor boundaries", () => {
  const valid = "x".repeat(64), oversized = "x".repeat(65);
  expect(check(`## A\n<!-- point:${valid} --> [@a]\n`, plan([point(valid)]))).toEqual([]);
  const longUnknown = `## A\n<!-- point:p -->\n<!-- point:${oversized} --> [@a]\n`;
  expect(check(longUnknown)).toEqual([]);
  const validUnknown = `## A\n<!-- point:p -->\n<!-- point:${valid} --> [@a]\n`;
  expect(check(validUnknown)).toMatchObject([{code: "missing-required-citation", pointId: "p"}]);
});

test("shared evidence is resolved once globally per check while findings stay attached to every affected point", () => {
  const ref = "attempt:aaaaaaaaaaaaaaaa", routing = plan([{...point("p"), evidence: [ref]}, {...point("q", ["b"]), evidence: [ref]}]);
  const resolve = spyOn(pointEvidence, "resolvePointEvidence").mockImplementation(() => ({resolved: false, reason: "synthetic source absent"}));
  try {
    const text = "## A\n<!-- point:p --> [@a]\n<!-- point:q --> [@b]\n", hits = check(text, routing);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(hits.map(hit => [hit.code, hit.pointId])).toEqual([["unresolved-point-evidence", "p"], ["unresolved-point-evidence", "q"]]);
    check(text, routing); expect(resolve).toHaveBeenCalledTimes(2);
  } finally { resolve.mockRestore(); }
});
