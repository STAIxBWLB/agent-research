import { closeSync, existsSync, lstatSync, openSync, opendirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { boundedText, commit, openStudy, plain, readJsonFile, readTextBounded, requireExperiment, requireGate, sha256, withLock, type Actor, type PendingEvent } from "../study.ts";
import { designBinding, protocolHash, readDesign, type Protocol } from "./protocol.ts";
import { buildContainerArgs, checkExecutorInputs, containerName, readExecutor, runOnExecutor, shellQuote, spawnRunner, startWatchdog, type ContainerPaths, type Executor, type ProcessRunner, type Stage } from "./executor.ts";
import { resolveSnapshot, transferSnapshot, transferTask } from "./snapshot.ts";
import { collectEvaluation as defaultEvaluationCollector, collectStageEvidence as defaultStageCollector, EvidenceError, MetricsError, outputBudget, type StageEvidence } from "./metrics.ts";

export type AttemptStatus = "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export interface AttemptStage { image: string; argv: string[]; mounts: { target: string; readOnly: boolean }[]; network: "none"; limits: Protocol["limits"]; user: string; containerId?: string; startedAt: string; endedAt?: string; exitCode?: number; evidence?: StageEvidence; evidenceError?: { reason: string; message: string } }
export interface Evaluation { metrics: { name: string; unit: string; value: number; provenance: "ares-observed" }[]; outputs: { path: string; sha256: string; bytes: number }[] }
export interface Attempt {
  v: 1; id: string; studyId: string; run: string; protocolHash: string; sealBinding: string; commit: string; treeId: string; snapshotSha256?: string; seed: number; label: string; retryOf?: string;
  executor: Executor; protocol: Protocol; paths: ContainerPaths; status: AttemptStatus; stage: Stage; reason?: string; error?: string; startedAt: string; endedAt?: string;
  stages: Partial<Record<Stage, AttemptStage>>; metrics: Evaluation["metrics"]; outputs: Evaluation["outputs"];
  sealing: { separateContainers: boolean; evaluatorReadOnly: boolean; candidateHasNoEvaluator: boolean; verifiedBy: "ares-observed" };
  launching?: { pid: number; host: string; token: string; claimedAt: string; expiresAt: string };
  pendingAutoApproval?: string;
}
export interface AttemptOptions { repo: string; commit: string; seed?: number; run?: string; label?: string; retry?: string; detach?: boolean }
/** collectEvaluation is T4's validating adapter; T3 does not parse or validate metric schemas. */
export interface AttemptContext { actor: Actor; runner?: ProcessRunner; now?: () => number; sleep?: (ms: number) => Promise<void>; collectEvaluation?: (attempt: Attempt, runner: ProcessRunner) => Promise<Evaluation>; collectStageEvidence?: (attempt: Attempt, stage: Stage, runner: ProcessRunner) => Promise<StageEvidence> }
export const ATTEMPT_BYTES = 1024 * 1024;
// Startup includes bounded image pulls and two 5-minute transfers; claims never survive indefinitely after a crash.
export const CONTROL_STALE_MS = 30 * 60_000;
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
      if (plain(raw) && (raw.v !== 1 || (typeof raw.status === "string" && !STATUSES.includes(raw.status as AttemptStatus)) || (typeof raw.stage === "string" && !["candidate", "evaluator"].includes(raw.stage)))) throw new Error("attempt record: unsupported schema version, status or stage; use an ares version that supports this record, keeping the original file unchanged");
      if (!plain(raw) || raw.v !== 1 || raw.run !== run || raw.id !== name.slice(0, 16) || !STATUSES.includes(raw.status as AttemptStatus) || !["candidate", "evaluator"].includes(raw.stage as string) || !plain(raw.stages) || !plain(raw.protocol) || !plain(raw.executor) || typeof raw.startedAt !== "string" || !Number.isFinite(Date.parse(raw.startedAt))) throw new Error("attempt record: malformed; restore its last valid version before retrying");
      if (++count > 1_000_000) throw new Error("attempt store: more than 1000000 records; archive the study and start a new one");
      yield raw as unknown as Attempt;
    }
  }
}
function load(dir: string): Attempt[] { return [...records(dir)]; }
function studyDir(dirArg: string): string { const { dir, study } = openStudy(dirArg); requireExperiment(study); return dir; }
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
  commit(dir, [[file(dir, attempt), JSON.stringify(attempt, null, 2) + "\n", ATTEMPT_BYTES]], [...approvals, { actor: ctx.actor, type: event, data: { id: attempt.id, run: attempt.run, stage: attempt.stage, status: attempt.status, ...(attempt.reason ? { reason: attempt.reason } : {}) } }]);
}
export function budgetUsage(attempts: Attempt[], time = Date.now()) {
  let wallHours = 0, gpuHours = 0;
  for (const attempt of attempts) {
    const elapsed = Math.max(0, (attempt.endedAt ? Date.parse(attempt.endedAt) : time) - Date.parse(attempt.startedAt)) / 3_600_000;
    if (!Number.isFinite(elapsed)) throw new Error("attempt timing: malformed; restore valid timestamps before starting an attempt");
    wallHours += elapsed;
    for (const stage of Object.values(attempt.stages)) {
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
      if (age < 0 || age >= CONTROL_STALE_MS) {
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
async function update(dir: string, attemptId: string, ctx: AttemptContext, fn: (current: Attempt) => string | undefined, approvals: PendingEvent[] = []): Promise<Attempt> {
  return withLock(dir, () => {
    const scope = controlScope.getStore();
    if (scope?.dir === dir) {
      let currentToken: string | undefined;
      try { currentToken = readTextBounded(join(dir, ".ares.control.lock"), 128); } catch { /* expired or replaced */ }
      if (currentToken !== scope.token) throw new Error("attempt control: ownership expired or changed; run ares attempt reconcile before retrying this operation");
    }
    const current = showAttempt(dir, attemptId), event = fn(current); if (event) save(dir, current, ctx, event, approvals); return current;
  });
}
function finish(attempt: Attempt, status: AttemptStatus, reason: string | undefined, ctx: AttemptContext): void {
  attempt.status = status; if (reason) attempt.reason = reason; else delete attempt.reason;
  if (status === "succeeded") delete attempt.error;
  attempt.endedAt = at(ctx); delete attempt.launching; delete attempt.pendingAutoApproval;
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
function stageRecord(attempt: Attempt, stage: Stage, user: string, ctx: AttemptContext): AttemptStage {
  return { image: attempt.protocol[stage].image, argv: attempt.protocol[stage].command, mounts: stage === "candidate" ? [{ target: "/workspace", readOnly: true }, { target: "/out", readOnly: false }] : [{ target: "/eval", readOnly: true }, { target: "/candidate", readOnly: true }, { target: "/result", readOnly: false }], network: "none", limits: attempt.protocol.limits, user, startedAt: at(ctx) };
}

/** Validate observed container settings before describing its sealing as ares-observed. */
function observed(raw: unknown, attempt: Attempt): { id: string; running: boolean; exitCode: number; finishedAt?: string; startedAt?: string } {
  const value = Array.isArray(raw) && raw.length === 1 ? raw[0] : undefined;
  if (!plain(value) || typeof value.Id !== "string" || !/^[a-f0-9]{64}$/.test(value.Id) || !plain(value.State) || typeof value.State.Running !== "boolean" || !Number.isSafeInteger(value.State.ExitCode) || !plain(value.Config) || !plain(value.HostConfig) || !Array.isArray(value.Mounts)) throw hostError(attempt, "container inspection");
  const expected = attempt.stages[attempt.stage]!, config = value.Config, settings = value.HostConfig;
  const mounts = attempt.stage === "candidate" ? [[attempt.paths.snapshot, "/workspace", false], [attempt.paths.output, "/out", true]] : [[attempt.paths.evaluator, "/eval", false], [attempt.paths.output, "/candidate", false], [attempt.paths.result, "/result", true]];
  const bindMounts = value.Mounts.filter(m => !(plain(m) && m.Type === "tmpfs" && m.Destination === "/tmp"));
  const devices = settings.DeviceRequests;
  const gpuMatches = expected.limits.gpus === 0 ? devices === null || devices === undefined || (Array.isArray(devices) && devices.length === 0) : Array.isArray(devices) && devices.length === 1 && plain(devices[0]) && devices[0].Count === expected.limits.gpus && Array.isArray(devices[0].Capabilities) && devices[0].Capabilities.some(c => Array.isArray(c) && c.includes("gpu"));
  if (!gpuMatches) throw hostError(attempt, "GPU limit verification");
  if (config.Seed !== `ARES_SEED=${attempt.seed}`) throw hostError(attempt, "selected seed verification");
  if (config.Image !== expected.image || config.User !== expected.user || JSON.stringify(config.Cmd) !== JSON.stringify(expected.argv) || !plain(config.Labels) || config.Labels["ares.study"] !== attempt.studyId || config.Labels["ares.attempt"] !== attempt.id || config.Labels["ares.stage"] !== attempt.stage || settings.NetworkMode !== "none" || settings.ReadonlyRootfs !== true || !Array.isArray(settings.CapDrop) || !settings.CapDrop.some(c => c === "ALL" || c === "all") || !Array.isArray(settings.SecurityOpt) || !settings.SecurityOpt.includes("no-new-privileges") || !plain(settings.Tmpfs) || !("/tmp" in settings.Tmpfs) || settings.Memory !== expected.limits.memoryMb * 1024 * 1024 || settings.PidsLimit !== expected.limits.pidsLimit || settings.NanoCpus !== Math.round(expected.limits.cpus * 1e9) || bindMounts.length !== mounts.length || !mounts.every(([source, target, writable]) => bindMounts.some(m => plain(m) && m.Type === "bind" && m.Source === source && m.Destination === target && m.RW === writable))) throw hostError(attempt, "container isolation verification");
  if (expected.containerId && value.Id !== expected.containerId) throw hostError(attempt, "container identity verification");
  const finishedAt = typeof value.State.FinishedAt === "string" && Number.isFinite(Date.parse(value.State.FinishedAt)) ? value.State.FinishedAt : undefined;
  const startedAt = typeof value.State.StartedAt === "string" && Number.isFinite(Date.parse(value.State.StartedAt)) ? value.State.StartedAt : undefined;
  return { id: value.Id, running: value.State.Running, exitCode: value.State.ExitCode as number, ...(finishedAt ? { finishedAt } : {}), ...(startedAt ? { startedAt } : {}) };
}
type ObservedStage = ReturnType<typeof observed>;
function needsReceipt(attempt: Attempt, state: ObservedStage): boolean {
  const stage = attempt.stages[attempt.stage]!;
  return !!attempt.launching || stage.containerId !== state.id || (!!state.startedAt && stage.startedAt !== state.startedAt) || (attempt.stage === "candidate" ? !attempt.sealing.candidateHasNoEvaluator || !!attempt.pendingAutoApproval : !attempt.sealing.evaluatorReadOnly || !attempt.sealing.separateContainers);
}
/** Every verified path persists the same receipt; auto approval and candidate receipt share one commit. */
async function recordVerifiedStage(dir: string, attempt: Attempt, state: ObservedStage, ctx: AttemptContext, event: string, approveDesign = true): Promise<Attempt> {
  const approvals: PendingEvent[] = [];
  return update(dir, attempt.id, ctx, current => {
    if (current.status !== "running" || current.stage !== attempt.stage) return undefined;
    const stage = current.stages[current.stage]!;
    stage.containerId = state.id; if (state.startedAt) stage.startedAt = state.startedAt;
    if (current.reason === "executor-start" || current.reason === "executor-start-uncertain") { delete current.reason; delete current.error; }
    delete current.launching;
    if (current.stage === "candidate") {
      current.sealing.candidateHasNoEvaluator = true;
      if (approveDesign && current.pendingAutoApproval === current.sealBinding && designBinding(dir) === current.sealBinding) {
        approvals.push(...requireGate(dir, { ...openStudy(dir).study, autonomy: "auto" }, "design", () => current.sealBinding));
      }
      delete current.pendingAutoApproval;
    } else {
      current.sealing.evaluatorReadOnly = true;
      current.sealing.separateContainers = !!current.stages.candidate?.containerId && state.id !== current.stages.candidate.containerId;
    }
    return event;
  }, approvals);
}
async function inspect(attempt: Attempt, ctx: AttemptContext) {
  let result;
  try { result = await runOnExecutor(attempt.executor, "docker", ["inspect", "--format", INSPECT_FORMAT, containerName(attempt.id, attempt.stage)], ctx.runner ?? spawnRunner, { maxOutputBytes: ATTEMPT_BYTES }); }
  catch { throw hostError(attempt, "container inspection"); }
  if (result.timedOut || result.truncated) throw hostError(attempt, "container inspection");
  if (result.exitCode === 1) {
    // inspect also exits 1 for daemon outages. Only a successful empty daemon listing confirms absence.
    const probe = await command(attempt, "container absence confirmation", "docker", ["ps", "--all", "--filter", `name=^/${containerName(attempt.id, attempt.stage)}$`, "--format", "{{.ID}}"], ctx);
    if (probe.stdout.trim() === "") return undefined;
    throw hostError(attempt, "container inspection");
  }
  if (result.exitCode !== 0) throw hostError(attempt, "container inspection");
  let raw: unknown; try { raw = JSON.parse(result.stdout); } catch { throw hostError(attempt, "container inspection"); }
  return observed(raw, attempt);
}
async function launch(dir: string, attempt: Attempt, user: string, ctx: AttemptContext): Promise<Attempt> {
  let startedId: string | undefined;
  try {
    const args = buildContainerArgs({ protocol: attempt.protocol, stage: attempt.stage, studyId: openStudy(dir).study.id, attemptId: attempt.id, seed: attempt.seed, user, paths: attempt.paths });
    const result = await command(attempt, "container start", "docker", args, ctx), cid = result.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(cid)) throw hostError(attempt, "container start");
    startedId = cid;
    attempt.stages[attempt.stage]!.containerId = cid;
    await startWatchdog(attempt.executor, attempt.id, attempt.stage, attempt.protocol.limits.wallSeconds, ctx.runner ?? spawnRunner, cid);
    const state = await inspect(attempt, ctx); if (!state) throw hostError(attempt, "container start verification");
    return recordVerifiedStage(dir, attempt, state, ctx, "attempt.stage.started");
  } catch {
    if (!startedId) {
      try {
        // A lost response is not proof that Docker rejected the start. Adopt only a verified owned container.
        const state = await inspect(attempt, ctx);
        if (state) {
          if (state.running) await startWatchdog(attempt.executor, attempt.id, attempt.stage, attempt.protocol.limits.wallSeconds, ctx.runner ?? spawnRunner, state.id);
          return recordVerifiedStage(dir, attempt, state, ctx, "attempt.stage.recovered");
        }
      } catch {
        return update(dir, attempt.id, ctx, current => { delete current.launching; current.reason = "executor-start-uncertain"; current.error = hostError(current, "container start confirmation").message; return "attempt.executor-error"; });
      }
    }
    // A name conflict can belong to another study with the same identity. Only clean up our returned container id.
    if (startedId) {
      try { await command(attempt, "failed launch cleanup", "docker", ["kill", startedId], ctx); }
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

export async function runAttempt(dirArg: string, options: AttemptOptions, ctx: AttemptContext): Promise<Attempt> {
  const dir = studyDir(dirArg), { study } = openStudy(dir);
  const frozen = await withLock(dir, () => {
    const design = readDesign(dir), executor = readExecutor(dir);
    if (!design) throw new Error("protocol: missing; run ares protocol <dir> --file PATH before attempt run");
    if (!executor) throw new Error("executor: missing; run ares executor set <dir> --kind local|ssh --workdir PATH before attempt run");
    return { ...design, executor };
  });
  const { protocol, executor } = frozen;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(study.id)) throw new Error("study id: invalid; restore the id generated by ares init before attempt run");
  const run = runName(options.run ?? "main"), label = boundedText(options.label ?? "baseline", "label", 128), seed = options.seed ?? protocol.seeds[0]!;
  if (!Number.isSafeInteger(seed) || !protocol.seeds.includes(seed)) throw new Error("seed: undeclared; choose a seed from protocol.seeds");
  if (options.retry !== undefined) id(options.retry);
  const initialBinding = frozen.binding;
  const snapshot = await resolveSnapshot(options.repo, options.commit, ctx.runner ?? spawnRunner), hash = protocolHash(protocol);
  const wanted = attemptId(hash, snapshot.commit, snapshot.treeId, seed, run, options.retry);
  let created = false;
  let attempt = await withLock(dir, () => {
    const attempts = load(dir), existing = attempts.find(a => a.id === wanted); if (existing) return existing;
    if (designBinding(dir) !== initialBinding) throw new Error("design: changed while resolving the snapshot; approve the current design and retry attempt run");
    if (options.retry && !attempts.some(a => a.id === options.retry)) throw new Error("retry: attempt not found; choose an existing id from ares attempt list");
    if (attempts.some(a => a.status === "running")) throw new Error("attempt: another attempt is running; reconcile or cancel it before starting a new one");
    const binding = designBinding(dir), approval = requireGate(dir, study, "design", () => binding);
    enforceBudget(protocol, attempts, now(ctx));
    const root = posix.join(executor.workdir, study.id, wanted);
    const record: Attempt = { v: 1, id: wanted, studyId: study.id, run, protocolHash: hash, sealBinding: binding!, ...snapshot, seed, label, ...(options.retry ? { retryOf: options.retry } : {}), executor, protocol, paths: { snapshot: posix.join(root, "snapshot"), output: posix.join(root, "output"), evaluator: posix.join(root, "task", "evaluator"), result: posix.join(root, "result") }, status: "running", stage: "candidate", startedAt: at(ctx), stages: {}, metrics: [], outputs: [], sealing: { separateContainers: false, evaluatorReadOnly: false, candidateHasNoEvaluator: false, verifiedBy: "ares-observed" }, launching: owner(ctx) };
    if (approval.length) record.pendingAutoApproval = binding!;
    commit(dir, [[file(dir, record), JSON.stringify(record, null, 2) + "\n", ATTEMPT_BYTES]], [{ actor: ctx.actor, type: "attempt.started", data: { id: wanted, run, seed, commit: record.commit, treeId: record.treeId } }]);
    created = true; return record;
  });
  if (created) {
    let preparationStep = "executor check";
    try {
      const checked = await checkExecutorInputs(attempt.executor, attempt.protocol, ctx.runner ?? spawnRunner);
      const root = posix.dirname(attempt.paths.snapshot), studyRoot = posix.dirname(root), base = executor.workdir;
      // Require a private, owned, physical root. Attempt mkdir is exclusive, never a shared pre-existing directory.
      const script = `set -eu; umask 077; base=${shellQuote(base)}; test -d "$base"; test ! -L "$base"; test -O "$base"; test "$(cd -P "$base" && pwd -P)" = "$base"; mode=$(stat -c %a "$base" 2>/dev/null || stat -f %Lp "$base"); test "$mode" = 700; study=${shellQuote(studyRoot)}; if test ! -e "$study"; then mkdir -m 700 "$study"; fi; test -d "$study"; test ! -L "$study"; test -O "$study"; mode=$(stat -c %a "$study" 2>/dev/null || stat -f %Lp "$study"); test "$mode" = 700; mkdir -m 700 ${shellQuote(root)}; mkdir -m 700 ${[attempt.paths.snapshot, attempt.paths.output, attempt.paths.result, posix.dirname(attempt.paths.evaluator)].map(shellQuote).join(" ")}`;
      preparationStep = "private workspace preparation";
      await command(attempt, "private workspace preparation", "sh", ["-c", script], ctx);
      preparationStep = "snapshot transfer";
      const transferred = await transferSnapshot(options.repo, snapshot.commit, executor, attempt.paths.snapshot, ctx.runner ?? spawnRunner);
      preparationStep = "evaluator transfer";
      await transferTask(join(dir, "task"), executor, posix.dirname(attempt.paths.evaluator), ctx.runner ?? spawnRunner, frozen.treeHash);
      preparationStep = "design recheck";
      if (designBinding(dir) !== attempt.sealBinding) throw new Error("design changed during preparation");
      const claim = attempt.launching!.token;
      attempt = await update(dir, attempt.id, ctx, current => { if (current.status !== "running" || current.launching?.token !== claim) throw new Error("attempt preparation: ownership changed; run ares attempt reconcile before retrying"); current.snapshotSha256 = transferred.sha256; current.stages.candidate = stageRecord(current, "candidate", checked.user, ctx); return "attempt.snapshot"; });
      preparationStep = "controller lock";
      attempt = await withControl(dir, async () => {
        const current = showAttempt(dir, attempt.id);
        if (current.status !== "running" || current.launching?.token !== claim) return current;
        return launch(dir, current, checked.user, ctx);
      });
    } catch {
      attempt = await update(dir, attempt.id, ctx, current => { if (current.status !== "running") return undefined; current.error = startupError(current, preparationStep); finish(current, "failed", "preparation", ctx); return "attempt.failed"; });
    }
  }
  if (!options.detach) {
    let delay = 1000;
    while (attempt.status === "running") {
      await (ctx.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))))(delay);
      const previousStage = attempt.stage;
      await reconcileAttempts(dir, ctx); attempt = showAttempt(dir, wanted);
      delay = attempt.stage === previousStage ? Math.min(delay * 2, 30_000) : 1000;
    }
  }
  return attempt;
}

export async function reconcileAttempts(dirArg: string, ctx: AttemptContext): Promise<Attempt[]> {
  const dir = studyDir(dirArg);
  return withControl(dir, async () => {
  const changed: Attempt[] = [];
  for (let attempt of load(dir).filter(a => a.status === "running")) {
    if (alive(attempt, ctx)) continue;
    try {
      let state = await inspect(attempt, ctx);
      if (!state) { changed.push(await update(dir, attempt.id, ctx, current => { finish(current, "unknown", "lost", ctx); return "attempt.unknown"; })); continue; }
      const recovered = needsReceipt(attempt, state);
      if (recovered) attempt = await recordVerifiedStage(dir, attempt, state, ctx, "attempt.stage.recovered");
      const stage = attempt.stages[attempt.stage];
      if (!stage) throw hostError(attempt, "stage record");
      const deadline = Date.parse(stage.startedAt) + stage.limits.wallSeconds * 1000;
      if ((state.running && now(ctx) >= deadline) || (!state.running && state.finishedAt !== undefined && Date.parse(state.finishedAt) >= deadline)) {
        if (state.running) { await command(attempt, "wall-clock kill", "docker", ["kill", state.id], ctx); const stopped = await inspect(attempt, ctx); if (stopped) state = stopped; }
        attempt = await captureStage(dir, attempt, ctx, true);
        const ended = state;
        changed.push(await update(dir, attempt.id, ctx, current => { if (ended.finishedAt) current.stages[current.stage]!.endedAt = ended.finishedAt; if (!ended.running) current.stages[current.stage]!.exitCode = ended.exitCode; finish(current, "failed", "wall-clock", ctx); return "attempt.failed"; })); continue;
      }
      if (state.running) {
        if (recovered) changed.push(attempt);
        continue;
      }
      if (state.exitCode !== 0) { attempt = await captureStage(dir, attempt, ctx, true); const ended = state; changed.push(await update(dir, attempt.id, ctx, current => { current.stages[current.stage]!.exitCode = ended.exitCode; if (ended.finishedAt) current.stages[current.stage]!.endedAt = ended.finishedAt; finish(current, "failed", `${current.stage}-exit`, ctx); return "attempt.failed"; })); continue; }
      try { attempt = await captureStage(dir, attempt, ctx, false); }
      catch (error) {
        const failure = error as EvidenceError, ended = state;
        changed.push(await update(dir, attempt.id, ctx, current => {
          current.stages[current.stage]!.exitCode = ended.exitCode;
          if (ended.finishedAt) current.stages[current.stage]!.endedAt = ended.finishedAt;
          current.error = failure.message; finish(current, "failed", failure.reason, ctx); return "attempt.failed";
        })); continue;
      }
      if (attempt.stage === "candidate") {
        const next = await update(dir, attempt.id, ctx, current => { current.stages.candidate!.exitCode = 0; current.stages.candidate!.endedAt = state.finishedAt ?? at(ctx); current.stage = "evaluator"; current.stages.evaluator = stageRecord(current, "evaluator", stage.user, ctx); current.launching = owner(ctx); return "attempt.stage.changed"; });
        changed.push(await launch(dir, next, stage.user, ctx));
      } else {
        let evaluation: Evaluation | undefined, failure: EvidenceError | undefined;
        try { evaluation = await (ctx.collectEvaluation ?? defaultEvaluationCollector)(attempt, ctx.runner ?? spawnRunner); }
        catch (error) { failure = error instanceof EvidenceError ? error : new MetricsError("invalid-metrics", "evaluator result validation failed"); }
        changed.push(await update(dir, attempt.id, ctx, current => {
          current.stages.evaluator!.exitCode = 0;
          if (state.finishedAt) current.stages.evaluator!.endedAt = state.finishedAt;
          if (!evaluation) { const rejected = failure ?? new MetricsError("invalid-metrics", "the collector returned no result"); current.error = rejected.message; finish(current, "failed", rejected.reason, ctx); return "attempt.failed"; }
          current.metrics = evaluation.metrics; current.outputs = outputBudget([...current.outputs, ...evaluation.outputs]); finish(current, "succeeded", undefined, ctx); return "attempt.succeeded";
        }));
      }
    } catch {
      await update(dir, attempt.id, ctx, current => { delete current.launching; return "attempt.executor-error"; });
      throw hostError(attempt, "reconcile");
    }
  }
  return changed;
  });
}
export async function cancelAttempt(dirArg: string, wanted: string, reason: string | undefined, ctx: AttemptContext): Promise<Attempt> {
  const dir = studyDir(dirArg), why = reason === undefined ? undefined : boundedText(reason, "reason", 500);
  return withControl(dir, async () => {
  let attempt = showAttempt(dir, id(wanted));
  if (attempt.status !== "running") return attempt;
  if (alive(attempt, ctx)) throw new Error("attempt: another startup operation is active; retry cancel when it finishes (abandoned claims expire after 30 minutes)");
  try {
    let state = await inspect(attempt, ctx);
    if (state && needsReceipt(attempt, state)) attempt = await recordVerifiedStage(dir, attempt, state, ctx, "attempt.stage.recovered", false);
    if (state?.running) { await command(attempt, "cancel kill", "docker", ["kill", state.id], ctx); state = await inspect(attempt, ctx); }
    if (state) attempt = await captureStage(dir, attempt, ctx, true);
    const ended = state;
    return update(dir, attempt.id, ctx, current => { if (ended && !ended.running) { current.stages[current.stage]!.exitCode = ended.exitCode; if (ended.finishedAt) current.stages[current.stage]!.endedAt = ended.finishedAt; } finish(current, "cancelled", why ?? "cancelled", ctx); return "attempt.cancelled"; });
  } catch {
    await update(dir, attempt.id, ctx, current => { delete current.launching; return "attempt.executor-error"; });
    throw hostError(attempt, "cancel");
  }
  });
}
