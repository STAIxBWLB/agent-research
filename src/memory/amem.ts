import { PROCESS_CONTEXT_ENV_KEYS, spawnRunner, type ProcessRunner } from "../exp/executor.ts";
import { plain } from "../study.ts";

export const AMEM_OUTPUT_BYTES = 262_144;
export const AMEM_BRIEF_BYTES = 8192;
export type AmemKind = "fail" | "finding" | "decision" | "contract";
export interface AmemNote {
  text: string; kind: AmemKind; title?: string;
  approach?: string; symptom?: string; cause?: string; evidence?: string[]; retryWhen?: string;
}
export interface AmemHit { id: string; kind: AmemKind; title: string | null; at: string; relevance: number; about: string[] }
export interface AmemBrief { brief: string; bytes: number; truncated: boolean; state: string }
export interface AmemClient {
  add(note: AmemNote): Promise<string>;
  search(words: string, kind?: AmemKind, limit?: number): Promise<AmemHit[]>;
  brief(text: string, bytes: number): Promise<AmemBrief>;
}
const kindOf = (value: unknown): value is AmemKind => ["fail", "finding", "decision", "contract"].includes(value as string);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
function invalid(): never { throw new Error("amem bad JSON: invalid response shape; check amem --version and inspect --json output in the study directory"); }
function input(text: string): void {
  if (!text.trim() || text === "-" || text.startsWith("-") || text.includes("\0")) throw new Error("amem input: provide non-empty text without a leading hyphen or NUL; correct the input and retry");
}
function hit(raw: unknown): AmemHit {
  if (!plain(raw) || !identifier(raw.id) || !kindOf(raw.kind) || (raw.title !== null && typeof raw.title !== "string")
    || typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))
    || !Array.isArray(raw.about) || !raw.about.every(node => typeof node === "string")) invalid();
  const details = raw.scoreDetails;
  if (!plain(details) || typeof details.finalScore !== "number" || !Number.isFinite(details.finalScore) || details.finalScore <= 0
    || typeof details.recencyFactor !== "number" || !Number.isFinite(details.recencyFactor) || details.recencyFactor <= 0) scoreUnavailable();
  const relevance = details.finalScore / details.recencyFactor;
  if (!Number.isFinite(relevance) || relevance <= 0) scoreUnavailable();
  return { id: raw.id, kind: raw.kind, title: raw.title, at: raw.at, relevance, about: [...raw.about] as string[] };
}
function scoreUnavailable(): never {
  throw new Error("amem score unavailable: finite positive finalScore and recencyFactor required; inspect amem search <words> --json --explain in the study directory");
}
async function readAmem(args: string[], cwd: string, runner: ProcessRunner, context: NodeJS.ProcessEnv): Promise<unknown> {
  let result;
  try { result = await runner({ command: "amem", args, cwd, env: context, maxOutputBytes: AMEM_OUTPUT_BYTES, timeoutMs: 30_000 }); }
  catch { throw new Error("amem spawn failure; check amem is on PATH (amem --version)"); }
  if (result.truncated || Buffer.byteLength(result.stdout) > AMEM_OUTPUT_BYTES) throw new Error("amem over-bound output; reduce the search limit or brief bytes and retry");
  if (result.timedOut) throw new Error("amem timeout; check amem --version and retry in the study directory");
  if (result.exitCode !== 0) throw new Error("amem nonzero exit; run amem search <words> --json in the study directory to see the cause");
  try { return JSON.parse(result.stdout); } catch { throw new Error("amem bad JSON; check amem --version and inspect --json output in the study directory"); }
}
function searchRows(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (!plain(raw) || !Array.isArray(raw.hits)) invalid();
  return raw.hits.flatMap(item => {
    if (!plain(item)) invalid();
    if (item.source !== "curated" || item.view === undefined) return [];
    if (!plain(item.view)) invalid();
    return [{ ...item.view, scoreDetails: item.scoreDetails }];
  });
}
/** The process boundary returns projections only; raw diagnostics never escape in errors. */
export function createAmemClient(cwd: string, runner: ProcessRunner = spawnRunner, env: NodeJS.ProcessEnv = process.env): AmemClient {
  const context = Object.fromEntries([...PROCESS_CONTEXT_ENV_KEYS, "HOME"].flatMap(key => env[key] === undefined ? [] : [[key, env[key]!]]));
  const read = (args: string[]) => readAmem(args, cwd, runner, context);
  return {
    async add(note) {
      input(note.text);
      if (!kindOf(note.kind)) throw new Error("amem input: invalid kind; use fail, finding, decision or contract");
      if (note.evidence && note.evidence.length > 16) throw new Error("amem input: at most 16 evidence refs; reduce evidence refs and retry");
      const args = ["note", "add", note.text, "--kind", note.kind];
      for (const [flag, value] of [["--approach", note.approach], ["--symptom", note.symptom], ["--cause", note.cause],
        ... (note.evidence ?? []).map(ref => ["--evidence", ref]), ["--retry-when", note.retryWhen], ["--title", note.title]]) {
        if (value !== undefined) { input(value); args.push(flag!, value); }
      }
      const raw = await read([...args, "--json"]);
      if (!plain(raw) || !identifier(raw.id)) invalid();
      return raw.id;
    },
    async search(words, kind, limit = 100) {
      input(words);
      if (kind !== undefined && !kindOf(kind)) throw new Error("amem input: invalid kind; use fail, finding, decision or contract");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("amem input: search limit must be 1..100; choose an integer in this range");
      const raw = await read(["search", words, "--json", "--explain", "--limit", String(limit)]);
      const rows = searchRows(raw);
      return rows.filter(row => kind === undefined || plain(row) && row.kind === kind).map(hit);
    },
    async brief(text, bytes) {
      input(text);
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > AMEM_BRIEF_BYTES) throw new Error("amem input: brief bytes must be 1..8192; choose an integer in this range");
      const raw = await read(["brief", "--for", text, "--json", "--bytes", String(bytes)]);
      if (!plain(raw) || typeof raw.brief !== "string" || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0
        || (raw.bytes as number) > bytes || Buffer.byteLength(raw.brief) > bytes || typeof raw.truncated !== "boolean" || typeof raw.state !== "string") invalid();
      return { brief: raw.brief, bytes: raw.bytes as number, truncated: raw.truncated, state: raw.state };
    },
  };
}
