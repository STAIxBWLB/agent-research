import { HttpError, type Http } from "../http.ts";
import { normTitle, verifySubject, type Candidate, type Registry, type Verification } from "./candidates.ts";
import { parseArxiv } from "./sources.ts";

export const DOI = /^10\.\d{4,9}\/\S+$/;
export const ARXIV_NEW = /^\d{4}\.\d{4,5}$/;
export const ARXIV_OLD = /^[a-z][a-z-]*(\.[a-z]{2})?\/\d{7}$/i;
const ARXIV_BATCH = 50;

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

export function syntax(c: Pick<Candidate, "doi" | "arxivId">): Verification["syntax"] {
  if (c.doi) return DOI.test(c.doi) ? "ok" : "bad";
  if (c.arxivId) return ARXIV_NEW.test(c.arxivId) || ARXIV_OLD.test(c.arxivId) ? "ok" : "bad";
  return "none";
}

function tokens(title: string): Set<string> { return new Set(normTitle(title).split(" ").filter(Boolean)); }
export function titleSimilarity(a: string, b: string): number {
  const x = tokens(a), y = tokens(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common++;
  return common / (x.size + y.size - common);
}

/** yes: title Jaccard >= 0.85 and both years present and within one; partial: the title is close but the year differs or cannot be compared. */
export function matchRegistry(c: Pick<Candidate, "title" | "year">, r: Registry): Verification["match"] {
  const similarity = titleSimilarity(c.title, r.title);
  const yearOk = c.year !== undefined && r.year !== undefined && Math.abs(c.year - r.year) <= 1;
  if (similarity >= 0.85 && yearOk) return "yes";
  if (similarity >= 0.5) return "partial";
  return "no";
}

export function parseCrossref(body: unknown): Registry {
  const m = record(record(body).message);
  const title = Array.isArray(m.title) ? str(m.title[0]) : str(m.title);
  if (!title) throw new Error("crossref: record without title");
  const authors = Array.isArray(m.author) ? m.author.map(a => { const r = record(a), family = str(r.family), given = str(r.given); return family ? (given ? `${family}, ${given}` : family) : str(r.name); }).filter((a): a is string => !!a) : [];
  const dates = [m.issued, m["published-print"], m["published-online"], m.created].map(d => record(d)["date-parts"]);
  let year: number | undefined;
  for (const parts of dates) { const y = Array.isArray(parts) && Array.isArray(parts[0]) ? parts[0][0] : undefined; if (Number.isSafeInteger(y)) { year = y as number; break; } }
  const venue = Array.isArray(m["container-title"]) ? str(m["container-title"][0]) : undefined;
  return { title, authors, ...(year !== undefined ? { year } : {}), ...(venue ? { venue } : {}), ...(str(m.type) ? { type: str(m.type)! } : {}) };
}

export function parseDatacite(body: unknown): Registry {
  const a = record(record(record(body).data).attributes);
  const title = Array.isArray(a.titles) ? str(record(a.titles[0]).title) : undefined;
  if (!title) throw new Error("datacite: record without title");
  const authors = Array.isArray(a.creators) ? a.creators.map(c => { const r = record(c), family = str(r.familyName), given = str(r.givenName); return family ? (given ? `${family}, ${given}` : family) : str(r.name); }).filter((x): x is string => !!x) : [];
  const year = Number.isSafeInteger(a.publicationYear) ? a.publicationYear as number : typeof a.publicationYear === "string" && /^\d{4}$/.test(a.publicationYear) ? Number(a.publicationYear) : undefined;
  const venue = str(a.publisher) ?? str(record(a.publisher).name);
  return { title, authors, ...(year !== undefined ? { year } : {}), ...(venue ? { venue } : {}), type: `datacite:${str(record(a.types).resourceTypeGeneral) ?? "other"}` };
}

const failure = (error: unknown) => (error instanceof HttpError ? error.message : error instanceof Error ? error.message.slice(0, 200) : "failed");
const done = (c: Candidate, v: Omit<Verification, "syntax" | "checkedAt">, now: string): Verification => ({ syntax: "ok", checkedAt: now, ...v, ...(v.registry ? { match: matchRegistry(c, v.registry) } : {}) });

async function verifyDoi(http: Http, c: Candidate, now: string): Promise<Verification> {
  const doi = encodeURIComponent(c.doi!).replace(/%2F/gi, "/");
  try {
    const crossref = await http.json(`https://api.crossref.org/works/${doi}`);
    if (crossref.body !== undefined) return done(c, { exists: "yes", match: "unknown", via: "crossref", registry: parseCrossref(crossref.body) }, now);
    const datacite = await http.json(`https://api.datacite.org/dois/${doi}`);
    if (datacite.body !== undefined) return done(c, { exists: "yes", match: "unknown", via: "datacite", registry: parseDatacite(datacite.body) }, now);
    return { syntax: "ok", exists: "no", match: "unknown", checkedAt: now };
  } catch (error) { return { syntax: "ok", exists: "unknown", match: "unknown", checkedAt: now, error: failure(error) }; }
}

/** One arXiv request per batch of up to 50 ids. A missing id is `no` only when arXiv answered with a valid feed. */
async function verifyArxiv(http: Http, batch: Candidate[], now: string, sleep: (ms: number) => Promise<void>): Promise<Map<string, Verification>> {
  const out = new Map<string, Verification>();
  for (let i = 0; i < batch.length; i += ARXIV_BATCH) {
    if (i) await sleep(3000); // arXiv asks for three seconds between requests
    const slice = batch.slice(i, i + ARXIV_BATCH);
    try {
      const result = await http.text(`https://export.arxiv.org/api/query?id_list=${slice.map(c => encodeURIComponent(c.arxivId!)).join(",")}&max_results=${slice.length}`);
      const feed = result.body === undefined ? undefined : parseArxiv(result.body);
      if (!feed || feed.total === undefined) throw new Error("arxiv: unexpected response");
      for (const c of slice) {
        const entry = feed.entries.find(e => e.arxivId === c.arxivId);
        out.set(c.id, entry
          ? done(c, { exists: "yes", match: "unknown", via: "arxiv", registry: { title: entry.title, authors: entry.authors, ...(entry.year !== undefined ? { year: entry.year } : {}), type: "arxiv" } }, now)
          : { syntax: "ok", exists: "no", match: "unknown", via: "arxiv", checkedAt: now });
      }
    } catch (error) {
      for (const c of slice) out.set(c.id, { syntax: "ok", exists: "unknown", match: "unknown", checkedAt: now, error: failure(error) });
    }
  }
  return out;
}

export async function verifyCandidates(http: Http, list: Candidate[], options: { now?: string; sleep?: (ms: number) => Promise<void> } = {}): Promise<Map<string, Verification>> {
  const now = options.now ?? new Date().toISOString(), sleep = options.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const out = new Map<string, Verification>(), arxiv: Candidate[] = [];
  for (const c of list) {
    const s = syntax(c);
    if (s !== "ok") { out.set(c.id, { syntax: s, exists: "unknown", match: "unknown", checkedAt: now }); continue; }
    if (c.doi) out.set(c.id, await verifyDoi(http, c, now));
    else arxiv.push(c);
  }
  for (const [id, v] of await verifyArxiv(http, arxiv, now, sleep)) out.set(id, v);
  for (const c of list) { const v = out.get(c.id); if (v) v.subject = verifySubject(c); }
  return out;
}
