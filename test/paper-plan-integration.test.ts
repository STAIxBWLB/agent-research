import { expect, spyOn, test } from "bun:test";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { saveCandidates, verifySubject, type Candidate } from "../src/lit/candidates.ts";
import * as plans from "../src/paper/plan.ts";
import { checkPaper } from "../src/paper/check.ts";
import { PAPER_EVIDENCE_BYTES, paperBuildPaths, readCurrentBuild } from "../src/paper/build.ts";
import { readBytesBounded, readJsonFile, readLedger, sha256, writeAtomic } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = {kind: "person" as const}, ctx = {actor, http: fakeHttp([]).http}, LEDGER_BYTES = 64 * 1024 * 1024;
function fixture(manuscript = "## Introduction\n\nA scoped survey.\n") {
  const dir = tempDir(); ops.init(dir, {question: "Synthetic paper plan integration", mode: "survey"}, ctx);
  mkdirSync(join(dir, "paper")); writeAtomic(join(dir, "paper", "manuscript.md"), manuscript, 2 * 1024 * 1024);
  const references = ["a2026", "b2026", "c2026"].map((citekey): Candidate => {
    const value: Candidate = {id: `doi:10.0000/${citekey}`, title: "Synthetic section reference", authors: ["Synthetic Author"], year: 2026, sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status: "included", citekey,
      verify: {syntax: "ok", exists: "yes", match: "yes", checkedAt: "2030-01-01T00:00:00Z"}};
    value.verify!.subject = verifySubject(value); return value;
  });
  saveCandidates(dir, references);
  return {dir, file: join(dir, "paper", "plan.json"), references};
}
const plan = () => ({v: 1 as const, sections: [{id: "intro-1", heading: "Introduction", cites: ["a2026"]}]});
const ledger = (dir: string) => readBytesBounded(join(dir, "ledger.jsonl"), LEDGER_BYTES);

test("paper plan file/stdin CLI and MCP share validation, storage and routing coverage", async () => {
  const f = fixture(), input = join(tempDir(), "plan.json"), raw = plan(); writeAtomic(input, JSON.stringify({sections: raw.sections}), plans.PAPER_PLAN_BYTES);
  const cli = await run(["paper", "plan", "set", f.dir, "--file", input, "--json"], {}, {http: ctx.http});
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toEqual(raw);
  const server = createAresMcp({}, ctx.http);
  expect(await server.handlers.ares_paper_plan_set!({study: f.dir, plan: raw})).toEqual(raw);
  expect(JSON.parse((await run(["paper", "plan", "set", f.dir, "--file", "-", "--json"], {}, {http: ctx.http, readStdin: async () => JSON.stringify(raw)})).text)).toEqual(raw);
  const shown = await server.handlers.ares_paper_plan_show!({study: f.dir});
  expect(shown).toEqual({plan: raw, coverage: {routed: 1, total: 3}});
  expect(JSON.parse((await run(["paper", "plan", "show", f.dir, "--json"], {}, {http: ctx.http})).text)).toEqual(shown);
  expect(ARES_TOOLS.find(tool => tool.name === "ares_paper_plan_show")!.annotations.readOnlyHint).toBe(true);
  const schema = ARES_TOOLS.find(tool => tool.name === "ares_paper_plan_set")!.inputSchema;
  expect(validArguments({study: f.dir, plan: raw}, schema)).toBe(true);
  expect(validArguments({study: f.dir, plan: {...raw, unexpected: true}}, schema)).toBe(false);
  const beforePlan = readBytesBounded(f.file, plans.PAPER_PLAN_BYTES), beforeLedger = ledger(f.dir);
  for (const invalid of [{...raw, v: 2}, {v: 1 as const, sections: [{...raw.sections[0]!, cites: ["unknown"]}]}]) {
    await expect(server.handlers.ares_paper_plan_set!({study: f.dir, plan: invalid})).rejects.toThrow("paper plan");
    await expect(run(["paper", "plan", "set", f.dir, "--file", "-"], {}, {http: ctx.http, readStdin: async () => JSON.stringify(invalid)})).rejects.toThrow("paper plan");
    expect(readBytesBounded(f.file, plans.PAPER_PLAN_BYTES)).toEqual(beforePlan); expect(ledger(f.dir)).toEqual(beforeLedger);
  }
});

test("paper check reports positioned scope ids, preserves front matter and keeps unplanned H2 inside the prior scope", async () => {
  const manuscript = "Front matter [@c2026].\r\n\r\n## Introduction\r\nAllowed [@a2026].\r\n## Extra\r\n한라 outside [@b2026].\r\n## Methods\r\nAllowed [@b2026].\r\n";
  const f = fixture(manuscript);
  await ops.paperPlanSet(f.dir, {v: 1 as const, sections: [...plan().sections, {id: "methods", heading: "Methods", cites: ["b2026"]}]}, ctx);
  const report = checkPaper(f.dir), bad = report.findings.filter(row => row.code === "out-of-scope-citation");
  expect(bad).toHaveLength(1);
  const start = manuscript.indexOf("@b2026", manuscript.indexOf("한라"));
  expect(bad[0]).toMatchObject({sectionId: "intro-1", severity: "blocking", start, end: start + "@b2026".length, line: 6, column: 13});
  expect(report.findings.find(row => row.code === "unplanned-section")?.severity).toBe("warning");
  expect(report.findings.filter(row => row.code === "unrouted-reference")).toHaveLength(1);
  expect(report.ok).toBe(false);
  expect((await run(["paper", "check", f.dir, "--json"], {}, {http: ctx.http})).code).toBe(1);
  expect(await createAresMcp({}, ctx.http).handlers.ares_paper_check!({study: f.dir})).toEqual(report);
});

test("scope warnings do not block a plan-bound build and current provenance understands its evidence", async () => {
  const f = fixture("## Introduction\nKnown [@a2026].\n## Extra\nNo citation here.\n"); await ops.paperPlanSet(f.dir, plan(), ctx);
  const report = checkPaper(f.dir);
  expect(report.findings.some(row => row.code === "unrouted-reference")).toBe(true);
  expect(report.findings.some(row => row.code === "unplanned-section")).toBe(true);
  expect(report.findings.every(row => row.severity === "warning")).toBe(true); expect(report.ok).toBe(true);
  const built = await ops.paperBuild(f.dir, ctx), evidence = readJsonFile(paperBuildPaths(f.dir).evidence, PAPER_EVIDENCE_BYTES) as {v: number; planSha256: string};
  expect(evidence.v).toBe(2); expect(evidence.planSha256).toBe(sha256(readBytesBounded(f.file, plans.PAPER_PLAN_BYTES)));
  expect(readCurrentBuild(f.dir).evidenceSha256).toBe(built.evidenceSha256);
  const graph = ops.lineageShow(f.dir), node = graph.nodes.find(row => row.ref.kind === "paper-evidence" && row.ref.sha256 === built.evidenceSha256);
  expect(node).toMatchObject({state: "current", availability: "available"});
  expect(graph.issues.some(issue => issue.code === "unsupported-closed-version")).toBe(false);
  const bundle = join(tempDir(), "bundle"); await ops.studyExport(f.dir, {bundle});
  const reduced = readJsonFile(join(bundle, "evidence.json"), PAPER_EVIDENCE_BYTES) as {planSha256: string};
  expect(reduced.planSha256).toBe(evidence.planSha256);
  expect(readBytesBounded(join(bundle, "evidence.json"), PAPER_EVIDENCE_BYTES).toString("utf8")).not.toContain("Introduction");
});

test("raw plan byte changes stale the existing build and approved review without rewriting either", async () => {
  const f = fixture(); await ops.paperPlanSet(f.dir, plan(), ctx); const built = await ops.paperBuild(f.dir, ctx);
  for (const family of ["synthetic-a", "synthetic-b"]) await ops.reviewAdd(f.dir, {v: 1, reviewer: {id: family, modelFamily: family}, buildSha256: built.evidenceSha256,
    checklist: {negativeResults: true, denominators: true, limitations: true, reproducibility: true}, findings: []}, ctx);
  await ops.gateDecide(f.dir, "review", "approve", undefined, ctx);
  expect(ops.gateList(f.dir).find(row => row.gate === "review")?.state).toBe("approved");
  const paths = paperBuildPaths(f.dir), beforeEvidence = readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES), beforeLedger = ledger(f.dir), beforeGraph = ops.lineageShow(f.dir);
  writeAtomic(f.file, readBytesBounded(f.file, plans.PAPER_PLAN_BYTES).toString("utf8") + "\n", plans.PAPER_PLAN_BYTES);
  expect(() => readCurrentBuild(f.dir)).toThrow("stale");
  expect(ops.reviewShow(f.dir).unmet.some(row => row.code === "build")).toBe(true);
  expect(ops.gateList(f.dir).find(row => row.gate === "review")?.state).toBe("none");
  const changedGraph = ops.lineageShow(f.dir);
  expect(changedGraph.sourceSha256).not.toBe(beforeGraph.sourceSha256);
  expect(changedGraph.nodes.find(row => row.ref.kind === "paper-evidence" && row.ref.sha256 === built.evidenceSha256)?.state).not.toBe("current");
  expect(readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES)).toEqual(beforeEvidence); expect(ledger(f.dir)).toEqual(beforeLedger);
  const rebuilt = await ops.paperBuild(f.dir, ctx);
  expect(rebuilt.evidenceSha256).not.toBe(built.evidenceSha256);
  expect(ops.gateList(f.dir).find(row => row.gate === "review")?.state).toBe("pending");
  expect(ops.reviewShow(f.dir).ready).toBe(false);
});

test("plan addition and removal stale prior builds while absence retains legacy v1 evidence", async () => {
  const f = fixture(), paths = paperBuildPaths(f.dir); await ops.paperBuild(f.dir, ctx);
  expect((readJsonFile(paths.evidence, PAPER_EVIDENCE_BYTES) as {v: number}).v).toBe(1);
  await ops.paperPlanSet(f.dir, plan(), ctx); expect(() => readCurrentBuild(f.dir)).toThrow("stale");
  await ops.paperBuild(f.dir, ctx); expect((readJsonFile(paths.evidence, PAPER_EVIDENCE_BYTES) as {v: number}).v).toBe(2);
  unlinkSync(f.file); expect(() => readCurrentBuild(f.dir)).toThrow("stale");
  await ops.paperBuild(f.dir, ctx); expect((readJsonFile(paths.evidence, PAPER_EVIDENCE_BYTES) as {v: number}).v).toBe(1);
});

test("build rechecks plan presence and exact bytes before its single publication commit", async () => {
  for (const fault of ["added", "removed", "changed"] as const) {
    const f = fixture(); if (fault !== "added") await ops.paperPlanSet(f.dir, plan(), ctx); await ops.paperBuild(f.dir, ctx);
    const paths = paperBuildPaths(f.dir), before = readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES), beforeLedger = ledger(f.dir), original = plans.readPaperPlanSnapshot;
    let once = false;
    const spy = spyOn(plans, "readPaperPlanSnapshot").mockImplementation((...args: Parameters<typeof original>) => {
      const snapshot = original(...args);
      if (!once) { once = true; if (fault === "removed") unlinkSync(f.file); else writeAtomic(f.file, JSON.stringify(plan()) + (fault === "changed" ? "\n\n" : "\n"), plans.PAPER_PLAN_BYTES); }
      return snapshot;
    });
    try { await expect(ops.paperBuild(f.dir, ctx)).rejects.toThrow("source plan was added, removed or changed"); }
    finally { spy.mockRestore(); }
    expect(readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES)).toEqual(before); expect(ledger(f.dir)).toEqual(beforeLedger);
  }
});
