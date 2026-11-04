import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, boundedText, commit, onlyKeys, openStudy, plain, readLedger, readTextBounded, sha256, type Actor } from "../study.ts";
import { loadCandidates } from "./candidates.ts";
import { SOURCES, type SourceName } from "./sources.ts";

export const WATCH_BYTES = 65_536, WATCH_QUERIES = 20, WATCH_IDS = 500, WATCH_RUN_BYTES = 60 * 1024, WATCH_RECENT = 10;
export interface WatchQuery { id: string; query: string; source?: SourceName | "all"; yearFrom?: number; limit?: number }
export interface WatchConfig { v: 1; queries: WatchQuery[]; rubric?: string }
export interface SearchResult { added: number; merged: number; dropped: number; linked: number; sources: { source: SourceName; ok: boolean; returned: number; error?: string }[] }
export interface WatchError { host: string; status: number | null }
export interface WatchQueryResult { id: string; added: number; merged: number; dropped: number; linked: number; sources: { source: SourceName; ok: boolean; returned: number }[]; errors: WatchError[] }
export interface WatchRun { configSha256: string; queries: WatchQueryResult[]; added: number; addedIds: string[]; addedIdsTotal: number; ok: boolean; rubric?: string }
const HOSTS: Record<SourceName, string> = { openalex: "api.openalex.org", s2: "api.semanticscholar.org", arxiv: "export.arxiv.org" };
class WatchInputError extends Error {}
function bad(message: string): never { throw new WatchInputError(`watch: ${message}; correct the watch input and rerun ares watch set before ares watch run`); }
function query(raw: unknown): WatchQuery {
  if (!plain(raw)) bad("query must be an object");
  onlyKeys(raw, ["id", "query", "source", "yearFrom", "limit"], "watch query");
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.id)) bad("query id must follow the 1..64 run-name rule");
  const text = boundedText(raw.query, "watch query", 500);
  if (raw.source !== undefined && raw.source !== "all" && !SOURCES.includes(raw.source as SourceName)) bad("source must be openalex, s2, arxiv or all");
  if (raw.yearFrom !== undefined && (!Number.isSafeInteger(raw.yearFrom) || (raw.yearFrom as number) < 1000 || (raw.yearFrom as number) > 2100)) bad("yearFrom must be an integer in 1000..2100");
  if (raw.limit !== undefined && (!Number.isSafeInteger(raw.limit) || (raw.limit as number) < 1 || (raw.limit as number) > 50)) bad("limit must be an integer in 1..50");
  return { id: raw.id, query: text, ...(raw.source === undefined ? {} : { source: raw.source as SourceName | "all" }), ...(raw.yearFrom === undefined ? {} : { yearFrom: raw.yearFrom as number }), ...(raw.limit === undefined ? {} : { limit: raw.limit as number }) };
}
export function validateWatch(raw: unknown): WatchConfig {
  try {
    if (!plain(raw)) bad("config must be an object");
    if (raw.v !== 1) throw new WatchInputError("watch config: unsupported version; use an ares version supporting this config and keep literature/watch.json unchanged");
    onlyKeys(raw, ["v", "queries", "rubric"], "watch config");
    if (!Array.isArray(raw.queries) || raw.queries.length < 1 || raw.queries.length > WATCH_QUERIES) bad("queries must contain 1..20 entries");
    const queries = raw.queries.map(query);
    if (new Set(queries.map(row => row.id)).size !== queries.length) bad("query ids must be unique");
    const rubric = raw.rubric === undefined ? undefined : boundedText(raw.rubric, "watch rubric", 8000);
    if (rubric !== undefined && Buffer.byteLength(rubric) > 8000) bad("rubric exceeds 8000 bytes");
    const result: WatchConfig = { v: 1, queries, ...(rubric === undefined ? {} : { rubric }) };
    assertWritable(JSON.stringify(result, null, 2) + "\n", WATCH_BYTES, "watch config"); return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid input";
    if (error instanceof WatchInputError) throw error;
    bad(message);
  }
}
export const watchPath = (dir: string) => join(dir, "literature", "watch.json");
function stored(dir: string): { config: WatchConfig; text: string } | undefined {
  const file = watchPath(dir); if (!existsSync(file)) return undefined;
  let text: string; try { text = readTextBounded(file, WATCH_BYTES); } catch { bad("watch file is unreadable, non-regular or over 65536 bytes; restore its bounded regular file"); }
  let raw: unknown; try { raw = JSON.parse(text); } catch { bad("watch file is not valid JSON"); }
  return { config: validateWatch(raw), text };
}
export function readWatch(dir: string): WatchConfig | undefined { return stored(dir)?.config; }
/** Caller holds study lock; identical bytes never add a second event. */
export function setWatch(dir: string, raw: unknown, actor: Actor) {
  const config = validateWatch(raw), before = stored(dir), text = JSON.stringify(config, null, 2) + "\n";
  if (before?.text === text) return { config, changed: false };
  commit(dir, [[watchPath(dir), text, WATCH_BYTES]], [{ actor, type: "watch.set", data: { sha256: sha256(text) } }]);
  return { config, changed: true };
}
function sourceErrors(sources: SearchResult["sources"]): WatchError[] {
  return sources.filter(row => !row.ok).map(row => {
    const host = HOSTS[row.source], prefix = `${host}: `, error = row.error ?? "";
    const match = error.startsWith(prefix) ? /^(?:network|rate|server|client|format)(?: ([1-5][0-9]{2}))?$/.exec(error.slice(prefix.length)) : null;
    return { host, status: match?.[1] === undefined ? null : Number(match[1]) };
  });
}
/** One finite pass, using the caller's existing locked lit-search operation. No timer or screening. */
export async function runWatch(dir: string, config: WatchConfig, actor: Actor, search: (query: WatchQuery) => Promise<SearchResult>): Promise<WatchRun> {
  const known = new Set(loadCandidates(dir).map(row => row.id)), addedIds = new Set<string>(), queries: WatchQueryResult[] = [];
  for (const query of config.queries) {
    const result = await search(query);
    for (const row of loadCandidates(dir)) if (!known.has(row.id)) { addedIds.add(row.id); known.add(row.id); }
    queries.push({ id: query.id, added: result.added, merged: result.merged, dropped: result.dropped, linked: result.linked,
      sources: result.sources.map(({ source, ok, returned }) => ({ source, ok, returned })), errors: sourceErrors(result.sources) });
  }
  const run: WatchRun = { configSha256: sha256(JSON.stringify(config)), queries, added: queries.reduce((sum, row) => sum + row.added, 0), addedIds: [], addedIdsTotal: addedIds.size,
    ok: queries.some(row => row.sources.some(source => source.ok)), ...(config.rubric === undefined ? {} : { rubric: config.rubric }) };
  for (const id of addedIds) {
    if (run.addedIds.length >= WATCH_IDS) break;
    run.addedIds.push(id);
    if (Buffer.byteLength(JSON.stringify(run)) > WATCH_RUN_BYTES) { run.addedIds.pop(); break; }
  }
  assertWritable(JSON.stringify(run), WATCH_RUN_BYTES, "watch run; shorten the rubric before the next run");
  commit(dir, [], [{ actor, type: "watch.ran", data: { ...run } }]); return run;
}
export function showWatch(dirArg: string) {
  const { dir } = openStudy(dirArg), config = readWatch(dir), events = readLedger(dir);
  const runs = events.filter(event => event.type === "watch.ran").slice(-WATCH_RECENT).reverse().map(event => ({ ...event.data, at: event.at, actor: event.actor }));
  return { config: config ?? null, runs };
}
