import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { readCurrentBuild } from "../src/paper/build.ts";
import { foldReviews, validateReview } from "../src/paper/review.ts";
import { saveCandidates, verifySubject, type Candidate } from "../src/lit/candidates.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { readLedger, sha256 } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
const KEY = "known2026";
async function setup(settings?: string, plan = false) {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "survey" }, ctx); mkdirSync(join(dir, "paper"));
  if (plan) {
    const candidate: Candidate = { id: "doi:10.0000/synthetic-readback", title: "Synthetic reference", authors: ["Synthetic Author"], year: 2026, doi: "10.0000/synthetic-readback", sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status: "included", citekey: KEY,
      verify: { syntax: "ok", exists: "yes", match: "yes", checkedAt: "2030-01-01T00:00:00Z", via: "crossref" } };
    candidate.verify!.subject = verifySubject(candidate); saveCandidates(dir, [candidate]);
    writeFileSync(join(dir, "paper", "manuscript.md"), `## Introduction\n\n<!-- point:claim-a -->\nSynthetic text [@${KEY}].\n`);
    await ops.paperPlanSet(dir, { v: 2, sections: [{ id: "intro", heading: "Introduction", cites: [KEY], points: [{ id: "claim-a", claim: "The synthetic method lowers error.", requires: [KEY] }] }] }, ctx);
  } else writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic draft.\n");
  await ops.paperBuild(dir, ctx);
  if (settings !== undefined) writeFileSync(join(dir, "study.toml"), settings);
  return dir;
}
function report(dir: string, family: string, readback?: unknown) {
  return { v: 1, reviewer: { id: `reviewer-${family}`, modelFamily: family }, buildSha256: readCurrentBuild(dir).evidenceSha256,
    checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings: [], ...(readback === undefined ? {} : { readback }) };
}

test("AC1: reports without the block validate unchanged and keep their event hash input", async () => {
  const dir = await setup(), raw = report(dir, "a");
  expect(validateReview(raw)).toEqual(raw as never);
  const added = await ops.reviewAdd(dir, raw, ctx);
  expect(added).not.toHaveProperty("readback");
  const event = readLedger(dir).find(e => e.type === "review.added")!;
  expect(event.data.review).toEqual(raw);
  expect(added.id).toBe(sha256(JSON.stringify([raw, readLedger(dir).length - 1])).slice(0, 16));
  expect(foldReviews(readLedger(dir))[0]!.report).toEqual(raw as never);
});

test("AC2: empty, over-count, multi-line and over-length claims refuse with the rule named", async () => {
  const dir = await setup();
  for (const [readback, rule] of [
    [{ claims: [] }, "1 to 8 claims"], [{ claims: Array(9).fill("x") }, "1 to 8 claims"], [{}, "1 to 8 claims"],
    [{ claims: ["first\nsecond"] }, "single line"], [{ claims: ["한".repeat(501)] }, "exceeds 500 characters"], [{ claims: ["  "] }, "nonblank"],
    [{ claims: ["ok"], extra: 1 }, "unknown field"],
  ] as [unknown, string][]) expect(() => validateReview(report(dir, "a", readback))).toThrow(rule);
  expect(validateReview(report(dir, "a", { claims: ["한".repeat(500)] })).readback!.claims[0]).toHaveLength(500);
});

test("AC3: review show lists current-build read-backs and plan claims; CLI and MCP agree", async () => {
  const dir = await setup(undefined, true);
  const a = await ops.reviewAdd(dir, report(dir, "a", { claims: ["The method lowers error on the held-out split."] }), ctx);
  await ops.reviewAdd(dir, report(dir, "b"), ctx);
  const shown = ops.reviewShow(dir);
  expect(shown.readback).toBe("show");
  expect(shown.readbacks).toEqual([{ reviewId: a.id, reviewer: "reviewer-a", modelFamily: "a", claims: ["The method lowers error on the held-out split."] }]);
  expect(shown.planClaims).toEqual([{ point: "claim-a", claim: "The synthetic method lowers error." }]);
  const cli = JSON.parse((await run(["review", "show", dir, "--json"], {}, { http: ctx.http })).text);
  const mcp = await createAresMcp({}, ctx.http).handlers.ares_review_show!({ study: dir });
  expect(cli.readbacks).toEqual(shown.readbacks); expect(cli).toEqual(JSON.parse(JSON.stringify(mcp)));
  const plain = await setup();
  expect(ops.reviewShow(plain)).not.toHaveProperty("planClaims");
});

test("AC4: require refuses a missing block without a write, off returns an empty array, default is show", async () => {
  const strict = await setup('[review]\nreadback = "require"\n'), before = readFileSync(join(strict, "ledger.jsonl"));
  await expect(ops.reviewAdd(strict, report(strict, "a"), ctx)).rejects.toThrow(/readback is required by study\.toml \[review\] readback = "require"/);
  expect(readFileSync(join(strict, "ledger.jsonl"))).toEqual(before);
  expect((await ops.reviewAdd(strict, report(strict, "a", { claims: ["x"] }), ctx)).readback).toEqual({ claims: ["x"] });
  const off = await setup('[review]\nreadback = "off"\n');
  await ops.reviewAdd(off, report(off, "a", { claims: ["x"] }), ctx);
  expect(ops.reviewShow(off).readbacks).toEqual([]); expect(ops.reviewShow(off).readback).toBe("off");
  const dflt = await setup(); expect(ops.reviewShow(dflt).readback).toBe("show");
  const bad = await setup(); writeFileSync(join(bad, "study.toml"), '[review]\nreadback = "always"\n');
  const shown = ops.reviewShow(bad);
  expect(shown.readback).toBe("show"); expect(shown.info.map(i => i.code)).toContain("review-readback-settings");
  expect(shown.unmet.map(u => u.code)).not.toContain("review-readback-settings");
});

test("AC5: read-back content never changes readiness", async () => {
  const plainDir = await setup(), withDir = await setup();
  await ops.reviewAdd(plainDir, report(plainDir, "a"), ctx); await ops.reviewAdd(plainDir, report(plainDir, "b"), ctx);
  await ops.reviewAdd(withDir, report(withDir, "a", { claims: ["Contradicts everything."] }), ctx); await ops.reviewAdd(withDir, report(withDir, "b", { claims: ["Something else."] }), ctx);
  const x = ops.reviewShow(plainDir), y = ops.reviewShow(withDir);
  expect(y.ready).toBe(x.ready); expect(y.unmet.map(u => u.code)).toEqual(x.unmet.map(u => u.code)); expect(y.openBlocking).toEqual([]);
  writeFileSync(join(withDir, "study.toml"), '[review]\nreadback = "require"\n');
  expect(ops.reviewShow(withDir).unmet.map(u => u.code)).toEqual(x.unmet.map(u => u.code));
});
