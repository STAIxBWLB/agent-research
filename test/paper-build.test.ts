import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { paperBuildPaths, type PaperEvidence } from "../src/paper/build.ts";
import { manuscriptPath } from "../src/paper/check.ts";
import { appendEvent, openStudy, readLedger, sha256 } from "../src/study.ts";
import { readProtocol, protocolHash } from "../src/exp/protocol.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), WIN = "b".repeat(40);
function study(mode = "survey") { const dir = tempDir(); ops.init(dir, { question: "synthetic", mode }, ctx); mkdirSync(join(dir, "paper")); return dir; }
let serial = 0;
function sample(dir: string, commit: string, value: number) {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, folder = join(dir, "runs", "investigate", "attempts"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run: "investigate", commit, seed: 1, protocolHash: protocolHash(protocol), protocol, executor: {}, stages: {}, stage: "evaluator", status: "succeeded", startedAt: "2030-01-01T00:00:00Z", metrics: [{ name: "score", value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run: "investigate", commit, seed: 1 }); return id;
}
async function experiment() {
  const dir = study("experiment"), image = `fixture@sha256:${"a".repeat(64)}`;
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image, command: ["candidate"] }, evaluator: { image, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  sample(dir, BASE, 10); sample(dir, WIN, 12); await ops.investigateClose(dir, ctx); return dir;
}

test("build renders closed values and literal escapes with one source-hashed evidence/receipt commit", async () => {
  const dir = await experiment(), input = "# Result\nDelta {{n:investigate.winner.delta|.2f}}, winner {{n:investigate.winner}}; cohort {{lit:2026}}.\n";
  writeFileSync(manuscriptPath(dir), input); const before = readLedger(dir).length;
  const result = await ops.paperBuild(dir, ctx), paths = paperBuildPaths(dir), bytes = readFileSync(paths.manuscript), evidenceText = readFileSync(paths.evidence), evidence: PaperEvidence = JSON.parse(evidenceText.toString());
  expect(bytes.toString()).toBe(`# Result\nDelta 2.00, winner ${WIN.slice(0, 12)}; cohort 2026.\n`);
  expect(result).toEqual({ manuscriptSha256: sha256(bytes), evidenceSha256: sha256(evidenceText), changed: true });
  expect(evidence.v).toBe(1); expect(evidence.manuscriptSha256).toBe(sha256(input)); expect(evidence.placeholders.map(p => p.value)).toEqual([2, WIN.slice(0, 12), "2026"]);
  for (const entry of evidence.placeholders) expect(entry.source.sha256).toBe(sha256(readFileSync(join(dir, entry.source.file))));
  expect(evidence.placeholders[2]?.source).toEqual({ file: "paper/manuscript.md", sha256: sha256(input) });
  expect(readLedger(dir).slice(before)).toMatchObject([{ type: "paper.built", actor, data: { manuscriptSha256: result.manuscriptSha256, evidenceSha256: result.evidenceSha256, sourceManuscriptSha256: sha256(input) } }]);
  expect(readFileSync(manuscriptPath(dir), "utf8")).toBe(input); expect(evidenceText.toString()).not.toContain("2030-01-01");
});

test("identical inputs and receipt are a no-op even after unrelated ledger events", async () => {
  const dir = study(); writeFileSync(manuscriptPath(dir), "Year {{lit:2026}}.\n"); const first = await ops.paperBuild(dir, ctx), paths = paperBuildPaths(dir), bytes = readFileSync(paths.evidence);
  appendEvent(dir, actor, "fixture.unrelated", {}); const before = readFileSync(join(dir, "ledger.jsonl"));
  expect(await ops.paperBuild(dir, ctx)).toEqual({ ...first, changed: false }); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(readFileSync(paths.evidence)).toEqual(bytes);
});

test("same rendered value with changed evidence provenance creates a new build receipt", async () => {
  const dir = await experiment(); writeFileSync(manuscriptPath(dir), "Delta {{n:investigate.winner.delta}}.\n");
  const first = await ops.paperBuild(dir, ctx); sample(dir, WIN, 999); await ops.investigateClose(dir, ctx);
  const second = await ops.paperBuild(dir, ctx);
  expect(second.changed).toBe(true); expect(second.manuscriptSha256).toBe(first.manuscriptSha256); expect(second.evidenceSha256).not.toBe(first.evidenceSha256); expect(readLedger(dir).filter(e => e.type === "paper.built")).toHaveLength(2);
});

test("every paper check failure refuses before any build output or event changes", async () => {
  const dir = await experiment(); writeFileSync(manuscriptPath(dir), "Valid {{lit:2026}}.\n"); await ops.paperBuild(dir, ctx);
  const paths = paperBuildPaths(dir), manuscript = readFileSync(paths.manuscript), evidence = readFileSync(paths.evidence);
  for (const [input, code] of [["Fabricated 42.", "bare-number"], ["{{n:final.delta}}", "unresolved-ref"], ["{{n:investigate.winner.delta|.9f}}", "bad-format"], ["[@missing2026]", "unknown-citation"]]) {
    writeFileSync(manuscriptPath(dir), input!); const before = readFileSync(join(dir, "ledger.jsonl"));
    await expect(ops.paperBuild(dir, ctx)).rejects.toThrow(code!); expect(readFileSync(paths.manuscript)).toEqual(manuscript); expect(readFileSync(paths.evidence)).toEqual(evidence); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  }
  const fresh = study("experiment"); writeFileSync(manuscriptPath(fresh), "Fabricated 42."); await expect(ops.paperBuild(fresh, ctx)).rejects.toThrow("paper check"); expect(existsSync(join(fresh, "paper", "build"))).toBe(false);
});

test("unknown or malformed prior evidence preserves both outputs and ledger", async () => {
  const dir = study(); writeFileSync(manuscriptPath(dir), "Clean manuscript."); await ops.paperBuild(dir, ctx); const paths = paperBuildPaths(dir), rendered = readFileSync(paths.manuscript);
  for (const value of ['{"v":99,"future":"keep"}', "not JSON"]) {
    writeFileSync(paths.evidence, value); const before = readFileSync(join(dir, "ledger.jsonl"));
    await expect(ops.paperBuild(dir, ctx)).rejects.toThrow(value.startsWith("{") ? "supports it" : "invalid JSON");
    expect(readFileSync(paths.evidence, "utf8")).toBe(value); expect(readFileSync(paths.manuscript)).toEqual(rendered); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  }
});

test("rebuild repairs missing output and records an absent receipt without inventing unchanged status", async () => {
  const dir = study(); writeFileSync(manuscriptPath(dir), "Clean."); const first = await ops.paperBuild(dir, ctx), paths = paperBuildPaths(dir);
  unlinkSync(paths.manuscript); expect((await ops.paperBuild(dir, ctx)).changed).toBe(true); expect(sha256(readFileSync(paths.manuscript))).toBe(first.manuscriptSha256);
  const ledger = join(dir, "ledger.jsonl"), events = readLedger(dir).filter(e => e.type !== "paper.built"); writeFileSync(ledger, events.map(e => JSON.stringify(e) + "\n").join(""));
  expect((await ops.paperBuild(dir, ctx)).changed).toBe(true); expect(readLedger(dir).filter(e => e.type === "paper.built")).toHaveLength(1);
});

test("CLI/MCP share build hashes/no-op and manifest declares supported paperEvidence v2", async () => {
  const dir = study(); writeFileSync(manuscriptPath(dir), "Year {{lit:2026}}.");
  const forbidden = async () => { throw new Error("build must not run a process"); }, server = createAresMcp({}, ctx.http, { runner: forbidden });
  const first = await server.handlers.ares_paper_build!({ study: dir }), cli = await run(["paper", "build", dir, "--json"], {}, { http: ctx.http, runner: forbidden });
  expect(JSON.parse(cli.text)).toEqual({ ...(first as object), changed: false }); expect(cli.code).toBe(0);
  expect(ARES_TOOLS.find(t => t.name === "ares_paper_build")?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: false }); expect(ops.manifest().formats.paperEvidence).toBe(2);
});
