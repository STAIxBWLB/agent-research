import { HttpError } from "../http.ts";
import { join } from "node:path";
import { assertWritable, boundedText, commit, onlyKeys, openStudy, plain, readLedger, readBytesBounded, sha256, type Actor } from "../study.ts";
import { loadCandidates } from "./candidates.ts";
import { SOURCES, type SourceName } from "./sources.ts";

export const WATCH_BYTES = 65_536, WATCH_QUERIES = 20, WATCH_IDS = 500, WATCH_RUN_BYTES = 60 * 1024, WATCH_RECENT = 10;
export interface WatchQuery { id: string; query: string; source?: SourceName | "all"; yearFrom?: number; limit?: number }
export interface WatchConfig { v: 1; queries: WatchQuery[]; rubric?: string }
export interface WatchSnapshot { config: WatchConfig; sha256: string }
export interface SearchResult { added: number; merged: number; dropped: number; linked: number; sources: { source: SourceName; ok: boolean; returned: number; error?: string }[] }
export interface WatchError { host: string; status: number | null }
export interface WatchQueryResult { id: string; added: number; merged: number; dropped: number; linked: number; sources: { source: SourceName; ok: boolean; returned: number }[]; errors: WatchError[] }
export type WatchFailureClass = "terminated" | "filesystem" | "network" | "rate" | "server" | "client" | "format" | "internal";
export interface WatchRun { cause?: WatchFailureClass; configSha256: string; queries: WatchQueryResult[]; added: number; addedIds: string[]; addedIdsTotal: number; ok: boolean }
const HOSTS: Record<SourceName, string> = { openalex: "api.openalex.org", s2: "api.semanticscholar.org", arxiv: "export.arxiv.org" };
class WatchInputError extends Error {}
class WatchVersionError extends WatchInputError {}
class WatchStoredError extends Error {}
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
    if (raw.v !== 1) {
      if (typeof raw.v === "number" && Number.isSafeInteger(raw.v) && raw.v > 1) throw new WatchVersionError("watch input: unsupported version is newer than this ares supports; use a compatible ares version or provide v1 input");
      bad("config version is malformed; set v to 1");
    }
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
function stored(dir: string): WatchSnapshot | undefined {
  const file = watchPath(dir);
  let bytes: Buffer, text: string;
  try { bytes = readBytesBounded(file, WATCH_BYTES); text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new WatchStoredError("watch: literature/watch.json is unreadable, non-regular or over 65536 bytes; rerun ares watch set <dir> --file PATH with valid input, or restore literature/watch.json as a bounded regular file");
  }
  try { return { config: validateWatch(JSON.parse(text)), sha256: sha256(bytes) }; }
  catch (error) {
    if (error instanceof WatchVersionError) throw new WatchVersionError("watch config: unsupported version in literature/watch.json; keep literature/watch.json unchanged and use an ares version supporting this config");
    throw new WatchStoredError("watch: literature/watch.json is invalid; rerun ares watch set <dir> --file PATH with valid v1 input, or restore literature/watch.json");
  }
}
export const readWatchSnapshot = (dir: string): WatchSnapshot | undefined => stored(dir);
export function readWatch(dir: string): WatchConfig | undefined { return stored(dir)?.config; }
/** Caller holds study lock; identical bytes never add a second event. */
export function setWatch(dir: string, raw: unknown, actor: Actor) {
  const config = validateWatch(raw), text = JSON.stringify(config, null, 2) + "\n";
  let before: WatchSnapshot | undefined;
  try { before = stored(dir); } catch (error) { if (!(error instanceof WatchStoredError)) throw error; }
  if (before?.sha256 === sha256(text)) return { config, changed: false };
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
/** A closed vocabulary only: thrown messages can contain request URLs, keys or response bodies. */
export function watchFailureClass(error: unknown): WatchFailureClass {
  if (error instanceof HttpError) return error.kind;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return ["ENOENT", "EACCES", "EPERM", "ENOSPC", "EIO", "EROFS", "ENOTDIR", "EISDIR"].includes(String(code)) ? "filesystem" : "internal";
}
/** Caller still holds the study lock; no partial query details or diagnostic text are copied. */
export function recordWatchFailure(dir: string, snapshot: WatchSnapshot, actor: Actor, cause: WatchFailureClass): void {
  const run: WatchRun = { configSha256: snapshot.sha256, queries: [], added: 0, addedIds: [], addedIdsTotal: 0, ok: false, cause };
  commit(dir, [], [{ actor, type: "watch.ran", data: { ...run } }]);
}
/** One finite pass, using the caller's existing locked lit-search operation. No timer or screening. */
export async function runWatch(dir: string, snapshot: WatchSnapshot, actor: Actor, search: (query: WatchQuery) => Promise<SearchResult>): Promise<WatchRun> {
  const { config } = snapshot;
  const known = new Set(loadCandidates(dir).map(row => row.id)), addedIds = new Set<string>(), queries: WatchQueryResult[] = [];
  for (const query of config.queries) {
    const result = await search(query);
    for (const row of loadCandidates(dir)) if (!known.has(row.id)) { addedIds.add(row.id); known.add(row.id); }
    queries.push({ id: query.id, added: result.added, merged: result.merged, dropped: result.dropped, linked: result.linked,
      sources: result.sources.map(({ source, ok, returned }) => ({ source, ok, returned })), errors: sourceErrors(result.sources) });
  }
  const surviving = new Set(loadCandidates(dir).map(row => row.id));
  for (const id of addedIds) if (!surviving.has(id)) addedIds.delete(id);
  const run: WatchRun = { configSha256: snapshot.sha256, queries, added: queries.reduce((sum, row) => sum + row.added, 0), addedIds: [], addedIdsTotal: addedIds.size,
    ok: queries.some(row => row.sources.some(source => source.ok)) };
  for (const id of addedIds) {
    if (run.addedIds.length >= WATCH_IDS) break;
    run.addedIds.push(id);
    if (Buffer.byteLength(JSON.stringify(run)) > WATCH_RUN_BYTES) { run.addedIds.pop(); break; }
  }
  assertWritable(JSON.stringify(run), WATCH_RUN_BYTES, "watch run; reduce watched queries before the next run");
  commit(dir, [], [{ actor, type: "watch.ran", data: { ...run } }]); return run;
}
export function showWatch(dirArg: string) {
  const { dir } = openStudy(dirArg), config = readWatch(dir), events = readLedger(dir);
  const runs = events.filter(event => event.type === "watch.ran").slice(-WATCH_RECENT).reverse().map(event => ({ ...event.data, at: event.at, actor: event.actor }));
  return { config: config ?? null, runs };
}
