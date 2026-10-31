import { existsSync } from "node:fs";
import { join } from "node:path";
import { plain, readJsonFile, sha256, writeAtomic, type Actor } from "../study.ts";

export interface Registry { title: string; authors: string[]; year?: number; venue?: string; type?: string }
export interface Verification {
  syntax: "ok" | "none" | "bad"; exists: "yes" | "no" | "unknown"; match: "yes" | "partial" | "no" | "unknown";
  via?: "crossref" | "datacite" | "arxiv"; checkedAt: string; error?: string; registry?: Registry;
  /** Hash of the identifiers, title and year that were checked; see verifySubject. */
  subject?: string;
}
export interface RawCandidate { title: string; authors: string[]; year?: number; venue?: string; doi?: string; arxivId?: string; url?: string; abstract?: string; source: string }
export interface Candidate extends Omit<RawCandidate, "source"> {
  id: string; sources: string[]; addedAt: string;
  status: "new" | "included" | "excluded"; reason?: string; decidedBy?: Actor; decidedAt?: string;
  citekey?: string; verify?: Verification;
  /** Other candidates that a record linked to this one but could not be absorbed (screened or keyed). */
  duplicates?: string[];
}

const ABSTRACT_MAX = 2000, TITLE_MAX = 1000, AUTHORS_MAX = 100, AUTHOR_MAX = 300, CANDIDATES_BYTES = 64 * 1024 * 1024;
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

export function normTitle(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
export function normDoi(doi: string | undefined): string | undefined {
  if (!doi) return undefined;
  const value = doi.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").replace(/^doi:/i, "").toLowerCase();
  return value || undefined;
}
export function normArxiv(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const value = id.trim().replace(/^https?:\/\/arxiv\.org\/abs\//i, "").replace(/^arxiv:/i, "").replace(/v\d+$/, "");
  return value || undefined;
}

/** Clean one source record: bounded fields, arXiv DOIs mapped to the arXiv id. */
export function cleanRaw(raw: RawCandidate): RawCandidate | undefined {
  const title = raw.title.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);
  if (!title) return undefined;
  let doi = normDoi(raw.doi), arxivId = normArxiv(raw.arxivId);
  const arxivDoi = doi && ARXIV_DOI.exec(doi);
  if (arxivDoi) { arxivId ??= normArxiv(arxivDoi[1]); doi = undefined; }
  return {
    title, authors: raw.authors.map(a => a.replace(/\s+/g, " ").trim().slice(0, AUTHOR_MAX)).filter(Boolean).slice(0, AUTHORS_MAX), source: raw.source,
    ...(raw.year !== undefined && Number.isSafeInteger(raw.year) ? { year: raw.year } : {}),
    ...(raw.venue?.trim() ? { venue: raw.venue.trim().slice(0, 500) } : {}),
    ...(doi ? { doi } : {}), ...(arxivId ? { arxivId } : {}),
    ...(raw.url?.trim() ? { url: raw.url.trim().slice(0, 2000) } : {}),
    ...(raw.abstract?.trim() ? { abstract: raw.abstract.replace(/\s+/g, " ").trim().slice(0, ABSTRACT_MAX) } : {}),
  };
}

export function candidateId(raw: RawCandidate): string {
  if (raw.doi) return `doi:${raw.doi}`;
  if (raw.arxivId) return `arxiv:${raw.arxivId}`;
  return `title:${sha256(`${normTitle(raw.title)}|${raw.year ?? ""}`).slice(0, 12)}`;
}

const titleKey = (c: { title: string; year?: number }) => `${normTitle(c.title)}|${c.year ?? ""}`;

/** Groups of candidates that are the same work by DOI, arXiv id, title plus year, or a recorded duplicate link. */
export function sameWork(list: Candidate[]): string[][] {
  const parent = new Map(list.map(c => [c.id, c.id]));
  const root = (id: string): string => { const p = parent.get(id)!; return p === id ? id : root(p); };
  const join = (a: string, b: string) => { if (parent.has(a) && parent.has(b)) parent.set(root(a), root(b)); };
  const seen = new Map<string, string>();
  for (const c of list) {
    for (const key of [c.doi && `doi:${c.doi}`, c.arxivId && `arxiv:${c.arxivId}`, `title:${titleKey(c)}`]) {
      if (!key) continue;
      const first = seen.get(key);
      if (first) join(first, c.id); else seen.set(key, c.id);
    }
    for (const d of c.duplicates ?? []) join(c.id, d);
  }
  const groups = new Map<string, string[]>();
  for (const c of list) { const r = root(c.id); groups.set(r, [...(groups.get(r) ?? []), c.id]); }
  return [...groups.values()].filter(g => g.length > 1);
}

/**
 * Merge source records into the list. A record joins an existing candidate on DOI, arXiv id or normalized
 * title plus year; the candidate keeps its first id so screening decisions and citekeys stay attached.
 */
function absorb(into: Candidate, from: Omit<RawCandidate, "source"> & { sources?: string[]; source?: string }): void {
  for (const source of from.sources ?? (from.source ? [from.source] : [])) if (!into.sources.includes(source)) into.sources.push(source);
  for (const key of ["doi", "arxivId", "year", "venue", "url", "abstract"] as const) if (into[key] === undefined && from[key] !== undefined) (into as unknown as Record<string, unknown>)[key] = from[key];
  if (!into.authors.length && from.authors.length) into.authors = from.authors;
}
function link(a: Candidate, b: Candidate): void {
  a.duplicates = [...new Set([...(a.duplicates ?? []), b.id])];
  b.duplicates = [...new Set([...(b.duplicates ?? []), a.id])];
}

export function mergeCandidates(list: Candidate[], incoming: RawCandidate[], limit: number, now = new Date().toISOString()): { added: number; merged: number; dropped: number; linked: number } {
  let added = 0, merged = 0, dropped = 0, linked = 0;
  for (const raw of incoming) {
    const clean = cleanRaw(raw);
    if (!clean) { dropped++; continue; }
    const matches = list.filter(c => (clean.doi && c.doi === clean.doi) || (clean.arxivId && c.arxivId === clean.arxivId) || titleKey(c) === titleKey(clean));
    const [primary, ...others] = matches;
    if (primary) {
      // A record that links several candidates folds the unscreened, unkeyed ones into the first; the rest are flagged.
      for (const other of others) {
        if (other.status === "new" && !other.citekey) {
          absorb(primary, other);
          for (const twin of other.duplicates ?? []) { const t = list.find(c => c.id === twin); if (t && t !== primary) { t.duplicates = t.duplicates!.filter(d => d !== other.id); link(primary, t); } }
          list.splice(list.indexOf(other), 1);
        }
        else { link(primary, other); linked++; }
      }
      absorb(primary, clean);
      merged++;
      continue;
    }
    if (list.length >= limit) { dropped++; continue; }
    const { source, ...rest } = clean;
    list.push({ ...rest, id: candidateId(clean), sources: [source], addedAt: now, status: "new" });
    added++;
  }
  return { added, merged, dropped, linked };
}

export function candidatesPath(dir: string): string { return join(dir, "literature", "candidates.json"); }
export function loadCandidates(dir: string): Candidate[] {
  const path = candidatesPath(dir);
  if (!existsSync(path)) return [];
  const raw = readJsonFile(path, CANDIDATES_BYTES);
  if (!Array.isArray(raw) || !raw.every(c => plain(c) && typeof c.id === "string" && typeof c.title === "string" && Array.isArray(c.sources)))
    throw new Error("literature/candidates.json: malformed");
  return raw as Candidate[];
}
export function saveCandidates(dir: string, list: Candidate[]): void {
  writeAtomic(candidatesPath(dir), JSON.stringify(list, null, 1) + "\n", CANDIDATES_BYTES);
}

/** The fields a verification checked. A later merge that adds a DOI, arXiv id or year makes an older verification stale. */
export function verifySubject(c: Pick<Candidate, "doi" | "arxivId" | "title" | "year">): string {
  return sha256(JSON.stringify([c.doi ?? null, c.arxivId ?? null, normTitle(c.title), c.year ?? null]));
}
export function isVerified(c: Candidate): boolean {
  return c.verify?.syntax === "ok" && c.verify.exists === "yes" && c.verify.match === "yes" && c.verify.subject === verifySubject(c);
}
/** The screen gate binds to the included set. */
export function includedHash(list: Candidate[]): string | undefined {
  const ids = list.filter(c => c.status === "included").map(c => c.id).sort();
  return ids.length ? sha256(ids.join("\n")) : undefined;
}
