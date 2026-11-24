import { paperDocument, paperEventFor, paperSourcePath, type PaperDocument } from "./document.ts";
import { figuresStillMatch, validFigureEvidence, type FigureEvidence } from "./figures.ts";
import { requireCopilotAccept } from "../copilot.ts";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { assertWritable, commit, openStudy, plain, readLedger, readTextBounded, sha256, type Actor } from "../study.ts";
import { checkPaper } from "./check.ts";
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
export type PaperEvidence = EvidenceBody & ({ v: 1 } | { v: 2; planSha256: string } | { v: 3; planSha256: string; figures: FigureEvidence[] });
/** Legacy evidence stays readable; plan-bound evidence requires a reader that understands its binding. */
export function paperEvidenceVersion(raw: unknown): 1 | 2 | 3 {
  if (!plain(raw) || (raw.v !== 1 && raw.v !== 2 && raw.v !== 3)) throw new Error("paper evidence: unsupported version; use an ares version that supports it, keeping paper/build/evidence.json unchanged");
  if (raw.v === 2 && (Object.keys(raw).some(key => !["v", "manuscriptSha256", "placeholders", "planSha256"].includes(key)) || typeof raw.planSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.planSha256))) throw new Error("paper evidence: invalid v2 plan binding or unknown field; restore the last valid paper/build/evidence.json, then run ares paper check and paper build");
  if (raw.v === 3 && (Object.keys(raw).some(key => !["v", "manuscriptSha256", "placeholders", "planSha256", "figures"].includes(key))
    || typeof raw.planSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.planSha256) || !validFigureEvidence(raw.figures))) {
    throw new Error("paper evidence: invalid v3 plan binding or figure evidence; restore paper/build/evidence.json, then run ares paper check and paper build");
  }
  return raw.v;
}
export function paperBuildPaths(dir: string, doc: PaperDocument = "manuscript") {
  return { manuscript: join(dir, "paper", "build", `${doc}.md`), evidence: join(dir, "paper", "build", doc === "slides" ? "slides.evidence.json" : "evidence.json") };
}
function previous(file: string, bound: number): string | undefined {
  if (!existsSync(file)) return undefined;
  try { return readTextBounded(file, bound); }
  catch { throw new Error(`paper build: previous output is unreadable, non-regular, invalid UTF-8 or oversized; restore the last valid paper/build/${basename(file)} before rebuilding`); }
}
function evidenceBytes(dir: string, doc: PaperDocument): string | undefined {
  const oldEvidence = previous(paperBuildPaths(dir, doc).evidence, PAPER_EVIDENCE_BYTES);
  if (oldEvidence !== undefined) {
    let raw: unknown;
    try { raw = JSON.parse(oldEvidence); } catch { throw new Error(`paper evidence: invalid JSON; restore the last valid paper/build/${doc === "slides" ? "slides.evidence.json" : "evidence.json"} before rebuilding`); }
    paperEvidenceVersion(raw);
  }
  return oldEvidence;
}
function calculatePaper(dir: string, doc: PaperDocument) {
  const report = checkPaper(dir, doc);
  if (!report.ok) {
    const blocking = report.findings.filter(f => f.severity === "blocking");
    const reasons = blocking.slice(0, 10).map(f => `${f.code} at ${f.line}:${f.column}`).join(", ");
    throw new Error(`paper build: paper check found ${blocking.length} blocking finding(s): ${reasons}; run ares paper check <dir>${doc === "slides" ? " --doc slides" : ""} --json and fix every finding before rebuilding`);
  }
  const version = report.planSha256 === undefined ? { v: 1 as const }
    : report.figures === undefined ? { v: 2 as const, planSha256: report.planSha256 }
      : { v: 3 as const, planSha256: report.planSha256, figures: report.figures };
  const evidence: PaperEvidence = { ...version, manuscriptSha256: report.manuscriptSha256, placeholders: report.placeholders.map(entry => {
    const token = entry.placeholder;
    return { kind: token.kind, raw: token.raw, start: token.start, end: token.end, line: token.line, column: token.column,
      ...(token.kind === "number" ? { ref: token.ref, ...(token.format === undefined ? {} : { format: token.format }) } : {}),
      value: entry.value, rendered: entry.rendered,
      source: entry.source ?? { file: `paper/${doc}.md`, sha256: report.manuscriptSha256 },
    };
  }) };
  const text = JSON.stringify(evidence, null, 2) + "\n";
  assertWritable(report.rendered, MANUSCRIPT_BYTES, "rendered manuscript; shorten paper/manuscript.md before rebuilding");
  assertWritable(text, PAPER_EVIDENCE_BYTES, "paper evidence; reduce paper/manuscript.md or its placeholders before rebuilding");
  return { report, evidence, text, manuscriptSha256: sha256(report.rendered), evidenceSha256: sha256(text) };
}
/** Caller holds the study lock. Refusals precede the single output-and-receipt commit. */
export function buildPaper(dirArg: string, actor: Actor, doc: PaperDocument = "manuscript") {
  paperDocument(doc);
  const { dir } = openStudy(dirArg);
  requireCopilotAccept(dir, "hypotheses");
  const paths = paperBuildPaths(dir, doc), oldEvidence = evidenceBytes(dir, doc);
  const { report, text, manuscriptSha256, evidenceSha256 } = calculatePaper(dir, doc), oldManuscript = previous(paths.manuscript, MANUSCRIPT_BYTES);
  const receipt = readLedger(dir).findLast(event => paperEventFor(event, "paper.built", doc));
  const changed = oldManuscript !== report.rendered || oldEvidence !== text || receipt?.data.manuscriptSha256 !== manuscriptSha256 || receipt.data.evidenceSha256 !== evidenceSha256;
  if (sha256(readTextBounded(paperSourcePath(dir, doc), MANUSCRIPT_BYTES)) !== report.manuscriptSha256) throw new Error("paper build: source manuscript changed during checking; rerun ares paper check and paper build on the current manuscript");
  if (doc === "manuscript" && readPaperPlanSnapshot(dir)?.sha256 !== report.planSha256) throw new Error("paper build: source plan was added, removed or changed during checking; rerun ares paper check and paper build on the current paper/plan.json");
  if (report.figures && !figuresStillMatch(dir, report.figures)) throw new Error("paper build: figure bytes or paths changed during checking; restore the figures and rerun ares paper check and paper build");
  if (changed) commit(dir, [[paths.manuscript, report.rendered, MANUSCRIPT_BYTES], [paths.evidence, text, PAPER_EVIDENCE_BYTES]], [{ actor, type: "paper.built", data: { ...(doc === "slides" ? { doc } : {}), manuscriptSha256, evidenceSha256, sourceManuscriptSha256: report.manuscriptSha256, ...(report.planSha256 === undefined ? {} : {planSha256: report.planSha256}) } }]);
  return { manuscriptSha256, evidenceSha256, changed };
}


/** The exact fresh build and both output receipts must agree; never repairs or writes files. */
export function readCurrentBuild(dirArg: string, doc: PaperDocument = "manuscript") {
  paperDocument(doc);
  const { dir } = openStudy(dirArg), paths = paperBuildPaths(dir, doc), evidence = evidenceBytes(dir, doc), manuscript = previous(paths.manuscript, MANUSCRIPT_BYTES);
  if (evidence === undefined || manuscript === undefined) throw new Error("paper build: missing output; run ares paper build before reviewing");
  const fresh = calculatePaper(dir, doc), receipt = readLedger(dir).findLast(event => paperEventFor(event, "paper.built", doc));
  if (evidence !== fresh.text || manuscript !== fresh.report.rendered || receipt?.data.manuscriptSha256 !== fresh.manuscriptSha256 || receipt.data.evidenceSha256 !== fresh.evidenceSha256 || receipt.data.sourceManuscriptSha256 !== fresh.report.manuscriptSha256) throw new Error("paper build: stale outputs or missing/mismatched receipt; run ares paper check and ares paper build before reviewing");
  return { manuscriptSha256: fresh.manuscriptSha256, evidenceSha256: fresh.evidenceSha256, check: fresh.report };
}
