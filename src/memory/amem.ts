import { spawnRunner, type ProcessRunner } from "../exp/executor.ts";
import { plain } from "../study.ts";

export const AMEM_OUTPUT_BYTES = 262_144;
export const AMEM_BRIEF_BYTES = 8192;
export type AmemKind = "fail" | "finding" | "decision" | "contract";
export interface AmemNote {
  text: string; kind: AmemKind; title?: string;
  approach?: string; symptom?: string; cause?: string; evidence?: string[]; retryWhen?: string;
}
export interface AmemHit { id: string; kind: AmemKind; title: string | null; at: string; score: number; about: string[] }
export interface AmemBrief { brief: string; bytes: number; truncated: boolean; state: string }
export interface AmemClient {
  add(note: AmemNote): Promise<string>;
  search(words: string, kind?: AmemKind): Promise<AmemHit[]>;
  brief(text: string, bytes: number): Promise<AmemBrief>;
}
const kindOf = (value: unknown): value is AmemKind => ["fail", "finding", "decision", "contract"].includes(value as string);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
function invalid(): never { throw new Error("amem bad JSON: invalid response shape"); }
function input(text: string): void {
  if (!text.trim() || text === "-" || text.startsWith("-") || text.includes("\0")) throw new Error("amem input: provide non-empty text without a leading hyphen or NUL");
}
function hit(raw: unknown): AmemHit {
  if (!plain(raw) || !identifier(raw.id) || !kindOf(raw.kind) || (raw.title !== null && typeof raw.title !== "string")
    || typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at)) || typeof raw.score !== "number" || !Number.isFinite(raw.score)
    || !Array.isArray(raw.about) || !raw.about.every(node => typeof node === "string")) invalid();
  return { id: raw.id, kind: raw.kind, title: raw.title, at: raw.at, score: raw.score, about: [...raw.about] as string[] };
}
/** The process boundary returns projections only; raw diagnostics never escape in errors. */
export function createAmemClient(runner: ProcessRunner = spawnRunner): AmemClient {
  async function read(args: string[]): Promise<unknown> {
    let result;
    try { result = await runner({ command: "amem", args, maxOutputBytes: AMEM_OUTPUT_BYTES, timeoutMs: 30_000 }); }
    catch { throw new Error("amem spawn failure"); }
    if (result.truncated || Buffer.byteLength(result.stdout) > AMEM_OUTPUT_BYTES) throw new Error("amem over-bound output");
    if (result.timedOut) throw new Error("amem timeout");
    if (result.exitCode !== 0) throw new Error("amem nonzero exit");
    try { return JSON.parse(result.stdout); } catch { throw new Error("amem bad JSON"); }
  }
  return {
    async add(note) {
      input(note.text);
      if (!kindOf(note.kind)) throw new Error("amem input: invalid kind");
      if (note.evidence && note.evidence.length > 16) throw new Error("amem input: at most 16 evidence refs");
      const args = ["note", "add", note.text, "--kind", note.kind];
      for (const [flag, value] of [["--approach", note.approach], ["--symptom", note.symptom], ["--cause", note.cause],
        ... (note.evidence ?? []).map(ref => ["--evidence", ref]), ["--retry-when", note.retryWhen], ["--title", note.title]]) {
        if (value !== undefined) { input(value); args.push(flag!, value); }
      }
      const raw = await read([...args, "--json"]);
      if (!plain(raw) || !identifier(raw.id)) invalid();
      return raw.id;
    },
    async search(words, kind) {
      input(words);
      if (kind !== undefined && !kindOf(kind)) throw new Error("amem input: invalid kind");
      const raw = await read(["search", words, ...(kind === undefined ? [] : ["--kind", kind]), "--json"]);
      if (!Array.isArray(raw)) invalid();
      return raw.map(hit);
    },
    async brief(text, bytes) {
      input(text);
      if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > AMEM_BRIEF_BYTES) throw new Error("amem input: brief bytes must be 1..8192");
      const raw = await read(["brief", "--for", text, "--json", "--bytes", String(bytes)]);
      if (!plain(raw) || typeof raw.brief !== "string" || !Number.isSafeInteger(raw.bytes) || (raw.bytes as number) < 0
        || (raw.bytes as number) > bytes || Buffer.byteLength(raw.brief) > bytes || typeof raw.truncated !== "boolean" || typeof raw.state !== "string") invalid();
      return { brief: raw.brief, bytes: raw.bytes as number, truncated: raw.truncated, state: raw.state };
    },
  };
}
