import { prepareStageReuse } from "./reuse-admission.ts";
import { executionView, materializePipeline, sealPipeline, pipelinePaths, pipelineInputRoot, type PipelineState, type AttemptReuseState } from "./pipeline.ts";
import { retainedOperation, RetentionError } from "./retention.ts";
import { validateStageProtocol } from "./stages.ts";
import { requireCopilotAccept } from "../copilot.ts";
import { resolveAutonomy } from "../autonomy.ts";
import { readFinalSeeds, authorizeFinalAttempt, finalGateBinding, requirePosthocClosed } from "./final.ts";
import { closeSync, existsSync, lstatSync, openSync, opendirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { boundedText, commit, openStudy, plain, readJsonFile, readTextBounded, requireExperiment, requireGate, sha256, withLock, StudyLockBusyError, type Actor, type PendingEvent } from "../study.ts";
import { canonical, designBinding, sameProtocolInputs, frozenProtocol, validateStoredProtocol, protocolHash, readProtocol, readDesign, type Protocol } from "./protocol.ts";
import { buildContainerArgs, probeGpuAdmission, GpuAdmissionDeferred, validateGpuDevices, validateContainerInputSources, executionPathsOverlap, verifyExecutorInputs, InputVerificationError, checkExecutorInputs, containerName, readExecutor, runOnExecutor, shellQuote, spawnRunner, startWatchdog, type ContainerPaths, type Executor, type ProcessRunner, type Stage } from "./executor.ts";
import { resolveSnapshot, transferSnapshot, transferTask } from "./snapshot.ts";
import { collectEvaluation as defaultEvaluationCollector, collectStageEvidence as defaultStageCollector, EvidenceError, MetricsError, OUTPUT_METADATA_BYTES, outputBudget, type StageEvidence } from "./metrics.ts";

export type AttemptStatus = "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface AttemptStage { image: string; argv: string[]; mounts: { target: string; readOnly: boolean }[]; network: "none"; limits: Protocol["limits"]; user: string; containerId?: string; startedAt: string; endedAt?: string; exitCode?: number; evidence?: StageEvidence; evidenceError?: { reason: string; message: string }; launchPending?: true }
export interface Evaluation { metrics: { name: string; unit: string; value: number; provenance: "ares-observed" }[]; outputs: { path: string; sha256: string; bytes: number }[] }
export interface Attempt {
  v: 1 | 2 | 3; pipeline?: PipelineState; reuse?: AttemptReuseState; freshRequest?: { reuse: "off" | "eligible"; forceFresh: boolean }; id: string; studyId: string; run: string; protocolHash: string; sealBinding: string; commit: string; treeId: string; snapshotSha256?: string; seed: number; label: string; retryOf?: string;
  executor: Executor; protocol: Protocol; paths: ContainerPaths; status: AttemptStatus; stage: Stage; reason?: string; error?: string; startedAt: string; endedAt?: string;
  stages: Partial<Record<Stage, AttemptStage>>; metrics: Evaluation["metrics"]; outputs: Evaluation["outputs"];
  sealing: { separateContainers: boolean; evaluatorReadOnly: boolean; candidateHasNoEvaluator: boolean; verifiedBy: "ares-observed" };
  launching?: { pid: number; host: string; token: string; claimedAt: string; expiresAt: string };
  verifiedInputs?: Record<string, string>;
  gpuDevices?: string[];
  pendingAutoApproval?: string;
  finalBinding?: string; finalWinner?: string; pendingFinalApproval?: string;
}
export interface AttemptOptions { repo: string; commit: string; seed?: number; run?: string; label?: string; retry?: string; detach?: boolean; expectedId?: string; reuse?: "off" | "eligible"; forceFresh?: boolean }
/** collectEvaluation is T4's validating adapter; T3 does not parse or validate metric schemas. */
export interface AttemptContext { actor: Actor; runner?: ProcessRunner; now?: () => number; sleep?: (ms: number) => Promise<void>; collectEvaluation?: (attempt: Attempt, runner: ProcessRunner) => Promise<Evaluation>; collectStageEvidence?: (attempt: Attempt, stage: Stage, runner: ProcessRunner) => Promise<StageEvidence> }
export const ATTEMPT_BYTES = 1024 * 1024;
// Startup includes bounded image pulls and two 5-minute transfers; claims never survive indefinitely after a crash.
export const CONTROL_STALE_MS = 30 * 60_000;
// Filesystem mtime has sub-ms precision; Date.now is integral. Tolerate small future skew on live locks.
export const CONTROL_FUTURE_SKEW_MS = 60_000;
const controlScope = new AsyncLocalStorage<{ dir: string; token: string }>();
const STATUSES: AttemptStatus[] = ["running", "succeeded", "failed", "cancelled", "unknown"];
const inspectFields = (prefix: string, fields: string[]) => fields.map(field => `${JSON.stringify(field)}:{{json ${prefix}.${field}}}`).join(",");
// Exclude inherited image labels/env and other unbounded Docker metadata from the observation.
const INSPECT_FORMAT = `{{$seed := ""}}{{range .Config.Env}}{{if and (ge (len .) 10) (eq (slice . 0 10) "ARES_SEED=")}}{{$seed = .}}{{end}}{{end}}[{"Id":{{json .Id}},"State":{${inspectFields(".State", ["Running", "ExitCode", "StartedAt", "FinishedAt"])}},"Config":{"Seed":{{json $seed}},${inspectFields(".Config", ["Image", "User", "Cmd"])},"Labels":{${["ares.study", "ares.attempt", "ares.stage"].map(key => `${JSON.stringify(key)}:{{json (index .Config.Labels ${JSON.stringify(key)})}}`).join(",")}}},"HostConfig":{${inspectFields(".HostConfig", ["NetworkMode", "ReadonlyRootfs", "CapDrop", "SecurityOpt", "Tmpfs", "Memory", "PidsLimit", "NanoCpus", "DeviceRequests"])}},"Mounts":{{json .Mounts}}}]`;
const now = (ctx: AttemptContext) => ctx.now?.() ?? Date.now();
const at = (ctx: AttemptContext) => new Date(now(ctx)).toISOString();
function runName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new Error("run: invalid name; use 1..64 letters, digits, underscores or hyphens, starting with a letter or digit");
  return value;
}
function id(value: string): string {
  if (!/^[a-f0-9]{16}$/.test(value)) throw new Error("attempt id: invalid; use a 16-hex id from ares attempt list");
  return value;
}
export function attemptId(hash: string, commit: string, treeId: string, seed: number, run: string, retryOf?: string): string {
  return sha256([hash, commit, treeId, seed, run, retryOf ?? ""].join("|")).slice(0, 16);
}
function file(dir: string, attempt: Pick<Attempt, "run" | "id">): string { return join(dir, "runs", runName(attempt.run), "attempts", `${id(attempt.id)}.json`); }
function directoryEntries(path: string): string[] {
  if (!existsSync(path)) return [];
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("attempt store: invalid directory; restore regular runs/ and attempts/ directories without symlinks");
  const directory = opendirSync(path), entries: string[] = [];
  try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) { if (entries.length >= 1_000_000) throw new Error("attempt store: too many entries; archive the study and start a new one"); entries.push(entry.name); } }
  finally { directory.closeSync(); }
  return entries.sort();
}
function* records(dir: string): Generator<Attempt> {
  let count = 0;
  for (const run of directoryEntries(join(dir, "runs"))) {
    runName(run);
    for (const name of directoryEntries(join(dir, "runs", run, "attempts"))) {
      if (!/^[a-f0-9]{16}\.json$/.test(name)) throw new Error("attempt store: unexpected file; keep only attempt-id.json records under runs/<run>/attempts/");
      const path = join(dir, "runs", run, "attempts", name), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("attempt record: regular file required; restore the record without symlinks");
      const raw = readJsonFile(path, ATTEMPT_BYTES);
      const attempt = validateAttemptRecord(raw, run, name.slice(0, 16));
      if (++count > 1_000_000) throw new Error("attempt store: more than 1000000 records; archive the study and start a new one");
      yield attempt;
    }
  }
}
function reuseMilliseconds(value: unknown): boolean { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function reuseContext(value: unknown): boolean {
  if (!plain(value) || typeof value.populationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.populationSha256) || !plain(value.runtime) || !plain(value.platform)) return false;
  return [value.runtime.semantics, value.runtime.producerVersion, value.platform.os, value.platform.arch, value.platform.abi].every(text => typeof text === "string" && !!text.trim() && Buffer.byteLength(text) <= 128 && !/\p{Cc}/u.test(text));
}
function validateReuseState(raw: Record<string, unknown>, definition: import("./stages.ts").ProtocolV2, completed: unknown[], wanted: string, run: string): void {
  const reuse = raw.reuse;
  if (!plain(reuse) || !["off", "eligible"].includes(String(reuse.mode)) || typeof reuse.forceFresh !== "boolean" || !plain(reuse.stages) || Object.keys(reuse.stages).length > 16 || !reuseMilliseconds(reuse.verificationMs) || !reuseMilliseconds(reuse.materializationMs) || (reuse.failureMs !== undefined && !reuseMilliseconds(reuse.failureMs))) throw new Error("reuse: malformed attempt control receipt; restore the last valid attempt record before running ares attempt reconcile <dir>");
  for (const [name, entry] of Object.entries(reuse.stages)) {
    if (!definition.candidate.stages.some(stage => stage.name === name) || !plain(entry) || !["fresh", "reused"].includes(String(entry.outcome)) || typeof entry.reason !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.reason) || !reuseMilliseconds(entry.verificationMs) || !reuseMilliseconds(entry.materializationMs) || (entry.key !== undefined && (typeof entry.key !== "string" || !/^[a-f0-9]{64}$/.test(entry.key) || !reuseContext(entry.context)))) throw new Error("reuse: malformed named stage outcome; restore the last valid attempt record before running ares attempt reconcile <dir>");
    if (entry.outcome === "reused" && !completed.some(parent => plain(parent) && parent.name === name && plain(parent.reuse))) throw new Error("reuse: outcome has no atomic completed-stage receipt; restore the last valid attempt record before running ares attempt reconcile <dir>");
    if (entry.outcome === "fresh" && entry.source !== undefined) throw new Error("reuse: fresh execution cannot carry a reused source; restore the last valid attempt record before running ares attempt reconcile <dir>");
  }
  const measurement = (value: unknown) => value === "unknown" || reuseMilliseconds(value);
  for (const parent of completed) if (plain(parent) && parent.reuse !== undefined) {
    const receipt = parent.reuse, ref = parent.ref, declared = definition.candidate.stages.find(stage => stage.name === parent.name);
    if (reuse.mode !== "eligible" || reuse.forceFresh || ["ablate", "final", "posthoc"].includes(run) || !declared?.reuse || !Object.keys(declared.outputs).length || !plain(ref) || ref.attemptId === wanted || !/^[a-f0-9]{16}$/.test(String(ref.attemptId)) || !plain(receipt) || receipt.v !== 1 || typeof receipt.key !== "string" || !/^[a-f0-9]{64}$/.test(receipt.key) || canonical(receipt.source) !== canonical(ref) || !reuseContext(receipt.context) || !plain(receipt.original) || !measurement(receipt.original.wallSeconds) || !measurement(receipt.original.gpuHours) || receipt.original.cpuSeconds !== "unknown" || !reuseMilliseconds(receipt.verificationMs) || !reuseMilliseconds(receipt.materializationMs)) throw new Error("reuse: malformed source receipt; restore the last valid attempt record before running ares attempt reconcile <dir>");
    const outcome = reuse.stages[parent.name as string];
    if (!plain(outcome) || outcome.outcome !== "reused" || outcome.key !== receipt.key || canonical(outcome.source) !== canonical(ref) || canonical(outcome.context) !== canonical(receipt.context)) throw new Error("reuse: source receipt and admitted outcome differ; restore the last valid attempt record before running ares attempt reconcile <dir>");
  }
}
/** Shared store validation for provenance snapshots without a second directory traversal. */
export function validateAttemptRecord(raw: unknown, run: string, wanted: string): Attempt {
  runName(run); id(wanted);
      if (plain(raw) && ((raw.v !== 1 && raw.v !== 2 && raw.v !== 3) || (typeof raw.status === "string" && !STATUSES.includes(raw.status as AttemptStatus)) || (typeof raw.stage === "string" && !["candidate", "evaluator"].includes(raw.stage)))) throw new Error("attempt record: unsupported schema version, status or stage; use an ares version that supports this record, keeping the original file unchanged");
      if (!plain(raw) || (raw.v !== 1 && raw.v !== 2 && raw.v !== 3) || raw.run !== run || raw.id !== wanted || !STATUSES.includes(raw.status as AttemptStatus) || !["candidate", "evaluator"].includes(raw.stage as string) || !plain(raw.stages) || !plain(raw.protocol) || !plain(raw.executor) || typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt))) throw new Error("attempt record: malformed; restore its last valid version before retrying");
  if (raw.v === 2 || raw.v === 3) {
    if (!plain(raw.pipeline) || !Number.isSafeInteger(raw.pipeline.index) || !Array.isArray(raw.pipeline.completed)) throw new Error("pipeline: malformed attempt state; restore its last valid record");
    const definition = validateStageProtocol(raw.pipeline.definition);
    if (!plain(raw.pipeline.inputHashes) || typeof raw.pipeline.taskTreeHash !== "string" || !/^[a-f0-9]{64}$/.test(raw.pipeline.taskTreeHash)) throw new Error("pipeline: invalid input snapshot identities");
    if (raw.pipeline.preflightRevision !== undefined && (!Number.isSafeInteger(raw.pipeline.preflightRevision) || (raw.pipeline.preflightRevision as number) < 0)) throw new Error("pipeline: invalid launch revision");
    if (raw.pipeline.reusedSidecarBytes !== undefined && (!reuseMilliseconds(raw.pipeline.reusedSidecarBytes) || (raw.pipeline.reusedSidecarBytes as number) > OUTPUT_METADATA_BYTES)) throw new Error("reuse: invalid retained metadata allowance; restore the last valid attempt record before running ares attempt reconcile <dir>");
    const completed = raw.pipeline.completed;
    if (completed.length !== (raw.pipeline.index as number) + (raw.stage === "evaluator" ? 1 : 0)) throw new Error("pipeline: completed stage receipts do not match current stage");
    for (const [index, parent] of completed.entries()) if (!plain(parent) || parent.name !== definition.candidate.stages[index]?.name || !plain(parent.ref) || (parent.reuse === undefined && parent.ref.attemptId !== wanted) || !/^[a-f0-9]{16}$/.test(String(parent.ref.attemptId)) || parent.ref.stage !== parent.name || typeof parent.ref.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(parent.ref.sha256) || !plain(parent.record) || parent.record.exitCode !== 0 || typeof parent.record.containerId !== "string" || typeof parent.record.endedAt !== "string") throw new Error("pipeline: malformed completed-stage provenance");
    if (canonical(raw.protocol) !== canonical(executionView(definition, raw.pipeline.index as number))) throw new Error("pipeline: execution projection differs from frozen definition");
    if ((raw.pipeline.index as number) < 0 || (raw.pipeline.index as number) >= definition.candidate.stages.length || raw.protocolHash !== protocolHash(definition)) throw new Error("pipeline: invalid frozen identity or stage index");
    if (raw.v === 3) {
      validateReuseState(raw, definition, completed, wanted, run);
    } else if (raw.reuse !== undefined || completed.some(parent => plain(parent) && parent.reuse !== undefined)) throw new Error("reuse: version 3 attempt required; use a compatible ares reader, keeping the original record unchanged");
  } else if (raw.pipeline !== undefined) throw new Error("pipeline: version 2 attempt required");
  if (Object.hasOwn(raw.protocol, "inputs")) {
    const protocol = validateStoredProtocol(raw.protocol);
    const expected = Object.entries(protocol.inputs ?? {}), verified = raw.verifiedInputs;
    if (!plain(verified) || Object.keys(verified).length !== expected.length || expected.some(([name, input]) => verified[name] !== input.sha256)) throw new Error("attempt inputs: verified hashes do not match the frozen input identities; restore the last valid attempt record before retrying");
  }
  if (raw.freshRequest !== undefined && (raw.v !== 1 || !plain(raw.freshRequest) || !["off", "eligible"].includes(String(raw.freshRequest.reuse)) || typeof raw.freshRequest.forceFresh !== "boolean")) throw new Error("attempt request controls: malformed fresh request; restore the last valid record before retrying");
  if (raw.executor.gpu !== undefined && plain(raw.protocol.limits) && typeof raw.protocol.limits.gpus === "number" && raw.protocol.limits.gpus > 0 && raw.gpuDevices === undefined) throw new Error("attempt GPU: frozen assignment missing; restore the chosen GPU UUIDs from the last valid attempt record before retrying");
  if (raw.gpuDevices !== undefined) {
    if (!plain(raw.protocol.limits)) throw new Error("attempt GPU: limits missing; restore the frozen attempt record before retrying");
    validateGpuDevices(raw.gpuDevices, raw.protocol.limits.gpus as number);
  }
  return raw as unknown as Attempt;
}
function load(dir: string): Attempt[] { return [...records(dir)]; }
function studyDir(dirArg: string): string { const { dir, study } = openStudy(dirArg); requireExperiment(study); return dir; }
/** One pass of regular, byte-bounded records; callers retain only the projections they need. */
export function* readAttemptRecords(dirArg: string): Generator<Attempt> { yield* records(studyDir(dirArg)); }
export function listAttempts(dirArg: string, options: { run?: string; status?: string } = {}) {
  const dir = studyDir(dirArg), all = load(dir), totals = Object.fromEntries(STATUSES.map(status => [status, all.filter(a => a.status === status).length])) as Record<AttemptStatus, number>;
  if (options.run !== undefined) runName(options.run);
  if (options.status !== undefined && !STATUSES.includes(options.status as AttemptStatus)) throw new Error("status: unknown attempt status; use running, succeeded, failed, cancelled or unknown");
  return { attempts: all.filter(a => (!options.run || a.run === options.run) && (!options.status || a.status === options.status)), totals };
}
export interface AttemptListOptions { run?: string; status?: string; limit?: number; offset?: number }
export interface AttemptSummary { id: string; run: string; commit: string; seed: number; label: string; status: AttemptStatus; stage: Stage; reason?: string; startedAt: string; endedAt?: string; metricCount: number; outputCount: number }
/** Page summaries while reading one bounded record at a time; totals always cover the whole study. */
export function listAttemptSummaries(dirArg: string, options: AttemptListOptions = {}) {
  const dir = studyDir(dirArg), limit = options.limit ?? 50, offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("attempt list: invalid limit; use --limit 1..200");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new Error("attempt list: invalid offset; use --offset 0..1000000");
  if (options.run !== undefined) runName(options.run);
  if (options.status !== undefined && !STATUSES.includes(options.status as AttemptStatus)) throw new Error("attempt list: invalid status; use running, succeeded, failed, cancelled or unknown");
  const totals = Object.fromEntries(STATUSES.map(status => [status, 0])) as Record<AttemptStatus, number>, attempts: AttemptSummary[] = [];
  let total = 0;
  for (const attempt of records(dir)) {
    totals[attempt.status]++;
    if ((options.run && attempt.run !== options.run) || (options.status && attempt.status !== options.status)) continue;
    const position = total++;
    if (position < offset || attempts.length >= limit) continue;
    if (typeof attempt.label !== "string" || attempt.label.length > 128 || typeof attempt.commit !== "string" || !/^[a-f0-9]{40}$/.test(attempt.commit) || !Number.isSafeInteger(attempt.seed) || !Array.isArray(attempt.metrics) || !Array.isArray(attempt.outputs) || attempt.startedAt.length > 64 || (attempt.reason !== undefined && (typeof attempt.reason !== "string" || attempt.reason.length > 500)) || (attempt.endedAt !== undefined && (typeof attempt.endedAt !== "string" || attempt.endedAt.length > 64 || !Number.isFinite(Date.parse(attempt.endedAt))))) throw new Error("attempt list: malformed summary fields; restore the last valid attempt record before retrying");
    attempts.push({ id: attempt.id, run: attempt.run, commit: attempt.commit, seed: attempt.seed, label: attempt.label, status: attempt.status, stage: attempt.stage, ...(attempt.reason !== undefined ? { reason: attempt.reason } : {}), startedAt: attempt.startedAt, ...(attempt.endedAt ? { endedAt: attempt.endedAt } : {}), metricCount: attempt.metrics.length, outputCount: attempt.outputs.length });
  }
  return { attempts, totals, total, offset, limit, remaining: Math.max(0, total - offset - attempts.length) };
}
export function showAttempt(dirArg: string, attemptId: string): Attempt {
  const dir = studyDir(dirArg), found = load(dir).find(a => a.id === id(attemptId));
  if (!found) throw new Error("attempt: not found; choose an id from ares attempt list");
  return found;
}
function save(dir: string, attempt: Attempt, ctx: AttemptContext, event: string, approvals: PendingEvent[] = []): void {
  if (attempt.pipeline && attempt.status === "running" && Buffer.byteLength(JSON.stringify(attempt, null, 2) + "\n") > ATTEMPT_BYTES - 1024) throw new EvidenceError("artifact-limit", "pipeline: reserve terminal receipt capacity within the 1 MiB attempt record");
  const reused = event === "attempt.stage.reused" ? attempt.pipeline?.completed.at(-1) : undefined;
  commit(dir, [[file(dir, attempt), JSON.stringify(attempt, null, 2) + "\n", ATTEMPT_BYTES]], [...approvals, { actor: ctx.actor, type: event, data: { id: attempt.id, run: attempt.run, stage: attempt.stage, status: attempt.status, ...(attempt.reason ? { reason: attempt.reason } : {}), ...(reused?.reuse ? { candidateStage: reused.name, key: reused.reuse.key, sourceAttemptId: reused.reuse.source.attemptId, sourceStage: reused.reuse.source.stage, sourceSha256: reused.reuse.source.sha256, reuse: reused.reuse } : {}) } }]);
}
export function budgetUsage(attempts: Attempt[], time = Date.now()) {
  let wallHours = 0, gpuHours = 0;
  for (const attempt of attempts) {
    if (Object.keys(attempt.stages).some(name => name !== "candidate" && name !== "evaluator")) throw new Error("budget: unsupported attempt stage kind prevents complete accounting; use an ares version that supports all recorded stages before starting another attempt, keeping the original records unchanged");
    const elapsed = Math.max(0, (attempt.endedAt ? Date.parse(attempt.endedAt) : time) - Date.parse(attempt.startedAt)) / 3_600_000;
    if (!Number.isFinite(elapsed)) throw new Error("attempt timing: malformed; restore valid timestamps before starting an attempt");
    wallHours += elapsed;
    // Unknown kinds cannot be accounted for safely; read-only operations do not call this function.
    for (const stage of [...Object.values(attempt.stages), ...(attempt.pipeline?.completed.filter(value => !value.reuse).map(value => value.record) ?? [])]) {
    if (!stage) continue;
    const end = stage.endedAt ? Date.parse(stage.endedAt) : attempt.endedAt ? Date.parse(attempt.endedAt) : time;
    const hours = Math.max(0, end - Date.parse(stage.startedAt)) / 3_600_000;
    if (!Number.isFinite(hours) || !Number.isFinite(stage.limits.gpus)) throw new Error("attempt timing: malformed; restore valid stage timestamps and limits before starting an attempt");
    gpuHours += hours * stage.limits.gpus;
    }
  }
  return { attempts: attempts.length, wallHours, gpuHours };
}
function enforceBudget(protocol: Protocol, attempts: Attempt[], time: number): void {
  const usage = budgetUsage(attempts, time);
  for (const [key, used] of [["maxAttempts", usage.attempts], ["maxWallHours", usage.wallHours], ["maxGpuHours", usage.gpuHours]] as const) {
    if (key === "maxGpuHours" && protocol.limits.gpus === 0 && used === 0) continue;
    if (used >= protocol.budget[key]) throw new Error(`budget ${key}: exhausted; raise protocol.budget.${key}, approve design again, and retry`);
  }
}
function owner(ctx: AttemptContext): NonNullable<Attempt["launching"]> {
  return { pid: process.pid, host: hostname(), token: randomUUID(), claimedAt: at(ctx), expiresAt: new Date(now(ctx) + CONTROL_STALE_MS).toISOString() };
}
function alive(attempt: Attempt, ctx: AttemptContext): boolean {
  const owner = attempt.launching;
  if (!owner) return false;
  const claimed = Date.parse(owner.claimedAt), expiry = Math.min(Date.parse(owner.expiresAt), claimed + CONTROL_STALE_MS);
  if (!Number.isFinite(expiry) || claimed > now(ctx) || now(ctx) >= expiry) return false;
  if (owner.host !== hostname()) return true;
  try { process.kill(owner.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
/** Serialize short control commands without changing records or ledger on read-only observations. */
async function withControl<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const path = join(dir, ".ares.control.lock"), token = randomUUID();
  const waitingSince = performance.now();
  let fd: number;
  for (;;) {
    try { fd = openSync(path, "wx", 0o600); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age = 0; try { age = Date.now() - statSync(path).mtimeMs; } catch { /* owner removed it */ }
      if (performance.now() - waitingSince >= 2000) throw new Error("attempt control: another operation is active; retry reconcile or cancel when it finishes (abandoned claims expire after 30 minutes)");
      if (age < -CONTROL_FUTURE_SKEW_MS || age >= CONTROL_STALE_MS) {
        try { unlinkSync(path); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("attempt control: abandoned lock could not be removed; restore study-directory ownership and permissions, then retry"); }
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  try { writeSync(fd, token); } finally { closeSync(fd); }
  try { return await controlScope.run({ dir, token }, fn); }
  finally { try { if (readTextBounded(path, 128) === token) unlinkSync(path); } catch { /* stale owner must not remove a newer claim */ } }
}
async function update(dir: string, attemptId: string, ctx: AttemptContext, fn: (current: Attempt) => string | undefined, approvals: PendingEvent[] = [], completion?: (attempt: Attempt) => PendingEvent[]): Promise<Attempt> {
  return withLock(dir, () => {
    const scope = controlScope.getStore();
    if (scope?.dir === dir) {
      let currentToken: string | undefined;
      try { currentToken = readTextBounded(join(dir, ".ares.control.lock"), 128); } catch { /* expired or replaced */ }
      if (currentToken !== scope.token) throw new Error("attempt control: ownership expired or changed; run ares attempt reconcile before retrying this operation");
    }
    const current = showAttempt(dir, attemptId), event = fn(current); if (event) save(dir, current, ctx, event, [...approvals, ...(completion?.(current) ?? [])]); return current;
  });
}
function finish(attempt: Attempt, status: AttemptStatus, reason: string | undefined, ctx: AttemptContext): void {
  attempt.status = status; if (reason) attempt.reason = reason; else delete attempt.reason;
  if (status === "succeeded") delete attempt.error;
  attempt.endedAt = at(ctx); delete attempt.launching; delete attempt.pendingAutoApproval; delete attempt.pendingFinalApproval;
  const stage = attempt.stages[attempt.stage]; if (stage && !stage.endedAt) stage.endedAt = attempt.endedAt;
}
function hostError(attempt: Attempt, step: string): Error {
  return new Error(`executor ${attempt.executor.host ?? "local"}: ${step} failed; check that step on the executor host and run ares attempt reconcile <dir>`);
}
function startupError(attempt: Attempt, step: string): string {
  const recovery = step === "private workspace preparation" ? "make the configured executor workdir an owned physical directory with mode 0700" : step === "evaluator transfer" || step === "design recheck" ? "restore the task evaluator files and approve the current design" : step === "snapshot transfer" ? "check the repository commit and executor workspace" : step === "controller lock" ? "wait for the active control operation to finish" : "run ares executor check <dir> and fix the reported host or image setup";
  return `executor ${attempt.executor.host ?? "local"}: ${step} failed; ${recovery}, then retry with the same attempt options and --retry ID`;
}
async function command(attempt: Attempt, step: string, executable: string, args: string[], ctx: AttemptContext) {
  try {
    const result = await runOnExecutor(attempt.executor, executable, args, ctx.runner ?? spawnRunner);
    if (result.exitCode !== 0 || result.timedOut || result.truncated) throw hostError(attempt, step);
    return result;
  } catch { throw hostError(attempt, step); }
}
/** Locators are transient and never copied to an attempt or a second store. */
function executionProtocol(dir: string, attempt: Attempt): Protocol {
  if (!Object.keys(attempt.protocol.inputs ?? {}).length) return attempt.protocol;
  let current: Protocol | undefined;
  try { const definition = readProtocol(dir); current = definition ? executionView(definition) : undefined; } catch { /* Return safe recovery guidance rather than private parser details. */ }
  if (!current || !sameProtocolInputs(current, attempt.protocol)) throw new InputVerificationError("attempt inputs: current design identities differ from the frozen attempt; restore the matching input names, hashes and mounts in design/protocol.json before reconciling or retrying");
  return { ...attempt.protocol, inputs: current.inputs };
}
function stageRecord(attempt: Attempt, stage: Stage, user: string, ctx: AttemptContext): AttemptStage {
  return { image: attempt.protocol[stage].image, argv: attempt.protocol[stage].command, mounts: [...(stage === "candidate" ? [{ target: "/workspace", readOnly: true }, { target: "/out", readOnly: false }] : [{ target: "/eval", readOnly: true }, { target: "/candidate", readOnly: true }, { target: "/result", readOnly: false }]), ...(pipelineInputRoot(attempt) ? [{ target: "/in", readOnly: true }] : []), ...Object.values(attempt.protocol.inputs ?? {}).flatMap(input => input.mount[stage] ? [{ target: input.mount[stage]!, readOnly: true }] : [])], network: "none", limits: attempt.protocol.limits, user, startedAt: at(ctx) };
}

/** Validate observed container settings before describing its sealing as ares-observed. */
function observed(raw: unknown, attempt: Attempt, protocol: Protocol, ownershipOnly = false): { id: string; running: boolean; exitCode: number; finishedAt?: string; startedAt?: string } {
  const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
  if (!plain(value) || typeof value.Id !== "string" || !/^[a-f0-9]{64}$/.test(value.Id) || !plain(value.State) || typeof value.State.Running !== "boolean" || !Number.isSafeInteger(value.State.ExitCode) || !plain(value.Config) || !plain(value.HostConfig) || !Array.isArray(value.Mounts)) throw hostError(attempt, "container inspection");
  const expected = attempt.stages[attempt.stage]!, config = value.Config, settings = value.HostConfig;
  if (ownershipOnly) {
    if (!plain(config.Labels) || config.Labels["ares.study"] !== attempt.studyId || config.Labels["ares.attempt"] !== attempt.id || config.Labels["ares.stage"] !== attempt.stage || (expected?.containerId && value.Id !== expected.containerId)) throw hostError(attempt, "container ownership verification");
    const finishedAt = typeof value.State.FinishedAt === "string" && Number.isFinite(Date.parse(value.State.FinishedAt)) ? value.State.FinishedAt : undefined;
    const startedAt = typeof value.State.StartedAt === "string" && Number.isFinite(Date.parse(value.State.StartedAt)) ? value.State.StartedAt : undefined;
    return { id: value.Id, running: value.State.Running, exitCode: value.State.ExitCode as number, ...(finishedAt ? { finishedAt } : {}), ...(startedAt ? { startedAt } : {}) };
  }
  const mounts = attempt.stage === "candidate" ? [[attempt.paths.snapshot, "/workspace", false], [attempt.paths.output, "/out", true]] : [[attempt.paths.evaluator, "/eval", false], [attempt.paths.output, "/candidate", false], [attempt.paths.result, "/result", true]];
  const inputRoot = pipelineInputRoot(attempt);
  if (inputRoot) mounts.push([inputRoot, "/in", false]);
  const bindMounts = value.Mounts.filter(m => !(plain(m) && m.Type === "tmpfs" && m.Destination === "/tmp"));
  // Input content was verified at launch. A locator relocation must not invalidate an in-flight mount.
  const inputs = Object.values(protocol.inputs ?? {}), visible = inputs.filter(input => input.mount[attempt.stage] !== undefined);
  const privateInputs = inputs.filter(input => input.mount[attempt.stage] === undefined);
  const workspace = Object.values(attempt.paths);
  const inputMountsValid = visible.every(input => {
    const mount = bindMounts.find(m => plain(m) && m.Destination === input.mount[attempt.stage]);
    if (!plain(mount) || mount.Type !== "bind" || mount.RW !== false || typeof mount.Source !== "string" || !mount.Source.startsWith("/") || /[\0\r\n,"]/.test(mount.Source)) return false;
    const source = mount.Source;
    return !workspace.some(path => executionPathsOverlap(source, path)) && !privateInputs.some(other => executionPathsOverlap(source, other.path!));
  });
  const devices = settings.DeviceRequests;
  const capabilitiesMatch = Array.isArray(devices) && devices.length === 1 && plain(devices[0]) && Array.isArray(devices[0].Capabilities) && devices[0].Capabilities.some(c => Array.isArray(c) && c.includes("gpu"));
  const gpuMatches = expected.limits.gpus === 0 ? devices === null || devices === undefined || (Array.isArray(devices) && devices.length === 0)
    : attempt.gpuDevices !== undefined ? capabilitiesMatch && devices[0].Count === 0 && Array.isArray(devices[0].DeviceIDs) && devices[0].DeviceIDs.length === attempt.gpuDevices.length && new Set(devices[0].DeviceIDs).size === attempt.gpuDevices.length && attempt.gpuDevices.every(device => (devices[0].DeviceIDs as unknown[]).includes(device))
    : capabilitiesMatch && devices[0].Count === expected.limits.gpus;
  if (!gpuMatches) throw hostError(attempt, "GPU limit verification");
  if (config.Seed !== (attempt.pipeline && attempt.stage === "candidate" && !attempt.pipeline!.definition.candidate.stages[attempt.pipeline!.index]!.seed ? "" : `ARES_SEED=${attempt.seed}`)) throw hostError(attempt, "selected seed verification");
  if (config.Image !== expected.image || config.User !== expected.user || JSON.stringify(config.Cmd) !== JSON.stringify(expected.argv) || !plain(config.Labels) || config.Labels["ares.study"] !== attempt.studyId || config.Labels["ares.attempt"] !== attempt.id || config.Labels["ares.stage"] !== attempt.stage || settings.NetworkMode !== "none" || settings.ReadonlyRootfs !== true || !Array.isArray(settings.CapDrop) || !settings.CapDrop.some(c => c === "ALL" || c === "all") || !Array.isArray(settings.SecurityOpt) || !settings.SecurityOpt.includes("no-new-privileges") || !plain(settings.Tmpfs) || !("/tmp" in settings.Tmpfs) || settings.Memory !== expected.limits.memoryMb * 1024 * 1024 || settings.PidsLimit !== expected.limits.pidsLimit || settings.NanoCpus !== Math.round(expected.limits.cpus * 1e9) || (!inputMountsValid || bindMounts.length !== mounts.length + visible.length) || !mounts.every(([source, target, writable]) => bindMounts.some(m => plain(m) && m.Type === "bind" && m.Source === source && m.Destination === target && m.RW === writable))) throw hostError(attempt, "container isolation verification");
  if (expected?.containerId && value.Id !== expected.containerId) throw hostError(attempt, "container identity verification");
  const finishedAt = typeof value.State.FinishedAt === "string" && Number.isFinite(Date.parse(value.State.FinishedAt)) ? value.State.FinishedAt : undefined;
  const startedAt = typeof value.State.StartedAt === "string" && Number.isFinite(Date.parse(value.State.StartedAt)) ? value.State.StartedAt : undefined;
  return { id: value.Id, running: value.State.Running, exitCode: value.State.ExitCode as number, ...(finishedAt ? { finishedAt } : {}), ...(startedAt ? { startedAt } : {}) };
}
type ObservedStage = ReturnType<typeof observed>;
function needsReceipt(attempt: Attempt, state: ObservedStage): boolean {
  const stage = attempt.stages[attempt.stage]!;
  return !!attempt.launching || stage.containerId !== state.id || (!!state.startedAt && stage.startedAt !== state.startedAt) || (attempt.stage === "candidate" ? !attempt.sealing.candidateHasNoEvaluator || !!attempt.pendingAutoApproval || !!attempt.pendingFinalApproval : !attempt.sealing.evaluatorReadOnly || !attempt.sealing.separateContainers);
}
/** Every verified path persists the same receipt; auto approval and candidate receipt share one commit. */
async function recordVerifiedStage(dir: string, attempt: Attempt, state: ObservedStage, ctx: AttemptContext, event: string, approveDesign = true): Promise<Attempt> {
  const approvals: PendingEvent[] = [];
  return update(dir, attempt.id, ctx, current => {
    if (current.status !== "running" || current.stage !== attempt.stage) return undefined;
    const stage = current.stages[current.stage]!;
    stage.containerId = state.id; if (state.startedAt) stage.startedAt = state.startedAt;
    if (current.reason === "executor-start" || current.reason === "executor-start-uncertain" || current.reason === "executor-preflight" || current.reason === "executor-seal") { delete current.reason; delete current.error; }
    delete current.launching;
    if (current.stage === "candidate") {
      current.sealing.candidateHasNoEvaluator = true;
      if (approveDesign && current.pendingAutoApproval === current.sealBinding && designBinding(dir) === current.sealBinding) {
        const study = openStudy(dir).study;
        if (resolveAutonomy(study.autonomy, "design") === "auto") approvals.push(...requireGate(dir, study, "design", () => current.sealBinding));
      }
      if (approveDesign && current.pendingFinalApproval === current.finalBinding && current.finalBinding && finalGateBinding(dir) === current.finalBinding) {
        const study = openStudy(dir).study;
        if (resolveAutonomy(study.autonomy, "final") === "auto") approvals.push(...requireGate(dir, study, "final", () => current.finalBinding));
      }
      delete current.pendingAutoApproval; delete current.pendingFinalApproval;
    } else {
      current.sealing.evaluatorReadOnly = true;
      current.sealing.separateContainers = (current.pipeline ? current.pipeline.completed.every(parent => !!parent.record.containerId && state.id !== parent.record.containerId) : !!current.stages.candidate?.containerId && state.id !== current.stages.candidate.containerId);
    }
    return event;
  }, approvals);
}
function attemptContainerName(attempt: Attempt): string {
  const base = containerName(attempt.id, attempt.stage);
  return attempt.pipeline && attempt.stage === "candidate" ? `${base}-${attempt.pipeline.definition.candidate.stages[attempt.pipeline.index]!.name}` : base;
}
async function inspect(dir: string, attempt: Attempt, ctx: AttemptContext, ownershipOnly = false) {
  const protocol = ownershipOnly ? attempt.protocol : executionProtocol(dir, attempt);
  let result;
  try { result = await runOnExecutor(attempt.executor, "docker", ["inspect", "--format", INSPECT_FORMAT, attemptContainerName(attempt)], ctx.runner ?? spawnRunner, { maxOutputBytes: ATTEMPT_BYTES }); }
  catch { throw hostError(attempt, "container inspection"); }
  if (result.timedOut || result.truncated) throw hostError(attempt, "container inspection");
  if (result.exitCode === 1) {
    // inspect also exits 1 for daemon outages. Only a successful empty daemon listing confirms absence.
    const probe = await command(attempt, "container absence confirmation", "docker", ["ps", "--all", "--filter", `name=^/${attemptContainerName(attempt)}$`, "--format", "{{.ID}}"], ctx);
    if (probe.stdout.trim() === "") return undefined;
    throw hostError(attempt, "container inspection");
  }
  if (result.exitCode !== 0) throw hostError(attempt, "container inspection");
  let raw: unknown; try { raw = JSON.parse(result.stdout); } catch { throw hostError(attempt, "container inspection"); }
  return observed(raw, attempt, protocol, ownershipOnly);
}
/** Caller holds a fresh control fence; potentially long input hashing has already completed. */
const recoveryRunners = new WeakMap<AttemptContext, ProcessRunner>();
function boundedPipelineContext(dir: string, attempt: Attempt, ctx: AttemptContext): AttemptContext {
  if (!attempt.pipeline) return ctx;
  const runner = ctx.runner ?? spawnRunner;
  const bounded: AttemptContext = { ...ctx, runner: async request => {
    const seconds = remainingWallSeconds(dir, attempt, ctx);
    const result = await runner({ ...request, timeoutMs: Math.min(request.timeoutMs ?? 300_000, seconds * 1000) });
    return result;
  } };
  recoveryRunners.set(bounded, recoveryRunners.get(ctx) ?? runner);
  return bounded;
}
function remainingWallSeconds(dir: string, attempt: Attempt, ctx: AttemptContext): number {
  if (!attempt.pipeline) return attempt.protocol.limits.wallSeconds;
  const usage = budgetUsage(load(dir), now(ctx)), budget = attempt.protocol.budget;
  const seconds = Math.floor(Math.min(
    (Date.parse(attempt.startedAt) + attempt.protocol.limits.wallSeconds * 1000 - now(ctx)) / 1000,
    (budget.maxWallHours - usage.wallHours) * 3600,
    attempt.protocol.limits.gpus > 0 ? (budget.maxGpuHours - usage.gpuHours) * 3600 / attempt.protocol.limits.gpus : Infinity,
  ));
  if (seconds < 1) throw new EvidenceError("wall-clock", "pipeline: aggregate wall budget exhausted");
  return seconds;
}
function pipelineFailure(error: unknown): EvidenceError {
  if (error instanceof EvidenceError) return error;
  const message = error instanceof Error ? error.message : "pipeline verification failed";
  if (/budget exhausted|deadline/i.test(message)) return new EvidenceError("wall-clock", message);
  if (/metadata.*limit|payload.*bound|file.*bound|output budget|reservation exceeded|output.*limit/i.test(message)) return new EvidenceError("artifact-limit", message);
  return new EvidenceError("evidence-read", message);
}
function pipelineFailureAt(dir: string, attempt: Attempt, error: unknown, ctx: AttemptContext): EvidenceError {
  try { remainingWallSeconds(dir, attempt, ctx); } catch (budget) { return pipelineFailure(budget); }
  return pipelineFailure(error);
}
function retryablePipelineFailure(error: unknown): boolean {
  if (error instanceof RetentionError) return error.retryable;
  const message = error instanceof Error ? error.message : "";
  return /retention operation active|executor operation failed|malformed executor receipt|mismatched executor receipt|process start failed/i.test(message);
}
async function recordPipelinePreflightFailure(dir: string, attempt: Attempt, error: unknown, ctx: AttemptContext, elapsedMs = 0): Promise<Attempt> {
  try { remainingWallSeconds(dir, attempt, ctx); } catch (budget) { error = budget; }
  const failure = pipelineFailure(error), retryable = retryablePipelineFailure(error) && failure.reason !== "wall-clock";
  return update(dir, attempt.id, ctx, current => {
    if (current.status !== "running" || current.stage !== attempt.stage || current.pipeline?.index !== attempt.pipeline?.index || current.stages[current.stage]?.containerId) return undefined;
    if ((current.pipeline?.preflightRevision ?? 0) !== (attempt.pipeline?.preflightRevision ?? 0)) return undefined;
    if (attempt.launching) { if (current.launching?.token !== attempt.launching.token) return undefined; }
    else if (!current.stages[current.stage]?.launchPending || current.launching) return undefined;
    current.error = failure.message;
    if (current.reuse) current.reuse.failureMs = (current.reuse.failureMs ?? 0) + elapsedMs;
    delete current.launching;
    if (retryable) {
      current.stages[current.stage]!.launchPending = true; current.reason = "executor-preflight";
      return "attempt.executor-error";
    }
    delete current.stages[current.stage]!.launchPending;
    finish(current, "failed", failure.reason, ctx);
    return "attempt.failed";
  });
}
function addMaterialization(attempt: Attempt, elapsedMs: number): void {
  if (!attempt.reuse || !attempt.pipeline) return;
  const name = attempt.stage === "evaluator" ? "evaluator" : attempt.pipeline.definition.candidate.stages[attempt.pipeline.index]!.name;
  attempt.reuse.materializationMs += elapsedMs;
  (attempt.pipeline.materializationMs ??= {})[name] = (attempt.pipeline.materializationMs?.[name] ?? 0) + elapsedMs;
}
async function recordMaterialization(dir: string, attempt: Attempt, elapsedMs: number, ctx: AttemptContext): Promise<Attempt> {
  return update(dir, attempt.id, ctx, current => {
    if (current.status !== "running" || current.stage !== attempt.stage || current.pipeline?.index !== attempt.pipeline?.index || current.launching?.token !== attempt.launching?.token) throw new InputVerificationError("reuse: stage ownership changed during materialization; run ares attempt reconcile <dir> after the active control operation finishes before retrying");
    addMaterialization(current, elapsedMs); return "attempt.reuse.materialized";
  });
}
async function launch(dir: string, attempt: Attempt, user: string, ctx: AttemptContext, verifiedProtocol?: Protocol): Promise<Attempt> {
  const preflightStarted = performance.now();
  const recoveryCtx = { ...ctx, runner: recoveryRunners.get(ctx) ?? ctx.runner };
  ctx = boundedPipelineContext(dir, attempt, ctx);
  let args: string[];
  try {
    if (attempt.reuse) {
      attempt = await update(dir, attempt.id, recoveryCtx, current => {
        if (current.status !== "running" || current.stage !== attempt.stage || current.pipeline?.index !== attempt.pipeline?.index || current.launching?.token !== attempt.launching?.token) throw new InputVerificationError("reuse: preflight ownership changed; run ares attempt reconcile <dir> after the active control operation finishes before retrying");
        requireCopilotAccept(dir, "hypotheses");
        if (designBinding(dir) !== current.sealBinding) throw new InputVerificationError("reuse: design changed before preflight; inspect ares gate list <dir>, restore or approve the current design, then run ares attempt reconcile <dir> before retrying");
        requireGate(dir, openStudy(dir).study, "design", () => current.sealBinding);
        if (current.stages[current.stage]!.launchPending) return undefined;
        current.stages[current.stage]!.launchPending = true;
        return "attempt.reuse.preflight";
      });
    }
    if (attempt.pipeline) {
      if (designBinding(dir) !== attempt.sealBinding) throw new InputVerificationError("pipeline: design changed; restore the frozen approved definition before consumption");
      remainingWallSeconds(dir, attempt, ctx);
      const materialized = await materializePipeline(attempt, ctx), hashes = materialized.inputHashes;
      if (attempt.reuse) attempt = await recordMaterialization(dir, attempt, materialized.materializationMs, ctx);
      remainingWallSeconds(dir, attempt, ctx);
      if (JSON.stringify(hashes) !== JSON.stringify(attempt.pipeline!.inputHashes)) throw new InputVerificationError("pipeline: verified input identities changed before consumption");
    }
    const currentProtocol = executionProtocol(dir, attempt), protocol = attempt.pipeline ? currentProtocol : verifiedProtocol ?? currentProtocol;
    if (!sameProtocolInputs(currentProtocol, protocol)) throw new InputVerificationError("attempt inputs: identities changed after verification; restore the frozen input identities and retry ares attempt reconcile <dir>");
    if (attempt.pipeline && attempt.reuse && attempt.stage === "candidate") {
      requireCopilotAccept(dir, "hypotheses");
      requireGate(dir, openStudy(dir).study, "design", () => designBinding(dir));
      const decision = await prepareStageReuse(dir, attempt, ctx, source => showAttempt(dir, source));
      remainingWallSeconds(dir, attempt, ctx);
      const approvals: PendingEvent[] = [];
      const index = attempt.pipeline.index, name = attempt.pipeline.definition.candidate.stages[index]!.name;
      attempt = await update(dir, attempt.id, ctx, current => {
        if (current.status !== "running" || current.stage !== "candidate" || current.pipeline?.index !== index || current.pipeline.preflightRevision !== attempt.pipeline!.preflightRevision || current.launching?.token !== attempt.launching?.token) throw new InputVerificationError("reuse: stage ownership changed before admission; run ares attempt reconcile <dir> after the active control operation finishes before retrying");
        if (designBinding(dir) !== current.sealBinding) throw new InputVerificationError("reuse: current design changed before admission; inspect ares gate list <dir>, restore or approve the current design, then run ares attempt reconcile <dir> before retrying");
        requireCopilotAccept(dir, "hypotheses");
        const gate = requireGate(dir, openStudy(dir).study, "design", () => current.sealBinding);
        remainingWallSeconds(dir, current, ctx);
        decision.materializationMs = current.pipeline.materializationMs?.[name] ?? 0;
        if (decision.outcome === "reused") decision.receipt.materializationMs = decision.materializationMs;
        current.reuse!.verificationMs += decision.verificationMs;
        current.reuse!.stages[name] = { outcome: decision.outcome, reason: decision.reason, ...(decision.key ? { key: decision.key, context: decision.context } : {}), verificationMs: decision.verificationMs, materializationMs: decision.materializationMs, ...(decision.outcome === "reused" ? { source: decision.source } : {}) };
        if (decision.outcome === "fresh") return "attempt.reuse.miss";
        const outputs = outputBudget([...current.outputs, ...decision.outputs]);
        const sidecarBytes = (current.pipeline.sidecarBytes ?? 0) + decision.manifestBytes;
        if (Buffer.byteLength(JSON.stringify(outputs, null, 2)) + sidecarBytes > OUTPUT_METADATA_BYTES) throw new EvidenceError("artifact-limit", "reuse: shared output and retained metadata budget exhausted; reduce declared output count or metadata and use ares attempt run <dir> --retry ID");
        current.outputs = outputs; current.pipeline.sidecarBytes = sidecarBytes;
        current.pipeline.reusedSidecarBytes = (current.pipeline.reusedSidecarBytes ?? 0) + decision.manifestBytes;
        current.pipeline.completed.push({ name, record: decision.record, ref: decision.source, reuse: decision.receipt });
        current.sealing.candidateHasNoEvaluator = true;
        if (current.pendingAutoApproval === current.sealBinding) { approvals.push(...gate); delete current.pendingAutoApproval; }
        delete current.stages.candidate;
        if (index + 1 < current.pipeline.definition.candidate.stages.length) { current.pipeline.index++; current.protocol = executionView(current.pipeline.definition, current.pipeline.index); }
        else current.stage = "evaluator";
        current.paths = pipelinePaths(current);
        current.stages[current.stage] = stageRecord(current, current.stage, user, ctx);
        current.stages[current.stage]!.launchPending = true; delete current.launching;
        return "attempt.stage.reused";
      }, approvals);
      if (decision.outcome === "reused") return attempt;
    }
    // Keep configuration refusals outside the uncertain container-start catch.
    args = buildContainerArgs({ protocol, stage: attempt.stage, studyId: openStudy(dir).study.id, attemptId: attempt.id, seed: attempt.seed, user, paths: attempt.paths, ...(attempt.gpuDevices ? { gpuDevices: attempt.gpuDevices } : {}), ...(attempt.pipeline && attempt.stage === "candidate" ? { pipeline: { name: attempt.pipeline.definition.candidate.stages[attempt.pipeline.index]!.name, inputRoot: pipelineInputRoot(attempt)!, seed: attempt.pipeline.definition.candidate.stages[attempt.pipeline.index]!.seed } } : {}) });
    if (attempt.reuse) attempt = await update(dir, attempt.id, recoveryCtx, current => {
      if (current.status !== "running" || current.stage !== attempt.stage || current.pipeline?.index !== attempt.pipeline?.index || current.launching?.token !== attempt.launching?.token) throw new InputVerificationError("reuse: container launch ownership changed; run ares attempt reconcile <dir> after the active control operation finishes before retrying");
      requireCopilotAccept(dir, "hypotheses");
      if (designBinding(dir) !== current.sealBinding) throw new InputVerificationError("reuse: design changed before fresh execution; inspect ares gate list <dir>, restore or approve the current design, then run ares attempt reconcile <dir> before retrying");
      requireGate(dir, openStudy(dir).study, "design", () => current.sealBinding);
      delete current.stages[current.stage]!.launchPending;
      return "attempt.reuse.fresh-intent";
    });
  } catch (error) {
    if (attempt.pipeline) return recordPipelinePreflightFailure(dir, attempt, error, recoveryCtx, performance.now() - preflightStarted);
    if (error instanceof InputVerificationError) await update(dir, attempt.id, ctx, current => {
      if (current.status !== "running" || current.stage !== attempt.stage || current.stages[current.stage]?.containerId || current.launching?.token !== attempt.launching?.token) return undefined;
      const stage = current.stages[current.stage]!;
      if (stage.launchPending && !current.launching) return undefined;
      stage.launchPending = true; delete current.launching;
      return "attempt.input-unavailable";
    });
    throw error;
  }
  let startedId: string | undefined;
  try {
    const result = await command(attempt, "container start", "docker", args, ctx), cid = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(cid)) throw hostError(attempt, "container start");
    startedId = cid;
    attempt.stages[attempt.stage]!.containerId = cid;
    await startWatchdog(attempt.executor, attempt.id, attempt.stage, remainingWallSeconds(dir, attempt, ctx), ctx.runner ?? spawnRunner, cid);
    const state = await inspect(dir, attempt, ctx); if (!state) throw hostError(attempt, "container start verification");
    return recordVerifiedStage(dir, attempt, state, ctx, "attempt.stage.started");
  } catch {
    if (!startedId) {
      try {
        // A lost response is not proof that Docker rejected the start. Adopt only a verified owned container.
        const state = await inspect(dir, attempt, ctx);
        if (state) {
          if (state.running) await startWatchdog(attempt.executor, attempt.id, attempt.stage, remainingWallSeconds(dir, attempt, ctx), ctx.runner ?? spawnRunner, state.id);
          return recordVerifiedStage(dir, attempt, state, ctx, "attempt.stage.recovered");
        }
      } catch {
        return update(dir, attempt.id, ctx, current => { delete current.launching; current.reason = "executor-start-uncertain"; current.error = hostError(current, "container start confirmation").message; return "attempt.executor-error"; });
      }
    }
    // A name conflict can belong to another study with the same identity. Only clean up our returned container id.
    if (startedId) {
      try { await command(attempt, "failed launch cleanup", "docker", ["kill", startedId], recoveryCtx); }
      catch { return update(dir, attempt.id, ctx, current => { delete current.launching; current.reason = "executor-start"; current.error = hostError(current, "failed start cleanup").message; return "attempt.executor-error"; }); }
    }
    return update(dir, attempt.id, ctx, current => { if (current.status !== "running") return undefined; current.error = startupError(current, "container start"); finish(current, "failed", "executor-start", ctx); return "attempt.failed"; });
  }
}

async function captureStage(dir: string, attempt: Attempt, ctx: AttemptContext, bestEffort: boolean): Promise<Attempt> {
  if (attempt.stages[attempt.stage]?.evidence) return attempt;
  try {
    const collected = await (ctx.collectStageEvidence ?? defaultStageCollector)(attempt, attempt.stage, ctx.runner ?? spawnRunner);
    const metadata = (log: StageEvidence["logs"]["stdout"]) => ({ path: log.path, sha256: log.sha256, bytes: log.bytes, truncated: log.truncated });
    const evidence: StageEvidence = { logs: { stdout: metadata(collected.logs.stdout), stderr: metadata(collected.logs.stderr) }, outputs: collected.outputs.map(output => ({ path: output.path, sha256: output.sha256, bytes: output.bytes })) };
    const outputs = outputBudget([...attempt.outputs, ...evidence.outputs]);
    return update(dir, attempt.id, ctx, current => { current.stages[current.stage]!.evidence = evidence; current.outputs = outputs; return "attempt.stage.evidence"; });
  } catch (error) {
    const failure = error instanceof EvidenceError ? error : new EvidenceError("evidence-read", "stage evidence: collection failed; inspect the executor stage files and retry the attempt");
    if (!bestEffort) throw failure;
    return update(dir, attempt.id, ctx, current => { current.stages[current.stage]!.evidenceError = { reason: failure.reason, message: failure.message }; return "attempt.stage.evidence-failed"; });
  }
}

function existingReuseControls(attempt: Attempt, options: AttemptOptions): Attempt {
  const recordedMode = attempt.v === 3 ? attempt.reuse!.mode : attempt.freshRequest?.reuse ?? "off", recordedForceFresh = attempt.v === 3 ? attempt.reuse!.forceFresh : attempt.freshRequest?.forceFresh ?? false;
  if ((options.reuse ?? "off") !== recordedMode || (options.forceFresh ?? false) !== recordedForceFresh) throw new Error(`attempt: existing identity recorded reuse=${recordedMode}, forceFresh=${recordedForceFresh}; resend those controls or use --retry ${attempt.id} for an explicit new attempt`);
  return attempt;
}
export async function runAttempt(dirArg: string, options: AttemptOptions, ctx: AttemptContext): Promise<Attempt> {
  if (options.reuse !== undefined && options.reuse !== "off" && options.reuse !== "eligible") throw new Error("reuse: choose off or eligible; select --reuse off|eligible (MCP reuse) and retry");
  if (options.forceFresh !== undefined && typeof options.forceFresh !== "boolean") throw new Error("force-fresh: boolean required; set forceFresh to true/false or use the CLI --force-fresh flag, then retry");
  const controlCtx = ctx;
  const cleanupRunner = ctx.runner ?? spawnRunner;
  const dir = studyDir(dirArg), { study } = openStudy(dir);
  const frozen = await withLock(dir, () => {
    requireCopilotAccept(dir, "hypotheses");
    const design = readDesign(dir), executor = readExecutor(dir);
    if (!design) throw new Error("protocol: missing; run ares protocol <dir> --file PATH before attempt run");
    if (!executor) throw new Error("executor: missing; run ares executor set <dir> --kind local|ssh --workdir PATH before attempt run");
    return { ...design, executor, finalSeeds: readFinalSeeds(dir, design.protocol) };
  });
  const definition = frozen.protocol, protocol = executionView(definition), executor = frozen.executor;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(study.id)) throw new Error("study id: invalid; restore the id generated by ares init before attempt run");
  const run = runName(options.run ?? "main"), label = boundedText(options.label ?? "baseline", "label", 128), seed = options.seed ?? protocol.seeds[0]!;
  if (!Number.isSafeInteger(seed) || !protocol.seeds.includes(seed)) throw new Error("seed: undeclared; choose a seed from protocol.seeds");
  if (frozen.finalSeeds?.seeds.includes(seed) && run !== "final") throw new Error("attempt seed: reserved for run final; choose a non-reserved exploratory seed");
  if (run === "posthoc") await withLock(dir, () => requirePosthocClosed(dir));
  const finalAuthorization = run === "final" ? await withLock(dir, () => authorizeFinalAttempt(dir, options.commit, seed)) : undefined;
  if (options.retry !== undefined) id(options.retry);
  const initialBinding = frozen.binding;
  const snapshot = await resolveSnapshot(options.repo, options.commit, ctx.runner ?? spawnRunner), hash = protocolHash(definition);
  const wanted = attemptId(hash, snapshot.commit, snapshot.treeId, seed, run, options.retry);
  if (options.expectedId !== undefined && wanted !== options.expectedId) throw new Error("attempt identity: changed since plan intent; reconcile the plan node before retrying");
  const inputRoot = posix.join(executor.workdir, study.id, wanted);
  validateContainerInputSources(protocol, { snapshot: posix.join(inputRoot, "snapshot"), output: posix.join(inputRoot, "output"), evaluator: posix.join(inputRoot, "task", "evaluator"), result: posix.join(inputRoot, "result") });
  const existingAttempt = await withLock(dir, () => load(dir).find(a => a.id === wanted)), existing = existingAttempt !== undefined;
  if (existingAttempt) existingReuseControls(existingAttempt, options);
  const verifiedInputs = !existing && protocol.inputs !== undefined ? await verifyExecutorInputs(executor, protocol, ctx.runner ?? spawnRunner) : undefined;
  let gpuDevices: string[] | undefined;
  if (!existing && executor.gpu && protocol.limits.gpus > 0) {
    const admission = await probeGpuAdmission(executor, protocol.limits.gpus, ctx.runner ?? spawnRunner);
    if (admission.status === "deferred") {
      // An overlapping duplicate may have admitted the same identity during this read-only probe.
      const duplicate = await withLock(dir, () => load(dir).find(attempt => attempt.id === wanted));
      if (duplicate) return duplicate;
      throw new GpuAdmissionDeferred(admission);
    }
    gpuDevices = admission.devices;
  }
  let created = false, reserved = false;
  let attempt: Attempt;
  try { attempt = await withLock(dir, async () => {
    requireCopilotAccept(dir, "hypotheses");
    if (run === "posthoc") requirePosthocClosed(dir);
    if (finalAuthorization && authorizeFinalAttempt(dir, options.commit, seed).binding !== finalAuthorization.binding) throw new Error("final inputs changed during snapshot resolution; approve the current final gate before retrying");
    const attempts = load(dir), existing = attempts.find(a => a.id === wanted); if (existing) return existingReuseControls(existing, options);
    if (designBinding(dir) !== initialBinding) throw new Error("design: changed while resolving the snapshot; approve the current design and retry attempt run");
    if (options.retry && !attempts.some(a => a.id === options.retry)) throw new Error("retry: attempt not found; choose an existing id from ares attempt list");
    if (attempts.some(a => a.status === "running")) throw new Error("attempt: another attempt is running; reconcile or cancel it before starting a new one");
    const binding = designBinding(dir), approval = requireGate(dir, openStudy(dir).study, "design", () => binding);
    enforceBudget(protocol, attempts, now(ctx));
    if (definition.v === 2) { await retainedOperation(executor, { op: "reserve", studyId: study.id, attemptId: wanted, ...(executor.retentionCapBytes === undefined ? {} : { capBytes: executor.retentionCapBytes }) }, cleanupRunner); reserved = true; }
    const root = posix.join(executor.workdir, study.id, wanted);
    const controlled = definition.v === 2 && (options.reuse === "eligible" || options.forceFresh === true);
    const record: Attempt = { v: controlled ? 3 : definition.v, ...(definition.v === 1 && (options.reuse !== undefined || options.forceFresh !== undefined) ? { freshRequest: { reuse: options.reuse ?? "off", forceFresh: options.forceFresh ?? false } } : {}), ...(controlled ? { reuse: { mode: options.reuse ?? "off", forceFresh: options.forceFresh ?? false, stages: {}, verificationMs: 0, materializationMs: 0, failureMs: 0 } } : {}), ...(definition.v === 2 ? { pipeline: { definition, index: 0, completed: [], inputHashes: {}, taskTreeHash: frozen.treeHash } } : {}), id: wanted, studyId: study.id, run, protocolHash: hash, sealBinding: binding!, ...snapshot, seed, label, ...(options.retry ? { retryOf: options.retry } : {}), executor, ...(gpuDevices ? { gpuDevices } : {}), protocol: frozenProtocol(protocol), ...(verifiedInputs !== undefined ? { verifiedInputs } : {}), paths: { snapshot: posix.join(root, "snapshot"), output: posix.join(root, "output"), evaluator: posix.join(root, "task", "evaluator"), result: posix.join(root, "result") }, status: "running", stage: "candidate", startedAt: at(ctx), stages: {}, metrics: [], outputs: [], sealing: { separateContainers: false, evaluatorReadOnly: false, candidateHasNoEvaluator: false, verifiedBy: "ares-observed" }, launching: owner(ctx) };
    if (record.pipeline) record.paths = pipelinePaths(record);
    if (approval.length) record.pendingAutoApproval = binding!;
    if (finalAuthorization) { record.finalBinding = finalAuthorization.binding; record.finalWinner = finalAuthorization.winner; if (finalAuthorization.auto) record.pendingFinalApproval = finalAuthorization.binding; }
    commit(dir, [[file(dir, record), JSON.stringify(record, null, 2) + "\n", ATTEMPT_BYTES]], [{ actor: ctx.actor, type: "attempt.started", data: { id: wanted, run, seed, commit: record.commit, treeId: record.treeId } }]);
    created = true; return record;
  }); } catch (error) {
    if (reserved) await withLock(dir, async () => {
      if (!load(dir).some(record => record.id === wanted)) await retainedOperation(executor, { op: "release", studyId: study.id, attemptId: wanted }, cleanupRunner);
    });
    throw error;
  }
  if (attempt.pipeline) ctx = boundedPipelineContext(dir, attempt, ctx);
  if (created) {
    let preparationStep = "executor check";
    try {
      const checked = await checkExecutorInputs(attempt.executor, executionProtocol(dir, attempt), ctx.runner ?? spawnRunner);
      const root = posix.dirname(attempt.paths.snapshot), studyRoot = posix.dirname(root), base = executor.workdir;
      // Require a private, owned, physical root. Attempt mkdir is exclusive, never a shared pre-existing directory.
      const stageDirectories = attempt.pipeline ? attempt.pipeline.definition.candidate.stages.map(stage => posix.join(root, "stages", stage.name, "output")) : [];
      const script = `set -eu; umask 077; base=${shellQuote(base)}; test -d "$base"; test ! -L "$base"; test -O "$base"; test "$(cd -P "$base" && pwd -P)" = "$base"; mode=$(stat -c %a "$base" 2>/dev/null || stat -f %Lp "$base"); test "$mode" = 700; study=${shellQuote(studyRoot)}; if test ! -e "$study"; then mkdir -m 700 "$study"; fi; test -d "$study"; test ! -L "$study"; test -O "$study"; mode=$(stat -c %a "$study" 2>/dev/null || stat -f %Lp "$study"); test "$mode" = 700; mkdir -m 700 ${shellQuote(root)}; mkdir -p -m 700 ${stageDirectories.length ? stageDirectories.map(shellQuote).join(" ") : shellQuote(posix.join(root, "stages"))}; mkdir -m 700 ${[attempt.paths.snapshot, ...(!attempt.pipeline ? [attempt.paths.output] : []), attempt.paths.result, posix.dirname(attempt.paths.evaluator)].map(shellQuote).join(" ")}`;
      preparationStep = "private workspace preparation";
      await command(attempt, "private workspace preparation", "sh", ["-c", script], ctx);
      preparationStep = "snapshot transfer";
      const transferred = await transferSnapshot(options.repo, snapshot.commit, executor, attempt.paths.snapshot, ctx.runner ?? spawnRunner);
      if (attempt.pipeline) {
        preparationStep = "code snapshot verification";
        const receipt = await retainedOperation(attempt.executor, { op: "snapshot", studyId: attempt.studyId, attemptId: attempt.id, source: attempt.paths.snapshot }, ctx.runner ?? spawnRunner);
        if (!receipt.sha256 || !/^[a-f0-9]{64}$/.test(receipt.sha256)) throw new Error("pipeline: invalid frozen code snapshot receipt");
        attempt = await update(dir, attempt.id, ctx, current => { current.pipeline!.codeSnapshotHash = receipt.sha256; return "attempt.pipeline.code"; });
      }
      preparationStep = "evaluator transfer";
      await transferTask(join(dir, "task"), executor, posix.dirname(attempt.paths.evaluator), ctx.runner ?? spawnRunner, frozen.treeHash, !!attempt.pipeline);
      if (attempt.pipeline) {
        for (let index = 1; index < attempt.pipeline.definition.candidate.stages.length; index++) await checkExecutorInputs(executor, executionView(attempt.pipeline.definition, index), ctx.runner ?? spawnRunner);
        const materialized = await materializePipeline(attempt, ctx);
        if (attempt.reuse) attempt = await recordMaterialization(dir, attempt, materialized.materializationMs, ctx);
        attempt = await update(dir, attempt.id, ctx, current => { current.pipeline!.inputHashes = materialized.inputHashes; return "attempt.pipeline.inputs"; });
      }
      preparationStep = "design recheck";
      if (designBinding(dir) !== attempt.sealBinding) throw new Error("design changed during preparation");
      if (attempt.finalBinding && finalGateBinding(dir) !== attempt.finalBinding) throw new Error("final inputs changed during preparation");
      const claim = attempt.launching!.token;
      attempt = await update(dir, attempt.id, ctx, current => { if (current.status !== "running" || current.launching?.token !== claim) throw new Error("attempt preparation: ownership changed; run ares attempt reconcile before retrying"); current.snapshotSha256 = transferred.sha256; current.stages.candidate = stageRecord(current, "candidate", checked.user, ctx); return "attempt.snapshot"; });
      preparationStep = "controller lock";
      attempt = await withControl(dir, async () => {
        const current = showAttempt(dir, attempt.id);
        if (current.status !== "running" || current.launching?.token !== claim) return current;
        return launch(dir, current, checked.user, ctx, protocol);
      });
    } catch (error) {
      if (!attempt.pipeline && error instanceof InputVerificationError) throw error;
      const failure = attempt.pipeline ? pipelineFailureAt(dir, attempt, error, controlCtx) : undefined;
      attempt = await update(dir, attempt.id, ctx, current => { if (current.status !== "running") return undefined; current.error = failure ? `${preparationStep}: ${failure.message}` : startupError(current, preparationStep); finish(current, "failed", failure?.reason ?? "preparation", ctx); return "attempt.failed"; });
    }
  }
  if (attempt.pipeline && attempt.status === "failed") await reconcileRetentionReservations(dir, controlCtx);
  if (!options.detach) {
    let delay = 1000;
    while (attempt.status === "running") {
      await (ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
      const previousStage = attempt.stage;
      await reconcileAttempts(dir, controlCtx); attempt = showAttempt(dir, wanted);
      delay = attempt.stage === previousStage ? Math.min(delay * 2, 30_000) : 1000;
    }
  }
  return attempt;
}

async function verifyAndLaunchPending(dir: string, pending: Attempt, ctx: AttemptContext): Promise<Attempt | undefined> {
  ctx = boundedPipelineContext(dir, pending, ctx);
  const protocol = executionProtocol(dir, pending);
  let hashes: Record<string, string> | undefined, materializationMs = 0;
  const preflightStarted = performance.now();
  try {
    if (pending.reuse) {
      requireCopilotAccept(dir, "hypotheses");
      if (designBinding(dir) !== pending.sealBinding) throw new InputVerificationError("reuse: design changed before pending consumption; inspect ares gate list <dir>, restore or approve the current design, then run ares attempt reconcile <dir> before retrying");
      requireGate(dir, openStudy(dir).study, "design", () => pending.sealBinding);
    }
    const materialized = pending.pipeline ? await materializePipeline(pending, ctx) : undefined;
    hashes = materialized?.inputHashes; materializationMs = materialized?.materializationMs ?? 0;
    validateContainerInputSources(protocol, pending.paths);
    await verifyExecutorInputs(pending.executor, protocol, ctx.runner ?? spawnRunner);
  } catch (error) {
    if (!pending.pipeline) throw error;
    return withControl(dir, () => recordPipelinePreflightFailure(dir, pending, error, ctx, performance.now() - preflightStarted));
  }
  return withControl(dir, async () => {
    const current = showAttempt(dir, pending.id);
    if (current.status !== "running" || current.stage !== pending.stage || !current.stages[current.stage]?.launchPending || alive(current, ctx)) return undefined;
    if (pending.pipeline && (current.pipeline?.index !== pending.pipeline.index || current.protocolHash !== pending.protocolHash || (current.pipeline?.preflightRevision ?? 0) !== (pending.pipeline.preflightRevision ?? 0) || canonical(current.protocol) !== canonical(protocol))) return undefined;
    executionProtocol(dir, current); // Recheck the frozen identities after hashing, under the fresh launch fence.
    const claimed = await update(dir, current.id, ctx, value => {
      if (hashes) value.pipeline!.inputHashes = hashes;
      if (value.reuse) addMaterialization(value, materializationMs);
      if (value.pipeline) value.pipeline.preflightRevision = (value.pipeline.preflightRevision ?? 0) + 1;
      delete value.stages[value.stage]!.launchPending; value.launching = owner(ctx);
      return "attempt.stage.retry-intent";
    });
    return launch(dir, claimed, claimed.stages[claimed.stage]!.user, ctx, protocol);
  });
}

export async function reconcileAttempts(dirArg: string, ctx: AttemptContext): Promise<Attempt[]> {
  const dir = studyDir(dirArg);
  const pending: Attempt[] = [];
  const changed = await withControl(dir, async () => {
  const changed: Attempt[] = [];
  for (let attempt of load(dir).filter(a => a.status === "running")) {
    if (alive(attempt, ctx)) continue;
    let observedState: ObservedStage | undefined;
    try {
      let state = await inspect(dir, attempt, ctx);
      observedState = state;
      if (!state) {
        if (attempt.stages[attempt.stage]?.launchPending) pending.push(attempt);
        else changed.push(await update(dir, attempt.id, ctx, current => { finish(current, "unknown", "lost", ctx); return "attempt.unknown"; }));
        continue;
      }
      const recovered = needsReceipt(attempt, state);
      if (recovered) attempt = await recordVerifiedStage(dir, attempt, state, ctx, "attempt.stage.recovered");
      const stage = attempt.stages[attempt.stage];
      if (!stage) throw hostError(attempt, "stage record");
      const deadline = (attempt.pipeline ? Date.parse(attempt.startedAt) : Date.parse(stage.startedAt)) + stage.limits.wallSeconds * 1000;
      const usage = attempt.pipeline ? budgetUsage(load(dir), now(ctx)) : undefined;
      const exhausted = usage && (usage.wallHours >= attempt.protocol.budget.maxWallHours || (attempt.protocol.limits.gpus > 0 && usage.gpuHours >= attempt.protocol.budget.maxGpuHours));
      if ((state.running && (now(ctx) >= deadline || exhausted)) || (!state.running && ((attempt.pipeline && (now(ctx) >= deadline || exhausted)) || (state.finishedAt !== undefined && Date.parse(state.finishedAt) >= deadline)))) {
        if (state.running) {
          await command(attempt, "wall-clock kill", "docker", ["kill", state.id], ctx);
          const stopped = await inspect(dir, attempt, ctx);
          if (stopped) state = stopped;
          else if (attempt.pipeline) state = { ...state, running: false, exitCode: 137, finishedAt: at(ctx) };
          if (attempt.pipeline && state.running) throw new EvidenceError("executor-stop", "pipeline: container termination is not yet observed; active attempt and retention reservation remain held");
        }
        attempt = await captureStage(dir, attempt, ctx, true);
        const ended = state;
        changed.push(await update(dir, attempt.id, ctx, current => { if (ended.finishedAt) current.stages[current.stage]!.endedAt = ended.finishedAt; if (!ended.running) current.stages[current.stage]!.exitCode = ended.exitCode; finish(current, "failed", "wall-clock", ctx); return "attempt.failed"; })); continue;
      }
      if (state.running) {
        if (recovered) changed.push(attempt);
        continue;
      }
      if (state.exitCode !== 0) { attempt = await captureStage(dir, attempt, ctx, true); const ended = state; changed.push(await update(dir, attempt.id, ctx, current => { current.stages[current.stage]!.exitCode = ended.exitCode; if (ended.finishedAt) current.stages[current.stage]!.endedAt = ended.finishedAt; finish(current, "failed", `${current.stage}-exit`, ctx); return "attempt.failed"; })); continue; }
      try { attempt = await captureStage(dir, attempt, boundedPipelineContext(dir, attempt, ctx), false); }
      catch (error) {
        const failure = attempt.pipeline ? pipelineFailureAt(dir, attempt, error, ctx) : error as EvidenceError, ended = state;
        changed.push(await update(dir, attempt.id, ctx, current => {
          current.stages[current.stage]!.exitCode = ended.exitCode;
          if (ended.finishedAt) current.stages[current.stage]!.endedAt = ended.finishedAt;
          current.error = failure.message; finish(current, "failed", failure.reason, ctx); return "attempt.failed";
        })); continue;
      }
      if (attempt.stage === "candidate" && attempt.pipeline) {
        attempt = await update(dir, attempt.id, ctx, current => { current.stages.candidate!.exitCode = 0; current.stages.candidate!.endedAt = state.finishedAt ?? at(ctx); return "attempt.stage.terminated"; });
        const ref = await sealPipeline(attempt, boundedPipelineContext(dir, attempt, ctx));
        const next = await update(dir, attempt.id, ctx, current => {
          const pipeline = current.pipeline!, completed = current.stages.candidate!;
          pipeline.sidecarBytes = attempt.pipeline!.sidecarBytes;
          pipeline.completed.push({ name: pipeline.definition.candidate.stages[pipeline.index]!.name, record: completed, ref });
          delete current.stages.candidate;
          if (pipeline.index + 1 < pipeline.definition.candidate.stages.length) { pipeline.index++; current.protocol = executionView(pipeline.definition, pipeline.index); }
          else current.stage = "evaluator";
          current.paths = pipelinePaths(current);
          current.stages[current.stage] = stageRecord(current, current.stage, stage.user, ctx);
          current.stages[current.stage]!.launchPending = true; delete current.launching;
          return "attempt.stage.changed";
        });
        pending.push(next);
      } else if (attempt.stage === "candidate") {
        const next = await update(dir, attempt.id, ctx, current => {
          current.stages.candidate!.exitCode = 0; current.stages.candidate!.endedAt = state.finishedAt ?? at(ctx); current.stage = "evaluator";
          current.stages.evaluator = stageRecord(current, "evaluator", stage.user, ctx);
          if (Object.keys(current.protocol.inputs ?? {}).length) { current.stages.evaluator.launchPending = true; delete current.launching; }
          else current.launching = owner(ctx);
          return "attempt.stage.changed";
        });
        if (next.stages.evaluator?.launchPending) pending.push(next);
        else changed.push(await launch(dir, next, stage.user, ctx));
      } else {
        let evaluation: Evaluation | undefined, failure: EvidenceError | undefined;
        try {
          const bounded = boundedPipelineContext(dir, attempt, ctx);
          evaluation = await (ctx.collectEvaluation ?? defaultEvaluationCollector)(attempt, bounded.runner ?? spawnRunner);
          if (attempt.pipeline) remainingWallSeconds(dir, attempt, ctx);
        }
        catch (error) {
          evaluation = undefined;
          if (attempt.pipeline) failure = pipelineFailureAt(dir, attempt, error, ctx);
          else failure = error instanceof EvidenceError ? error : new MetricsError("invalid-metrics", "evaluator result validation failed");
        }
        changed.push(await update(dir, attempt.id, ctx, current => {
          current.stages.evaluator!.exitCode = 0;
          if (state.finishedAt) current.stages.evaluator!.endedAt = state.finishedAt;
          if (!evaluation) { const rejected = failure ?? new MetricsError("invalid-metrics", "the collector returned no result"); current.error = rejected.message; finish(current, "failed", rejected.reason, ctx); return "attempt.failed"; }
          if (current.pipeline && Buffer.byteLength(JSON.stringify(outputBudget([...current.outputs, ...evaluation.outputs]), null, 2)) + (current.pipeline.sidecarBytes ?? 0) > OUTPUT_METADATA_BYTES) {
            current.error = "pipeline: total output metadata including retained sidecars exceeds the attempt limit"; finish(current, "failed", "artifact-limit", ctx); return "attempt.failed";
          }
          current.metrics = evaluation.metrics; current.outputs = outputBudget([...current.outputs, ...evaluation.outputs]); finish(current, "succeeded", undefined, ctx); return "attempt.succeeded";
        }));
      }
    } catch (error) {
      if (attempt.pipeline && observedState && !observedState.running) {
        const failure = pipelineFailureAt(dir, attempt, error, ctx);
        const retryable = retryablePipelineFailure(error) && failure.reason !== "wall-clock";
        changed.push(await update(dir, attempt.id, ctx, current => {
          if (current.status !== "running") return undefined;
          const stage = current.stages[current.stage];
          if (stage) { stage.exitCode = observedState!.exitCode; stage.endedAt = observedState!.finishedAt ?? at(ctx); delete stage.launchPending; }
          current.error = failure.message;
          if (retryable) { current.reason = "executor-seal"; return "attempt.executor-error"; }
          finish(current, "failed", failure.reason, ctx); return "attempt.failed";
        }));
        continue;
      }
      if (error instanceof InputVerificationError) throw error;
      await update(dir, attempt.id, ctx, current => { delete current.launching; current.error = error instanceof Error ? error.message : hostError(current, "reconcile").message; if (current.pipeline && error instanceof EvidenceError) current.reason = error.reason; return "attempt.executor-error"; });
      throw hostError(attempt, "reconcile");
    }
  }
  return changed;
  });
  // No control lock or launch claim is held across a potentially 40-minute manifest pass.
  for (const attempt of pending) {
    const launched = await verifyAndLaunchPending(dir, attempt, ctx);
    if (launched) changed.push(launched);
  }
  await reconcileRetentionReservations(dir, ctx);
  return changed;
}
/** Explicit reconciliation only frees a hold after the executor confirms no owned live container. */
async function reconcileRetentionReservations(dir: string, ctx: AttemptContext): Promise<void> {
  const executor = readExecutor(dir), { study } = openStudy(dir);
  if (!executor || (!load(dir).some(attempt => !!attempt.pipeline) && readProtocol(dir)?.v !== 2)) return;
  if (load(dir).some(attempt => attempt.status === "running")) return;
  const view = await retainedOperation(executor, { op: "inspect", studyId: study.id }, ctx.runner ?? spawnRunner);
  for (const reservation of view.reservations ?? []) {
    if (!reservation.active) continue;
    const attempt = load(dir).find(value => value.id === reservation.attemptId);
    if (attempt?.status === "running") continue;
    try { await withControl(dir, () => withLock(dir, async () => {
      const current = load(dir).find(value => value.id === reservation.attemptId);
      if (current?.status === "running") return;
      const live = await runOnExecutor(executor, "docker", ["ps", "--filter", `label=ares.study=${study.id}`, "--filter", `label=ares.attempt=${reservation.attemptId}`, "--format", "{{.ID}}"], ctx.runner ?? spawnRunner);
      if (live.exitCode !== 0 || live.timedOut || live.truncated || live.stdout.trim()) return;
      await retainedOperation(executor, { op: "release", studyId: study.id, attemptId: reservation.attemptId }, ctx.runner ?? spawnRunner);
    })); } catch (error) { if (!(error instanceof StudyLockBusyError)) throw error; }
  }
}
export async function cancelAttempt(dirArg: string, wanted: string, reason: string | undefined, ctx: AttemptContext, completion?: (attempt: Attempt) => PendingEvent[]): Promise<Attempt> {
  const dir = studyDir(dirArg), why = reason === undefined ? undefined : boundedText(reason, "reason", 500);
  return withControl(dir, async () => {
  let attempt = showAttempt(dir, id(wanted));
  if (attempt.status !== "running") return withLock(dir, () => {
    const current = showAttempt(dir, wanted);
    const pending = completion?.(current) ?? [];
    if (pending.length) commit(dir, [], pending);
    return current;
  });
  if (alive(attempt, ctx)) throw new Error("attempt: another startup operation is active; retry cancel when it finishes (abandoned claims expire after 30 minutes)");
  try {
    let state = await inspect(dir, attempt, ctx, true);
    if (state && needsReceipt(attempt, state)) {
      const owned = state;
      attempt = await update(dir, attempt.id, ctx, current => {
        current.stages[current.stage]!.containerId = owned.id;
        if (owned.startedAt) current.stages[current.stage]!.startedAt = owned.startedAt;
        delete current.launching;
        // Ownership permits cancellation; it does not establish isolation or approve any gate.
        return "attempt.stage.recovered";
      });
    }
    if (state?.running) { await command(attempt, "cancel kill", "docker", ["kill", state.id], ctx); state = await inspect(dir, attempt, ctx, true); }
    if (attempt.pipeline && state?.running) throw hostError(attempt, "cancellation termination confirmation");
    if (state) attempt = await captureStage(dir, attempt, ctx, true);
    if (attempt.pipeline) await retainedOperation(attempt.executor, { op: "release", studyId: attempt.studyId, attemptId: attempt.id }, ctx.runner ?? spawnRunner);
    const ended = state;
    return update(dir, attempt.id, ctx, current => { if (ended && !ended.running) { current.stages[current.stage]!.exitCode = ended.exitCode; if (ended.finishedAt) current.stages[current.stage]!.endedAt = ended.finishedAt; } finish(current, "cancelled", why ?? "cancelled", ctx); return "attempt.cancelled"; }, [], completion);
  } catch (error) {
    await update(dir, attempt.id, ctx, current => { delete current.launching; return "attempt.executor-error"; });
    if (error instanceof InputVerificationError) throw error;
    throw hostError(attempt, "cancel");
  }
  });
}
