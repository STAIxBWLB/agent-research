import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { readCurrentBuild } from "../src/paper/build.ts";
import { SURVEY_CHECKLIST, type ReviewFinding } from "../src/paper/review.ts";
import { readTextBounded } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
const falseAnswers = Object.fromEntries(SURVEY_CHECKLIST.map(item => [item.key, false]));
async function setup(settings?: string) {
  const dir = tempDir(); ops.init(dir, { question: "Synthetic point review?", mode: "survey" }, ctx);
  mkdirSync(join(dir, "paper")); writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic survey draft.\n");
  if (settings !== undefined) writeFileSync(join(dir, "study.toml"), settings);
  await ops.paperBuild(dir, ctx); return dir;
}
function finding(id: string, location: string, options: Partial<ReviewFinding> = {}): ReviewFinding {
  return { id, kind: "clarity", location, text: "Synthetic private finding text", blocking: false, ...options };
}
function report(dir: string, family: string, findings: ReviewFinding[], survey = false) {
  return { v: 1, reviewer: { id: `synthetic-${family}`, modelFamily: family }, buildSha256: readCurrentBuild(dir).evidenceSha256,
    checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true, ...(survey ? { survey: falseAnswers } : {}) }, findings };
}

test("ordinary or ambiguous locations leave the no-point review projection unchanged and read-only", async () => {
  const dir = await setup();
  await ops.reviewAdd(dir, report(dir, "a", [
    finding("ordinary", "Intro paragraph"), finding("trailing", "point:alpha paragraph"), finding("embedded", "Intro point:alpha"),
    finding("uppercase", "point:Alpha"), finding("underscore", "point:alpha_beta"), finding("long", `point:${"a".repeat(65)}`),
  ]), ctx);
  await ops.reviewAdd(dir, report(dir, "b", []), ctx);
  const before = readTextBounded(join(dir, "ledger.jsonl"), 16 * 1024 * 1024), shown = ops.reviewShow(dir);
  expect(Object.hasOwn(shown, "openByPoint")).toBe(false);
  expect(shown.ready).toBe(true); expect(shown.openBlocking).toEqual([]);
  expect(readTextBounded(join(dir, "ledger.jsonl"), 16 * 1024 * 1024)).toBe(before);
});

test("current unresolved findings group by exact point location without plan resolution or inferred support", async () => {
  const dir = await setup(), a = await ops.reviewAdd(dir, report(dir, "a", [
    finding("alpha-note", "point:alpha", { section: "Intro", repair: "paragraph" }),
    finding("beta-contradiction", "point:beta", { kind: "contradiction" }),
    finding("ordinary-blocker", "Methods paragraph", { blocking: true }),
  ]), ctx);
  const b = await ops.reviewAdd(dir, report(dir, "b", [
    finding("alpha-blocker", "  point:alpha  ", { kind: "citation", blocking: true }), finding("alpha-other", "point:alpha"),
    finding("unplanned", "point:no-plan-entry"),
  ], true), ctx);
  const before = readTextBounded(join(dir, "ledger.jsonl"), 16 * 1024 * 1024), shown = ops.reviewShow(dir);
  expect(shown.openByPoint).toEqual([
    { point: "alpha", open: 3, blocking: 1, findings: [
      { reviewId: a.id, findingId: "alpha-note", kind: "clarity", blocking: false },
      { reviewId: b.id, findingId: "alpha-blocker", kind: "citation", blocking: true },
      { reviewId: b.id, findingId: "alpha-other", kind: "clarity", blocking: false },
    ] },
    { point: "beta", open: 1, blocking: 1, findings: [{ reviewId: a.id, findingId: "beta-contradiction", kind: "contradiction", blocking: true }] },
    { point: "no-plan-entry", open: 1, blocking: 0, findings: [{ reviewId: b.id, findingId: "unplanned", kind: "clarity", blocking: false }] },
  ]);
  expect(shown.unmet.map(item => item.code)).toEqual(["blocking-findings"]);
  expect(shown.openBlocking).toHaveLength(3); expect(shown.ready).toBe(false);
  expect(JSON.stringify(shown.openByPoint)).not.toContain("Synthetic private finding text");
  expect(shown.claims).toBe("unavailable (STAIxBWLB/agent-hub#931)");
  expect(readTextBounded(join(dir, "ledger.jsonl"), 16 * 1024 * 1024)).toBe(before);
  await ops.reviewResolve(dir, `${a.id}/beta-contradiction`, "Synthetic reconciliation", ctx);
  await ops.reviewResolve(dir, `${b.id}/alpha-blocker`, "Synthetic reconciliation", ctx);
  const resolved = ops.reviewShow(dir);
  expect(resolved.openByPoint?.map(item => [item.point, item.open, item.blocking])).toEqual([["alpha", 2, 0], ["no-plan-entry", 1, 0]]);
  expect(resolved.openBlocking).toHaveLength(1); expect(resolved.ready).toBe(false);
  await ops.reviewResolve(dir, `${a.id}/ordinary-blocker`, "Synthetic reconciliation", ctx);
  expect(ops.reviewShow(dir).ready).toBe(true);
  for (const [review, id] of [[a.id, "alpha-note"], [b.id, "alpha-other"], [b.id, "unplanned"]]) await ops.reviewResolve(dir, `${review}/${id}`, "Synthetic reconciliation", ctx);
  const closed = ops.reviewShow(dir);
  expect(Object.hasOwn(closed, "openByPoint")).toBe(true); expect(closed.openByPoint).toEqual([]); expect(closed.ready).toBe(true);
});

test("stale build findings leave the point projection while section rounds and survey off semantics remain intact", async () => {
  const dir = await setup('[paper]\nreviewRounds = 1\n[review]\nsurveyChecklist = "off"\n');
  await ops.reviewAdd(dir, report(dir, "a", [finding("old", "point:old-point", { section: "Intro" })], true), ctx);
  expect(ops.reviewShow(dir).openByPoint?.map(item => item.point)).toEqual(["old-point"]);
  writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic revised survey draft.\n"); await ops.paperBuild(dir, ctx);
  expect(Object.hasOwn(ops.reviewShow(dir), "openByPoint")).toBe(false);
  await ops.reviewAdd(dir, report(dir, "a", [finding("new", "point:new-point", { section: "Intro" })], true), ctx);
  await ops.reviewAdd(dir, report(dir, "b", [], true), ctx);
  const shown = ops.reviewShow(dir);
  expect(shown.openByPoint?.map(item => item.point)).toEqual(["new-point"]);
  expect(shown.roundBudget).toBe(1); expect(shown.overBudget.map(item => [item.section, item.rounds])).toEqual([["Intro", 2]]);
  expect(shown.info.some(item => item.code === "review-rounds")).toBe(true);
  expect(shown.surveyChecklist).toBe("off"); expect(shown.surveyAnswers).toEqual([]);
  expect(shown.checklists.every(item => !Object.hasOwn(item, "survey"))).toBe(true);
  expect(shown.ready).toBe(true); expect(shown.unmet).toEqual([]);
});
