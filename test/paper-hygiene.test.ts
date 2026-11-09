import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { checkPaper } from "../src/paper/check.ts";
import { saveCandidates, verifySubject, type Candidate } from "../src/lit/candidates.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const KEYS = ["a2026", "b2026", "c2026", "d2026", "e2026", "f2026", "g2026", "h2026"];
function study(settings?: string) {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "survey" }, ctx); mkdirSync(join(dir, "paper"));
  const base: Candidate = { id: "doi:10.1/synthetic-0", title: "Synthetic fixture", authors: [], year: 2026, sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status: "included", citekey: "a2026", verify: { syntax: "ok", exists: "yes", match: "yes", checkedAt: "2030-01-01T00:00:00Z" } };
  saveCandidates(dir, KEYS.map((key, index) => { const c: Candidate = { ...base, id: `doi:10.1/synthetic-${index}`, citekey: key, verify: { ...base.verify! } }; c.verify!.subject = verifySubject(c); return c; }));
  if (settings !== undefined) writeFileSync(join(dir, "study.toml"), settings);
  return dir;
}
function check(dir: string, text: string) { writeFileSync(join(dir, "paper", "manuscript.md"), text); return checkPaper(dir); }
const codes = (report: ReturnType<typeof checkPaper>) => report.findings.map(f => f.code);

const fixtures: Record<string, [string, string]> = {
  "adjacent-duplicate-citation": ["# Intro\n\nPrior work [@a2026; @a2026] and [@b2026][@b2026].\n", "# Intro\n\nPrior work [@a2026] and [@b2026].\n"],
  "citation-stack": ["# Intro\n\nMany works [@a2026; @b2026; @c2026; @d2026; @e2026; @f2026; @g2026].\n", "# Intro\n\nMany works [@a2026; @b2026; @c2026].\n"],
  "repeated-bundle": ["# Intro\n\nOne [@a2026; @b2026; @c2026]. Two [@c2026; @b2026; @a2026]. Three [@a2026; @b2026; @c2026].\n", "# Intro\n\nOne [@a2026; @b2026; @c2026]. Two [@a2026; @b2026; @c2026]. Three [@a2026].\n"],
  "bare-identifier": ["# Intro\n\nSee arXiv:2608.18034 and doi:10.1234/xyz.5 and https://example.org/paper.\n", "# Intro\n\nSee the survey [@a2026].\n"],
  "duplicate-heading": ["# Intro\n\n## Method\n\ntext\n\n## Method\n\ntext\n", "# Intro\n\n## Method\n\ntext\n\n# Other\n\n## Method\n\ntext\n"],
};

test("AC1: each hygiene code is reported on its fixture and not on the corrected counterpart", () => {
  for (const [code, [bad, good]] of Object.entries(fixtures)) {
    const dir = study(), report = check(dir, bad);
    expect(codes(report)).toContain(code as never);
    const hit = report.findings.find(f => f.code === code)!;
    expect(hit.severity).toBe("warning"); expect(hit.section?.[0]).toBe("Intro"); expect(hit.line).toBeGreaterThan(1); expect(hit.message).toContain(";");
    expect(codes(check(dir, good))).not.toContain(code as never);
  }
  expect(check(study(), fixtures["bare-identifier"]![0]).findings.filter(f => f.code === "bare-identifier")).toHaveLength(3);
});

test("AC2: hygiene findings warn by default and block paper check and build only when listed", async () => {
  const bad = fixtures["citation-stack"]![0];
  const warn = study(), report = check(warn, bad);
  expect(report.ok).toBe(true);
  const blocking = study('[paper]\nblocking = ["citation-stack"]\n'), refused = check(blocking, bad);
  expect(refused.ok).toBe(false); expect(refused.findings.find(f => f.code === "citation-stack")!.severity).toBe("blocking");
  await expect(ops.paperBuild(blocking, ctx)).rejects.toThrow(/citation-stack at 3:/);
  expect(check(study("[paper]\nmaxGroup = 8\nblocking = [\"citation-stack\"]\n"), bad).ok).toBe(true);
  expect(codes(check(study("[paper]\nmaxBundleRepeats = 3\n"), fixtures["repeated-bundle"]![0]))).not.toContain("repeated-bundle");
});

test("AC2: unknown settings and codes refuse with the cause and the next step", () => {
  for (const toml of ['[paper]\nblocking = ["bare-number"]\n', "[paper]\nmaxStack = 3\n", "[other]\nx = 1\n", "[paper]\nmaxGroup = 0\n", "not toml ==", '[paper]\nblocking = ["citation-stack", "citation-stack"]\n']) {
    const dir = study(toml);
    expect(() => check(dir, "# Intro\n")).toThrow(/^study\.toml: .*; fix the \[paper\] settings/);
  }
});

test("AC3: identifiers in link targets, code spans, citation keys and reference definitions are not bare", () => {
  const dir = study(), text = [
    "# Intro", "", "A [paper](https://arxiv.org/abs/2608.18034) and <https://doi.org/10.1234/xyz>.",
    "Code `arXiv:2608.18034` and `10.1234/abc`.", "Cited [@a2026; see doi:10.1234/xyz].", "",
    "```", "https://example.org/fenced", "```", "", "[ref]: https://doi.org/10.1234/def \"10.1234/title\"", "",
  ].join("\n");
  expect(codes(check(dir, text))).not.toContain("bare-identifier");
});

test("Setext headings give sections and duplicate-heading; lists, rules and code do not", () => {
  const dir = study('[paper]\nblocking = ["duplicate-heading"]\n');
  const report = check(dir, "Intro\n=====\n\nMethod\n------\n\ntext [@a2026; @a2026]\n\nMethod\n------\n\n```\nFake\n----\n```\n\n- item\n---\n");
  const dup = report.findings.filter(f => f.code === "duplicate-heading");
  expect(dup).toHaveLength(1); expect(dup[0]!.severity).toBe("blocking"); expect(dup[0]!.line).toBe(9); expect(dup[0]!.section).toEqual(["Intro", "Method"]);
  expect(report.ok).toBe(false);
  expect(report.findings.find(f => f.code === "adjacent-duplicate-citation")!.section).toEqual(["Intro", "Method"]);
  expect(codes(check(dir, "Intro\n=====\n\nA\n---\n\nB\n---\n"))).not.toContain("duplicate-heading");
});

test("section assignment stays fast with many headings and findings", () => {
  const dir = study(), parts: string[] = [];
  for (let i = 0; i < 40_000; i++) parts.push(`## H\n\nhttps://example.org/${i}\n`);
  const started = performance.now(), report = check(dir, `# Top\n\n${parts.join("\n")}`);
  expect(report.findings.filter(f => f.code === "duplicate-heading")).toHaveLength(39_999);
  expect(performance.now() - started).toBeLessThan(5_000);
}, 20_000);

test("a URL used as its own link text is not bare", () => {
  expect(codes(check(study(), "# Intro\n\nSee [https://example.org/p](https://example.org/p) and [https://example.org/a](https://example.org/b).\n")).filter(c => c === "bare-identifier")).toHaveLength(1);
});

test("AC4: existing studies without settings keep their blocking set and CLI/MCP agree", async () => {
  const dir = study(), text = "# Intro\n\nUnknown [@zzz2026] and [@a2026; @a2026].\n", report = check(dir, text);
  expect(report.ok).toBe(false);
  expect(report.findings.filter(f => f.severity === "blocking").map(f => f.code)).toEqual(["unknown-citation"]);
  expect(report.settings).toEqual({ maxGroup: 6, maxBundleRepeats: 2, blocking: [] });
  expect(await createAresMcp({}, ctx.http).handlers.ares_paper_check!({ study: dir })).toEqual(report);
  const blocking = study('[paper]\nblocking = ["adjacent-duplicate-citation"]\n'); check(blocking, text);
  expect(await createAresMcp({}, ctx.http).handlers.ares_paper_check!({ study: blocking })).toEqual(ops.paperCheck(blocking));
});
