import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { commit, openStudy, plain, readJsonFile, requireExperiment, type Actor } from "../study.ts";
import { readProtocol, validateProtocol, type Protocol } from "./protocol.ts";

export interface Executor { v: 1; kind: "local" | "ssh"; host?: string; workdir: string }
export interface ProcessRequest { command: string; args: string[]; stdin?: Uint8Array; timeoutMs?: number; maxOutputBytes?: number }
export interface ProcessResult { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; truncated?: boolean }
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
export const EXECUTOR_BYTES = 8192, PROCESS_OUTPUT_BYTES = 65_536;

/** No parent API credentials enter child processes. HOME and SSH_AUTH_SOCK support normal Docker/SSH configuration. */
export function processEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK", "DOCKER_HOST", "DOCKER_CONTEXT"].flatMap(key => env[key] === undefined ? [] : [[key, env[key]!]]));
}

/** Bounded tails and a deadline; callers must never persist raw process diagnostics. */
export const spawnRunner: ProcessRunner = request => new Promise((resolve, reject) => {
  const max = request.maxOutputBytes ?? PROCESS_OUTPUT_BYTES, timeout = request.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(max) || max < 1 || max > 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 604_800_000) {
    reject(new Error("process bounds: invalid; use 1..1048576 output bytes and 1..604800000 timeout milliseconds")); return;
  }
  const child = spawn(request.command, request.args, { env: processEnvironment(process.env), detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), truncated = false, timedOut = false;
  const append = (old: Buffer, chunk: Buffer): Buffer => {
    if (old.length + chunk.length > max) truncated = true;
    return chunk.length >= max ? Buffer.from(chunk.subarray(chunk.length - max)) : Buffer.concat([old.subarray(Math.max(0, old.length + chunk.length - max)), chunk]);
  };
  child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const timer = setTimeout(() => {
    timedOut = true;
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  }, timeout);
  child.once("error", error => { clearTimeout(timer); reject(error); });
  child.once("close", code => { clearTimeout(timer); resolve({ exitCode: code ?? -1, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), ...(timedOut ? { timedOut } : {}), ...(truncated ? { truncated } : {}) }); });
  // EPIPE is normal if a child exits before consuming its snapshot input.
  child.stdin.on("error", () => {});
  child.stdin.end(request.stdin);
});

function host(executor: Executor): string { return executor.kind === "ssh" ? executor.host! : "local"; }
function failed(executor: Executor, step: string): Error {
  return new Error(`executor ${host(executor)}: ${step} failed; check that step on the executor host and rerun ares executor check <dir>`);
}
function directory(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || /[\0\r\n,]/.test(value)) throw new Error(`${field}: invalid directory; use an absolute path of at most 4096 characters without NUL, newlines or commas`);
  return posix.normalize(value);
}
export function validateExecutor(raw: unknown): Executor {
  if (!plain(raw)) throw new Error("executor: object required; pass kind and workdir to ares executor set");
  const extra = Object.keys(raw).find(key => !["v", "kind", "host", "workdir"].includes(key));
  if (extra !== undefined) throw new Error(`executor: unknown field ${extra}; use only v, kind, host and workdir`);
  if (raw.v !== 1 || (raw.kind !== "local" && raw.kind !== "ssh")) throw new Error("executor: invalid version or kind; set v to 1 and kind to local or ssh");
  if (raw.kind === "ssh" && (typeof raw.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.host))) throw new Error("executor.host: invalid SSH alias; configure an SSH alias and pass its name only (letters, digits, dot, underscore or hyphen)");
  if (raw.kind === "local" && raw.host !== undefined) throw new Error("executor.host: local executor has no SSH host; remove host or set kind to ssh");
  return { v: 1, kind: raw.kind, ...(raw.kind === "ssh" ? { host: raw.host as string } : {}), workdir: directory(raw.workdir ?? "/tmp/ares", "executor.workdir") };
}
export function readExecutor(dir: string): Executor | undefined {
  const file = join(dir, "executor.json");
  return existsSync(file) ? validateExecutor(readJsonFile(file, EXECUTOR_BYTES)) : undefined;
}
/** Caller holds the study lock. Config contains no credentials and is outside the design seal. */
export function setExecutor(dir: string, raw: unknown, actor: Actor): Executor {
  requireExperiment(openStudy(dir).study);
  const executor = validateExecutor(raw);
  commit(dir, [[join(dir, "executor.json"), JSON.stringify(executor, null, 2) + "\n", EXECUTOR_BYTES]], [{ actor, type: "executor.set", data: { kind: executor.kind, ...(executor.host ? { host: executor.host } : {}) } }]);
  return executor;
}

/** SSH concatenates its remote command argv into a shell command, so quote every unsafe byte. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}
export async function runOnExecutor(executorArg: Executor, command: string, args: string[], runner: ProcessRunner = spawnRunner, options: Omit<ProcessRequest, "command" | "args"> = {}): Promise<ProcessResult> {
  const executor = validateExecutor(executorArg);
  try { return await runner(executor.kind === "local" ? { ...options, command, args } : { ...options, command: "ssh", args: ["-o", "BatchMode=yes", executor.host!, shellQuote(command), ...args.map(shellQuote)] }); }
  catch { throw failed(executor, "process start"); }
}
async function step(executor: Executor, name: string, command: string, args: string[], runner: ProcessRunner, options: Omit<ProcessRequest, "command" | "args"> = {}): Promise<ProcessResult> {
  try {
    const result = await runOnExecutor(executor, command, args, runner, options);
    if (result.exitCode !== 0 || result.timedOut || result.truncated) throw failed(executor, name);
    return result;
  } catch { throw failed(executor, name); }
}
export interface ExecutorCheck { executor: Executor; serverVersion: string; user: string; images: { image: string; available: true }[]; pull: "missing" }
export async function checkExecutor(dir: string, runner: ProcessRunner = spawnRunner): Promise<ExecutorCheck> {
  requireExperiment(openStudy(dir).study);
  const executor = readExecutor(dir), protocol = readProtocol(dir);
  if (!executor) throw new Error("executor: not configured; run ares executor set <dir> --kind local|ssh [--host ALIAS]");
  if (!protocol) throw new Error("protocol: missing; run ares protocol <dir> --file PATH before executor check");
  const version = (await step(executor, "Docker server version", "docker", ["version", "--format", "{{.Server.Version}}"], runner)).stdout.trim();
  if (!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?[A-Za-z0-9.+_-]*$/.test(version) || version.length > 128) throw failed(executor, "Docker server version");
  const uid = (await step(executor, "host uid", "id", ["-u"], runner)).stdout.trim();
  const gid = (await step(executor, "host gid", "id", ["-g"], runner)).stdout.trim();
  if (!/^[1-9][0-9]{0,9}$/.test(uid) || !/^[1-9][0-9]{0,9}$/.test(gid)) throw failed(executor, "non-root host uid:gid");
  const images: ExecutorCheck["images"] = [];
  for (const image of new Set([protocol.candidate.image, protocol.evaluator.image])) {
    let present: ProcessResult;
    try { present = await runOnExecutor(executor, "docker", ["image", "inspect", image], runner); }
    catch { throw failed(executor, "image availability"); }
    if (present.timedOut || present.truncated) throw failed(executor, "image availability");
    if (present.exitCode !== 0) await step(executor, "image pull", "docker", ["pull", image], runner, { timeoutMs: 300_000 });
    images.push({ image, available: true });
  }
  return { executor, serverVersion: version, user: `${uid}:${gid}`, images, pull: "missing" };
}

export type Stage = "candidate" | "evaluator";
export interface ContainerPaths { snapshot: string; output: string; evaluator: string; result: string }
export interface ContainerOptions { protocol: Protocol; stage: Stage; studyId: string; attemptId: string; user: string; paths: ContainerPaths }
export function containerName(attemptId: string, stage: Stage): string {
  if (!/^[a-f0-9]{16}$/.test(attemptId) || !["candidate", "evaluator"].includes(stage)) throw new Error("container identity: invalid attempt or stage; use a 16-hex attempt id and candidate or evaluator stage");
  return `ares-${attemptId}-${stage}`;
}
/** Mounts are fixed by stage, never supplied as free-form Docker options. */
export function buildContainerArgs(options: ContainerOptions): string[] {
  const p = validateProtocol(options.protocol), name = containerName(options.attemptId, options.stage);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.studyId)) throw new Error("study id: invalid label; use the id from study.json");
  if (!/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/.test(options.user)) throw new Error("container user: non-root uid:gid required; use the user reported by ares executor check");
  const paths = Object.fromEntries(Object.entries(options.paths).map(([key, value]) => [key, directory(value, `container.paths.${key}`)])) as unknown as ContainerPaths;
  // Prevent a broad snapshot/output mount from exposing evaluator data or result storage.
  const sources = [paths.snapshot, paths.output, paths.evaluator, paths.result];
  for (let a = 0; a < sources.length; a++) for (let b = a + 1; b < sources.length; b++) {
    const x = sources[a]!, y = sources[b]!;
    if (!x || !y || x === y || x.startsWith(y === "/" ? y : `${y}/`) || y.startsWith(x === "/" ? x : `${x}/`)) throw new Error("container mounts: overlapping sources; use separate snapshot, output, evaluator and result directories");
  }
  const argv = ["run", "--detach", "--pull", "missing", "--name", name, "--label", `ares.study=${options.studyId}`, "--label", `ares.attempt=${options.attemptId}`, "--label", `ares.stage=${options.stage}`,
    "--network", "none", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", options.user,
    "--cpus", String(p.limits.cpus), "--memory", `${p.limits.memoryMb}m`, "--pids-limit", String(p.limits.pidsLimit)];
  if (p.limits.gpus > 0) argv.push("--gpus", String(p.limits.gpus));
  const mount = (source: string, target: string, readonly: boolean) => argv.push("--mount", `type=bind,src=${source},dst=${target}${readonly ? ",readonly" : ""}`);
  if (options.stage === "candidate") {
    mount(paths.snapshot, "/workspace", true); mount(paths.output, "/out", false);
    argv.push("--workdir", "/workspace");
    for (const [key, value] of Object.entries(p.candidate.env ?? {})) argv.push("--env", `${key}=${value}`);
  } else {
    mount(paths.evaluator, "/eval", true); mount(paths.output, "/candidate", true); mount(paths.result, "/result", false);
    argv.push("--workdir", "/eval");
  }
  argv.push(p[options.stage].image, ...p[options.stage].command);
  return argv;
}

/** Launch on the executor host; stdio is detached so SSH returns immediately. T3 reconciles deadlines as a backstop. */
export async function startWatchdog(executor: Executor, attemptId: string, stage: Stage, wallSeconds: number, runner: ProcessRunner = spawnRunner): Promise<void> {
  const name = containerName(attemptId, stage);
  if (!Number.isSafeInteger(wallSeconds) || wallSeconds < 1 || wallSeconds > 604_800) throw new Error("watchdog deadline: invalid wallSeconds; use the validated protocol limit (1..604800 seconds)");
  const script = `nohup sh -c ${shellQuote(`sleep ${wallSeconds}; docker kill ${name}`)} </dev/null >/dev/null 2>&1 &`;
  await step(executor, "watchdog start", "sh", ["-c", script], runner);
}
