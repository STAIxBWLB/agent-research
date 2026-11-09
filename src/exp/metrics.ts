import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { plain } from "../study.ts";
import { runOnExecutor, shellQuote, type ProcessRunner, type Stage } from "./executor.ts";
import { ARTIFACT_BYTES, ARTIFACT_FILES, ArtifactError, readArtifactArchive } from "./artifacts.ts";
import type { Attempt, Evaluation } from "./attempts.ts";
import type { Protocol } from "./protocol.ts";

export const METRICS_BYTES = 65_536;
export const OUTPUT_METADATA_BYTES = 256 * 1024;
export const LOG_COPY_BYTES = 16 * 1024 * 1024;
export interface LogEvidence { path: string; sha256: string; bytes: number; truncated: boolean }
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
  try { archive = await readArtifactArchive(attempt.executor, "docker", ["cp", `${container(attempt, "evaluator")}:/result/.`, "-"], runner, { capture: "metrics.json", captureBytes: METRICS_BYTES, ...remaining(attempt) }); }
  catch (error) { throw archiveFailure(error, attempt, "evaluator result archive"); }
  if (!archive.captured) throw new MetricsError("missing-metrics", "metrics.json is missing from the evaluator result directory");
  const metrics = parseMetrics(archive.captured, attempt.protocol);
  const outputs = archive.files.map(file => ({ path: posix.join(attempt.paths.result, file.path), sha256: file.sha256, bytes: file.bytes }));
  outputBudget([...attempt.outputs, ...outputs]);
  return { metrics, outputs };
}

/** Raw copies remain in the executor's private attempt directory; only metadata enters the study. */
export async function collectStageEvidence(attempt: Attempt, stage: Stage, runner: ProcessRunner): Promise<StageEvidence> {
  const stageLabel = attempt.pipeline && stage === "candidate" ? `candidate-${attempt.pipeline.definition.candidate.stages[attempt.pipeline.index]!.name}` : stage;
  const cid = container(attempt, stage), root = posix.dirname(attempt.paths.snapshot), logs = posix.join(root, "logs");
  const stdout = posix.join(logs, `${stageLabel}.stdout.log`), stderr = posix.join(logs, `${stageLabel}.stderr.log`), suffix = randomUUID();
  const statePath = `logs/${stageLabel}.state.json`, stateFile = posix.join(root, statePath);
  const script = [
    "set -eu", "umask 077", `logs=${shellQuote(logs)}`,
    'if test ! -e "$logs"; then mkdir -m 700 "$logs"; fi', 'test -d "$logs"; test ! -L "$logs"; test -O "$logs"',
    `out=${shellQuote(stdout)}; err=${shellQuote(stderr)}; state=${shellQuote(stateFile)}`,
    'for file in "$out" "$err" "$state"; do if test -e "$file" || test -L "$file"; then test -f "$file"; test ! -L "$file"; fi; done',
    `if test -f "$out" && test -f "$err" && test -f "$state" && test "$(wc -c < "$out")" -le ${LOG_COPY_BYTES} && test "$(wc -c < "$err")" -le ${LOG_COPY_BYTES}; then :; else`,
    `outtmp=${shellQuote(`${stdout}.${suffix}.tmp`)}; errtmp=${shellQuote(`${stderr}.${suffix}.tmp`)}; statetmp=${shellQuote(`${stateFile}.${suffix}.tmp`)}`,
    `outpipe=${shellQuote(posix.join(logs, `${stageLabel}.${suffix}.stdout.pipe`))}; errpipe=${shellQuote(posix.join(logs, `${stageLabel}.${suffix}.stderr.pipe`))}`,
    'trap \'rm -f "$outtmp" "$errtmp" "$statetmp" "$outpipe" "$errpipe"\' 0',
    'mkfifo "$outpipe" "$errpipe"',
    `head -c ${LOG_COPY_BYTES} < "$outpipe" > "$outtmp" & outpid=$!`,
    `head -c ${LOG_COPY_BYTES} < "$errpipe" > "$errtmp" & errpid=$!`,
    `status=0; docker logs ${cid} > "$outpipe" 2> "$errpipe" || status=$?`,
    'wait "$outpid"; wait "$errpid"', 'outbytes=$(wc -c < "$outtmp"); errbytes=$(wc -c < "$errtmp")',
    'outcut=false; errcut=false',
    `if test "$outbytes" -ge ${LOG_COPY_BYTES}; then outcut=true; fi; if test "$errbytes" -ge ${LOG_COPY_BYTES}; then errcut=true; fi`,
    'if test "$status" -ne 0; then if test "$outcut" = true || test "$errcut" = true; then outcut=true; errcut=true; else exit "$status"; fi; fi',
    'printf \'{"stdout":%s,"stderr":%s}\\n\' "$outcut" "$errcut" > "$statetmp"',
    'mv "$outtmp" "$out"; mv "$errtmp" "$err"; mv "$statetmp" "$state"', 'fi',
    // Archive content only: BSD tar otherwise emits binary xattr PAX and AppleDouble entries.
    // ponytail: requires GNU tar >= 1.27 or bsdtar with --no-xattrs; unsupported tar
    // (e.g. BusyBox) fails closed with the generic stage-log collection error, never a metadata fallback.
    `COPYFILE_DISABLE=1 tar --no-xattrs -C ${shellQuote(root)} -cf - ${shellQuote(`logs/${stageLabel}.stdout.log`)} ${shellQuote(`logs/${stageLabel}.stderr.log`)} ${shellQuote(statePath)}`,
  ].join("\n");
  let logArchive;
  try { logArchive = await readArtifactArchive(attempt.executor, "sh", ["-c", script], runner, { capture: statePath, captureBytes: 1024, maxFiles: 3, maxBytes: LOG_COPY_BYTES * 2 + 1024 }); }
  catch (error) { throw archiveFailure(error, attempt, "stage log collection"); }
  let truncated: unknown;
  try { truncated = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(logArchive.captured)); } catch { /* validated below without copying metadata */ }
  if (!plain(truncated) || Object.keys(truncated).length !== 2 || typeof truncated.stdout !== "boolean" || typeof truncated.stderr !== "boolean") throw new EvidenceError("invalid-log-state", "stage evidence: truncation metadata is missing or malformed; remove incomplete log copies on the executor host and retry collection");
  const cuts = truncated as { stdout: boolean; stderr: boolean };
  const log = (kind: "stdout" | "stderr"): LogEvidence => {
    const file = logArchive.files.find(item => item.path === `logs/${stageLabel}.${kind}.log`);
    if (!file) throw new EvidenceError("missing-logs", "stage evidence: a stdout/stderr copy is missing; inspect the executor log directory and retry collection");
    return { path: posix.join(root, file.path), sha256: file.sha256, bytes: file.bytes, truncated: cuts[kind] || file.bytes >= LOG_COPY_BYTES };
  };
  const outputs: Evaluation["outputs"] = [];
  if (stage === "candidate") {
    let archive;
    try { archive = await readArtifactArchive(attempt.executor, "docker", ["cp", `${cid}:/out/.`, "-"], runner, { ...remaining(attempt, outputs) }); }
    catch (error) { throw archiveFailure(error, attempt, "candidate output archive"); }
    outputs.push(...archive.files.map(file => ({ path: posix.join(attempt.paths.output, file.path), sha256: file.sha256, bytes: file.bytes })));
  }
  outputBudget([...attempt.outputs, ...outputs]);
  return { logs: { stdout: log("stdout"), stderr: log("stderr") }, outputs };
}
