import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import * as ops from "../src/commands.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { paperBuildPaths, readCurrentBuild, type PaperEvidence } from "../src/paper/build.ts";
import { paperSourcePath } from "../src/paper/document.ts";
import { protocolHash, readProtocol } from "../src/exp/protocol.ts";
import { appendEvent, openStudy, readBytesBounded, readLedger, sha256 } from "../src/study.ts";
import { experimentTree } from "./exp-fixture.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
function fixture(mode: "survey" | "experiment" = "survey") {
  const dir = tempDir();
  ops.init(dir, { mode, question: "Synthetic slides" }, ctx);
  mkdirSync(join(dir, "paper"), { recursive: true });
  return dir;
}
const read = (path: string) => readBytesBounded(path, 65_536);
const evidence = (dir: string, doc?: "slides"): PaperEvidence => JSON.parse(read(paperBuildPaths(dir, doc).evidence).toString());
async function protocol(dir: string) {
  const image = `synthetic@sha256:${"a".repeat(64)}`;
  experimentTree(dir);
  await ops.protocol(dir, {
    v: 1, method: "Synthetic", candidate: { image, command: ["candidate"] }, evaluator: { image, command: ["evaluate"] },
    metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 },
    network: "none", budget: { maxAttempts: 10, maxWallHours: 1, maxGpuHours: 0 },
  }, ctx);
}

test("slides check reuses positioned experiment findings without writing build outputs", async () => {
  const dir = fixture("experiment");
  const source = "## Results\n\n{{n:final.delta}}\n\nObserved 42.\n\n[@missing]\n";
  writeFileSync(paperSourcePath(dir, "slides"), source);
  const out = await run(["paper", "check", dir, "--doc", "slides", "--json"], {}, ctx);
  expect(out.code).toBe(1);
  expect(JSON.parse(out.text).findings).toMatchObject([
    { code: "unresolved-ref", line: 3, column: 1 },
    { code: "bare-number", line: 5, column: 10 },
    { code: "unknown-citation", line: 7, column: 2 },
  ]);
  const ledger = read(join(dir, "ledger.jsonl"));
  await expect(ops.paperBuild(dir, ctx, "slides")).rejects.toThrow("paper check");
  expect(existsSync(paperBuildPaths(dir, "slides").evidence)).toBe(false);
  expect(read(join(dir, "ledger.jsonl"))).toEqual(ledger);
});

test("slides and manuscript share a closed metric source and keep independent build receipts", async () => {
  const dir = fixture("experiment"), id = "c".repeat(16), commit = "b".repeat(40), runName = "synthetic";
  await protocol(dir);
  const frozen = readProtocol(dir)!;
  const folder = join(dir, "runs", runName, "attempts");
  mkdirSync(folder, { recursive: true });
  const attempt = join(folder, `${id}.json`);
  writeFileSync(attempt, JSON.stringify({
    v: 1, id, studyId: openStudy(dir).study.id, run: runName, commit, seed: 1, protocolHash: protocolHash(frozen), protocol: frozen,
    executor: {}, stages: {}, status: "succeeded", stage: "evaluator", startedAt: "2026-01-01T00:00:00Z",
    metrics: [{ name: "score", unit: "points", value: 4, provenance: "ares-observed" }], outputs: [],
  }));
  appendEvent(dir, actor, "attempt.started", { id, run: runName, commit, seed: 1 });
  const measured = `Score {{n:attempt:${id}.score}}.\n`;
  writeFileSync(paperSourcePath(dir, "manuscript"), "# Paper\n\n" + measured);
  writeFileSync(paperSourcePath(dir, "slides"), "## Slide\n\n" + measured + "Cohort {{lit:2026}}.\n");
  const original = await ops.paperBuild(dir, ctx), originalPaths = paperBuildPaths(dir), manuscript = read(originalPaths.manuscript), oldEvidence = read(originalPaths.evidence);
  const server = createAresMcp({}, ctx.http);
  const args = { study: dir, doc: "slides" };
  const tool = ARES_TOOLS.find(entry => entry.name === "ares_paper_build")!;
  expect(validArguments(args, tool.inputSchema)).toBe(true);
  const slides = JSON.parse((await run(["paper", "build", dir, "--doc", "slides", "--json"], {}, ctx)).text);
  expect(await server.handlers.ares_paper_build!(args)).toEqual({ ...slides, changed: false });
  expect(evidence(dir).placeholders[0]?.source).toEqual(evidence(dir, "slides").placeholders[0]?.source);
  expect(evidence(dir, "slides").placeholders[1]?.source.file).toBe("paper/slides.md");
  expect(read(paperBuildPaths(dir, "slides").manuscript).toString()).toBe("## Slide\n\nScore 4.\nCohort 2026.\n");
  expect(read(originalPaths.manuscript)).toEqual(manuscript);
  expect(read(originalPaths.evidence)).toEqual(oldEvidence);
  expect(readCurrentBuild(dir).evidenceSha256).toBe(original.evidenceSha256);
  expect(readLedger(dir).filter(event => event.type === "paper.built").map(event => event.data.doc)).toEqual([undefined, "slides"]);
  expect(JSON.parse((await run(["paper", "check", dir, "--doc", "slides", "--json"], {}, ctx)).text)).toEqual(await server.handlers.ares_paper_check!(args));
});

test("slides skip manuscript-only writing plans and still require visible negative results", async () => {
  const dir = fixture("experiment");
  await protocol(dir);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: "d".repeat(40) }, minSeeds: 1, minDelta: 0 }, ctx);
  await ops.investigateClose(dir, ctx);
  await ops.paperPlanSet(dir, { sections: [{ id: "results", heading: "Paper Results", cites: [], points: [{ id: "paper-point", claim: "Synthetic", requires: [] }] }] }, ctx);
  const source = paperSourcePath(dir, "slides");
  writeFileSync(source, "## Outcome\n\nResults are available.\n");
  expect(ops.paperCheck(dir, "slides").findings.map(finding => finding.code)).toEqual(["missing-negative-result"]);
  writeFileSync(source, "## Outcome\n\nReason {{n:investigate.reason}}.\n");
  expect(ops.paperCheck(dir, "slides").ok).toBe(true);
  expect((await ops.paperBuild(dir, ctx, "slides")).changed).toBe(true);
  expect(evidence(dir, "slides").v).toBe(1);
});

test("slides render receipts bind only to the slides build and cannot change manuscript render status", async () => {
  const dir = fixture(), renderFile = join(dir, "synthetic.pdf"), receiptFile = join(dir, "receipt.json");
  writeFileSync(renderFile, "synthetic PDF bytes");
  writeFileSync(paperSourcePath(dir, "manuscript"), "# Paper\n\nOriginal manuscript.\n");
  const paper = await ops.paperBuild(dir, ctx);
  const seal = (build: typeof paper) => writeFileSync(receiptFile, JSON.stringify({
    v: 1, tool: "synthetic", version: "1", environment: "fixture", template: "synthetic",
    manuscriptSha256: build.manuscriptSha256, evidenceSha256: build.evidenceSha256,
    outputs: [{ name: "result.pdf", sha256: sha256(read(renderFile)), pages: 1 }],
  }));
  seal(paper);
  const original = await ops.paperRenderRecord(dir, renderFile, receiptFile, ctx);
  writeFileSync(paperSourcePath(dir, "slides"), "## Slide\n\nSeparate slides.\n");
  const slides = await ops.paperBuild(dir, ctx, "slides");
  await expect(ops.paperRenderRecord(dir, renderFile, receiptFile, ctx, "slides")).rejects.toThrow("slides.evidence.json");
  seal(slides);
  const args = { study: dir, file: renderFile, receipt: receiptFile, doc: "slides" };
  const server = createAresMcp({}, ctx.http);
  const recorded = await server.handlers.ares_paper_render_record!(args);
  expect(recorded).toMatchObject({ path: "paper/build/slides.render/result.pdf", changed: true, evidenceSha256: slides.evidenceSha256 });
  expect(ops.paperRenderShow(dir).render?.receiptSha256).toBe(original.receiptSha256);
  expect(ops.paperRenderShow(dir).current).toBe(true);
  expect(JSON.parse((await run(["paper", "render", "show", dir, "--doc", "slides", "--json"], {}, ctx)).text)).toEqual(await server.handlers.ares_paper_render_show!({ study: dir, doc: "slides" }));
  writeFileSync(paperSourcePath(dir, "slides"), "## Slide\n\nChanged slides.\n");
  expect(ops.paperRenderShow(dir, "slides").current).toBe(false);
  expect(ops.paperRenderShow(dir).current).toBe(true);
  expect(ops.manifest().paperDocuments).toEqual(["manuscript", "slides"]);
});

test("invalid --doc exits with usage status before reading a study", () => {
  const cli = join(import.meta.dir, "..", "bin", "ares.js");
  const result = Bun.spawnSync([process.execPath, cli, "paper", "check", "missing-study", "--doc", "example"]);
  expect(result.exitCode).toBe(2);
  expect(result.stdout.toString()).toBe("");
  expect(result.stderr.toString()).toContain("use manuscript or slides with --doc");
});
