import { HttpError, type Http } from "../http.ts";
import type { RawCandidate } from "./candidates.ts";

export type SourceName = "openalex" | "s2" | "arxiv";
export const SOURCES: readonly SourceName[] = ["openalex", "s2", "arxiv"];
export interface SearchOptions { limit: number; yearFrom?: number; yearTo?: number }
export interface SourceResult { source: SourceName; ok: boolean; records: RawCandidate[]; error?: string }

const record = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const int = (v: unknown): number | undefined => (Number.isSafeInteger(v) ? v as number : typeof v === "string" && /^\d{4}$/.test(v) ? Number(v) : undefined);

/** OpenAlex returns abstracts as an inverted index: word -> positions. */
export function invertedAbstract(index: unknown): string | undefined {
  const words: string[] = [];
  for (const [word, positions] of Object.entries(record(index))) {
    if (!Array.isArray(positions)) continue;
    for (const p of positions) if (Number.isSafeInteger(p) && p >= 0 && p < 5000) words[p] = word;
  }
  const text = words.filter(Boolean).join(" ");
  return text || undefined;
}

export function parseOpenAlex(body: unknown): RawCandidate[] {
  const results = record(body).results;
  if (!Array.isArray(results)) throw new Error("openalex: unexpected response");
  return results.map(raw => {
    const r = record(raw), ids = record(r.ids), location = record(r.primary_location), source = record(location.source);
    const doi = str(r.doi), title = str(r.title) ?? str(r.display_name) ?? "";
    const authors = Array.isArray(r.authorships) ? r.authorships.map(a => str(record(record(a).author).display_name)).filter((a): a is string => !!a) : [];
    const arxiv = str(ids.arxiv);
    return {
      source: "openalex", title, authors, year: int(r.publication_year), venue: str(source.display_name), doi, arxivId: arxiv,
      url: str(location.landing_page_url) ?? str(r.id), abstract: invertedAbstract(r.abstract_inverted_index),
    };
  });
}

export function parseS2(body: unknown): RawCandidate[] {
  const data = record(body).data;
  if (!Array.isArray(data)) throw new Error("s2: unexpected response");
  return data.map(raw => {
    const r = record(raw), ext = record(r.externalIds);
    return {
      source: "s2", title: str(r.title) ?? "", authors: Array.isArray(r.authors) ? r.authors.map(a => str(record(a).name)).filter((a): a is string => !!a) : [],
      year: int(r.year), venue: str(r.venue), doi: str(ext.DOI), arxivId: str(ext.ArXiv), url: str(r.url), abstract: str(r.abstract),
    };
  });
}

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function xmlText(text: string): string {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === "#") { const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10); return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole; }
    return ENTITY[name.toLowerCase()] ?? whole;
  }).replace(/\s+/g, " ").trim();
}
const tag = (xml: string, name: string) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml); return m ? xmlText(m[1]!) : undefined; };

export interface ArxivEntry extends RawCandidate { arxivId: string }
/**
 * Parse an arXiv Atom feed. `complete` means the feed closed and every entry closed; `errors` counts the error
 * entries arXiv reports under /api/errors. Absence may be concluded only from a complete, error-free feed.
 */
export function parseArxiv(xml: string): { total: number | undefined; entries: ArxivEntry[]; errors: number; complete: boolean } {
  if (!/<feed[\s>]/.test(xml)) throw new Error("arxiv: unexpected response");
  const totalText = /<opensearch:totalResults[^>]*>(\d+)</.exec(xml)?.[1];
  const entries: ArxivEntry[] = [];
  let errors = 0;
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = m[1]!, idUrl = tag(body, "id") ?? "";
    const id = /arxiv\.org\/abs\/(.+?)(v\d+)?$/.exec(idUrl)?.[1];
    if (!id) { errors++; continue; }
    const authors = [...body.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map(a => xmlText(a[1]!));
    entries.push({
      source: "arxiv", arxivId: id, title: tag(body, "title") ?? "", authors, year: int(tag(body, "published")?.slice(0, 4)),
      venue: tag(body, "arxiv:journal_ref"), doi: tag(body, "arxiv:doi"), url: `https://arxiv.org/abs/${id}`, abstract: tag(body, "summary"),
    });
  }
  const opened = xml.match(/<entry>/g)?.length ?? 0, closed = xml.match(/<\/entry>/g)?.length ?? 0;
  const complete = /<\/feed>\s*$/.test(xml) && opened === closed;
  return { total: totalText === undefined ? undefined : Number(totalText), entries, errors, complete };
}

function terms(query: string): string[] { return query.split(/\s+/).map(t => t.replace(/[^\p{L}\p{N}-]/gu, "")).filter(Boolean).slice(0, 20); }

export function sourceUrl(source: SourceName, query: string, options: SearchOptions, env: NodeJS.ProcessEnv): string {
  const q = encodeURIComponent(query);
  if (source === "openalex") {
    const filters = [options.yearFrom ? `from_publication_date:${options.yearFrom}-01-01` : "", options.yearTo ? `to_publication_date:${options.yearTo}-12-31` : ""].filter(Boolean);
    const key = env.OPENALEX_API_KEY?.trim();
    return `https://api.openalex.org/works?search=${q}&per-page=${options.limit}${filters.length ? `&filter=${filters.join(",")}` : ""}${key ? `&api_key=${encodeURIComponent(key)}` : ""}`;
  }
  if (source === "s2") {
    const years = options.yearFrom || options.yearTo ? `&year=${options.yearFrom ?? ""}-${options.yearTo ?? ""}` : "";
    return `https://api.semanticscholar.org/graph/v1/paper/search?query=${q}&limit=${options.limit}&fields=title,year,authors,venue,externalIds,abstract,url${years}`;
  }
  const parts = terms(query).map(t => `all:${t}`);
  if (options.yearFrom || options.yearTo) parts.push(`submittedDate:[${options.yearFrom ?? 1991}01010000 TO ${options.yearTo ?? 2100}12312359]`);
  return `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(parts.join(" AND "))}&max_results=${options.limit}`;
}

/** Search one source. Failures are reported per source and never abort the others. */
export async function searchSource(http: Http, source: SourceName, query: string, options: SearchOptions): Promise<SourceResult> {
  const url = sourceUrl(source, query, options, http.env);
  try {
    if (source === "arxiv") {
      const result = await http.text(url);
      const feed = result.body === undefined ? undefined : parseArxiv(result.body);
      if (feed?.errors) throw new Error("arxiv: query error");
      if (feed && !feed.complete) throw new Error("arxiv: incomplete response");
      return { source, ok: true, records: feed?.entries ?? [] };
    }
    const key = http.env.S2_API_KEY?.trim();
    const result = await http.json(url, source === "s2" && key ? { "x-api-key": key } : {});
    if (result.body === undefined) return { source, ok: true, records: [] };
    return { source, ok: true, records: source === "openalex" ? parseOpenAlex(result.body) : parseS2(result.body) };
  } catch (error) {
    const message = error instanceof HttpError ? error.message : error instanceof Error ? error.message.slice(0, 200) : "failed";
    return { source, ok: false, records: [], error: message };
  }
}
