import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { plain } from "../study.ts";
import { runOnExecutor, shellQuote, type ProcessRunner, type Stage } from "./executor.ts";
import { ARTIFACT_BYTES, ARTIFACT_FILES, ArtifactError, readArtifactArchive } from "./artifacts.ts";
import type { Attempt, Evaluation } from "./attempts.ts";
import type { Protocol } from "./protocol.ts";

export const METRICS_BYTES = 65_536, LOG_TAIL_BYTES = 16_384;
export const OUTPUT_METADATA_BYTES = 256 * 1024;
export const LOG_COPY_BYTES = 16 * 1024 * 1024;
export interface LogEvidence { path: string; sha256: string; bytes: number; tail: string; redacted: boolean }
export interface StageEvidence { logs: { stdout: LogEvidence; stderr: LogEvidence }; outputs: Evaluation["outputs"] }
export class EvidenceError extends Error {
  constructor(readonly reason: string, message: string) { super(message); this.name = "EvidenceError"; }
}
export class MetricsError extends EvidenceError {
  constructor(reason: string, cause: string) { super(reason, `evaluator metrics: ${cause}; write /result/metrics.json as an object of all declared metric names and finite numbers, then retry the attempt`); this.name = "MetricsError"; }
}
export function validateMetrics(raw: unknown, protocol: Protocol): Evaluation["metrics"] {
  if (!plain(raw)) throw new MetricsError("malformed-metrics", "a metric-name to number object is required");
  const declared = new Set(protocol.metrics.map(metric => metric.name));
  if (Object.keys(raw).some(name => !declared.has(name))) throw new MetricsError("undeclared-metric", "an undeclared metric name is present");
  if (protocol.metrics.some(metric => !Object.hasOwn(raw, metric.name))) throw new MetricsError("missing-metric", "a declared metric is missing");
  return protocol.metrics.map(metric => {
    const value = raw[metric.name];
    if (typeof value !== "number") throw new MetricsError("invalid-metric-value", "a metric value is not a number");
    if (!Number.isFinite(value)) throw new MetricsError("nonfinite-metric", "a metric value is not finite");
    return { name: metric.name, unit: metric.unit, value, provenance: "ares-observed" };
  });
}
export function parseMetrics(bytes: Uint8Array, protocol: Protocol): Evaluation["metrics"] {
  if (bytes.byteLength > METRICS_BYTES) throw new MetricsError("metrics-limit", "metrics.json exceeds 65536 bytes");
  let text: string, raw: unknown;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); raw = JSON.parse(text); }
  catch { throw new MetricsError("malformed-metrics", "metrics.json is not valid UTF-8 JSON"); }
  // After parsing, only a flat numeric object is valid; reject duplicate keys rather than silently use the last number.
  const keys = new Set<string>();
  for (const match of text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)) {
    let key: string; try { key = JSON.parse(`"${match[1]}"`) as string; } catch { throw new MetricsError("malformed-metrics", "a metric name is malformed"); }
    if (keys.has(key)) throw new MetricsError("duplicate-metric", "a metric name appears more than once"); keys.add(key);
  }
  return validateMetrics(raw, protocol);
}
function container(attempt: Attempt, stage: Stage): string {
  const cid = attempt.stages[stage]?.containerId;
  if (!cid || !/^[a-f0-9]{64}$/.test(cid)) throw new EvidenceError("missing-receipt", "stage evidence: verified container id is missing; run ares attempt reconcile before collecting evidence");
  return cid;
}
export function outputBudget(outputs: Evaluation["outputs"]): Evaluation["outputs"] {
  const unique = new Map<string, Evaluation["outputs"][number]>();
  for (const output of outputs) {
    const previous = unique.get(output.path);
    if (previous && (previous.sha256 !== output.sha256 || previous.bytes !== output.bytes)) throw new EvidenceError("changed-output", "stage evidence: output changed after collection; inspect the executor workspace and retry with a fresh attempt");
    unique.set(output.path, output);
  }
  const result = [...unique.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (result.length > ARTIFACT_FILES || result.reduce((total, item) => total + item.bytes, 0) > ARTIFACT_BYTES) throw new EvidenceError("artifact-limit", "stage evidence: output budget exceeded; reduce outputs to 500 files and 256 MiB before retrying");
  if (Buffer.byteLength(JSON.stringify(result, null, 2)) > OUTPUT_METADATA_BYTES) throw new EvidenceError("artifact-limit", "stage evidence: output manifest is too large for the attempt record; shorten artifact paths or reduce their count before retrying");
  return result;
}
function remaining(attempt: Attempt, extra: Evaluation["outputs"] = []) {
  const outputs = outputBudget([...attempt.outputs, ...extra]);
  return { maxFiles: ARTIFACT_FILES - outputs.length, maxBytes: ARTIFACT_BYTES - outputs.reduce((total, file) => total + file.bytes, 0) };
}
function archiveFailure(error: unknown, attempt: Attempt, step: string): EvidenceError {
  const reason = error instanceof ArtifactError ? error.code : "artifact-read";
  return new EvidenceError(reason, `executor ${attempt.executor.host ?? "local"}: ${step} failed; inspect the stage files for unsafe links, oversized output or malformed archives and retry the attempt`);
}
/** Only the evaluator's result mount supplies numbers. Candidate files and printed numbers are never parsed. */
export async function collectEvaluation(attempt: Attempt, runner: ProcessRunner): Promise<Evaluation> {
  let archive;
  try { archive = await readArtifactArchive(attempt.executor, "docker", ["cp", `${container(attempt, "evaluator")}:/result/.`, "-"], runner, { capture: "metrics.json", captureBytes: METRICS_BYTES, tailBytes: 0, ...remaining(attempt) }); }
  catch (error) { throw archiveFailure(error, attempt, "evaluator result archive"); }
  if (!archive.captured) throw new MetricsError("missing-metrics", "metrics.json is missing from the evaluator result directory");
  const metrics = parseMetrics(archive.captured, attempt.protocol);
  const outputs = archive.files.map(file => ({ path: posix.join(attempt.paths.result, file.path), sha256: file.sha256, bytes: file.bytes }));
  outputBudget([...attempt.outputs, ...outputs]);
  return { metrics, outputs };
}

function normalizeLog(value: string): string { return value.replace(/\p{C}/gu, character => character === "\n" || character === "\t" ? character : ""); }
function assignmentEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"' || first === "'") {
    let escaped = false;
    for (let index = start + 1; index < text.length; index++) { const character = text[index]; if (!escaped && character === first) return index + 1; escaped = !escaped && character === "\\"; }
    return text.length;
  }
  if (first === "{" || first === "[") {
    const stack: string[] = []; let quote: string | undefined, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index]!;
      if (quote) { if (!escaped && character === quote) quote = undefined; escaped = !escaped && character === "\\"; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (character === "{" || character === "[") stack.push(character);
      else if (character === "}" || character === "]") { stack.pop(); if (!stack.length) return index + 1; }
    }
    return text.length;
  }
  let end = start; while (end < text.length && !/[\s,;&]/.test(text[end]!)) end++; return end;
}
/** Apply the spec's explicit masks before taking a bounded tail; do not guess or omit response bodies. */
export function sanitizeLogTail(bytes: Uint8Array, env: NodeJS.ProcessEnv = process.env): { tail: string; redacted: boolean } {
  if (bytes.byteLength > LOG_COPY_BYTES) throw new EvidenceError("log-limit", "stage evidence: log exceeds 16 MiB; reduce stage log volume before retrying");
  const original = new TextDecoder().decode(bytes);
  let text = normalizeLog(original);
  text = text.replace(/\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s@]+@/g, "$1***@");
  const assignment = /("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|(?<![A-Za-z0-9_-])[A-Za-z0-9_-]+)\s*(?:=|:)\s*/g;
  let masked = "", cursor = 0;
  for (let match = assignment.exec(text); match; match = assignment.exec(text)) {
    let key = match[1]!;
    if (key.startsWith('"')) { try { key = JSON.parse(key) as string; } catch { /* shell-style quoted key; inspect its literal spelling */ } }
    if (!/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) continue;
    const start = assignment.lastIndex, end = assignmentEnd(text, start), quote = text[start] === '"' || text[start] === "'" ? text[start]! : "";
    masked += text.slice(cursor, start) + quote + "***" + quote; cursor = end; assignment.lastIndex = Math.max(end, start);
  }
  text = masked + text.slice(cursor);
  const secrets = [...new Set(Object.entries(env).filter(([key, value]) => /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key) && value).map(([, value]) => normalizeLog(value!)).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (secrets.length) text = text.replace(new RegExp(secrets.map(value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g"), "***");
  const encoded = Buffer.from(text), tail = encoded.length > LOG_TAIL_BYTES ? new TextDecoder().decode(encoded.subarray(-(LOG_TAIL_BYTES - 3))) : text;
  return { tail, redacted: text !== original };
}
/** Raw copies remain in the executor's private attempt directory; only sanitized tails and hashes enter the study. */
export async function collectStageEvidence(attempt: Attempt, stage: Stage, runner: ProcessRunner): Promise<StageEvidence> {
  const cid = container(attempt, stage), root = posix.dirname(attempt.paths.snapshot), logs = posix.join(root, "logs");
  const stdout = posix.join(logs, `${stage}.stdout.log`), stderr = posix.join(logs, `${stage}.stderr.log`), suffix = randomUUID();
  const outTmp = `${stdout}.${suffix}.tmp`, errTmp = `${stderr}.${suffix}.tmp`;
  // POSIX shells use 512/1024-byte file-size blocks: 16384 blocks caps each raw copy at no more than 16 MiB.
  const script = `set -eu; umask 077; ulimit -f 16384; logs=${shellQuote(logs)}; if test ! -e "$logs"; then mkdir -m 700 "$logs"; fi; test -d "$logs"; test ! -L "$logs"; test -O "$logs"; out=${shellQuote(stdout)}; err=${shellQuote(stderr)}; if test -e "$out" || test -L "$out" || test -e "$err" || test -L "$err"; then test -f "$out"; test ! -L "$out"; test -f "$err"; test ! -L "$err"; else outtmp=${shellQuote(outTmp)}; errtmp=${shellQuote(errTmp)}; trap 'rm -f "$outtmp" "$errtmp"' 0; docker logs ${cid} > "$outtmp" 2> "$errtmp"; mv "$outtmp" "$out"; mv "$errtmp" "$err"; fi; tar -C ${shellQuote(root)} -cf - ${shellQuote(`logs/${stage}.stdout.log`)} ${shellQuote(`logs/${stage}.stderr.log`)}`;
  const copies = new Map<string, { parts: Buffer[]; bytes: number }>(); let oversized = false;
  const observe = (path: string, chunk: Uint8Array) => {
    let copy = copies.get(path); if (!copy) { copy = { parts: [], bytes: 0 }; copies.set(path, copy); }
    if (copy.bytes + chunk.length > LOG_COPY_BYTES) { oversized = true; throw new Error("bounded log copy"); }
    copy.bytes += chunk.length; copy.parts.push(Buffer.from(chunk));
  };
  let logArchive;
  try { logArchive = await readArtifactArchive(attempt.executor, "sh", ["-c", script], runner, { tailBytes: 0, onFileChunk: observe, maxFiles: 2, maxBytes: LOG_COPY_BYTES * 2 }); }
  catch (error) { if (oversized) throw new EvidenceError("log-limit", "stage evidence: log exceeds 16 MiB; reduce stage log volume before retrying"); throw archiveFailure(error, attempt, "stage log collection"); }
  const log = (kind: "stdout" | "stderr"): LogEvidence => {
    const file = logArchive.files.find(item => item.path === `logs/${stage}.${kind}.log`);
    if (!file) throw new EvidenceError("missing-logs", "stage evidence: a stdout/stderr copy is missing; inspect the executor log directory and retry collection");
    const copy = copies.get(file.path);
    return { path: posix.join(root, file.path), sha256: file.sha256, bytes: file.bytes, ...sanitizeLogTail(copy ? Buffer.concat(copy.parts, copy.bytes) : Buffer.alloc(0)) };
  };
  const outputs: Evaluation["outputs"] = [];
  if (stage === "candidate") {
    let archive;
    try { archive = await readArtifactArchive(attempt.executor, "docker", ["cp", `${cid}:/out/.`, "-"], runner, { tailBytes: 0, ...remaining(attempt, outputs) }); }
    catch (error) { throw archiveFailure(error, attempt, "candidate output archive"); }
    outputs.push(...archive.files.map(file => ({ path: posix.join(attempt.paths.output, file.path), sha256: file.sha256, bytes: file.bytes })));
  }
  outputBudget([...attempt.outputs, ...outputs]);
  return { logs: { stdout: log("stdout"), stderr: log("stderr") }, outputs };
}
