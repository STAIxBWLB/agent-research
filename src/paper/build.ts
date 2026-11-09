import { requireCopilotAccept } from "../copilot.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, commit, openStudy, plain, readLedger, readTextBounded, sha256, type Actor } from "../study.ts";
import { checkPaper, manuscriptPath } from "./check.ts";
import { MANUSCRIPT_BYTES } from "./placeholders.ts";
import { readPaperPlanSnapshot } from "./plan.ts";

export const PAPER_EVIDENCE_BYTES = 8 * 1024 * 1024;
interface EvidenceBody {
  manuscriptSha256: string;
  placeholders: {
    kind: "number" | "literal"; raw: string; start: number; end: number; line: number; column: number;
    ref?: string; format?: number; value: string | number; rendered: string;
    source: { file: string; sha256: string };
  }[];
}
export type PaperEvidence = EvidenceBody & ({ v: 1 } | { v: 2; planSha256: string });
/** Legacy evidence stays readable; plan-bound evidence requires a reader that understands its binding. */
export function paperEvidenceVersion(raw: unknown): 1 | 2 {
  if (!plain(raw) || (raw.v !== 1 && raw.v !== 2)) throw new Error("paper evidence: unsupported version; use an ares version that supports it, keeping paper/build/evidence.json unchanged");
  if (raw.v === 2 && (Object.keys(raw).some(key => !["v", "manuscriptSha256", "placeholders", "planSha256"].includes(key)) || typeof raw.planSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.planSha256))) throw new Error("paper evidence: invalid v2 plan binding or unknown field; restore the last valid paper/build/evidence.json, then run ares paper check and paper build");
  return raw.v;
}
export function paperBuildPaths(dir: string) { return { manuscript: join(dir, "paper", "build", "manuscript.md"), evidence: join(dir, "paper", "build", "evidence.json") }; }
function previous(file: string, bound: number): string | undefined {
  if (!existsSync(file)) return undefined;
  try { return readTextBounded(file, bound); }
  catch { throw new Error(`paper build: previous output is unreadable, non-regular, invalid UTF-8 or oversized; restore the last valid ${file.endsWith("evidence.json") ? "paper/build/evidence.json" : "paper/build/manuscript.md"} before rebuilding`); }
}
function evidenceBytes(dir: string): string | undefined {
  const oldEvidence = previous(paperBuildPaths(dir).evidence, PAPER_EVIDENCE_BYTES);
  if (oldEvidence !== undefined) {
    let raw: unknown;
    try { raw = JSON.parse(oldEvidence); } catch { throw new Error("paper evidence: invalid JSON; restore the last valid paper/build/evidence.json before rebuilding"); }
    paperEvidenceVersion(raw);
  }
  return oldEvidence;
}
function calculatePaper(dir: string) {
  const report = checkPaper(dir);
  if (!report.ok) {
    const blocking = report.findings.filter(f => f.severity === "blocking");
    const reasons = blocking.slice(0, 10).map(f => `${f.code} at ${f.line}:${f.column}`).join(", ");
    throw new Error(`paper build: paper check found ${blocking.length} blocking finding(s): ${reasons}; run ares paper check <dir> --json and fix every finding before rebuilding`);
  }
  const evidence: PaperEvidence = { ...(report.planSha256 === undefined ? { v: 1 as const } : { v: 2 as const, planSha256: report.planSha256 }), manuscriptSha256: report.manuscriptSha256, placeholders: report.placeholders.map(entry => {
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
  return { report, evidence, text, manuscriptSha256: sha256(report.rendered), evidenceSha256: sha256(text) };
}
/** Caller holds the study lock. Refusals precede the single output-and-receipt commit. */
export function buildPaper(dirArg: string, actor: Actor) {
  const { dir } = openStudy(dirArg);
  requireCopilotAccept(dir, "hypotheses");
  const paths = paperBuildPaths(dir), oldEvidence = evidenceBytes(dir);
  const { report, text, manuscriptSha256, evidenceSha256 } = calculatePaper(dir), oldManuscript = previous(paths.manuscript, MANUSCRIPT_BYTES);
  const receipt = readLedger(dir).findLast(event => event.type === "paper.built");
  const changed = oldManuscript !== report.rendered || oldEvidence !== text || receipt?.data.manuscriptSha256 !== manuscriptSha256 || receipt.data.evidenceSha256 !== evidenceSha256;
  if (sha256(readTextBounded(manuscriptPath(dir), MANUSCRIPT_BYTES)) !== report.manuscriptSha256) throw new Error("paper build: source manuscript changed during checking; rerun ares paper check and paper build on the current manuscript");
  if (readPaperPlanSnapshot(dir)?.sha256 !== report.planSha256) throw new Error("paper build: source plan was added, removed or changed during checking; rerun ares paper check and paper build on the current paper/plan.json");
  if (changed) commit(dir, [[paths.manuscript, report.rendered, MANUSCRIPT_BYTES], [paths.evidence, text, PAPER_EVIDENCE_BYTES]], [{ actor, type: "paper.built", data: { manuscriptSha256, evidenceSha256, sourceManuscriptSha256: report.manuscriptSha256, ...(report.planSha256 === undefined ? {} : {planSha256: report.planSha256}) } }]);
  return { manuscriptSha256, evidenceSha256, changed };
}


/** The exact fresh build and both output receipts must agree; never repairs or writes files. */
export function readCurrentBuild(dirArg: string) {
  const { dir } = openStudy(dirArg), paths = paperBuildPaths(dir), evidence = evidenceBytes(dir), manuscript = previous(paths.manuscript, MANUSCRIPT_BYTES);
  if (evidence === undefined || manuscript === undefined) throw new Error("paper build: missing output; run ares paper build before reviewing");
  const fresh = calculatePaper(dir), receipt = readLedger(dir).findLast(event => event.type === "paper.built");
  if (evidence !== fresh.text || manuscript !== fresh.report.rendered || receipt?.data.manuscriptSha256 !== fresh.manuscriptSha256 || receipt.data.evidenceSha256 !== fresh.evidenceSha256 || receipt.data.sourceManuscriptSha256 !== fresh.report.manuscriptSha256) throw new Error("paper build: stale outputs or missing/mismatched receipt; run ares paper check and ares paper build before reviewing");
  return { manuscriptSha256: fresh.manuscriptSha256, evidenceSha256: fresh.evidenceSha256, check: fresh.report };
}
