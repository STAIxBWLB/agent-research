import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { readCurrentBuild } from "../src/paper/build.ts";
import { SURVEY_CHECKLIST, validateReview, foldReviews } from "../src/paper/review.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { readLedger } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const KEYS: string[] = ["taxonomyPrinciple", "noEnumeration", "specificGaps", "citationRelations", "selectionReported", "scopeControl"];
const allTrue = Object.fromEntries(KEYS.map(k => [k, true])) as Record<string, boolean>;
async function setup(mode = "survey", settings?: string) {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode }, ctx); mkdirSync(join(dir, "paper"));
  writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic survey draft.\n"); await ops.paperBuild(dir, ctx);
  if (settings !== undefined) writeFileSync(join(dir, "study.toml"), settings);
  return dir;
}
function report(dir: string, family: string, survey?: Record<string, unknown>) {
  const checklist: Record<string, unknown> = { negativeResults: true, denominators: true, limitations: true, reproducibility: true };
  if (survey) checklist.survey = survey;
  return { v: 1, reviewer: { id: `reviewer-${family}`, modelFamily: family }, buildSha256: readCurrentBuild(dir).evidenceSha256, checklist, findings: [] };
}

test("AC1: reports with and without the survey block validate under show; require refuses a missing block; unknown keys refuse", async () => {
  const dir = await setup();
  const without = await ops.reviewAdd(dir, report(dir, "a"), ctx), withBlock = await ops.reviewAdd(dir, report(dir, "b", { ...allTrue, scopeControl: false }), ctx);
  expect(without.checklist).not.toHaveProperty("survey"); expect(withBlock.checklist.survey as unknown).toEqual({ ...allTrue, scopeControl: false });
  expect(() => validateReview(report(dir, "c", { ...allTrue, extra: true }))).toThrow(/checklist\.survey/);
  expect(() => validateReview(report(dir, "c", { ...allTrue, noEnumeration: "yes" }))).toThrow(/checklist\.survey\.noEnumeration must be a boolean/);
  const { taxonomyPrinciple: _t, ...missing } = allTrue;
  expect(() => validateReview(report(dir, "c", missing))).toThrow(/checklist\.survey\.taxonomyPrinciple/);
  const strict = await setup("survey", '[review]\nsurveyChecklist = "require"\n'), ledger = readFileSync(join(strict, "ledger.jsonl"));
  await expect(ops.reviewAdd(strict, report(strict, "a"), ctx)).rejects.toThrow(/checklist\.survey is required .* ares review checklist/);
  expect(readFileSync(join(strict, "ledger.jsonl"))).toEqual(ledger);
  // Require asks for presence, not true answers.
  expect((await ops.reviewAdd(strict, report(strict, "a", Object.fromEntries(KEYS.map(k => [k, false]))), ctx)).checklist.survey!.scopeControl).toBe(false);
  for (const toml of ['[review]\nsurveyChecklist = "always"\n', "[review]\nother = 1\n", '[review]\nsurveyChecklist = 1\n']) {
    const bad = await setup("survey"), raw = report(bad, "a"); writeFileSync(join(bad, "study.toml"), toml);
    await expect(ops.reviewAdd(bad, raw, ctx)).rejects.toThrow(/^study\.toml: .*\[review\]/);
  }
});

test("AC2: false answers are displayed and never change gate readiness", async () => {
  const dir = await setup();
  await ops.reviewAdd(dir, report(dir, "a"), ctx); await ops.reviewAdd(dir, report(dir, "b"), ctx);
  const before = ops.reviewShow(dir);
  const falseDir = await setup();
  await ops.reviewAdd(falseDir, report(falseDir, "a", Object.fromEntries(KEYS.map(k => [k, false]))), ctx); await ops.reviewAdd(falseDir, report(falseDir, "b", allTrue), ctx);
  const shown = ops.reviewShow(falseDir);
  expect(shown.surveyChecklist).toBe("show");
  expect(shown.surveyAnswers.map(a => a.survey as unknown)).toEqual([Object.fromEntries(KEYS.map(k => [k, false])), allTrue]);
  expect(shown.checklists[0]!.survey!.taxonomyPrinciple).toBe(false);
  expect(shown.ready).toBe(before.ready); expect(shown.unmet.map(u => u.code)).toEqual(before.unmet.map(u => u.code));
  // Require mode also adds no gate condition.
  writeFileSync(join(falseDir, "study.toml"), '[review]\nsurveyChecklist = "require"\n');
  expect(ops.reviewShow(falseDir).unmet.map(u => u.code)).toEqual(before.unmet.map(u => u.code));
  // Off hides the block in review show.
  writeFileSync(join(falseDir, "study.toml"), '[review]\nsurveyChecklist = "off"\n');
  expect(ops.reviewShow(falseDir).surveyAnswers).toEqual([]);
});

test("AC3: existing reports and studies without the setting read unchanged", async () => {
  const dir = await setup("experiment");
  const added = await ops.reviewAdd(dir, report(dir, "a"), ctx);
  const stored = readLedger(dir).filter(e => e.type === "review.added").at(-1)!;
  expect(Object.keys((stored.data.review as { checklist: object }).checklist)).toEqual(["negativeResults", "denominators", "limitations", "reproducibility"]);
  const { id: _id, ...stored_report } = added;
  expect(foldReviews(readLedger(dir))[0]!.report).toEqual(stored_report);
  const shown = ops.reviewShow(dir);
  expect(shown.surveyChecklist).toBe("off"); expect(shown.surveyAnswers).toEqual([]);
  expect(shown.checklists).toEqual([{ reviewId: added.id, negativeResults: true, denominators: true, limitations: true, reproducibility: true }]);
  // A survey study without study.toml defaults to show, and a pre-existing report shows null answers.
  const survey = await setup("survey"), old = await ops.reviewAdd(survey, report(survey, "a"), ctx);
  expect(ops.reviewShow(survey).surveyAnswers).toEqual([{ reviewId: old.id, modelFamily: "a", survey: null }]);
});

test("AC4: review checklist lists exactly the six keys with questions, CLI and MCP alike", async () => {
  const direct = ops.reviewChecklistShow();
  expect(direct.survey.map(q => q.key as string)).toEqual(KEYS);
  for (const item of direct.survey) expect(item.question.length).toBeGreaterThan(20);
  expect(direct.survey).toEqual(SURVEY_CHECKLIST.map(item => ({ ...item })));
  expect(await createAresMcp({}, ctx.http).handlers.ares_review_checklist!({})).toEqual(direct);
  const cli = await run(["review", "checklist", "--json"], {}, { http: ctx.http });
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toEqual(direct);
  // MCP accepts the survey block and the #100 repair/section fields through its transport schema.
  const dir = await setup(), server = createAresMcp({}, ctx.http);
  const viaMcp = await server.handlers.ares_review_add!({ study: dir, review: { ...report(dir, "a", allTrue), findings: [{ id: "f", kind: "clarity", location: "p:1", text: "synthetic", blocking: false, repair: "paragraph", section: "Intro" }] } }) as { checklist: { survey: unknown } };
  expect(viaMcp.checklist.survey).toEqual(allTrue);
});
