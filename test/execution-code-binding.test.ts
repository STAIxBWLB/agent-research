import { expect, spyOn, test } from "bun:test";
import * as child from "node:child_process";
import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bindRunCode, RUN_CODE_FILE_BYTES, RUN_CODE_FILES } from "../scripts/execution-code-binding.ts";
import { tempDir } from "./helpers.ts";

function fixture() {
  const parent = realpathSync(tempDir()), root = join(parent, "repo"), home = join(parent, "home");
  mkdirSync(root); mkdirSync(home);
  const git = (...args: string[]) => {
    const result = child.spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
      cwd: root, env: { PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }, encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0 || result.error) throw new Error("synthetic fixture Git setup failed");
    return result.stdout.trim();
  };
  const write = (name: string, bytes: string | Uint8Array) => { const file = join(root, name); mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, bytes); };
  git("init", "--quiet");
  write("bin/ares.js", "// synthetic bootstrap\n"); write("package.json", '{"name":"synthetic-fixture","version":"0.0.0"}\n'); write("bun.lock", "synthetic-lock\n");
  write("scripts/execution-eval.ts", "export const syntheticHarness = 1;\n"); write("src/runtime.ts", "export const syntheticRuntime = 1;\n");
  const commit = () => { git("add", "--all"); git("commit", "--quiet", "-m", "Synthetic fixture"); };
  commit(); return { root, home, git, write, commit };
}

test("binding includes bootstrap, package, lock, harness and runtime bytes; committed changes alter it", () => {
  const f = fixture(); let previous = bindRunCode(f.root);
  expect(previous.files.map(file => file.path)).toEqual(["bin/ares.js", "bun.lock", "package.json", "scripts/execution-eval.ts", "src/runtime.ts"]);
  expect(previous.commit).toBe(f.git("rev-parse", "HEAD")); expect(previous.tree).toBe(f.git("rev-parse", "HEAD^{tree}"));
  expect(bindRunCode(f.root)).toEqual(previous);
  for (const name of ["bin/ares.js", "scripts/execution-eval.ts", "src/runtime.ts", "package.json", "bun.lock"]) {
    f.write(name, `// revised synthetic ${name}\n`); f.commit(); const next = bindRunCode(f.root);
    expect(next.commit).not.toBe(previous.commit); expect(next.tree).not.toBe(previous.tree); expect(next.codeSha256).not.toBe(previous.codeSha256);
    expect(next.files.find(file => file.path === name)!.sha256).not.toBe(previous.files.find(file => file.path === name)!.sha256); previous = next;
  }
  f.write("receipts/synthetic.json", "{}\n"); expect(bindRunCode(f.root)).toEqual(previous);
  f.commit(); const receiptsCommit = bindRunCode(f.root);
  expect(receiptsCommit.commit).not.toBe(previous.commit); expect(receiptsCommit.codeSha256).toBe(previous.codeSha256); expect(receiptsCommit.files).toEqual(previous.files);
});

test("dirty, staged, untracked and ignored source files refuse, including assume-unchanged content", () => {
  for (const shape of ["dirty", "staged", "new", "ignored", "assume-unchanged"] as const) {
    const f = fixture();
    if (shape === "ignored") { f.write(".gitignore", "src/ignored.ts\n"); f.commit(); f.write("src/ignored.ts", "uncommitted synthetic source\n"); }
    else if (shape === "new") f.write("scripts/new.ts", "uncommitted synthetic source\n");
    else {
      if (shape === "assume-unchanged") f.git("update-index", "--assume-unchanged", "src/runtime.ts");
      f.write("src/runtime.ts", "changed synthetic runtime\n");
      if (shape === "staged") f.git("add", "src/runtime.ts");
    }
    expect(() => bindRunCode(f.root)).toThrow(/execution code binding:.*; restore and commit/);
  }
});

test("required bootstrap and harness, root containment and source links fail closed", () => {
  for (const name of ["bin/ares.js", "scripts/execution-eval.ts"]) {
    const f = fixture(); rmSync(join(f.root, name)); f.commit(); expect(() => bindRunCode(f.root)).toThrow("required bootstrap");
  }
  const rootLink = fixture(), alias = join(rootLink.home, "repo-link"); symlinkSync(rootLink.root, alias);
  expect(() => bindRunCode(alias)).toThrow("root links");
  expect(() => bindRunCode(join(rootLink.root, "src"))).toThrow("execution code binding:");
  const fileLink = fixture(); symlinkSync(join(fileLink.home, "missing"), join(fileLink.root, "src", "linked.ts"));
  expect(() => bindRunCode(fileLink.root)).toThrow("source links");
  const parentLink = fixture(); renameSync(join(parentLink.root, "bin"), join(parentLink.home, "bootstrap")); symlinkSync(join(parentLink.home, "bootstrap"), join(parentLink.root, "bin"));
  expect(() => bindRunCode(parentLink.root)).toThrow("source parent links");
  const trackedLink = fixture(); rmSync(join(trackedLink.root, "src", "runtime.ts")); symlinkSync(join(trackedLink.home, "missing"), join(trackedLink.root, "src", "runtime.ts")); trackedLink.commit();
  expect(() => bindRunCode(trackedLink.root)).toThrow("non-regular");
});

test("source byte/count ceilings and changed executable modes refuse", () => {
  const bytes = fixture(); truncateSync(join(bytes.root, "src", "runtime.ts"), RUN_CODE_FILE_BYTES + 1);
  expect(() => bindRunCode(bytes.root)).toThrow("byte bound");
  const count = fixture(); for (let i = 0; i < RUN_CODE_FILES; i++) count.write(`src/file-${i}.ts`, ""); count.commit();
  expect(() => bindRunCode(count.root)).toThrow("file count");
  const mode = fixture(); chmodSync(join(mode.root, "bin", "ares.js"), 0o755);
  expect(() => bindRunCode(mode.root)).toThrow("executable mode");
});

test("Git reads use isolated homes, bounded calls and disabled configuration helpers", () => {
  const f = fixture(), marker = join(f.home, "helper-ran"), helper = join(f.home, "fsmonitor");
  writeFileSync(helper, `#!/bin/sh\ntouch '${marker}'\n`); chmodSync(helper, 0o700);
  f.git("config", "core.fsmonitor", helper); f.git("config", "core.hooksPath", f.home);
  const spawn = child.spawnSync, calls: { args: readonly string[]; env: NodeJS.ProcessEnv; timeout: number | undefined; maxBuffer: number | undefined }[] = [];
  const spy = spyOn(child, "spawnSync").mockImplementation(((program, args, options) => {
    const value = options as child.SpawnSyncOptions;
    calls.push({ args: args as string[], env: value.env!, timeout: value.timeout, maxBuffer: value.maxBuffer });
    return spawn(program, args, options);
  }) as typeof child.spawnSync);
  try { bindRunCode(f.root); }
  finally { spy.mockRestore(); }
  expect(calls.length).toBeGreaterThan(0); expect(existsSync(marker)).toBe(false);
  for (const call of calls) {
    expect(call.env.HOME).not.toBe(process.env.HOME); expect(call.env.HOME).not.toBe(f.home);
    expect(call.env.GIT_CONFIG_GLOBAL).toBe("/dev/null"); expect(call.env.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(call.env.GIT_TERMINAL_PROMPT).toBe("0"); expect(call.env.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(call.args).toContain("core.fsmonitor=false"); expect(call.args).toContain("core.hooksPath=/dev/null");
    expect(call.timeout).toBe(5000); expect(call.maxBuffer).toBe(1024 * 1024);
    expect(existsSync(call.env.HOME!)).toBe(false);
  }
});

test("historical run identity verifies real commit/tree/ancestry and source blobs", async () => {
  const {verifyRunCodeCommit} = await import("../scripts/execution-code-binding.ts"), {sha256} = await import("../src/study.ts"), f = fixture(), original = bindRunCode(f.root);
  expect(() => verifyRunCodeCommit(f.root, original)).not.toThrow();
  expect(() => verifyRunCodeCommit(f.root, {...original, commit: "f".repeat(40)})).toThrow("execution code binding");
  expect(() => verifyRunCodeCommit(f.root, {...original, tree: "e".repeat(40)})).toThrow("stored run tree mismatch");
  f.write("src/runtime.ts", "export const changed = 2;\n"); f.commit(); const changed = bindRunCode(f.root);
  expect(() => verifyRunCodeCommit(f.root, changed)).not.toThrow();
  expect(() => verifyRunCodeCommit(f.root, {...original, commit: changed.commit, tree: changed.tree})).toThrow("stored commit file hash mismatch");
  const forged = structuredClone(original); forged.files[0]!.sha256 = "a".repeat(64); forged.codeSha256 = sha256(JSON.stringify(forged.files)); expect(() => verifyRunCodeCommit(f.root, forged)).toThrow("stored commit file hash mismatch");
  expect(() => verifyRunCodeCommit(f.root, original)).not.toThrow();
  f.write("src/space source.ts", "// Synthetic native filename\n"); f.commit(); expect(() => verifyRunCodeCommit(f.root, bindRunCode(f.root))).not.toThrow();
  f.git("checkout", "--quiet", "--detach", original.commit); expect(() => verifyRunCodeCommit(f.root, changed)).toThrow("not an ancestor");
});
