import { createHash } from "node:crypto";
import { posix } from "node:path";
import { openStudy, requireExperiment } from "../study.ts";
import { showAttempt, type AttemptStage } from "./attempts.ts";
import { runOnExecutor, shellQuote, spawnRunner, validateExecutor, type ProcessRunner, type Stage } from "./executor.ts";
import { LOG_COPY_BYTES } from "./metrics.ts";

export type LogStream = "stdout" | "stderr";
export interface LogOptions { stage?: string; candidateStage?: string; stream?: string; tailBytes?: number }
export interface LogReadResult { id: string; logs: { stage: Stage; candidateStage?: string; stream: LogStream; path: string; sha256: string; bytes: number; truncated: boolean; text: string; tailBytes: number }[] }
export const DEFAULT_LOG_TAIL_BYTES = 16_384, MAX_LOG_TAIL_BYTES = 65_536;
export const MAX_LOG_TOTAL_TAIL_BYTES = 256 * 1024;

/** Explicit read-only log access. Nothing, including the returned text, is written to the study. */
export async function readAttemptLogs(dir: string, wanted: string, options: LogOptions = {}, runner: ProcessRunner = spawnRunner): Promise<LogReadResult> {
  const { study } = openStudy(dir); requireExperiment(study);
  const attempt = showAttempt(dir, wanted), executor = validateExecutor(attempt.executor);
  if (attempt.studyId !== study.id || !/^[A-Za-z0-9_-]{1,80}$/.test(attempt.studyId)) throw new Error("attempt logs: study identity differs from the record; restore the original attempt record before reading logs");
  if (options.stage !== undefined && options.stage !== "candidate" && options.stage !== "evaluator") throw new Error("attempt logs: invalid stage; use --stage candidate or evaluator");
  if (options.stream !== undefined && options.stream !== "stdout" && options.stream !== "stderr") throw new Error("attempt logs: invalid stream; use --stream stdout or stderr");
  const count = options.tailBytes ?? DEFAULT_LOG_TAIL_BYTES;
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_LOG_TAIL_BYTES) throw new Error(`attempt logs: invalid tail bound; use --tail 0..${MAX_LOG_TAIL_BYTES}`);
  const root = posix.join(executor.workdir, attempt.studyId, attempt.id), logsDir = posix.join(root, "logs");
  if (!attempt.paths || attempt.paths.snapshot !== posix.join(root, "snapshot")) throw new Error("attempt logs: workspace differs from recorded executor identity; restore the original record before reading logs");
  const result: LogReadResult = { id: attempt.id, logs: [] };
  const sources: { stage: Stage; candidateStage?: string; record?: AttemptStage }[] = [];
  if (attempt.pipeline) {
    for (const parent of attempt.pipeline.completed) sources.push({ stage: "candidate", candidateStage: parent.name, record: parent.record });
    if (attempt.stage === "candidate") sources.push({ stage: "candidate", candidateStage: attempt.pipeline.definition.candidate.stages[attempt.pipeline.index]!.name, record: attempt.stages.candidate });
  } else sources.push({ stage: "candidate", record: attempt.stages.candidate });
  sources.push({ stage: "evaluator", record: attempt.stages.evaluator });
  if (options.candidateStage !== undefined && (!attempt.pipeline || options.stage === "evaluator" || !attempt.pipeline.definition.candidate.stages.some(stage => stage.name === options.candidateStage))) throw new Error("attempt logs: invalid candidate stage; choose a declared v2 candidate name and --stage candidate");
  const selected = sources.filter(source => (options.stage === undefined || source.stage === options.stage) && (options.candidateStage === undefined || source.candidateStage === options.candidateStage));
  const streams: LogStream[] = options.stream ? [options.stream as LogStream] : ["stdout", "stderr"];
  const requests: { stage: Stage; candidateStage?: string; stream: LogStream; path: string; sha256: string; bytes: number; truncated: boolean }[] = [];
  for (const source of selected) for (const stream of streams) {
    const metadata = source.record?.evidence?.logs?.[stream];
    if (!metadata) {
      if ((options.stage !== undefined && !attempt.pipeline) || options.candidateStage !== undefined) throw new Error("attempt logs: the selected stage has no collected logs; reconcile after the stage finishes, then retry");
      continue;
    }
    const label = source.candidateStage === undefined ? source.stage : `candidate-${source.candidateStage}`;
    const expected = posix.join(logsDir, `${label}.${stream}.log`);
    if (metadata.path !== expected || typeof metadata.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 || metadata.bytes > LOG_COPY_BYTES || typeof metadata.truncated !== "boolean") throw new Error("attempt logs: invalid log receipt or path; restore the original metadata before reading logs");
    requests.push({ stage: source.stage, ...(source.candidateStage === undefined ? {} : { candidateStage: source.candidateStage }), stream, path: expected, sha256: metadata.sha256, bytes: metadata.bytes, truncated: metadata.truncated });
  }
  if (!requests.length) throw new Error("attempt logs: no collected logs for the selected stage yet; reconcile after the stage finishes, then retry");
  const tailCount = options.tailBytes === undefined ? Math.min(count, Math.floor(MAX_LOG_TOTAL_TAIL_BYTES / requests.length)) : count;
  if (tailCount * requests.length > MAX_LOG_TOTAL_TAIL_BYTES) throw new Error("attempt logs: combined tail bound exceeded; select --candidate-stage NAME or --stream, or lower --tail");
  for (const entry of requests) {
    const controller = new AbortController(), hash = createHash("sha256");
    let bytes = 0, tail: Buffer = Buffer.alloc(0);
    const script = [
      "set -eu", `root=${shellQuote(root)}; logs=${shellQuote(logsDir)}; file=${shellQuote(entry.path)}`,
      'test -d "$root"; test ! -L "$root"; test -O "$root"; test "$(cd -P "$root" && pwd -P)" = "$root"',
      'mode=$(stat -c %a "$root" 2>/dev/null || stat -f %Lp "$root"); test "$mode" = 700',
      'test -d "$logs"; test ! -L "$logs"; test -O "$logs"; test -f "$file"; test ! -L "$file"; test -O "$file"',
      `head -c ${LOG_COPY_BYTES + 1} "$file"`,
    ].join("\n");
    try {
      const response = await runOnExecutor(executor, "sh", ["-c", script], runner, { signal: controller.signal, timeoutMs: 300_000, stdoutSink: chunk => {
        if (bytes + chunk.byteLength > LOG_COPY_BYTES) { controller.abort(); throw new Error("log receipt read bound"); }
        bytes += chunk.byteLength; hash.update(chunk);
        if (tailCount) tail = chunk.byteLength >= tailCount ? Buffer.from(chunk.subarray(chunk.byteLength - tailCount)) : Buffer.concat([tail.subarray(Math.max(0, tail.length + chunk.byteLength - tailCount)), chunk]);
      } });
      if (response.exitCode !== 0 || response.timedOut || response.truncated) throw new Error("log read failed");
    } catch {
      controller.abort(); throw new Error(`executor ${executor.host ?? "local"}: log read failed; check the recorded private log file and retry ares attempt logs`);
    }
    if (bytes !== entry.bytes || hash.digest("hex") !== entry.sha256) throw new Error("attempt logs: host log differs from the recorded hash or size; inspect the executor copy before retrying");
    result.logs.push({ ...entry, text: new TextDecoder().decode(tail), tailBytes: tail.byteLength });
  }
  return result;
}
