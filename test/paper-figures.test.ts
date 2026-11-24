import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import * as ops from "../src/commands.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { paperBuildPaths, paperEvidenceVersion } from "../src/paper/build.ts";
import { PAPER_FIGURE_BYTES } from "../src/paper/figures.ts";
import { openStudy, readBytesBounded, sha256 } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
const diagram = { id: "fig-arch", kind: "diagram", file: "paper/figures/arch.svg" };
const sections = [{ id: "method", heading: "Method", cites: [] }];
const content = "Synthetic figure bytes";
function fixture(mode: "survey" | "experiment" = "survey") {
  const dir = tempDir(), paper = join(dir, "paper"), manuscript = join(paper, "manuscript.md");
  ops.init(dir, { question: "Synthetic figure test", mode }, ctx);
  mkdirSync(join(paper, "figures"), { recursive: true });
  writeFileSync(manuscript, "# Method\n\nSynthetic prose.\n");
  return { dir, manuscript };
}
const codes = (dir: string) => ops.paperCheck(dir).findings.map(finding => finding.code);
async function plan(dir: string, figures: unknown[]) { return ops.paperPlanSet(dir, { sections, figures }, ctx); }

test("legacy plan and build bytes retain their shape with undeclared image markup", async () => {
  const { dir, manuscript } = fixture();
  writeFileSync(manuscript, "# Method\n\n![Synthetic](figures/untracked.svg)\n");
  const paths = paperBuildPaths(dir);
  for (const version of [1, 2] as const) {
    if (version === 2) await ops.paperPlanSet(dir, { sections }, ctx);
    const report = ops.paperCheck(dir);
    expect(report).not.toHaveProperty("figures");
    expect(report.ok).toBe(true);
    await ops.paperBuild(dir, ctx);
    const bytes = readBytesBounded(paths.evidence, 65_536);
    const evidence = JSON.parse(bytes.toString("utf8"));
    expect(paperEvidenceVersion(evidence)).toBe(version);
    const expected = version === 1 ? { v: 1 } : { v: 2, planSha256: report.planSha256 };
    expect(bytes.toString()).toBe(JSON.stringify({ ...expected, manuscriptSha256: report.manuscriptSha256, placeholders: [] }, null, 2) + "\n");
  }
});

test("the check finds unregistered links and unlinked, unsafe, missing or oversized figures", async () => {
  const { dir, manuscript } = fixture();
  writeFileSync(manuscript, "# Method\n\n![Other](figures/other.svg)\n\n`![example](figures/code.svg)`\n");
  const file = join(dir, diagram.file);
  writeFileSync(file, content);
  expect((await plan(dir, [diagram])).v).toBe(3);
  expect(codes(dir)).toEqual(["missing-figure", "undeclared-figure"]);

  writeFileSync(manuscript, "# Method\n\n![Diagram][art]\n\n[art]: <figures/arch.svg>\n");
  expect(codes(dir)).toEqual([]);
  truncateSync(file, PAPER_FIGURE_BYTES + 1);
  expect(codes(dir)).toEqual(["missing-figure"]);
  const other = { ...diagram, file: "paper/figures/linked.svg" };
  symlinkSync(file, join(dir, other.file));
  await plan(dir, [other]);
  writeFileSync(manuscript, "# Method\n\n![Mapped](figures/linked.svg)\n");
  expect(ops.paperCheck(dir).findings[0]).toMatchObject({ code: "missing-figure", figureId: diagram.id, line: 3 });
  await expect(plan(dir, [{ ...diagram, file: "paper/../outside" }])).rejects.toThrow("without traversal");
  await expect(plan(dir, [{ ...diagram, file: "/outside.svg" }])).rejects.toThrow("under paper/");
});

test("a plot must provide exactly one source and unresolved evidence blocks the build", async () => {
  const { dir, manuscript } = fixture(), plot = { ...diagram, kind: "plot" }, evidence = ["attempt:0000000000000000"];
  for (const raw of [plot, { ...plot, evidence, waiver: "Synthetic" }]) {
    await expect(plan(dir, [raw])).rejects.toThrow("exactly one");
  }
  await plan(dir, [{ ...plot, evidence }]);
  writeFileSync(join(dir, diagram.file), content);
  writeFileSync(manuscript, "# Method\n\n![Plot](paper/figures/arch.svg)\n");
  expect(codes(dir)).toEqual(["unresolved-figure-evidence"]);
  expect(ops.paperPlanShow(dir).figureCoverage).toEqual({ artifact: 0, referenced: 0, waived: 0, diagram: 0, total: 1 });
  await expect(ops.paperBuild(dir, ctx)).rejects.toThrow("unresolved-figure-evidence");
});

test("figure bytes bind evidence and stale reviews; CLI and MCP share the figure plan and view", async () => {
  const { dir, manuscript } = fixture(), file = join(dir, diagram.file);
  writeFileSync(file, content);
  writeFileSync(manuscript, "# Method\n\n![Diagram](figures/arch.svg)\n");
  const planArgs = { study: dir, plan: { sections, figures: [diagram] } };
  const server = createAresMcp({}, ctx.http);
  const set = ARES_TOOLS.find(tool => tool.name === "ares_paper_plan_set")!;
  expect(validArguments(planArgs, set.inputSchema)).toBe(true);
  await server.handlers.ares_paper_plan_set!(planArgs);
  const show = JSON.parse((await run(["paper", "plan", "show", dir, "--json"], {}, ctx)).text);
  expect(show).toEqual(await server.handlers.ares_paper_plan_show!({ study: dir }));
  expect(show.figureCoverage).toEqual({ artifact: 0, referenced: 0, waived: 0, diagram: 1, total: 1 });

  expect(JSON.parse((await run(["paper", "check", dir, "--json"], {}, ctx)).text)).toEqual(await server.handlers.ares_paper_check!({ study: dir }));
  const first = await ops.paperBuild(dir, ctx);
  const evidence = JSON.parse(readBytesBounded(paperBuildPaths(dir).evidence, 65_536).toString("utf8"));
  expect(evidence).toMatchObject({ v: 3, figures: [{ id: diagram.id, file: diagram.file, sha256: sha256(content), bytes: Buffer.byteLength(content), provenance: "diagram" }] });
  await ops.reviewAdd(dir, {
    v: 1, reviewer: { id: "synthetic-reviewer", modelFamily: "synthetic" }, buildSha256: first.evidenceSha256,
    checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings: [],
  }, ctx);
  expect(ops.reviewShow(dir).reviews).toHaveLength(1);
  writeFileSync(file, "Changed synthetic figure");
  expect(ops.reviewShow(dir).unmet.some(item => item.code === "build" && item.message.includes("stale outputs"))).toBe(true);
  const second = await ops.paperBuild(dir, ctx);
  expect(second.changed).toBe(true);
  expect(second.evidenceSha256).not.toBe(first.evidenceSha256);
  expect(ops.reviewShow(dir).reviews).toHaveLength(0);
});

test("byte-identical attempt output metadata yields artifact provenance", async () => {
  const { dir, manuscript } = fixture("experiment"), id = "c".repeat(16), directory = join(dir, "runs", "main", "attempts");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), JSON.stringify({
    v: 1, id, studyId: openStudy(dir).study.id, run: "main", stage: "evaluator", status: "succeeded", stages: {}, protocol: {}, executor: {},
    startedAt: "2026-01-01T00:00:00Z",
    outputs: [{ path: "/synthetic/plot.svg", sha256: sha256(content), bytes: Buffer.byteLength(content) }],
  }));
  const figure = { ...diagram, kind: "plot", evidence: [`attempt:${id}`] };
  await plan(dir, [figure]);
  writeFileSync(manuscript, "# Method\n\n![Plot](figures/arch.svg)\n");
  const file = join(dir, diagram.file);
  writeFileSync(file, content);
  expect(ops.paperCheck(dir).figures?.[0]?.provenance).toBe("artifact");
  writeFileSync(file, "Different bytes");
  expect(ops.paperCheck(dir).figures?.[0]?.provenance).toBe("referenced");
});
