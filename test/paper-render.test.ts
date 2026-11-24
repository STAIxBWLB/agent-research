import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { copilotBinding } from "../src/copilot.ts";
import { readCurrentBuild } from "../src/paper/build.ts";
import { PAPER_RENDER_BYTES, paperRenderDir } from "../src/paper/render.ts";
import { readLedger, sha256 } from "../src/study.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const PDF = Buffer.from("%PDF-1.7\nsynthetic render\n%%EOF\n");
async function setup(autonomy = "gates") {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", autonomy }, ctx); mkdirSync(join(dir, "paper"));
  writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic cohort {{lit:2026}}.\n"); await ops.paperBuild(dir, ctx); return dir;
}
function files(dir: string, bytes: Buffer = PDF, edit: (r: Record<string, unknown>) => void = () => {}) {
  const build = readCurrentBuild(dir), out = tempDir(), pdf = join(out, "paper.pdf"), receipt = join(out, "receipt.json");
  const raw: Record<string, unknown> = { v: 1, tool: "synthetic-renderer", version: "v0.0.1", environment: "fixture", evidenceSha256: build.evidenceSha256, manuscriptSha256: build.manuscriptSha256, template: "plain", outputs: [{ name: "paper.pdf", sha256: sha256(bytes), pages: 1 }], futureField: { kept: true } };
  edit(raw); writeFileSync(pdf, bytes); writeFileSync(receipt, JSON.stringify(raw)); return { pdf, receipt };
}
const snapshot = (dir: string) => ({ ledger: readFileSync(join(dir, "ledger.jsonl")), render: existsSync(paperRenderDir(dir)) });

test("AC1: mismatched evidence, manuscript or file hash refuses before any write", async () => {
  const dir = await setup(), before = snapshot(dir);
  for (const [edit, reason] of [
    [(r: Record<string, unknown>) => { r.evidenceSha256 = "0".repeat(64); }, "evidenceSha256 does not match"],
    [(r: Record<string, unknown>) => { r.manuscriptSha256 = "0".repeat(64); }, "manuscriptSha256 does not match"],
    [(r: Record<string, unknown>) => { r.outputs = [{ name: "paper.pdf", sha256: "1".repeat(64), pages: 1 }]; }, "matches no output"],
  ] as const) {
    const { pdf, receipt } = files(dir, PDF, edit);
    await expect(ops.paperRenderRecord(dir, pdf, receipt, ctx)).rejects.toThrow(reason);
    expect(snapshot(dir)).toEqual(before);
  }
});

test("AC2: a matching render is stored with one paper.rendered event; accept:paper binding unchanged; identical record is a no-op", async () => {
  const dir = await setup("copilot"), binding = copilotBinding(dir, "paper"), count = readLedger(dir).length, { pdf, receipt } = files(dir);
  const result = await ops.paperRenderRecord(dir, pdf, receipt, ctx);
  expect(result).toMatchObject({ changed: true, outputSha256: sha256(PDF), bytes: PDF.length, path: "paper/build/render/paper.pdf" });
  expect(readFileSync(join(paperRenderDir(dir), "paper.pdf"))).toEqual(PDF);
  expect(readFileSync(join(paperRenderDir(dir), "receipt.json"))).toEqual(readFileSync(receipt));
  expect(JSON.parse(readFileSync(join(paperRenderDir(dir), "receipt.json"), "utf8")).futureField).toEqual({ kept: true });
  const events = readLedger(dir).slice(count);
  expect(events).toMatchObject([{ type: "paper.rendered", actor, data: { evidenceSha256: result.evidenceSha256, outputSha256: sha256(PDF), bytes: PDF.length, renderer: { tool: "synthetic-renderer", version: "v0.0.1", environment: "fixture" }, template: "plain" } }]);
  expect(JSON.stringify(events)).not.toContain(PDF.toString());
  expect(copilotBinding(dir, "paper")).toBe(binding);
  const ledger = readFileSync(join(dir, "ledger.jsonl"));
  expect((await ops.paperRenderRecord(dir, pdf, receipt, ctx)).changed).toBe(false);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  expect(ops.paperRenderShow(dir)).toMatchObject({ current: true, reason: null, render: { outputSha256: sha256(PDF) } });
});

test("AC3: a rebuild with a new evidence hash leaves the render stale but stored; review show says so", async () => {
  const dir = await setup(), { pdf, receipt } = files(dir); await ops.paperRenderRecord(dir, pdf, receipt, ctx);
  expect(ops.reviewShow(dir).render).toEqual({ current: true, reason: null });
  writeFileSync(join(dir, "paper", "manuscript.md"), "Changed cohort {{lit:2027}}.\n"); await ops.paperBuild(dir, ctx);
  const shown = ops.paperRenderShow(dir);
  expect(shown.current).toBe(false); expect(shown.reason).toContain("earlier build");
  expect(existsSync(join(paperRenderDir(dir), "paper.pdf"))).toBe(true);
  expect(ops.reviewShow(dir).render.current).toBe(false);
  expect(ops.paperRenderShow(await setup())).toMatchObject({ current: false, render: null });
});

test("AC4: requireRender makes review readiness need a current render", async () => {
  const dir = await setup();
  writeFileSync(join(dir, "study.toml"), "[paper]\nrequireRender = true\n");
  expect(ops.reviewShow(dir).unmet.map(item => item.code)).toContain("render");
  const { pdf, receipt } = files(dir); await ops.paperRenderRecord(dir, pdf, receipt, ctx);
  expect(ops.reviewShow(dir).unmet.map(item => item.code)).not.toContain("render");
  writeFileSync(join(dir, "study.toml"), "[paper]\nrequireRender = \"yes\"\n");
  expect(() => ops.paperCheck(dir)).toThrow("requireRender must be true or false");
  writeFileSync(join(dir, "study.toml"), "[paper]\nrequireRender = false\n");
  expect(ops.paperCheck(dir).settings.requireRender).toBe(false);
  const plainDir = await setup(); expect(ops.reviewShow(plainDir).unmet.map(item => item.code)).not.toContain("render");
  expect(ops.paperCheck(plainDir).settings).toEqual({ maxGroup: 6, maxBundleRepeats: 2, reviewRounds: 3, blocking: [] });
});

test("AC5: oversized, symlinked and non-regular files are refused", async () => {
  const dir = await setup(), before = snapshot(dir), { pdf, receipt } = files(dir), link = join(tempDir(), "link.pdf"); symlinkSync(pdf, link);
  await expect(ops.paperRenderRecord(dir, link, receipt, ctx)).rejects.toThrow("symbolic link");
  await expect(ops.paperRenderRecord(dir, tempDir(), receipt, ctx)).rejects.toThrow("not a regular file");
  const big = Buffer.alloc(PAPER_RENDER_BYTES + 1), over = files(dir, big);
  await expect(ops.paperRenderRecord(dir, over.pdf, over.receipt, ctx)).rejects.toThrow("larger than");
  const receiptLink = join(tempDir(), "r.json"); symlinkSync(receipt, receiptLink);
  await expect(ops.paperRenderRecord(dir, pdf, receiptLink, ctx)).rejects.toThrow("receipt is missing, a symbolic link");
  expect(snapshot(dir)).toEqual(before);
  mkdirSync(join(dir, "paper", "build", "elsewhere")); symlinkSync(join(dir, "paper", "build", "elsewhere"), paperRenderDir(dir));
  await expect(ops.paperRenderRecord(dir, pdf, receipt, ctx)).rejects.toThrow("real directory");
});

test("AC6: manifest reports paperRender 1; a newer receipt version is refused and left unchanged", async () => {
  expect(ops.manifest().formats.paperRender).toBe(1); expect(ops.manifest().ledgerEvents).toContain("paper.rendered");
  const dir = await setup(), before = snapshot(dir), { pdf, receipt } = files(dir, PDF, r => { r.v = 2; }), bytes = readFileSync(receipt);
  await expect(ops.paperRenderRecord(dir, pdf, receipt, ctx)).rejects.toThrow("unsupported receipt version");
  expect(readFileSync(receipt)).toEqual(bytes); expect(snapshot(dir)).toEqual(before);
});

test("CLI, MCP and study export carry the render receipt without document bytes", async () => {
  const dir = await setup(), { pdf, receipt } = files(dir);
  const cli = await run(["paper", "render", "record", dir, "--file", pdf, "--receipt", receipt, "--json"], { ARES_ACTOR: "person" });
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text).changed).toBe(true);
  expect(JSON.parse((await run(["paper", "render", "show", dir, "--json"], {})).text).current).toBe(true);
  const mcp = createAresMcp({}, fakeHttp([]).http);
  expect(await mcp.handlers.ares_paper_render_show!({ study: dir })).toMatchObject({ current: true });
  await expect(Promise.resolve().then(() => mcp.handlers.ares_paper_render_record!({ study: dir, file: "relative.pdf", receipt }))).rejects.toThrow("absolute path");
  expect(await mcp.handlers.ares_paper_render_record!({ study: dir, file: pdf, receipt })).toMatchObject({ changed: false });
  mcp.terminate();
  const bundle = join(tempDir(), "bundle"); await ops.studyExport(dir, { bundle });
  const ledger = readFileSync(join(bundle, "ledger.jsonl"), "utf8"), event = ledger.split("\n").filter(Boolean).map(line => JSON.parse(line)).find(e => e.type === "paper.rendered");
  expect(event.data).toMatchObject({ outputSha256: sha256(PDF), renderer: { tool: "synthetic-renderer", version: "v0.0.1", environment: "fixture" } });
  for (const name of ["manifest.json", "ledger.jsonl", "evidence.json"]) expect(readFileSync(join(bundle, name), "utf8")).not.toContain("synthetic render");
});
