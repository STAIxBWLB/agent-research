import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import { commit, openStudy, plain, readJsonFile, requireExperiment, type Actor } from "../study.ts";
import { readProtocol, validateProtocol, type Protocol } from "./protocol.ts";

export interface Executor { v: 1; kind: "local" | "ssh"; host?: string; workdir: string }
export interface ProcessRequest {
  command: string; args: string[]; stdin?: Uint8Array | AsyncIterable<Uint8Array>;
  stdoutSink?: (chunk: Uint8Array) => void | Promise<void>; signal?: AbortSignal;
  timeoutMs?: number; maxOutputBytes?: number; cwd?: string; env?: NodeJS.ProcessEnv;
}
export interface ProcessResult { exitCode: number; stdout: string; stderr: string; timedOut?: boolean; truncated?: boolean }
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
export const EXECUTOR_BYTES = 8192, PROCESS_OUTPUT_BYTES = 65_536;

/** Opt-in context for native CLI attribution and config discovery; no API credentials. */
export const PROCESS_CONTEXT_ENV_KEYS = ["AGENTHUB_PEER_ID", "CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "PI_SESSION_ID",
  "AMEM_HOME", "AGENTHUB_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME", "KIMI_CODE_HOME", "PI_CODING_AGENT_DIR", "QWEN_HOME", "JCODE_HOME"] as const;
const BASE_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "SSH_AUTH_SOCK", "DOCKER_HOST", "DOCKER_CONTEXT"];
/** Context is opt-in; executor children keep their existing minimal environment by default. */
export function processEnvironment(env: NodeJS.ProcessEnv, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return Object.fromEntries([...BASE_ENV_KEYS, ...PROCESS_CONTEXT_ENV_KEYS].flatMap(key => {
    const value = extra[key] ?? (BASE_ENV_KEYS.includes(key) ? env[key] : undefined);
    return value === undefined ? [] : [[key, value]];
  }));
}

/** Bounded tails and a deadline; callers must never persist raw process diagnostics. */
export const spawnRunner: ProcessRunner = async request => {
  const max = request.maxOutputBytes ?? PROCESS_OUTPUT_BYTES, timeout = request.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(max) || max < 1 || max > 1024 * 1024 || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 604_800_000) {
    throw new Error("process bounds: invalid; use 1..1048576 output bytes and 1..604800000 timeout milliseconds");
  }
  if (request.signal?.aborted) throw new Error("process cancelled; retry the operation when cancellation is cleared");
  const child = spawn(request.command, request.args, { env: processEnvironment(process.env, request.env), cwd: request.cwd, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), truncated = false, timedOut = false;
  const append = (old: Buffer, chunk: Buffer): Buffer => {
    if (old.length + chunk.length > max) truncated = true;
    return chunk.length >= max ? Buffer.from(chunk.subarray(chunk.length - max)) : Buffer.concat([old.subarray(Math.max(0, old.length + chunk.length - max)), chunk]);
  };
  child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
  const stop = () => {
    try { if (child.pid) process.kill(-child.pid, "SIGKILL"); }
    catch { child.kill("SIGKILL"); }
  };
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
  request.signal?.addEventListener("abort", stop, { once: true });
  const closed = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? -1));
  });
  // EPIPE is normal if a child exits before consuming its snapshot input.
  child.stdin.on("error", () => {});
  const input = async () => {
    if (request.stdin && Symbol.asyncIterator in request.stdin) {
      const iterator = request.stdin[Symbol.asyncIterator]();
      try {
        for (;;) {
          const next = await Promise.race([iterator.next().then(value => ({ value })), closed.then(() => ({ value: undefined }))]);
          if (!next.value || next.value.done || request.signal?.aborted || child.stdin.destroyed) break;
          await new Promise<void>((resolve, reject) => child.stdin.write(next.value!.value, error => error ? reject(error) : resolve()));
        }
      } finally {
        // A cancelled producer can have a pending next(); do not wait forever for its return().
        void iterator.return?.().catch(() => {});
      }
      child.stdin.end();
    } else child.stdin.end(request.stdin);
  };
  const output = async () => {
    for await (const chunk of child.stdout) {
      if (request.stdoutSink) await request.stdoutSink(chunk as Buffer);
      else stdout = append(stdout, chunk as Buffer);
    }
  };
  let ioError: unknown;
  const pumps = [input(), output()].map(pump => pump.catch(error => { ioError ??= error; stop(); }));
  try {
    const code = await closed;
    await Promise.all(pumps);
    if (ioError) throw ioError;
    return { exitCode: code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), ...(timedOut ? { timedOut } : {}), ...(truncated ? { truncated } : {}) };
  } finally {
    clearTimeout(timer); request.signal?.removeEventListener("abort", stop);
  }
};

function host(executor: Executor): string { return executor.kind === "ssh" ? executor.host! : "local"; }
function failed(executor: Executor, step: string): Error {
  return new Error(`executor ${host(executor)}: ${step} failed; check that step on the executor host and rerun ares executor check <dir>`);
}
function directory(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 4096 || !value.startsWith("/") || /[\0\r\n,"]/.test(value)) throw new Error(`${field}: invalid directory; use an absolute path of at most 4096 characters without NUL, newlines, commas or double quotes`);
  return posix.normalize(value);
}
export function validateExecutor(raw: unknown): Executor {
  if (!plain(raw)) throw new Error("executor: object required; pass kind and workdir to ares executor set");
  const extra = Object.keys(raw).find(key => !["v", "kind", "host", "workdir"].includes(key));
  if (extra !== undefined) throw new Error(`executor: unknown field ${extra}; use only v, kind, host and workdir`);
  if (raw.v !== 1 || (raw.kind !== "local" && raw.kind !== "ssh")) throw new Error("executor: invalid version or kind; set v to 1 and kind to local or ssh");
  if (raw.kind === "ssh" && (typeof raw.host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(raw.host))) throw new Error("executor.host: invalid SSH alias; configure an SSH alias and pass its name only (letters, digits, dot, underscore or hyphen)");
  if (raw.kind === "local" && raw.host !== undefined) throw new Error("executor.host: local executor has no SSH host; remove host or set kind to ssh");
  if (raw.workdir === undefined || raw.workdir === null) throw new Error("executor.workdir: required with no default; run ares executor set <dir> --kind local|ssh [--host ALIAS] --workdir PATH using a private directory on the executor host");
  return { v: 1, kind: raw.kind, ...(raw.kind === "ssh" ? { host: raw.host as string } : {}), workdir: directory(raw.workdir, "executor.workdir") };
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
export class InputVerificationError extends Error {}
export interface InputManifest { sha256: string; files: number; bytes: number }
export const INPUT_MANIFEST_FILES = 100_000, INPUT_MANIFEST_TIMEOUT_MS = 300_000, INPUT_MANIFEST_OUTPUT_BYTES = 4096;
// ponytail: ceiling 100,000 files/directories, depth 64 and 5 minutes; bytes stream in 1 MiB chunks, never into the study.
export const INPUT_MANIFEST_SCRIPT = String.raw`import os,sys,stat,hashlib,json
MAX=100000
records=[]
entries=0
directories=0
total=0
def identity(s):
 return (s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
def walk(fd,prefix,depth):
 global entries,directories,total
 if depth>64: raise ValueError()
 directories+=1
 if directories>MAX: raise ValueError()
 before=os.fstat(fd)
 with os.scandir(fd) as stream:
  for item in stream:
   entries+=1
   if entries>2*MAX or item.name in ('.','..'): raise ValueError()
   name=prefix+'/'+item.name if prefix else item.name
   if len(name.encode('utf-8'))>4096: raise ValueError()
   info=os.stat(item.name,dir_fd=fd,follow_symlinks=False)
   if stat.S_ISDIR(info.st_mode):
    child=os.open(item.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    try:
     if identity(os.fstat(child))!=identity(info): raise ValueError()
     walk(child,name,depth+1)
    finally: os.close(child)
   elif stat.S_ISREG(info.st_mode):
    if len(records)>=MAX or info.st_size>9007199254740991-total: raise ValueError()
    child=os.open(item.name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
    try:
     opened=os.fstat(child)
     if not stat.S_ISREG(opened.st_mode) or identity(opened)!=identity(info): raise ValueError()
     digest=hashlib.sha256()
     size=0
     while True:
      chunk=os.read(child,1048576)
      if not chunk: break
      size+=len(chunk)
      if size>info.st_size: raise ValueError()
      digest.update(chunk)
     if size!=info.st_size or identity(os.fstat(child))!=identity(opened): raise ValueError()
    finally: os.close(child)
    total+=size
    records.append((name,size,digest.hexdigest()))
   else: raise ValueError()
 if identity(os.fstat(fd))!=identity(before): raise ValueError()
try:
 root=sys.argv[1]
 if not os.path.isabs(root): raise ValueError()
 fd=os.open('/',os.O_RDONLY|os.O_DIRECTORY)
 try:
  for part in root.split('/'):
   if not part: continue
   if part in ('.','..'): raise ValueError()
   child=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
   os.close(fd)
   fd=child
  walk(fd,'',0)
 finally: os.close(fd)
 digest=hashlib.sha256()
 for row in sorted(records,key=lambda row:row[0].encode('utf-8')):
  digest.update((json.dumps(row,ensure_ascii=False,separators=(',',':'))+'\n').encode('utf-8'))
 print(json.dumps({'sha256':digest.hexdigest(),'files':len(records),'bytes':total},separators=(',',':')))
except Exception:
 sys.stderr.write('input manifest refused\n')
 sys.exit(1)
`;
/** Host-local streaming only: stdout is bounded metadata, never file names, contents or host paths. */
export async function hashExecutorInput(executorArg: Executor, path: string, runner: ProcessRunner = spawnRunner): Promise<InputManifest> {
  const executor = validateExecutor(executorArg), source = directory(path, "executor input path");
  const refuse = () => new Error("executor input manifest: hashing failed; check Python3 and a stable readable regular directory without links/special files on the executor, then rerun ares executor inputs hash <dir> <path>");
  let result: ProcessResult;
  try {result = await runOnExecutor(executor, "python3", ["-I", "-S", "-c", INPUT_MANIFEST_SCRIPT, source], runner, {timeoutMs: INPUT_MANIFEST_TIMEOUT_MS, maxOutputBytes: INPUT_MANIFEST_OUTPUT_BYTES});}
  catch {throw refuse();}
  if (result.exitCode !== 0 || result.timedOut || result.truncated || Buffer.byteLength(result.stdout) > INPUT_MANIFEST_OUTPUT_BYTES) throw refuse();
  let raw: unknown; try {raw = JSON.parse(result.stdout);} catch {throw refuse();}
  if (!plain(raw) || Object.keys(raw).some(key => !["sha256", "files", "bytes"].includes(key)) || typeof raw.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.sha256) || !Number.isSafeInteger(raw.files) || Number(raw.files)<0 || Number(raw.files)>INPUT_MANIFEST_FILES || !Number.isSafeInteger(raw.bytes) || Number(raw.bytes)<0) throw refuse();
  return {sha256: raw.sha256, files: raw.files as number, bytes: raw.bytes as number};
}
/** Verify every declared input without persisting its host locator or manifest rows. */
export async function verifyExecutorInputs(executor: Executor, protocol: Protocol, runner: ProcessRunner = spawnRunner): Promise<Record<string, string>> {
  const inputs = validateProtocol(protocol).inputs ?? {}, verified: [string, string][] = [];
  for (const [name, input] of Object.entries(inputs)) {
    let manifest: InputManifest;
    try { manifest = await hashExecutorInput(executor, input.path!, runner); }
    catch { throw new InputVerificationError(`executor input ${name}: manifest could not be verified; restore the staged directory and rerun ares executor inputs hash <dir> <path> before retrying the attempt`); }
    if (manifest.sha256 !== input.sha256) throw new InputVerificationError(`executor input ${name}: manifest hash mismatch; restore the staged input or update its protocol hash and approve the design before retrying the attempt`);
    verified.push([name, manifest.sha256]);
  }
  return Object.fromEntries(verified);
}
async function step(executor: Executor, name: string, command: string, args: string[], runner: ProcessRunner, options: Omit<ProcessRequest, "command" | "args"> = {}): Promise<ProcessResult> {
  try {
    const result = await runOnExecutor(executor, command, args, runner, options);
    if (result.exitCode !== 0 || result.timedOut || result.truncated) throw failed(executor, name);
    return result;
  } catch { throw failed(executor, name); }
}
export interface ExecutorCheck { inputRuntime?: "python3"; executor: Executor; serverVersion: string; user: string; images: { image: string; available: true }[]; pull: "missing" }
export async function checkExecutor(dir: string, runner: ProcessRunner = spawnRunner): Promise<ExecutorCheck> {
  requireExperiment(openStudy(dir).study);
  const executor = readExecutor(dir), protocol = readProtocol(dir);
  if (!executor) throw new Error("executor: not configured; run ares executor set <dir> --kind local|ssh [--host ALIAS] --workdir PATH");
  if (!protocol) throw new Error("protocol: missing; run ares protocol <dir> --file PATH before executor check");
  return checkExecutorInputs(executor, protocol, runner);
}
/** Check a frozen attempt's configuration rather than mutable study files. */
export async function checkExecutorInputs(executor: Executor, protocol: Protocol, runner: ProcessRunner = spawnRunner): Promise<ExecutorCheck> {
  if (Object.keys(protocol.inputs ?? {}).length) await step(executor, "Python3 input manifest runtime", "python3", ["-I", "-S", "-c", "import sys; assert sys.version_info.major == 3"], runner);
  const version = (await step(executor, "Docker server version", "docker", ["version", "--format", "{{.Server.Version}}"], runner)).stdout.trim();
  if (!/^[0-9]+\.[0-9]+(?:\.[0-9]+)?[A-Za-z0-9.+_-]*$/.test(version) || version.length > 128) throw failed(executor, "Docker server version");
  const uid = (await step(executor, "host uid", "id", ["-u"], runner)).stdout.trim();
  const gid = (await step(executor, "host gid", "id", ["-g"], runner)).stdout.trim();
  if (!/^[1-9][0-9]{0,9}$/.test(uid) || !/^[1-9][0-9]{0,9}$/.test(gid)) throw failed(executor, "non-root host uid:gid");
  const images: ExecutorCheck["images"] = [];
  for (const image of new Set([protocol.candidate.image, protocol.evaluator.image])) {
    let present: ProcessResult;
    try { present = await runOnExecutor(executor, "docker", ["image", "inspect", "--format", "{{.Id}}", image], runner); }
    catch { throw failed(executor, "image availability"); }
    if (present.timedOut || present.truncated) throw failed(executor, "image availability");
    if (present.exitCode !== 0) await step(executor, "image pull", "docker", ["pull", image], runner, { timeoutMs: 300_000 });
    images.push({ image, available: true });
  }
  return { ...(Object.keys(protocol.inputs ?? {}).length ? { inputRuntime: "python3" as const } : {}), executor, serverVersion: version, user: `${uid}:${gid}`, images, pull: "missing" };
}

export type Stage = "candidate" | "evaluator";
export interface ContainerPaths { snapshot: string; output: string; evaluator: string; result: string }
export interface ContainerOptions { protocol: Protocol; stage: Stage; studyId: string; attemptId: string; user: string; paths: ContainerPaths; seed?: number }
export function containerName(attemptId: string, stage: Stage): string {
  if (!/^[a-f0-9]{16}$/.test(attemptId) || !["candidate", "evaluator"].includes(stage)) throw new Error("container identity: invalid attempt or stage; use a 16-hex attempt id and candidate or evaluator stage");
  return `ares-${attemptId}-${stage}`;
}
/** Mounts are fixed by stage, never supplied as free-form Docker options. */
export function buildContainerArgs(options: ContainerOptions): string[] {
  const p = validateProtocol(options.protocol), name = containerName(options.attemptId, options.stage);
  const seed = options.seed === undefined ? p.seeds[0]! : options.seed;
  if (!Number.isSafeInteger(seed) || !p.seeds.includes(seed)) throw new Error("container seed: undeclared or non-integer; choose a seed from protocol.seeds for ares attempt run --seed N");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(options.studyId)) throw new Error("study id: invalid label; use the id from study.json");
  if (!/^[1-9][0-9]{0,9}:[1-9][0-9]{0,9}$/.test(options.user)) throw new Error("container user: non-root uid:gid required; use the user reported by ares executor check");
  const paths = Object.fromEntries(Object.entries(options.paths).map(([key, value]) => [key, directory(value, `container.paths.${key}`)])) as unknown as ContainerPaths;
  // Prevent a broad snapshot/output mount from exposing evaluator data or result storage.
  const sources = [paths.snapshot, paths.output, paths.evaluator, paths.result];
  for (let a = 0; a < sources.length; a++) for (let b = a + 1; b < sources.length; b++) {
    const x = sources[a]!, y = sources[b]!;
    if (!x || !y || x === y || x.startsWith(y === "/" ? y : `${y}/`) || y.startsWith(x === "/" ? x : `${x}/`)) throw new Error("container mounts: overlapping sources; use separate snapshot, output, evaluator and result directories");
  }
  const inputs = Object.values(p.inputs ?? {});
  const overlaps = (a: string, b: string) => a === b || a.startsWith(b === "/" ? b : `${b}/`) || b.startsWith(a === "/" ? a : `${a}/`);
  for (const input of inputs) if (sources.some(source => overlaps(source, input.path!))) throw new Error("container inputs: source overlaps the attempt workspace; stage inputs in a separate executor directory before retrying");
  for (let a = 0; a < inputs.length; a++) for (let b = a + 1; b < inputs.length; b++) {
    const x = inputs[a]!, y = inputs[b]!;
    if (overlaps(x.path!, y.path!) && (!!x.mount.candidate !== !!y.mount.candidate || !!x.mount.evaluator !== !!y.mount.evaluator)) throw new Error("container inputs: overlapping sources expose a stage-private input; stage private inputs in separate directories before retrying");
  }
  const argv = ["run", "--detach", "--pull", "missing", "--name", name, "--label", `ares.study=${options.studyId}`, "--label", `ares.attempt=${options.attemptId}`, "--label", `ares.stage=${options.stage}`,
    "--network", "none", "--read-only", "--tmpfs", "/tmp", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", options.user,
    "--cpus", String(p.limits.cpus), "--memory", `${p.limits.memoryMb}m`, "--pids-limit", String(p.limits.pidsLimit), "--env", `ARES_SEED=${seed}`];
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
  for (const input of inputs) {
    const target = input.mount[options.stage];
    if (target !== undefined) mount(input.path!, target, true);
  }
  argv.push(p[options.stage].image, ...p[options.stage].command);
  return argv;
}

/** Launch on the executor host; stdio is detached so SSH returns immediately. T3 reconciles deadlines as a backstop. */
export async function startWatchdog(executor: Executor, attemptId: string, stage: Stage, wallSeconds: number, runner: ProcessRunner = spawnRunner, containerId?: string): Promise<void> {
  const name = containerName(attemptId, stage);
  if (containerId !== undefined && !/^[a-f0-9]{64}$/.test(containerId)) throw new Error("watchdog container id: invalid; use the full id returned by the verified container start");
  if (!Number.isSafeInteger(wallSeconds) || wallSeconds < 1 || wallSeconds > 604_800) throw new Error("watchdog deadline: invalid wallSeconds; use the validated protocol limit (1..604800 seconds)");
  const script = `nohup sh -c ${shellQuote(`sleep ${wallSeconds}; docker kill ${containerId ?? name}`)} </dev/null >/dev/null 2>&1 &`;
  await step(executor, "watchdog start", "sh", ["-c", script], runner);
}
