import { expect, test } from "bun:test";
import { mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { saveCandidates, verifySubject, type Candidate } from "../src/lit/candidates.ts";
import { PAPER_PLAN_BYTES, readPaperPlanSnapshot } from "../src/paper/plan.ts";
import { PAPER_EVIDENCE_BYTES, paperBuildPaths, readCurrentBuild } from "../src/paper/build.ts";
import { POINT_CODES } from "../src/paper/points.ts";
import { ATTEMPT_BYTES } from "../src/exp/attempts.ts";
import { appendEvent, openStudy, readBytesBounded, readJsonFile, sha256, writeAtomic } from "../src/study.ts";
import { metricAttempt } from "./metric-fixtures.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http }, MANUSCRIPT_BYTES = 2 * 1024 * 1024, LEDGER_BYTES = 64 * 1024 * 1024;
const KEY = "known2026", HEADING = "Introduction";
const manuscript = `## ${HEADING}\n\n<!-- point:claim-a -->\nUnrelated wording with the declared citation [@${KEY}].\n`;
function fixture(mode = "survey", text = manuscript) {
  const dir = tempDir(); ops.init(dir, { question: "Synthetic writing-point integration?", mode }, ctx);
  mkdirSync(join(dir, "paper")); const source = join(dir, "paper", "manuscript.md"); writeAtomic(source, text, MANUSCRIPT_BYTES);
  const candidate: Candidate = { id: "doi:10.0000/synthetic-writing-point", title: "Synthetic point reference", authors: ["Synthetic Author"], year: 2026, doi: "10.0000/synthetic-writing-point", sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status: "included", citekey: KEY,
    verify: { syntax: "ok", exists: "yes", match: "yes", checkedAt: "2030-01-01T00:00:00Z", via: "crossref" } };
  candidate.verify!.subject = verifySubject(candidate); saveCandidates(dir, [candidate]);
  return { dir, source, plan: join(dir, "paper", "plan.json") };
}
function pointsPlan(claim = "A declared claim deliberately absent from the manuscript.", evidence?: string[]) {
  return { v: 2 as const, sections: [{ id: "intro", heading: HEADING, cites: [KEY], points: [{ id: "claim-a", claim, requires: [KEY], ...(evidence === undefined ? {} : { evidence }) }] }] };
}
const ledger = (dir: string) => readBytesBounded(join(dir, "ledger.jsonl"), LEDGER_BYTES);


test("writing points set/check/build use only anchor and citation presence, and failed checks preserve built outputs", async () => {
  const f = fixture();
  const stored = await ops.paperPlanSet(f.dir, pointsPlan(), ctx);
  expect(stored.v).toBe(2); expect(readPaperPlanSnapshot(f.dir)?.plan).toEqual(stored);
  const report = ops.paperCheck(f.dir);
  expect(report.ok).toBe(true); expect(report.findings).toEqual([]);
  expect(report.rendered).toBe(manuscript);
  const built = await ops.paperBuild(f.dir, ctx), paths = paperBuildPaths(f.dir);
  expect(readCurrentBuild(f.dir).evidenceSha256).toBe(built.evidenceSha256);
  const evidence = readJsonFile(paths.evidence, PAPER_EVIDENCE_BYTES) as { v: number; planSha256: string };
  expect(evidence.v).toBe(2); expect(evidence.planSha256).toBe(sha256(readBytesBounded(f.plan, PAPER_PLAN_BYTES)));
  const beforeEvidence = readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES), beforeRendered = readBytesBounded(paths.manuscript, MANUSCRIPT_BYTES);
  for (const [text, expected] of [
    [`## ${HEADING}\n\nNo point anchor but a valid citation [@${KEY}].\n`, "missing-point"],
    [`## ${HEADING}\n\n<!-- point:claim-a -->\nNo citation in this paragraph.\n`, "missing-required-citation"],
  ] as const) {
    writeAtomic(f.source, text, MANUSCRIPT_BYTES);
    const beforeLedger = ledger(f.dir), checked = ops.paperCheck(f.dir), hit = checked.findings.find(item => item.code === expected);
    expect(checked.ok).toBe(false); expect(hit).toMatchObject({ code: expected, severity: "blocking", pointId: "claim-a", sectionId: "intro" });
    expect(hit!.line).toBeGreaterThan(0); expect(hit!.column).toBeGreaterThan(0);
    await expect(ops.paperBuild(f.dir, ctx)).rejects.toThrow(expected);
    expect(readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES)).toEqual(beforeEvidence);
    expect(readBytesBounded(paths.manuscript, MANUSCRIPT_BYTES)).toEqual(beforeRendered); expect(ledger(f.dir)).toEqual(beforeLedger);
  }
});

test("no-point plans stay byte-identical v1 and explicit empty points preserve section-scope check/build behavior", async () => {
  const f = fixture("survey", `## ${HEADING}\n\nA scoped citation [@${KEY}].\n`);
  const legacy = { v: 1 as const, sections: [{ id: "intro", heading: HEADING, cites: [KEY] }] };
  expect(await ops.paperPlanSet(f.dir, legacy, ctx)).toEqual(legacy);
  const beforePlan = readBytesBounded(f.plan, PAPER_PLAN_BYTES);
  expect(beforePlan.toString("utf8")).toBe(JSON.stringify(legacy, null, 2) + "\n");
  const beforeCheck = ops.paperCheck(f.dir), first = await ops.paperBuild(f.dir, ctx), paths = paperBuildPaths(f.dir), beforeEvidence = readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES);
  expect(await ops.paperPlanSet(f.dir, { sections: [{ ...legacy.sections[0]!, points: [] }] }, ctx)).toEqual(legacy);
  expect(readBytesBounded(f.plan, PAPER_PLAN_BYTES)).toEqual(beforePlan); expect(ops.paperCheck(f.dir)).toEqual(beforeCheck);
  expect(ops.paperCheck(f.dir).findings.some(item => (POINT_CODES as readonly string[]).includes(item.code))).toBe(false);
  const second = await ops.paperBuild(f.dir, ctx);
  expect(second.changed).toBe(false); expect(second.evidenceSha256).toBe(first.evidenceSha256);
  expect(readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES)).toEqual(beforeEvidence);
});

test("failed and unknown attempt evidence resolve by existence, then disappearing evidence becomes a blocking finding rather than a throw", async () => {
  for (const status of ["failed", "unknown"] as const) {
    const f = fixture("experiment"), attempt = metricAttempt(); attempt.studyId = openStudy(f.dir).study.id; attempt.status = status; attempt.endedAt = "2030-01-01T00:00:01Z"; attempt.reason = status === "unknown" ? "lost" : "fixture-failure";
    const folder = join(f.dir, "runs", attempt.run, "attempts"), record = join(folder, `${attempt.id}.json`); mkdirSync(folder, { recursive: true });
    writeAtomic(record, JSON.stringify(attempt, null, 2) + "\n", ATTEMPT_BYTES);
    appendEvent(f.dir, ctx.actor, "attempt.started", { id: attempt.id, run: attempt.run, commit: attempt.commit, seed: attempt.seed });
    expect(ops.attemptShow(f.dir, attempt.id).status).toBe(status);
    await ops.paperPlanSet(f.dir, pointsPlan(undefined, [`attempt:${attempt.id}`]), ctx);
    expect(ops.paperCheck(f.dir).ok).toBe(true); await ops.paperBuild(f.dir, ctx);
    const paths = paperBuildPaths(f.dir), beforeEvidence = readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES), beforePlan = readBytesBounded(f.plan, PAPER_PLAN_BYTES);
    unlinkSync(record);
    const beforeLedger = ledger(f.dir), checked = ops.paperCheck(f.dir);
    expect(checked.ok).toBe(false);
    expect(checked.findings.filter(item => item.code === "unresolved-point-evidence")).toMatchObject([{ code: "unresolved-point-evidence", severity: "blocking", pointId: "claim-a", sectionId: "intro", line: 3, column: 1 }]);
    await expect(ops.paperBuild(f.dir, ctx)).rejects.toThrow("unresolved-point-evidence");
    expect(readBytesBounded(f.plan, PAPER_PLAN_BYTES)).toEqual(beforePlan); expect(readBytesBounded(paths.evidence, PAPER_EVIDENCE_BYTES)).toEqual(beforeEvidence); expect(ledger(f.dir)).toEqual(beforeLedger);
  }
});

test("CLI and MCP share Unicode-character claims, versioning and atomic invalid-set refusals", async () => {
  const cli = fixture(), remote = fixture(), claim = "😀".repeat(500), raw = pointsPlan(claim), schema = ARES_TOOLS.find(tool => tool.name === "ares_paper_plan_set")!.inputSchema;
  expect(validArguments({ study: remote.dir, plan: raw }, schema)).toBe(true);
  const response = await run(["paper", "plan", "set", cli.dir, "--file", "-", "--json"], {}, { http: ctx.http, readStdin: async () => JSON.stringify(raw) });
  const server = createAresMcp({}, ctx.http), stored = await server.handlers.ares_paper_plan_set!({ study: remote.dir, plan: raw });
  expect(JSON.parse(response.text)).toEqual(stored); expect(stored).toEqual(raw);
  expect(ops.paperCheck(cli.dir)).toEqual(ops.paperCheck(remote.dir));
  const beforePlan = readBytesBounded(remote.plan, PAPER_PLAN_BYTES), beforeLedger = ledger(remote.dir);
  const invalid = [
    pointsPlan("😀".repeat(501)),
    { ...raw, v: 1 },
    { ...raw, sections: [{ ...raw.sections[0]!, points: [{ ...raw.sections[0]!.points[0]!, requires: ["not-in-section"] }] }] },
    pointsPlan(claim, ["attempt:ffffffffffffffff"]),
  ];
  for (const value of invalid) {
    await expect(server.handlers.ares_paper_plan_set!({ study: remote.dir, plan: value })).rejects.toThrow("paper plan:");
    await expect(run(["paper", "plan", "set", remote.dir, "--file", "-"], {}, { http: ctx.http, readStdin: async () => JSON.stringify(value) })).rejects.toThrow("paper plan:");
    expect(readBytesBounded(remote.plan, PAPER_PLAN_BYTES)).toEqual(beforePlan); expect(ledger(remote.dir)).toEqual(beforeLedger);
  }
});

test("escaped comments and link/reference metadata neither create anchors nor truncate a real point window", async () => {
  const fakeAnchors = [
    `\\<!-- point:claim-a --> [@${KEY}]`,
    `[link](https://synthetic.test "<!-- point:claim-a -->")\n[@${KEY}]`,
    `[x]: https://synthetic.test "<!-- point:claim-a -->"\n[@${KEY}]`,
  ];
  for (const fake of fakeAnchors) {
    const f = fixture("survey", `## ${HEADING}\n\n${fake}\n`);
    await ops.paperPlanSet(f.dir, pointsPlan(), ctx);
    const absent = ops.paperCheck(f.dir), hits = absent.findings.filter(item => item.code === "missing-point");
    expect(absent.ok).toBe(false);
    expect(hits).toMatchObject([{ code: "missing-point", severity: "blocking", pointId: "claim-a", sectionId: "intro" }]);
    writeAtomic(f.source, `## ${HEADING}\n\n<!-- point:claim-a -->\n${fake.replace("point:claim-a", "point:unknown")}\n`, MANUSCRIPT_BYTES);
    const real = ops.paperCheck(f.dir);
    expect(real.findings.filter(item => (POINT_CODES as readonly string[]).includes(item.code))).toEqual([]);
  }
});
