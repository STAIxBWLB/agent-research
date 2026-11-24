import { paperDocument, paperEventFor, type PaperDocument } from "./document.ts";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { commit, hashFileBounded, openStudy, plain, readBytesBounded, readLedger, sha256, type Actor } from "../study.ts";
import { readCurrentBuild } from "./build.ts";

/**
 * External render receipts (#162). ares records what was rendered from which build; it never runs a renderer and
 * never judges whether the rendering is faithful. `renderReceipt: 1` is renderer-agnostic.
 */
export const RENDER_RECEIPT_VERSION = 1;
export const PAPER_RENDER_BYTES = 64 * 1024 * 1024, RENDER_RECEIPT_BYTES = 64 * 1024, RENDER_OUTPUTS = 16;
const HEX64 = /^[a-f0-9]{64}$/, NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const renderFolder = (doc: PaperDocument) => doc === "slides" ? "slides.render" : "render";
export function paperRenderDir(dir: string, doc: PaperDocument = "manuscript") { return join(dir, "paper", "build", renderFolder(doc)); }
const receiptPath = (dir: string, doc: PaperDocument) => join(paperRenderDir(dir, doc), "receipt.json");

export interface RenderReceipt { v: 1; tool: string; version: string; environment: string; evidenceSha256: string; manuscriptSha256: string; template: string; outputs: { name: string; sha256: string; pages: number }[] }
function bad(detail: string): never { throw new Error(`paper render: receipt ${detail}; pass a renderReceipt v1 JSON with tool, version, environment, evidenceSha256, manuscriptSha256, template and outputs`); }
function identity(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f]/.test(value)) bad(`${what} must be 1..256 characters without control characters`);
  return value;
}
/** Unknown fields stay in the stored bytes; only a newer or unknown version is refused, leaving every file unchanged. */
export function validateRenderReceipt(raw: unknown): RenderReceipt {
  if (!plain(raw)) bad("is not a JSON object");
  if (raw.v !== RENDER_RECEIPT_VERSION) throw new Error(`paper render: unsupported receipt version ${JSON.stringify(raw.v)?.slice(0, 20)}; use an ares version that supports it; nothing was recorded`);
  for (const key of ["evidenceSha256", "manuscriptSha256"] as const) if (typeof raw[key] !== "string" || !HEX64.test(raw[key] as string)) bad(`${key} must be a lowercase SHA-256`);
  if (!Array.isArray(raw.outputs) || raw.outputs.length < 1 || raw.outputs.length > RENDER_OUTPUTS) bad(`outputs must list 1..${RENDER_OUTPUTS} files`);
  const names = new Set<string>();
  const outputs = raw.outputs.map((item: unknown) => {
    if (!plain(item) || typeof item.name !== "string" || !NAME.test(item.name) || item.name === "receipt.json") bad("output name must be a plain file name other than receipt.json");
    if (typeof item.sha256 !== "string" || !HEX64.test(item.sha256)) bad("output sha256 must be a lowercase SHA-256");
    if (typeof item.pages !== "number" || !Number.isSafeInteger(item.pages) || item.pages < 0) bad("output pages must be a nonnegative integer");
    if (names.has(item.name)) bad(`output ${item.name} is listed twice`);
    names.add(item.name);
    return { name: item.name, sha256: item.sha256, pages: item.pages };
  });
  return { v: 1, tool: identity(raw.tool, "tool"), version: identity(raw.version, "version"), environment: identity(raw.environment, "environment"), evidenceSha256: raw.evidenceSha256 as string, manuscriptSha256: raw.manuscriptSha256 as string, template: identity(raw.template, "template"), outputs };
}
function parseReceipt(bytes: Buffer): RenderReceipt {
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { bad("is not valid UTF-8 JSON"); }
  return validateRenderReceipt(raw);
}
/** The reserved derived path must be real directories, so a stored file never lands outside the study. */
function assertReservedPath(dir: string, doc: PaperDocument): void {
  for (const part of [join(dir, "paper"), join(dir, "paper", "build"), paperRenderDir(dir, doc)]) {
    if (!existsSync(part)) continue;
    const info = lstatSync(part);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`paper render: paper/build/${renderFolder(doc)} must be a real directory without symbolic links; restore it before recording`);
  }
}

/** Caller holds the study lock. Every check precedes the single file-and-receipt commit. */
export function recordPaperRender(dirArg: string, file: string, receiptFile: string, actor: Actor, doc: PaperDocument = "manuscript") {
  paperDocument(doc);
  const { dir } = openStudy(dirArg);
  let receiptBytes: Buffer, output: Buffer;
  try { receiptBytes = readBytesBounded(receiptFile, RENDER_RECEIPT_BYTES, { noFollow: true }); }
  catch { throw new Error(`paper render: receipt is missing, a symbolic link, not a regular file or larger than ${RENDER_RECEIPT_BYTES} bytes; pass the renderer's receipt JSON file`); }
  const receipt = parseReceipt(receiptBytes);
  try { output = readBytesBounded(file, PAPER_RENDER_BYTES, { noFollow: true }); }
  catch { throw new Error(`paper render: file is missing, a symbolic link, not a regular file or larger than ${PAPER_RENDER_BYTES} bytes; pass the rendered document itself`); }
  const current = readCurrentBuild(dir, doc), outputSha256 = sha256(output);
  if (receipt.evidenceSha256 !== current.evidenceSha256) throw new Error(`paper render: receipt evidenceSha256 does not match the current paper/build/${doc === "slides" ? "slides.evidence.json" : "evidence.json"}; render the current build and retry`);
  if (receipt.manuscriptSha256 !== current.manuscriptSha256) throw new Error("paper render: receipt manuscriptSha256 does not match the current rendered manuscript; render the current build and retry");
  const entry = receipt.outputs.find(item => item.sha256 === outputSha256);
  if (!entry) throw new Error("paper render: the file's SHA-256 matches no output in the receipt; pass the file the receipt describes");
  assertReservedPath(dir, doc);
  const receiptSha256 = sha256(receiptBytes), stored = join(paperRenderDir(dir, doc), entry.name);
  const last = readLedger(dir).findLast(event => paperEventFor(event, "paper.rendered", doc));
  const same = last?.data.receiptSha256 === receiptSha256 && last.data.outputSha256 === outputSha256 && last.data.name === entry.name && stillStored(dir, entry.name, outputSha256, receiptSha256, doc);
  const result = { evidenceSha256: current.evidenceSha256, outputSha256, bytes: output.length, name: entry.name, receiptSha256, path: `paper/build/${renderFolder(doc)}/${entry.name}` };
  if (same) return { ...result, changed: false };
  commit(dir, [[stored, output, PAPER_RENDER_BYTES], [receiptPath(dir, doc), receiptBytes, RENDER_RECEIPT_BYTES]], [{ actor, type: "paper.rendered", data: {
    ...(doc === "slides" ? { doc } : {}), evidenceSha256: current.evidenceSha256, manuscriptSha256: current.manuscriptSha256, outputSha256, bytes: output.length, name: entry.name, receiptSha256,
    renderer: { tool: receipt.tool, version: receipt.version, environment: receipt.environment }, template: receipt.template,
  } }]);
  return { ...result, changed: true };
}
function stillStored(dir: string, name: string, outputSha256: string, receiptSha256: string, doc: PaperDocument): boolean {
  try {
    return hashFileBounded(join(paperRenderDir(dir, doc), name), PAPER_RENDER_BYTES, { noFollow: true }).sha256 === outputSha256
      && sha256(readBytesBounded(receiptPath(dir, doc), RENDER_RECEIPT_BYTES, { noFollow: true })) === receiptSha256;
  } catch { return false; }
}

export interface RenderStatus {
  current: boolean;
  reason: string | null;
  render: { evidenceSha256: string; outputSha256: string; bytes: number; name: string; path: string; receiptSha256: string; renderer: unknown; template: unknown; at: string } | null;
}
/** Read-only. A rebuild with a new evidence hash makes the last render stale without deleting it. */
export function showPaperRender(dirArg: string, doc: PaperDocument = "manuscript"): RenderStatus {
  paperDocument(doc);
  const { dir } = openStudy(dirArg), last = readLedger(dir).findLast(event => paperEventFor(event, "paper.rendered", doc));
  if (!last) return { current: false, reason: "no render recorded; run ares paper render record after rendering the current build", render: null };
  const data = last.data, name = typeof data.name === "string" && NAME.test(data.name) ? data.name : undefined;
  if (!name || typeof data.evidenceSha256 !== "string" || typeof data.outputSha256 !== "string" || typeof data.receiptSha256 !== "string") return { current: false, reason: "the last paper.rendered event is malformed; record the render again", render: null };
  const render = { evidenceSha256: data.evidenceSha256, outputSha256: data.outputSha256, bytes: typeof data.bytes === "number" ? data.bytes : 0, name, path: `paper/build/${renderFolder(doc)}/${name}`, receiptSha256: data.receiptSha256, renderer: data.renderer ?? null, template: data.template ?? null, at: last.at };
  let build: ReturnType<typeof readCurrentBuild>;
  try { build = readCurrentBuild(dir, doc); }
  catch { return { current: false, reason: `no current paper build; run ares paper build${doc === "slides" ? " --doc slides" : ""}, render it and record the render`, render }; }
  if (build.evidenceSha256 !== data.evidenceSha256 || build.manuscriptSha256 !== data.manuscriptSha256) return { current: false, reason: "the recorded render belongs to an earlier build; render the current build and record it", render };
  if (!stillStored(dir, name, data.outputSha256, data.receiptSha256, doc)) return { current: false, reason: "the stored render or receipt changed or is missing; record the render again", render };
  return { current: true, reason: null, render };
}
/** Never throws: summaries for review show and archive preview. */
export function renderSummary(dir: string): { current: boolean; reason: string | null } {
  try { const status = showPaperRender(dir); return { current: status.current, reason: status.reason }; }
  catch (error) { return { current: false, reason: error instanceof Error ? error.message : "render status unavailable" }; }
}
