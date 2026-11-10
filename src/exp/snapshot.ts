import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, opendirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { PORTABLE_TAR_CREATE, runOnExecutor, shellQuote, spawnRunner, validateExecutor, type Executor, type ProcessResult, type ProcessRunner } from "./executor.ts";
import { TarMemberScan, type ArtifactFile } from "./artifacts.ts";
import { TASK_BYTES, TASK_DIRECTORIES, TASK_FILES } from "./protocol.ts";
import { readBytesBounded, sha256 } from "../study.ts";

export const SNAPSHOT_BYTES = 256 * 1024 * 1024;
function fullCommit(value: string): string {
  if (!/^[a-fA-F0-9]{40}$/.test(value)) throw new Error("snapshot commit: full 40-hex SHA required; pass the commit SHA from git rev-parse HEAD");
  return value.toLowerCase();
}
function repository(value: string): string {
  if (!value || value.length > 4096 || value.includes("\0")) throw new Error("snapshot repo: invalid path; pass a local Git repository path of 1..4096 characters without NUL");
  return value;
}
function passed(result: ProcessResult): boolean { return result.exitCode === 0 && !result.timedOut && !result.truncated; }
function gitFailure(step: string): Error { return new Error(`snapshot Git ${step} failed; check --repo and that --commit names an existing commit, then retry ares attempt run`); }

/** One pending chunk, with explicit cancellation instead of stream callback ordering. */
class ArchiveChannel implements AsyncIterableIterator<Uint8Array> {
  private pending?: { chunk: Uint8Array; resolve: () => void; reject: (error: Error) => void };
  private waiting?: { resolve: (value: IteratorResult<Uint8Array>) => void; reject: (error: Error) => void };
  private ended = false;
  private failure?: Error;
  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> { return this; }
  write(chunk: Uint8Array): Promise<void> {
    if (this.failure || this.ended) return Promise.reject(this.failure ?? new Error("archive channel closed"));
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting.resolve({ value: chunk, done: false }); return Promise.resolve(); }
    return new Promise((resolve, reject) => { this.pending = { chunk, resolve, reject }; });
  }
  next(): Promise<IteratorResult<Uint8Array>> {
    if (this.pending) { const pending = this.pending; this.pending = undefined; pending.resolve(); return Promise.resolve({ value: pending.chunk, done: false }); }
    if (this.failure) return Promise.reject(this.failure);
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
  end(error?: Error): void {
    if (this.ended) return;
    this.ended = true; this.failure = error;
    if (this.pending) { this.pending.reject(error ?? new Error("archive channel closed")); this.pending = undefined; }
    if (this.waiting) { if (error) this.waiting.reject(error); else this.waiting.resolve({ value: undefined, done: true }); this.waiting = undefined; }
  }
  return(): Promise<IteratorResult<Uint8Array>> { this.end(new Error("archive consumer stopped")); return Promise.resolve({ value: undefined, done: true }); }
}

/** Resolve only an existing commit object, independent of the worktree or an annotated tag. */
export async function resolveSnapshot(repoArg: string, commitArg: string, runner: ProcessRunner = spawnRunner): Promise<{ commit: string; treeId: string }> {
  const repo = repository(repoArg), commit = fullCommit(commitArg);
  let type: ProcessResult, tree: ProcessResult;
  try {
    type = await runner({ command: "git", args: ["-C", repo, "cat-file", "-t", commit] });
    if (!passed(type) || type.stdout.trim() !== "commit") throw gitFailure("commit validation");
  } catch { throw gitFailure("commit validation"); }
  try { tree = await runner({ command: "git", args: ["-C", repo, "rev-parse", "--verify", `${commit}^{tree}`] }); }
  catch { throw gitFailure("tree resolution"); }
  const treeId = tree.stdout.trim();
  if (!passed(tree) || !/^[a-f0-9]{40}$/.test(treeId)) throw gitFailure("tree resolution");
  return { commit, treeId };
}

/** Stream raw archive bytes with backpressure; nothing buffers or decodes the whole archive. */
export async function transferSnapshot(repoArg: string, commitArg: string, executorArg: Executor, destination: string, runner: ProcessRunner = spawnRunner): Promise<{ sha256: string; bytes: number }> {
  const repo = repository(repoArg), commit = fullCommit(commitArg);
  return transferArchive("snapshot", { command: "git", args: ["-C", repo, "archive", "--format=tar", commit] }, SNAPSHOT_BYTES, executorArg, destination, runner);
}

/** Capture each file once; the hash binds the same bytes copied into private immutable evaluator staging. */
export async function transferTask(taskDir: string, executor: Executor, destination: string, runner: ProcessRunner = spawnRunner, expectedTreeHash?: string, includeCandidate = false): Promise<{ sha256: string; bytes: number; treeHash: string }> {
  repository(taskDir);
  if (expectedTreeHash !== undefined && !/^[a-f0-9]{64}$/.test(expectedTreeHash)) throw new Error("task tree hash: invalid; use the approved taskTreeHash before transferring evaluator files");
  const staging = mkdtempSync(join(tmpdir(), "ares-task-")), entries: [string, string][] = [];
  let total = 0, directories = 0;
  try {
    const evaluator = lstatSync(join(taskDir, "evaluator"));
    if (!evaluator.isDirectory() || evaluator.isSymbolicLink()) throw new Error("task/evaluator: regular directory required; restore evaluator files before ares attempt run");
    mkdirSync(join(staging, "evaluator"), { mode: 0o700 });
    function capture(relative: string, depth: number): void {
      const source = relative ? join(taskDir, relative) : taskDir, label = relative ? `task/${relative}` : "task/", stat = lstatSync(source);
      if (stat.isSymbolicLink()) throw new Error(`${label}: symlink refused; replace it with regular task files before ares attempt run`);
      if (stat.isDirectory()) {
        if (++directories > TASK_DIRECTORIES || depth > 64) throw new Error(`${label}: task traversal limit exceeded; reduce task/ to 1000 directories and 64 levels`);
        if (relative.startsWith("evaluator/")) mkdirSync(join(staging, relative), { recursive: true, mode: 0o700 });
        const directory = opendirSync(source);
        try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) capture(relative ? `${relative}/${entry.name}` : entry.name, depth + 1); }
        finally { directory.closeSync(); }
      } else {
        if (!stat.isFile()) throw new Error(`${label}: regular file required; remove special files before ares attempt run`);
        if (entries.length >= TASK_FILES || stat.size > TASK_BYTES - total) throw new Error("task/: task size limit exceeded; reduce task/ to 500 files and 64 MiB before ares attempt run");
        let content: Buffer;
        try { content = readBytesBounded(source, TASK_BYTES - total); }
        catch { throw new Error(`${label}: bounded read failed; restore a readable regular file within the 64 MiB task limit`); }
        total += content.length; entries.push([relative, sha256(content)]);
        if (includeCandidate || relative.startsWith("evaluator/")) {
          const target = join(staging, relative); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
          writeFileSync(target, content, { mode: stat.mode & 0o777 });
        }
      }
    }
    capture("", 0);
    const treeHash = sha256(JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
    if (expectedTreeHash !== undefined && treeHash !== expectedTreeHash) throw new Error("task/: content changed since approval; set the protocol, approve design again, and retry ares attempt run");
    // Bounded tar headers and long-path metadata supplement the 64 MiB task payload cap. The archive is created with the
    // shared content-only tar rule, and its members are checked against the staged files while it streams.
    const staged = new Map((includeCandidate ? entries : entries.filter(([path]) => path.startsWith("evaluator/"))).map(([path, digest]) => [path, digest]));
    const transferred = await transferArchive("task", { command: "sh", args: ["-c", `${PORTABLE_TAR_CREATE} -C ${shellQuote(staging)} -cf - ${includeCandidate ? "." : "evaluator"}`] }, TASK_BYTES + 16 * 1024 * 1024, executor, destination, runner, staged);
    return { ...transferred, treeHash };
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("task/") || error.message.startsWith("task archive:") || error.message.startsWith("executor "))) throw error;
    throw new Error("task archive capture failed; restore readable task/evaluator files, then retry ares attempt run");
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** Checks a task archive's members against the staged files: refuses AppleDouble `._*` members and any other drift by name. */
function memberCheck(files: ArtifactFile[], staged: Map<string, string>): void {
  const metadata = files.find(file => file.path.split("/").some(part => part.startsWith("._")) && !staged.has(file.path));
  if (metadata) throw new Error(`task archive: AppleDouble/extended-attribute metadata member ${metadata.path.slice(0, 200)} refused; the archive must carry task content only (tar --no-xattrs with COPYFILE_DISABLE=1, GNU tar >= 1.27 or bsdtar), then retry ares attempt run`);
  const extra = files.find(file => staged.get(file.path) !== file.sha256);
  if (extra || files.length !== staged.size) throw new Error(`task archive: member ${(extra?.path ?? "set").slice(0, 200)} differs from the staged task files; check the controller tar (GNU tar >= 1.27 or bsdtar) and retry ares attempt run`);
}

async function transferArchive(kind: "snapshot" | "task", source: { command: string; args: string[] }, limit: number, executorArg: Executor, destination: string, runner: ProcessRunner, staged?: Map<string, string>): Promise<{ sha256: string; bytes: number }> {
  const executor = validateExecutor(executorArg);
  if (!destination.startsWith("/") || destination.length > 4096 || /[\0\r\n,"]/.test(destination) || posix.normalize(destination) === "/") throw new Error("snapshot destination: invalid directory; use a private absolute non-root directory without NUL, newlines, commas or double quotes");
  const stream = new ArchiveChannel(), controller = new AbortController(), hash = createHash("sha256");
  const scan = staged ? new TarMemberScan(TASK_BYTES, TASK_FILES, TASK_FILES + TASK_DIRECTORIES) : undefined;
  let bytes = 0, oversized = false, failedSide: "archive" | "extract" | undefined, refused: Error | undefined;
  const archive = (async () => {
    try {
      const result = await runner({ ...source, signal: controller.signal, timeoutMs: 300_000,
        stdoutSink: async chunk => {
          if (bytes + chunk.byteLength > limit) { oversized = true; throw new Error("archive size limit"); }
          bytes += chunk.byteLength; hash.update(chunk);
          try { scan?.push(chunk); } catch { refused ??= new Error("task archive: malformed or unsupported tar stream refused; check the controller tar (GNU tar >= 1.27 or bsdtar) and retry ares attempt run"); throw refused; }
          await stream.write(chunk);
        } });
      if (!passed(result)) throw gitFailure("archive");
      if (scan && staged) {
        let files: ArtifactFile[];
        try { files = scan.finish(); } catch { refused ??= new Error("task archive: truncated tar stream refused; retry ares attempt run"); throw refused; }
        try { memberCheck(files, staged); } catch (error) { refused ??= error as Error; throw refused; }
      }
      stream.end();
    } catch (error) { failedSide ??= "archive"; stream.end(error as Error); throw error; }
  })();
  const extract = (async () => {
    try {
      const result = await runOnExecutor(executor, "tar", ["--no-same-owner", "-xf", "-", "-C", destination], runner, { stdin: stream, signal: controller.signal, timeoutMs: 300_000 });
      if (!passed(result)) throw new Error("archive extraction failed");
    } catch (error) { failedSide ??= "extract"; throw error; }
  })();
  try {
    await Promise.all([archive, extract]);
    if (bytes === 0) { failedSide = "archive"; throw gitFailure("empty archive"); }
    return { sha256: hash.digest("hex"), bytes };
  } catch {
    controller.abort(); stream.end(new Error("archive transfer cancelled"));
    await Promise.allSettled([archive, extract]);
    if (oversized) throw new Error(`${kind} archive: larger than ${limit} bytes; reduce the ${kind === "snapshot" ? "committed snapshot" : "task evaluator"} before ares attempt run`);
    // A refused member is named even though extraction may have begun; the attempt fails and nothing is marked verified.
    if (refused) throw refused;
    if (failedSide === "archive") throw kind === "snapshot" ? gitFailure("archive") : new Error("task archive failed; restore readable task/evaluator files, then retry ares attempt run");
    throw new Error(`executor ${executor.kind === "ssh" ? executor.host : "local"}: snapshot extraction failed; check the private destination directory and tar on the executor host, then retry ares attempt run`);
  }
}
