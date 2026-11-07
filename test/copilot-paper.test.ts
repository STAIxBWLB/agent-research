import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import type { AutonomyMode } from "../src/autonomy.ts";
import { readCurrentBuild, paperBuildPaths } from "../src/paper/build.ts";
import { readLedger } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "agent" as const, id: "synthetic-copilot" }, ctx = { actor, http: fakeHttp([]).http };
function fixture(autonomy: AutonomyMode = "copilot") {
  const home = tempDir(), dir = join(home, "study");
  ops.init(dir, { question: "Synthetic copilot paper", autonomy }, ctx);
  mkdirSync(join(dir, "paper")); writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic citation-free survey manuscript.\n");
  return dir;
}
const ledger = (dir: string) => readFileSync(join(dir, "ledger.jsonl"));
function report(dir: string, family: string, blocking = false) {
  return { v: 1, reviewer: { id: family, modelFamily: family }, buildSha256: readCurrentBuild(dir).evidenceSha256,
    checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true },
    findings: blocking ? [{ id: "clarify", kind: "clarity", location: "paper:1", text: "Synthetic clarification", blocking: true }] : [] };
}
const accept = (dir: string, artifact: "hypotheses" | "paper" | "reviews") => ops.gateDecide(dir, `accept:${artifact}`, "approve", undefined, ctx);

test("paper producer consumes current hypotheses acceptance but diagnostics and own draft remain usable", async () => {
  const dir = fixture(), hypotheses = join(dir, "hypotheses.md"); writeFileSync(hypotheses, "Synthetic hypothesis\n");
  const before = ledger(dir); expect(ops.paperCheck(dir).ok).toBe(true);
  await expect(ops.paperBuild(dir, ctx)).rejects.toThrow("accept:hypotheses");
  expect(ledger(dir)).toEqual(before); expect(existsSync(join(dir, "paper", "build"))).toBe(false);
  await accept(dir, "hypotheses"); const built = await ops.paperBuild(dir, ctx);
  expect(readCurrentBuild(dir).evidenceSha256).toBe(built.evidenceSha256);
  expect(ops.gateList(dir).find(gate => gate.gate === "accept:paper")?.state).toBe("pending");
  const paths = paperBuildPaths(dir), evidence = readFileSync(paths.evidence), manuscript = readFileSync(paths.manuscript), accepted = ledger(dir);
  writeFileSync(hypotheses, "Changed synthetic hypothesis\n");
  expect(ops.paperCheck(dir).ok).toBe(true); expect(readCurrentBuild(dir).evidenceSha256).toBe(built.evidenceSha256);
  await expect(ops.paperBuild(dir, ctx)).rejects.toThrow("accept:hypotheses");
  expect(ledger(dir)).toEqual(accepted); expect(readFileSync(paths.evidence)).toEqual(evidence); expect(readFileSync(paths.manuscript)).toEqual(manuscript);
  const shown = ops.reviewShow(dir); expect(shown.unmet.map(item => item.code)).not.toContain("accept:hypotheses"); expect(shown.unmet.map(item => item.code)).toContain("model-families");
});

test("review editing consumes paper acceptance and each review mutation stales reviews acceptance", async () => {
  const dir = fixture(); await ops.paperBuild(dir, ctx);
  const firstReport = report(dir, "family-a", true), before = ledger(dir);
  await expect(ops.reviewAdd(dir, firstReport, ctx)).rejects.toThrow("accept:paper"); expect(ledger(dir)).toEqual(before);
  await accept(dir, "paper");
  const first = await ops.reviewAdd(dir, firstReport, ctx); await ops.reviewAdd(dir, report(dir, "family-b"), ctx);
  expect(ops.gateList(dir).find(gate => gate.gate === "accept:reviews")?.state).toBe("pending");
  await accept(dir, "reviews"); expect(ops.reviewShow(dir).unmet.map(item => item.code)).toContain("blocking-findings");
  const notes = join(dir, "paper", "notes.md"); writeFileSync(notes, "Synthetic supplemental drafting notes\n");
  const stale = ledger(dir);
  await expect(ops.reviewResolve(dir, `${first.id}/clarify`, "Clarified synthetic wording", ctx)).rejects.toThrow("accept:paper"); expect(ledger(dir)).toEqual(stale);
  await accept(dir, "paper");
  await ops.reviewResolve(dir, `${first.id}/clarify`, "Clarified synthetic wording", ctx);
  expect(ops.reviewShow(dir).openBlocking).toEqual([]); expect(ops.reviewShow(dir).unmet.map(item => item.code)).toContain("accept:reviews");
  const unresolved = ledger(dir); await expect(ops.gateDecide(dir, "review", "approve", undefined, ctx)).rejects.toThrow("accept:reviews"); expect(ledger(dir)).toEqual(unresolved);
  await accept(dir, "reviews"); expect(ops.reviewShow(dir).ready).toBe(true);
  await ops.gateDecide(dir, "review", "approve", undefined, ctx);
  expect(readLedger(dir).at(-1)).toMatchObject({ type: "gate.approve", actor, data: { gate: "review" } });
  await ops.reviewAdd(dir, report(dir, "family-c"), ctx);
  expect(ops.reviewShow(dir).unmet.map(item => item.code)).toContain("accept:reviews");
  expect(ops.gateList(dir).find(gate => gate.gate === "accept:reviews")?.state).toBe("pending");
});

test("review readiness guards its paper/review inputs without writing or weakening strict checks", async () => {
  const dir = fixture(), hypotheses = join(dir, "hypotheses.md"); writeFileSync(hypotheses, "Original hypothesis\n");
  await accept(dir, "hypotheses"); await ops.paperBuild(dir, ctx); await accept(dir, "paper");
  await ops.reviewAdd(dir, report(dir, "family-a"), ctx); await ops.reviewAdd(dir, report(dir, "family-b"), ctx); await accept(dir, "reviews");
  writeFileSync(hypotheses, "Revised hypothesis\n"); writeFileSync(join(dir, "paper", "notes.md"), "Revised drafting notes\n");
  // A further canonical report changes the reviews journal after its acceptance.
  await accept(dir, "paper"); await ops.reviewAdd(dir, report(dir, "family-c"), ctx);
  writeFileSync(join(dir, "paper", "notes.md"), "Later revised drafting notes\n");
  const before = ledger(dir), shown = ops.reviewShow(dir), codes = shown.unmet.map(item => item.code);
  expect(codes).not.toContain("accept:hypotheses"); expect(codes).toContain("accept:paper"); expect(codes).toContain("accept:reviews"); expect(shown.ready).toBe(false);
  expect(shown.families).toEqual(["family-a", "family-b", "family-c"]); expect(shown.claims).toBe("unavailable (STAIxBWLB/agent-hub#931)");
  await expect(ops.gateDecide(dir, "review", "approve", undefined, ctx)).rejects.toThrow("accept:paper"); expect(ledger(dir)).toEqual(before);
});

test("auto gates and step policies retain paper and review behavior without acceptance gates", async () => {
  for (const mode of ["auto", "gates", "step"] as const) {
    const dir = fixture(mode); writeFileSync(join(dir, "hypotheses.md"), "Unaccepted synthetic hypothesis\n");
    await ops.paperBuild(dir, ctx); const first = await ops.reviewAdd(dir, report(dir, "family-a", true), ctx); await ops.reviewAdd(dir, report(dir, "family-b"), ctx);
    await ops.reviewResolve(dir, `${first.id}/clarify`, "Clarified synthetic wording", ctx);
    expect(ops.reviewShow(dir).ready).toBe(true); expect(ops.gateList(dir).some(gate => gate.gate.startsWith("accept:"))).toBe(false);
    await ops.gateDecide(dir, "review", "approve", undefined, ctx); expect(readLedger(dir).at(-1)).toMatchObject({ type: "gate.approve", actor });
  }
});

test("per-phase copilot overrides consume only the enabled artifact acceptance", async () => {
  const dir = fixture("gates"); await ops.autonomySet(dir, "copilot", "write", ctx); writeFileSync(join(dir, "hypotheses.md"), "Unaccepted hypothesis outside copilot phase\n");
  await ops.paperBuild(dir, ctx); await expect(ops.reviewAdd(dir, report(dir, "family-a"), ctx)).rejects.toThrow("accept:paper");
  await accept(dir, "paper"); await ops.reviewAdd(dir, report(dir, "family-a"), ctx); await ops.reviewAdd(dir, report(dir, "family-b"), ctx);
  expect(ops.reviewShow(dir).ready).toBe(true); expect(ops.reviewShow(dir).unmet.some(item => item.code.startsWith("accept:"))).toBe(false);
});
