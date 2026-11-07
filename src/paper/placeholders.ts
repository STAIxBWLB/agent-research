import { CopilotAcceptError } from "../copilot.ts";
import { join, relative } from "node:path";
import { openStudy, plain, readLedger, readTextBounded, sha256 } from "../study.ts";
import { ATTEMPT_BYTES, listAttempts, type Attempt, type AttemptStatus } from "../exp/attempts.ts";
import { protocolHash, readProtocol } from "../exp/protocol.ts";
import { INVESTIGATE_BYTES, investigateResultPath, metricValue, readClosedInvestigation } from "../exp/investigate.ts";
import { ABLATE_BYTES, ablateResultPath, readClosedAblate } from "../exp/ablate.ts";
import { FINAL_RESULT_BYTES, finalResultPath, readClosedFinal, requirePosthocClosed } from "../exp/final.ts";

export const MANUSCRIPT_BYTES = 2 * 1024 * 1024, MAX_PLACEHOLDERS = 5000;
interface Position { start: number; end: number; line: number; column: number; raw: string }
export type Placeholder = Position & ({ kind: "number"; ref: string; format?: number } | { kind: "literal"; text: string });
export interface PlaceholderFinding extends Position { code: "bad-format" | "unresolved-ref" | "unaccepted-draft"; message: string }
export interface ResolvedPlaceholder { placeholder: Placeholder; value: number | string; rendered: string; source?: { file: string; sha256: string } }
/** Offsets are UTF-16 string indices; line and column are 1-based, as used by the Markdown checker. */
export function parsePlaceholders(text: string): { placeholders: Placeholder[]; findings: PlaceholderFinding[] } {
  if (Buffer.byteLength(text) > MANUSCRIPT_BYTES) throw new Error("paper manuscript: larger than 2 MiB; shorten paper/manuscript.md before checking or building");
  const placeholders: Placeholder[] = [], findings: PlaceholderFinding[] = [];
  const opening = /{{(?:n|lit):/g;
  let match: RegExpExecArray | null, count = 0, scanned = 0, line = 1, column = 1;
  while ((match = opening.exec(text))) {
    const start = match.index, closing = text.indexOf("}}", opening.lastIndex), end = closing < 0 ? text.length : closing + 2;
    while (scanned < start) { if (text[scanned++] === "\n") { line++; column = 1; } else column++; }
    const at: Position = { start, end, line, column, raw: text.slice(start, end) };
    if (++count > MAX_PLACEHOLDERS) { findings.push({ ...at, code: "bad-format", message: "paper placeholders: more than 5000; reduce the number of n/lit placeholders before building" }); break; }
    const body = text.slice(opening.lastIndex, closing < 0 ? text.length : closing);
    if (closing < 0 || body.includes("{{") || body.includes("}}")) {
      findings.push({ ...at, code: "bad-format", message: "placeholder: missing closing braces or nested placeholder; use {{n:REF[|.Nf]}} or {{lit:TEXT}}" });
      opening.lastIndex = end; continue;
    }
    opening.lastIndex = end;
    if (match[0] === "{{lit:") {
      if (!body.length) findings.push({ ...at, code: "bad-format", message: "literal placeholder: empty TEXT; supply the literal text for reviewer inspection" });
      else placeholders.push({ ...at, kind: "literal", text: body });
      continue;
    }
    // ponytail: metric names containing | or } cannot be represented by this grammar; rename them in a new protocol.
    const parsed = /^([^{}|]+)(?:\|\.([0-6])f)?$/.exec(body);
    if (!parsed || (/\s/.test(parsed[1]!) && !/^(attempt|posthoc):[a-f0-9]{16}\..+$/s.test(parsed[1]!))) findings.push({ ...at, code: "bad-format", message: "number placeholder: invalid ref or format; use {{n:REF}} or {{n:REF|.Nf}} with N from 0 to 6" });
    else placeholders.push({ ...at, kind: "number", ref: parsed[1]!, ...(parsed[2] === undefined ? {} : { format: Number(parsed[2]) }) });
  }
  return { placeholders, findings };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
interface Source<T> { value: T; source: { file: string; sha256: string } }
function source<T>(dir: string, file: string, bound: number, value: T, expected?: string): Source<T> {
  const text = readTextBounded(file, bound), hash = sha256(text);
  if (expected === undefined && canonical(JSON.parse(text)) !== canonical(value)) throw new Error("source value changed during resolution");
  if (expected !== undefined && hash !== expected) throw new Error("source bytes changed during resolution");
  return { value, source: { file: relative(dir, file), sha256: hash } };
}
const statuses: readonly string[] = ["running", "succeeded", "failed", "cancelled", "unknown"];
function validValue(value: unknown): value is string | number { return typeof value === "string" ? value.length > 0 : typeof value === "number" && Number.isFinite(value); }
/** A per-call cache keeps repeated placeholders tied to the same checked source bytes. No writes, network or process execution. */
export function resolvePlaceholders(dirArg: string, text: string) {
  const { dir, study } = openStudy(dirArg), parsed = parsePlaceholders(text), findings = [...parsed.findings], resolved: ResolvedPlaceholder[] = [], literals: Placeholder[] = [];
  const cache = new Map<string, Source<unknown> | Error>();
  const cached = <T>(key: string, read: () => Source<T>): Source<T> => {
    if (!cache.has(key)) { try { cache.set(key, read()); } catch (error) { cache.set(key, error instanceof CopilotAcceptError ? error : new Error("absent, unclosed, stale or invalid source")); } }
    const value = cache.get(key)!; if (value instanceof Error) throw value; return value as Source<T>;
  };
  const investigate = () => cached("investigate", () => { const closed = readClosedInvestigation(dir); return source(dir, investigateResultPath(dir, closed.result.run), INVESTIGATE_BYTES, closed.result, closed.sha256); });
  const ablate = () => cached("ablate", () => { const closed = readClosedAblate(dir); return source(dir, ablateResultPath(dir), ABLATE_BYTES, closed.result, closed.sha256); });
  const final = () => cached("final", () => { const closed = readClosedFinal(dir); return source(dir, finalResultPath(dir), FINAL_RESULT_BYTES, closed.result, closed.sha256); });
  let attemptIndex: Map<string, Attempt[]> | undefined;
  const attempt = (id: string, posthoc: boolean): Source<Attempt> => cached(`attempt:${id}:${posthoc}`, () => {
    if (!attemptIndex) {
      attemptIndex = new Map();
      for (const record of listAttempts(dir).attempts) { const same = attemptIndex.get(record.id) ?? []; same.push(record); attemptIndex.set(record.id, same); }
    }
    const found = attemptIndex.get(id) ?? [];
    if (found.length !== 1) throw new Error("attempt missing or ambiguous");
    const a = found[0]!, protocol = readProtocol(dir);
    if (posthoc) requirePosthocClosed(dir);
    if (a.studyId !== study.id || a.status !== "succeeded" || !protocol || a.protocolHash !== protocolHash(protocol) || a.protocolHash !== protocolHash(a.protocol) || (a.run === "posthoc") !== posthoc) throw new Error("attempt is not a current completed metric source");
    if (!readLedger(dir).some(e => e.type === "attempt.started" && e.data.id === a.id && e.data.run === a.run && e.data.commit === a.commit && e.data.seed === a.seed)) throw new Error("attempt start receipt missing");
    return source(dir, join(dir, "runs", a.run, "attempts", `${a.id}.json`), ATTEMPT_BYTES, a);
  });
  for (const placeholder of parsed.placeholders) {
    if (placeholder.kind === "literal") { literals.push(placeholder); resolved.push({ placeholder, value: placeholder.text, rendered: placeholder.text }); continue; }
    const ref = placeholder.ref;
    try {
      if (study.mode !== "experiment") throw new Error("experiment refs unavailable in survey");
      let value: unknown, provenance: Source<unknown>, exploratory = false;
      let match: RegExpExecArray | null;
      if ((match = /^final\.(status|reason|delta|mean|baselineMean)$/.exec(ref))) { const read = final(); provenance = read; value = read.value[match[1] as "status"]; }
      else if ((match = /^final\.attempts\.([a-z]+)$/.exec(ref)) && statuses.includes(match[1]!)) { const read = final(); provenance = read; value = read.value.attempts.filter(a => a.status === match![1]).length; }
      else if ((match = /^investigate\.(winner|reason)$/.exec(ref))) { const read = investigate(); provenance = read; value = match[1] === "winner" ? read.value.winner?.commit.slice(0, 12) : read.value.reason; }
      else if ((match = /^investigate\.winner\.(delta|mean)$/.exec(ref))) { const read = investigate(); provenance = read; value = read.value.winner?.[match[1] as "delta"]; }
      else if (ref === "investigate.baseline.mean") { const read = investigate(); provenance = read; value = read.value.baseline.mean; }
      else if ((match = /^(investigate|ablate)\.totals\.([a-z]+)$/.exec(ref)) && statuses.includes(match[2]!)) { const read = match[1] === "investigate" ? investigate() : ablate(); provenance = read; value = read.value.totals.byStatus[match[2] as AttemptStatus]; }
      else if ((match = /^ablate:([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.(delta|mean|referenceMean)$/.exec(ref))) { const read = ablate(); provenance = read; value = read.value.ablations.find(a => a.id === match![1])?.paired[match[2] as "delta"]; }
      else if ((match = /^(attempt|posthoc):([a-f0-9]{16})\.(.+)$/.exec(ref))) {
        exploratory = match[1] === "posthoc"; const read = attempt(match[2]!, exploratory); provenance = read;
        const metric = read.value.protocol.metrics?.find(m => m.name === match![3]);
        if (!metric) throw new Error("metric undeclared"); value = metricValue(read.value, metric);
      } else throw new Error("unknown reference");
      if (!validValue(value)) throw new Error("value unavailable or non-finite");
      if (typeof value === "string" && placeholder.format !== undefined) {
        findings.push({ ...placeholder, code: "bad-format", message: `placeholder ${ref}: text refs take no numeric format; remove |.Nf` }); continue;
      }
      const rendered = (typeof value === "number" && placeholder.format !== undefined ? value.toFixed(placeholder.format) : String(value)) + (exploratory ? " (exploratory)" : "");
      resolved.push({ placeholder, value, rendered, source: provenance.source });
    } catch (error) {
      if (error instanceof CopilotAcceptError) { findings.push({ ...placeholder, code: "unaccepted-draft", message: error.message }); continue; }
      findings.push({ ...placeholder, code: "unresolved-ref", message: `placeholder ${ref}: unknown ref or absent, unclosed, stale or invalid source; inspect the attempt and close the current phase results before retrying` });
    }
  }
  const replacements = new Map(resolved.map(entry => [entry.placeholder.start, entry]));
  let rendered = "", cursor = 0;
  for (const placeholder of parsed.placeholders) { rendered += text.slice(cursor, placeholder.start) + (replacements.get(placeholder.start)?.rendered ?? placeholder.raw); cursor = placeholder.end; }
  rendered += text.slice(cursor);
  return { rendered, placeholders: resolved, findings: findings.sort((a, b) => a.start - b.start), literals };
}
