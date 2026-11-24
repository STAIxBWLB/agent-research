import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { plain, readBytesBounded, readLedger, sha256 } from "../study.ts";
import { retentionDisposalIndex } from "../provenance.ts";
import { resolvePointEvidence } from "./point-evidence.ts";
import { canonical } from "../plan/state.ts";

export const PAPER_FIGURES = 100, PAPER_FIGURE_BYTES = 16 * 1024 * 1024;
export const PAPER_FIGURE_PATH_BYTES = 4096, PAPER_FIGURE_WAIVER_BYTES = 500;
export interface PaperFigure { id: string; file: string; kind: "plot" | "diagram"; evidence?: string[]; waiver?: string }
const PROVENANCE = ["artifact", "referenced", "waived", "diagram"] as const;
export type FigureProvenance = typeof PROVENANCE[number];
export interface FigureEvidence { id: string; file: string; sha256: string; bytes: number; provenance: FigureProvenance }
export type FigureFindingCode = "undeclared-figure" | "missing-figure" | "unresolved-figure-evidence";
export interface ImageLink { target: string; start: number; end: number }
interface FigureFinding { code: FigureFindingCode; severity: "blocking"; start: number; end: number; figureId?: string; message: string }
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HASH = /^[a-f0-9]{64}$/;
const repair = "correct the figure declaration, then rerun ares paper plan set <dir> --file PATH";
function invalid(reason: string): never { throw new Error(`paper plan figures: ${reason}; ${repair}`); }

function figureFile(raw: unknown): raw is string {
  return typeof raw === "string" && raw.startsWith("paper/") && raw.trim() === raw
    && Buffer.byteLength(raw) <= PAPER_FIGURE_PATH_BYTES && !/[\\:\p{Cc}\p{Zl}\p{Zp}?#]/u.test(raw)
    && raw.split("/").every(part => part !== "" && part !== "." && part !== "..");
}
function figureId(raw: unknown): raw is string { return typeof raw === "string" && raw.length <= 64 && ID.test(raw); }

export function validateFigures(raw: unknown, pointReference: (raw: unknown) => string): PaperFigure[] {
  if (!Array.isArray(raw) || raw.length > PAPER_FIGURES) invalid("figures must be an array of at most 100 entries");
  const ids = new Set<string>(), files = new Set<string>();
  return raw.map((value): PaperFigure => {
    if (!plain(value) || Object.keys(value).some(key => !["id", "file", "kind", "evidence", "waiver"].includes(key))) invalid("each figure must be a closed object");
    const { id, file, kind, evidence, waiver } = value;
    if (!figureId(id) || ids.has(id)) invalid("figure id must be a unique lowercase alphanumeric hyphenated slug of 1..64 characters");
    if (!figureFile(file) || files.has(file)) invalid(`figure ${id} needs a unique relative file under paper/ without traversal`);
    if (kind !== "plot" && kind !== "diagram") invalid(`figure ${id} kind must be plot or diagram`);
    ids.add(id); files.add(file);
    const base: PaperFigure = { id, file, kind };
    if (kind === "diagram") {
      if (evidence !== undefined || waiver !== undefined) invalid(`diagram ${id} takes neither evidence nor waiver`);
      return base;
    }
    if ((evidence === undefined) === (waiver === undefined)) invalid(`plot ${id} needs exactly one of evidence and waiver`);
    if (evidence !== undefined) {
      if (!Array.isArray(evidence) || !evidence.length || evidence.length > 64) invalid(`plot ${id} needs 1..64 evidence references`);
      const refs = evidence.map(pointReference);
      if (new Set(refs).size !== refs.length) invalid(`plot ${id} has duplicate evidence references`);
      return { ...base, evidence: refs };
    }
    if (typeof waiver !== "string" || !waiver.trim() || waiver.includes("\0") || Buffer.byteLength(waiver) > PAPER_FIGURE_WAIVER_BYTES) {
      invalid(`plot ${id} waiver must be nonempty written text of at most 500 UTF-8 bytes without NUL`);
    }
    return { ...base, waiver };
  });
}

export function validFigureEvidence(raw: unknown): raw is FigureEvidence[] {
  if (!Array.isArray(raw) || raw.length > PAPER_FIGURES) return false;
  const ids = new Set<string>(), files = new Set<string>();
  return raw.every(row => {
    if (!plain(row) || Object.keys(row).some(key => !["id", "file", "sha256", "bytes", "provenance"].includes(key))
      || !figureId(row.id) || ids.has(row.id) || !figureFile(row.file) || files.has(row.file)
      || typeof row.sha256 !== "string" || !HASH.test(row.sha256)
      || typeof row.bytes !== "number" || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || row.bytes > PAPER_FIGURE_BYTES
      || !PROVENANCE.includes(row.provenance as FigureProvenance)) return false;
    ids.add(row.id); files.add(row.file);
    return true;
  });
}

function physicalFigure(dir: string, file: string) {
  if (!figureFile(file)) throw new Error("figure path outside paper/");
  const parts = file.split("/"), root = realpathSync(dir);
  let path = root;
  for (const [index, part] of parts.entries()) {
    path = join(path, part);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink() || (index === parts.length - 1 ? !metadata.isFile() : !metadata.isDirectory())) throw new Error("figure is not a regular physical file");
  }
  if (realpathSync(path) !== path) throw new Error("figure escapes the physical paper directory");
  const bytes = readBytesBounded(path, PAPER_FIGURE_BYTES, { noFollow: true });
  if (realpathSync(path) !== path) throw new Error("figure path changed during read");
  return { sha256: sha256(bytes), bytes: bytes.length };
}

export function figuresStillMatch(dir: string, figures: readonly FigureEvidence[]): boolean {
  try {
    return figures.every(figure => {
      const current = physicalFigure(dir, figure.file);
      return current.sha256 === figure.sha256 && current.bytes === figure.bytes;
    });
  } catch { return false; }
}

function linkFile(raw: string): string | undefined {
  let target = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  try { target = decodeURIComponent(target.replace(/\\([\\()[\] <>])/g, "$1")).replace(/^\.\//, ""); } catch { return undefined; }
  if (target.startsWith("/") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return undefined;
  const candidate = target.startsWith("paper/") ? target : `paper/${target}`;
  return figureFile(candidate) ? candidate : undefined;
}

export function inspectFigures(dir: string, figures: readonly PaperFigure[], links?: readonly ImageLink[]) {
  const findings: FigureFinding[] = [], evidence: FigureEvidence[] = [];
  const hit = (code: FigureFindingCode, message: string, link?: ImageLink, figureId?: string) =>
    findings.push({ code, severity: "blocking", start: link?.start ?? 0, end: link?.end ?? 0, ...(figureId === undefined ? {} : { figureId }), message });
  const declared = new Map(figures.map(figure => [figure.file, figure]));
  const used = new Map<string, ImageLink>();
  for (const link of links ?? []) {
    const file = linkFile(link.target);
    if (!file || !declared.has(file)) {
      hit("undeclared-figure", "image link has no declared figure id; declare its local paper/ file with ares paper plan set or remove the link", link);
    } else if (!used.has(file)) used.set(file, link);
  }
  const resolutions = new Map<string, ReturnType<typeof resolvePointEvidence>>();
  const disposals = figures.some(figure => figure.evidence?.some(ref => ref.startsWith("attempt:"))) ? retentionDisposalIndex(readLedger(dir)) : undefined;
  for (const figure of figures) {
    const link = used.get(figure.file);
    if (links !== undefined && !link) hit("missing-figure", `figure ${figure.id}: manuscript has no image link; link ${figure.file} or remove the declaration`, undefined, figure.id);
    let bytes: ReturnType<typeof physicalFigure> | undefined;
    try { bytes = physicalFigure(dir, figure.file); }
    catch {
      hit("missing-figure", `figure ${figure.id}: file is absent, linked, unreadable, special or larger than 16 MiB; restore a regular file under paper/ and rerun ares paper check`, link, figure.id);
    }
    let provenance: FigureProvenance = figure.kind === "diagram" ? "diagram" : figure.waiver !== undefined ? "waived" : "referenced";
    let resolvedAll = true;
    for (const ref of figure.evidence ?? []) {
      let resolved = resolutions.get(ref);
      if (!resolved) {
        resolved = resolvePointEvidence(dir, ref, true);
        resolutions.set(ref, resolved);
      }
      if (!resolved.resolved) {
        resolvedAll = false;
        hit("unresolved-figure-evidence", `figure ${figure.id}: evidence does not resolve; restore the referenced card or attempt record, or update the plan`, link, figure.id);
        continue;
      }
      const artifacts = resolved.artifacts ?? [];
      if (bytes && artifacts.some(artifact => artifact.sha256 === bytes?.sha256 && artifact.bytes === bytes?.bytes && (!artifact.retained || !disposals?.has(canonical([artifact.retained.attemptId, artifact.retained.stage, artifact.retained.sha256]))))) provenance = "artifact";
    }
    if (bytes && resolvedAll) evidence.push({ id: figure.id, file: figure.file, ...bytes, provenance });
  }
  return { findings, evidence };
}

export function figureCoverage(dir: string, figures: readonly PaperFigure[]) {
  const { evidence } = inspectFigures(dir, figures);
  const coverage = { artifact: 0, referenced: 0, waived: 0, diagram: 0, total: figures.length };
  for (const entry of evidence) coverage[entry.provenance]++;
  return coverage;
}
