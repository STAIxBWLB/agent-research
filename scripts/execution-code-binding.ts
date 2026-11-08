import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, opendirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { readBytesBounded, sha256 } from "../src/study.ts";

export const RUN_CODE_FILES = 256, RUN_CODE_FILE_BYTES = 1024 * 1024, RUN_CODE_TOTAL_BYTES = 16 * 1024 * 1024;
const GIT_BYTES = 1024 * 1024, GIT_TIMEOUT_MS = 5000, CODE_DIRECTORIES = 256, CODE_DEPTH = 64;
const ROOTS = ["bin/ares.js", "package.json", "bun.lock", "scripts", "src"];
const REQUIRED = ["bin/ares.js", "package.json", "bun.lock", "scripts/execution-eval.ts"];
export interface RunCodeBinding { commit: string; tree: string; codeSha256: string; files: { path: string; sha256: string; bytes: number }[] }
class CodeBindingError extends Error {}
function fail(reason: string): never { throw new CodeBindingError(`execution code binding: ${reason}; restore and commit a clean bounded source checkout, then retry baseline admission`); }
interface GitEntry { mode: string; hash: string }
function names(output: string, tree: boolean): Map<string, GitEntry> {
  const entries = new Map<string, GitEntry>();
  for (const line of output.split("\0")) {
    if (!line) continue;
    const match = tree ? /^([0-7]{6}) blob ([a-f0-9]{40,64})\t(.+)$/.exec(line) : /^([0-7]{6}) ([a-f0-9]{40,64}) 0\t(.+)$/.exec(line);
    if (!match || !["100644", "100755"].includes(match[1]!)) fail("non-regular, unmerged or malformed tracked source");
    const name = match[3]!;
    if (isAbsolute(name) || name.includes("\\") || name.length > 4096 || name.split("/").some(part => !part || part === "." || part === "..") || entries.has(name)) fail("invalid or duplicate source path");
    entries.set(name, { mode: match[1]!, hash: match[2]! });
    if (entries.size > RUN_CODE_FILES) fail("tracked source file count exceeds the bound");
  }
  return entries;
}
/** Bind only committed checked-out source; no accounts, remote Git operations, effects or result authority. */
export function bindRunCode(root: string): RunCodeBinding {
  let home: string | undefined;
  try {
    const requested = resolve(root);
    if (lstatSync(requested).isSymbolicLink()) fail("source root links are refused");
    const dir = realpathSync(requested);
    home = mkdtempSync(join(tmpdir(), "ares-code-binding-home-"));
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, TMPDIR: home, LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_NO_LAZY_FETCH: "1", GIT_CEILING_DIRECTORIES: dirname(dir), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_ATTR_NOSYSTEM: "1", GIT_PAGER: "cat", PAGER: "cat",
    };
    const git = (...args: string[]): string => {
      const result = spawnSync("git", ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "credential.helper=", "-c", "core.attributesFile=/dev/null", "-c", "core.excludesFile=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "protocol.allow=never", ...args], {
        cwd: dir, env, encoding: "utf8", maxBuffer: GIT_BYTES, timeout: GIT_TIMEOUT_MS,
      });
      if (result.error || result.status !== 0 || Buffer.byteLength(result.stdout) > GIT_BYTES) fail("Git read failed, timed out or exceeded its output bound");
      return result.stdout;
    };
    if (realpathSync(git("rev-parse", "--show-toplevel").trim()) !== dir) fail("root must be the repository top level");
    const commit = git("rev-parse", "--verify", "HEAD").trim(), tree = git("rev-parse", "--verify", "HEAD^{tree}").trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) fail("missing committed source identity");
    const treeText = git("ls-tree", "-r", "-z", "HEAD", "--", ...ROOTS), indexText = git("ls-files", "--stage", "-z", "--", ...ROOTS);
    const tracked = names(treeText, true), index = names(indexText, false);
    if (tracked.size !== index.size || [...tracked].some(([name, value]) => { const staged = index.get(name); return !staged || staged.hash !== value.hash || staged.mode !== value.mode; })) fail("staged source differs from HEAD");
    for (const name of REQUIRED) if (!tracked.has(name)) fail("required bootstrap, lockfile or evaluation harness is missing");
    const files: RunCodeBinding["files"] = []; let bytes = 0, directories = 0;
    function walk(name: string, depth: number): void {
      const file = join(dir, name), info = lstatSync(file);
      if (info.isSymbolicLink()) fail("source links are refused");
      if (info.isDirectory()) {
        if (++directories > CODE_DIRECTORIES || depth > CODE_DEPTH) fail("source directory count or depth exceeds the bound");
        const directory = opendirSync(file);
        try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) walk(`${name}/${entry.name}`, depth + 1); }
        finally { directory.closeSync(); }
        return;
      }
      if (!info.isFile()) fail("source must contain regular files only");
      const expected = tracked.get(name);
      if (!expected) fail("new or ignored source is not committed");
      if (files.length >= RUN_CODE_FILES || info.size > RUN_CODE_FILE_BYTES || info.size > RUN_CODE_TOTAL_BYTES - bytes) fail("source file count or byte bound exceeded");
      const content = readBytesBounded(file, Math.min(RUN_CODE_FILE_BYTES, RUN_CODE_TOTAL_BYTES - bytes), { noFollow: true });
      bytes += content.length;
      const blob = createHash(expected.hash.length === 40 ? "sha1" : "sha256").update(`blob ${content.length}\0`).update(content).digest("hex");
      if (blob !== expected.hash) fail("dirty source bytes differ from HEAD");
      // Git records the executable bit on POSIX filesystems; it affects direct bootstrap execution.
      if (((info.mode & 0o111) !== 0) !== (expected.mode === "100755")) fail("dirty source executable mode differs from HEAD");
      files.push({ path: name, sha256: sha256(content), bytes: content.length });
    }
    for (const name of ROOTS) {
      const parts = name.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = lstatSync(join(dir, ...parts.slice(0, i)));
        if (parent.isSymbolicLink() || !parent.isDirectory()) fail("source parent links or non-directories are refused");
      }
      walk(name, 0);
    }
    if (files.length !== tracked.size) fail("committed source files are missing");
    if (git("rev-parse", "--verify", "HEAD").trim() !== commit || git("ls-files", "--stage", "-z", "--", ...ROOTS) !== indexText) fail("source identity changed during admission");
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { commit, tree, files, codeSha256: sha256(JSON.stringify(files)) };
  } catch (error) {
    if (error instanceof CodeBindingError) throw error;
    fail("source is missing, unreadable, linked or over-bound");
  } finally { if (home !== undefined) rmSync(home, { recursive: true, force: true }); }
}
