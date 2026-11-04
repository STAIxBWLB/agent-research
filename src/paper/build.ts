import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, commit, openStudy, plain, readLedger, readTextBounded, sha256, type Actor } from "../study.ts";
import { checkPaper, manuscriptPath } from "./check.ts";
import { MANUSCRIPT_BYTES } from "./placeholders.ts";

export const PAPER_EVIDENCE_BYTES = 8 * 1024 * 1024;
export interface PaperEvidence {
  v: 1;
  manuscriptSha256: string;
  placeholders: {
    kind: "number" | "literal"; raw: string; start: number; end: number; line: number; column: number;
    ref?: string; format?: number; value: string | number; rendered: string;
    source: { file: string; sha256: string };
  }[];
}
export function paperBuildPaths(dir: string) { return { manuscript: join(dir, "paper", "build", "manuscript.md"), evidence: join(dir, "paper", "build", "evidence.json") }; }
function previous(file: string, bound: number): string | undefined {
  if (!existsSync(file)) return undefined;
  try { return readTextBounded(file, bound); }
  catch { throw new Error(`paper build: previous output is unreadable, non-regular, invalid UTF-8 or oversized; restore the last valid ${file.endsWith("evidence.json") ? "paper/build/evidence.json" : "paper/build/manuscript.md"} before rebuilding`); }
}
/** Caller holds the study lock. Refusals precede the single output-and-receipt commit. */
export function buildPaper(dirArg: string, actor: Actor) {
  const { dir } = openStudy(dirArg), paths = paperBuildPaths(dir);
  const oldEvidence = previous(paths.evidence, PAPER_EVIDENCE_BYTES);
  if (oldEvidence !== undefined) {
    let raw: unknown;
    try { raw = JSON.parse(oldEvidence); } catch { throw new Error("paper evidence: invalid JSON; restore the last valid paper/build/evidence.json before rebuilding"); }
    if (!plain(raw) || raw.v !== 1) throw new Error("paper evidence: unsupported version; use an ares version that supports it, keeping paper/build/evidence.json unchanged");
  }
  const report = checkPaper(dir);
  if (!report.ok) {
    const reasons = report.findings.slice(0, 10).map(f => `${f.code} at ${f.line}:${f.column}`).join(", ");
    throw new Error(`paper build: paper check found ${report.findings.length} finding(s): ${reasons}; run ares paper check <dir> --json and fix every finding before rebuilding`);
  }
  const evidence: PaperEvidence = { v: 1, manuscriptSha256: report.manuscriptSha256, placeholders: report.placeholders.map(entry => {
    const token = entry.placeholder;
    return { kind: token.kind, raw: token.raw, start: token.start, end: token.end, line: token.line, column: token.column,
      ...(token.kind === "number" ? { ref: token.ref, ...(token.format === undefined ? {} : { format: token.format }) } : {}),
      value: entry.value, rendered: entry.rendered,
      source: entry.source ?? { file: "paper/manuscript.md", sha256: report.manuscriptSha256 },
    };
  }) };
  const text = JSON.stringify(evidence, null, 2) + "\n";
  assertWritable(report.rendered, MANUSCRIPT_BYTES, "rendered manuscript; shorten paper/manuscript.md before rebuilding");
  assertWritable(text, PAPER_EVIDENCE_BYTES, "paper evidence; reduce paper/manuscript.md or its placeholders before rebuilding");
  const manuscriptSha256 = sha256(report.rendered), evidenceSha256 = sha256(text), oldManuscript = previous(paths.manuscript, MANUSCRIPT_BYTES);
  const receipt = readLedger(dir).findLast(event => event.type === "paper.built");
  const changed = oldManuscript !== report.rendered || oldEvidence !== text || receipt?.data.manuscriptSha256 !== manuscriptSha256 || receipt.data.evidenceSha256 !== evidenceSha256;
  if (sha256(readTextBounded(manuscriptPath(dir), MANUSCRIPT_BYTES)) !== report.manuscriptSha256) throw new Error("paper build: source manuscript changed during checking; rerun ares paper check and paper build on the current manuscript");
  if (changed) commit(dir, [[paths.manuscript, report.rendered, MANUSCRIPT_BYTES], [paths.evidence, text, PAPER_EVIDENCE_BYTES]], [{ actor, type: "paper.built", data: { manuscriptSha256, evidenceSha256, sourceManuscriptSha256: report.manuscriptSha256 } }]);
  return { manuscriptSha256, evidenceSha256, changed };
}
