import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { readCurrentBuild, paperBuildPaths } from "../src/paper/build.ts";
import { validateReview, reviewBinding } from "../src/paper/review.ts";
import { appendEvent, decideGate, openStudy, readLedger, requireGate } from "../src/study.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
async function setup(autonomy = "gates") {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", autonomy }, ctx); mkdirSync(join(dir, "paper")); writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic cohort {{lit:2026}}.\n"); await ops.paperBuild(dir, ctx); return dir;
}
function report(dir: string, family = "family-a", findings: {id:string;kind:string;location:string;text:string;blocking:boolean}[] = []) {
  return { v: 1, reviewer: { id: `reviewer-${family}`, modelFamily: family }, buildSha256: readCurrentBuild(dir).evidenceSha256, checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings };
}
function finding(kind = "contradiction", blocking = false) { return { id: "f1", kind, location: "paper:1", text: "Synthetic conflicting interpretation", blocking }; }

test("reviews bind current evidence hash and preserve output bytes with one event", async () => {
  const dir = await setup(), paths = paperBuildPaths(dir), evidence = readFileSync(paths.evidence), manuscript = readFileSync(paths.manuscript), before = readLedger(dir).length;
  const added = await ops.reviewAdd(dir, report(dir), ctx);
  expect(added.id).toMatch(/^[a-f0-9]{16}$/); expect(readLedger(dir).slice(before)).toMatchObject([{ type: "review.added", actor, data: { id: added.id, review: { buildSha256: added.buildSha256 } } }]);
  expect(readFileSync(paths.evidence)).toEqual(evidence); expect(readFileSync(paths.manuscript)).toEqual(manuscript);
  const raw = report(dir); raw.buildSha256 = "0".repeat(64); const ledger = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.reviewAdd(dir, raw, ctx)).rejects.toThrow("stale buildSha256"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
});

test("closed schema, 200-finding limit and 4000-byte text bounds refuse before writes", async () => {
  const dir = await setup(), good = report(dir), ledger = readFileSync(join(dir, "ledger.jsonl"));
  for (const raw of [
    { ...good, extra: true }, { ...good, v: 99 }, { ...good, reviewer: { ...good.reviewer, extra: true } },
    { ...good, checklist: { ...good.checklist, extra: true } }, { ...good, checklist: { ...good.checklist, limitations: "yes" } },
    { ...good, findings: [{ ...finding(), extra: true }] }, { ...good, findings: [finding("unsupported")] },
    { ...good, findings: [finding(), finding()] }, { ...good, findings: [{ ...finding(), text: "한".repeat(1334) }] },
    { ...good, findings: Array.from({ length: 201 }, (_, i) => ({ ...finding(), id: `f${i}` })) },
  ]) { await expect(ops.reviewAdd(dir, raw, ctx)).rejects.toThrow(); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger); }
  const accepted = await ops.reviewAdd(dir, { ...good, findings: Array.from({ length: 200 }, (_, i) => ({ ...finding("clarity"), id: `f${i}` })) }, ctx); expect(accepted.findings).toHaveLength(200);
  expect(validateReview({ ...good, findings: [{ ...finding(), text: "x".repeat(4000) }] }).findings[0]?.text).toHaveLength(4000);
});

test("contradictions always block regardless of votes and resolve only with an actor/reason", async () => {
  const dir = await setup(), first = await ops.reviewAdd(dir, report(dir, "family-a", [finding()]), ctx);
  expect(first.findings[0]?.blocking).toBe(true);
  await ops.reviewAdd(dir, report(dir, "family-b"), ctx); await ops.reviewAdd(dir, report(dir, "family-c"), ctx);
  const ledger = readFileSync(join(dir, "ledger.jsonl")); await expect(ops.gateDecide(dir, "review", "approve", undefined, ctx)).rejects.toThrow("blocking-findings"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  const resolver = { kind: "agent" as const, id: "synthetic-resolver" };
  await expect(ops.reviewResolve(dir, `${first.id}/f1`, "", { actor: resolver })).rejects.toThrow();
  await ops.reviewResolve(dir, `${first.id}/f1`, "Compared evidence and reconciled the interpretation", { actor: resolver });
  const ready = ops.reviewShow(dir); expect(ready.ready).toBe(true); expect(ready.openBlocking).toEqual([]); expect(ready.claims).toBe("unavailable (STAIxBWLB/agent-hub#931)");
  expect(readLedger(dir).findLast(e => e.type === "review.resolved")).toMatchObject({ actor: resolver, data: { reviewId: first.id, findingId: "f1", reason: "Compared evidence and reconciled the interpretation" } });
  await ops.gateDecide(dir, "review", "approve", undefined, ctx); expect(ops.gateList(dir).find(g => g.gate === "review")?.state).toBe("approved");
  await expect(ops.reviewResolve(dir, `${first.id}/f1`, "again", ctx)).rejects.toThrow("already resolved");
});

test("two distinct normalized families are required; false checklist answers remain visible, claims unavailable does not block", async () => {
  const dir = await setup(); await ops.reviewAdd(dir, report(dir), ctx); await ops.reviewAdd(dir, report(dir, " FAMILY-A "), ctx);
  expect(ops.reviewShow(dir).families).toEqual(["family-a"]); await expect(ops.gateDecide(dir, "review", "approve", undefined, ctx)).rejects.toThrow("model-families");
  const other = report(dir, "family-b"); other.checklist.limitations = false; await ops.reviewAdd(dir, other, ctx);
  const ready = ops.reviewShow(dir); expect(ready.ready).toBe(true); expect(ready.checklists.some(row => !row.limitations)).toBe(true); expect(ready.unmet).toEqual([]);
});

test("current check and build freshness block approvals, additions and automatic gate helpers", async () => {
  const dir = await setup("auto"), raw = report(dir); const before = readFileSync(join(dir, "ledger.jsonl"));
  expect(() => requireGate(dir, openStudy(dir).study, "review", ops.binder(dir))).toThrow("model-families");
  expect(() => decideGate(dir, "review", "approve", actor, ops.binder(dir))).toThrow("model-families"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  await ops.reviewAdd(dir, raw, ctx); await ops.reviewAdd(dir, report(dir, "family-b"), ctx);
  expect(requireGate(dir, openStudy(dir).study, "review", ops.binder(dir))).toMatchObject([{ actor: { kind: "auto" }, type: "gate.approve" }]);
  writeFileSync(join(dir, "paper", "manuscript.md"), "Unknown [@missing2026].");
  expect(ops.reviewShow(dir).unmet.map(row => row.code)).toContain("paper-check");
  await expect(ops.gateDecide(dir, "review", "approve", undefined, ctx)).rejects.toThrow("paper-check"); await expect(ops.reviewAdd(dir, raw, ctx)).rejects.toThrow("paper check");
  writeFileSync(join(dir, "paper", "manuscript.md"), "A different clean manuscript."); expect(ops.reviewShow(dir).unmet.map(row => row.code)).toContain("build");
  await expect(ops.reviewAdd(dir, raw, ctx)).rejects.toThrow("stale outputs");
});

test("new build, new report and resolutions reopen the content-bound gate without rewriting old reviews", async () => {
  const dir = await setup(); const a = await ops.reviewAdd(dir, report(dir, "family-a", [finding("clarity")]), ctx); await ops.reviewAdd(dir, report(dir, "family-b"), ctx);
  await ops.gateDecide(dir, "review", "approve", undefined, ctx); const binding = reviewBinding(dir);
  const third = await ops.reviewAdd(dir, report(dir, "family-c"), ctx); expect(ops.gateList(dir).find(g => g.gate === "review")?.state).toBe("pending"); expect(reviewBinding(dir)).not.toBe(binding);
  await ops.gateDecide(dir, "review", "approve", undefined, ctx); await ops.reviewResolve(dir, `${a.id}/f1`, "Clarified wording", ctx); expect(ops.gateList(dir).find(g => g.gate === "review")?.state).toBe("pending");
  const originalCount = readLedger(dir).filter(e => e.type === "review.added").length;
  writeFileSync(join(dir, "paper", "manuscript.md"), "New cohort {{lit:2027}}."); await ops.paperBuild(dir, ctx);
  expect(ops.reviewShow(dir).reviews).toEqual([]); expect(ops.reviewShow(dir).ready).toBe(false); expect(readLedger(dir).filter(e => e.type === "review.added")).toHaveLength(originalCount);
  await expect(ops.reviewResolve(dir, `${third.id}/missing`, "reason", ctx)).rejects.toThrow("unknown finding");
});

test("review count and combined ledger-event ceilings fail closed", async () => {
  const dir = await setup(), raw = report(dir);
  for (let i = 0; i < 100; i++) await ops.reviewAdd(dir, raw, ctx);
  const before = readFileSync(join(dir, "ledger.jsonl")); await expect(ops.reviewAdd(dir, raw, ctx)).rejects.toThrow("100 reviews"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  const other = await setup(), large = report(other, "family-a", Array.from({ length: 20 }, (_, i) => ({ ...finding("clarity"), id: `f${i}`, text: "x".repeat(4000) })));
  const old = readFileSync(join(other, "ledger.jsonl")); await expect(ops.reviewAdd(other, large, ctx)).rejects.toThrow("60 KiB"); expect(readFileSync(join(other, "ledger.jsonl"))).toEqual(old);
});

test("CLI/MCP share review operations and show remains read-only with missing builds named", async () => {
  const dir = await setup(), raw = report(dir, "family-a", [finding()]);
  const added = JSON.parse((await run(["review", "add", dir, "--file", "-", "--json"], {}, { http: ctx.http, readStdin: async () => JSON.stringify(raw) })).text);
  const server = createAresMcp({}, ctx.http); await server.handlers.ares_review_add!({ study: dir, review: report(dir, "family-b") });
  await server.handlers.ares_review_resolve!({ study: dir, target: `${added.id}/f1`, reason: "Resolved synthetic disagreement" });
  const before = readFileSync(join(dir, "ledger.jsonl")), shown = ops.reviewShow(dir);
  expect(await server.handlers.ares_review_show!({ study: dir })).toEqual(shown); expect(JSON.parse((await run(["review", "show", dir, "--json"], {}, { http: ctx.http })).text)).toEqual(shown); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  const missing = tempDir(); ops.init(missing, { question: "synthetic" }, ctx); expect(ops.reviewShow(missing).unmet.map(row => row.code)).toEqual(["build", "paper-check", "model-families"]);
});

test("additive ledger review metadata survives appends and unsupported versions refuse unchanged", async () => {
  const dir = await setup(), raw = report(dir); appendEvent(dir, actor, "review.added", { id: "old-review", review: { ...raw, future: "keep" }, future: "also keep" });
  await ops.reviewAdd(dir, report(dir, "family-b"), ctx); expect(readLedger(dir).find(e => e.type === "review.added")!.data.future).toBe("also keep");
  appendEvent(dir, actor, "review.added", { id: "future", review: { ...raw, v: 99 } }); const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.reviewAdd(dir, raw, ctx)).rejects.toThrow("supports this report"); expect(ops.reviewShow(dir).unmet.map(row => row.code)).toContain("review-journal"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});
