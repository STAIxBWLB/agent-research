import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { readCurrentBuild } from "../src/paper/build.ts";
import { validateReview } from "../src/paper/review.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
type Finding = { id: string; kind: string; location: string; text: string; blocking: boolean; repair?: string; section?: string };
async function setup(settings?: string) {
  const dir = tempDir(); ops.init(dir, { question: "synthetic" }, ctx); mkdirSync(join(dir, "paper"));
  writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic draft one.\n"); await ops.paperBuild(dir, ctx);
  if (settings !== undefined) writeFileSync(join(dir, "study.toml"), settings);
  return dir;
}
async function rebuild(dir: string, text: string) { writeFileSync(join(dir, "paper", "manuscript.md"), text); await ops.paperBuild(dir, ctx); }
function report(dir: string, family: string, findings: Finding[]) {
  return { v: 1, reviewer: { id: `reviewer-${family}`, modelFamily: family }, buildSha256: readCurrentBuild(dir).evidenceSha256, checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings };
}
const f = (id: string, extra: Partial<Finding> = {}): Finding => ({ id, kind: "clarity", location: "paper:1", text: `Synthetic finding text ${id}`, blocking: false, ...extra });

test("AC1: findings validate with and without repair/section; unknown repair refuses", async () => {
  const dir = await setup(), plain = validateReview(report(dir, "a", [f("x")]));
  expect(plain.findings[0]).toEqual({ id: "x", kind: "clarity", location: "paper:1", text: "Synthetic finding text x", blocking: false });
  const scoped = validateReview(report(dir, "a", [f("y", { repair: "paragraph", section: " Methods/Setup " })]));
  expect(scoped.findings[0]).toMatchObject({ repair: "paragraph", section: "Methods/Setup" });
  for (const repair of ["rewrite", "", "EDIT"]) expect(() => validateReview(report(dir, "a", [f("z", { repair })]))).toThrow(/unknown repair scope; use edit, paragraph, section/);
  expect(() => validateReview(report(dir, "a", [f("z", { section: "x".repeat(300) })]))).toThrow(/section/);
  expect(() => validateReview({ ...report(dir, "a", []), findings: [{ ...f("z"), scope: "edit" }] })).toThrow();
});

test("AC2: rounds count reports per section across evidence hashes and list over-budget sections", async () => {
  const dir = await setup('[paper]\nreviewRounds = 2\n');
  // Round 1 at build 1: Intro and Methods; a second finding for Intro in the same report counts once.
  await ops.reviewAdd(dir, report(dir, "a", [f("i1", { section: "Intro" }), f("i2", { section: "Intro", repair: "section" }), f("m1", { section: "Methods" })]), ctx);
  await rebuild(dir, "Synthetic draft two.\n");
  // Round 2 at build 2 for Intro only; a report without sections adds no rounds.
  await ops.reviewAdd(dir, report(dir, "b", [f("i3", { section: "Intro", repair: "paragraph" })]), ctx);
  await ops.reviewAdd(dir, report(dir, "c", [f("u1")]), ctx);
  await rebuild(dir, "Synthetic draft three.\n");
  const third = await ops.reviewAdd(dir, report(dir, "a", [f("i4", { section: "Intro" }), f("r1", { section: "Results" })]), ctx);
  await ops.reviewResolve(dir, `${third.id}/r1`, "synthetic fixed", ctx);
  const shown = ops.reviewShow(dir);
  expect(shown.roundBudget).toBe(2);
  expect(shown.sections).toEqual([
    { section: "Intro", rounds: 3, pass: false, overBudget: true },
    { section: "Methods", rounds: 1, pass: true, overBudget: false },
    { section: "Results", rounds: 1, pass: true, overBudget: false },
  ]);
  expect(shown.overBudget).toEqual([{ section: "Intro", rounds: 3, advice: "replan the section or ask a person" }]);
  expect(shown.openBySection).toHaveLength(1);
  expect(shown.openBySection[0]).toMatchObject({ section: "Intro", rounds: 3, byRepair: { edit: [{ findingId: "i4" }], paragraph: [], section: [] } });
  expect(shown.info.map(i => i.code)).toEqual(["review-rounds"]);
  expect(shown.info[0]!.message).toContain("replan the section or ask a person");
  // Default budget 3: no section is over it.
  writeFileSync(join(dir, "study.toml"), "");
  expect(ops.reviewShow(dir).overBudget).toEqual([]);
  // CLI and MCP share the same view.
  expect(await createAresMcp({}, ctx.http).handlers.ares_review_show!({ study: dir })).toEqual(ops.reviewShow(dir));
});

test("AC3: gate readiness conditions are unchanged; over-budget is informational only", async () => {
  const dir = await setup('[paper]\nreviewRounds = 1\n');
  await ops.reviewAdd(dir, report(dir, "a", [f("s1", { section: "Intro" })]), ctx);
  await rebuild(dir, "Synthetic draft two.\n");
  await ops.reviewAdd(dir, report(dir, "a", [f("s2", { section: "Intro" })]), ctx);
  await ops.reviewAdd(dir, report(dir, "b", []), ctx);
  const shown = ops.reviewShow(dir);
  expect(shown.overBudget.map(o => o.section)).toEqual(["Intro"]);
  expect(shown.unmet.filter(u => !u.code.startsWith("accept"))).toEqual([]);
  expect(shown.unmet.some(u => u.code.startsWith("review-rounds"))).toBe(false);
  // A blocking finding still blocks exactly as before; rounds add no unmet code.
  await ops.reviewAdd(dir, report(dir, "b", [f("blk", { blocking: true, section: "Intro" })]), ctx);
  expect(ops.reviewShow(dir).unmet.map(u => u.code).filter(c => !c.startsWith("accept"))).toEqual(["blocking-findings"]);
  // A broken study.toml shows the default budget as info; rounds still add no unmet code (paper check refuses it on its own, as since #99).
  writeFileSync(join(dir, "study.toml"), "[paper]\nreviewRounds = 0\n");
  const broken = ops.reviewShow(dir);
  expect(broken.roundBudget).toBe(3); expect(broken.info.map(i => i.code)).toContain("review-rounds-settings");
  expect(broken.unmet.some(u => u.code.startsWith("review-rounds"))).toBe(false);
});

test("AC4: the export bundle carries section rounds, pass and repair histogram without finding or section text", async () => {
  const dir = await setup();
  await ops.reviewAdd(dir, report(dir, "a", [f("i1", { section: "Secret Intro Name", repair: "section" }), f("m1", { section: "Methods" })]), ctx);
  await rebuild(dir, "Synthetic draft two.\n");
  const second = await ops.reviewAdd(dir, report(dir, "b", [f("i2", { section: "Secret Intro Name", repair: "paragraph" }), f("m2", { section: "Methods" })]), ctx);
  await ops.reviewResolve(dir, `${second.id}/m2`, "synthetic fixed", ctx);
  const out = join(tempDir(), "bundle"), manifest = await ops.studyExport(dir, { bundle: out }) as { counts: { reviewSections: { sections: { sectionSha256: string; rounds: number; pass: boolean }[]; repairs: Record<string, number> } } };
  const { sections, repairs } = manifest.counts.reviewSections;
  expect(repairs).toEqual({ edit: 2, paragraph: 1, section: 1 });
  expect(sections.map(s => [s.rounds, s.pass]).sort()).toEqual([[2, false], [2, true]]);
  for (const s of sections) expect(s.sectionSha256).toMatch(/^[a-f0-9]{64}$/);
  for (const name of ["manifest.json", "reviews.jsonl", "ledger.jsonl"]) {
    const text = readFileSync(join(out, name), "utf8");
    expect(text).not.toContain("Secret Intro Name"); expect(text).not.toContain("Synthetic finding text");
  }
  const rows = readFileSync(join(out, "reviews.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(rows.map(row => row.repairs)).toEqual([{ section: 1, edit: 1 }, { paragraph: 1, edit: 1 }]);
});
