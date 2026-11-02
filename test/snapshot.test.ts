import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processEnvironment, spawnRunner, type Executor, type ProcessRequest, type ProcessResult, type ProcessRunner } from "../src/exp/executor.ts";
import { resolveSnapshot, SNAPSHOT_BYTES, transferSnapshot, transferTask } from "../src/exp/snapshot.ts";
import { taskTreeHash } from "../src/exp/protocol.ts";
import { readBytesBounded, sha256 } from "../src/study.ts";
import { fakeDocker, tempDir } from "./helpers.ts";

const commit = "a".repeat(40), treeId = "b".repeat(40), local: Executor = { v: 1, kind: "local", workdir: "/private/executor" };
const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
function chunksRunner(chunks: Uint8Array[], requests: ProcessRequest[], received: Uint8Array[], fail: "source" | "extract" | undefined = undefined): ProcessRunner {
  return async request => {
    requests.push(request);
    if (request.stdoutSink) {
      if (fail === "source") throw new Error("synthetic-private-process-diagnostics");
      for (const chunk of chunks) await request.stdoutSink(chunk);
    } else {
      if (fail === "extract") throw new Error("synthetic-private-process-diagnostics");
      for await (const chunk of request.stdin as AsyncIterable<Uint8Array>) received.push(chunk);
    }
    return ok();
  };
}

test("snapshot resolution accepts a full existing commit and records its tree", async () => {
  const fake = fakeDocker([ok("commit\n"), ok(`${treeId}\n`)]);
  expect(await resolveSnapshot("synthetic-repo", commit.toUpperCase(), fake.runner)).toEqual({ commit, treeId });
  expect(fake.requests.map(r => r.args)).toEqual([["-C", "synthetic-repo", "cat-file", "-t", commit], ["-C", "synthetic-repo", "rev-parse", "--verify", `${commit}^{tree}`]]);
});

test("snapshot resolution refuses short SHAs, absent commits, tag objects and malformed trees with recovery", async () => {
  const untouched = fakeDocker([]);
  for (const value of ["HEAD", "abc123", "-".repeat(40)]) await expect(resolveSnapshot("synthetic-repo", value, untouched.runner)).rejects.toThrow("full 40-hex SHA required; pass the commit SHA");
  expect(untouched.requests).toHaveLength(0);
  for (const script of [[ok("tag")], [{ exitCode: 128, stdout: "", stderr: "synthetic-secret" }], [new Error("synthetic-secret")]]) {
    await expect(resolveSnapshot("synthetic-repo", commit, fakeDocker(script).runner)).rejects.toThrow("snapshot Git commit validation failed; check --repo");
  }
  await expect(resolveSnapshot("synthetic-repo", commit, fakeDocker([ok("commit"), ok("not-a-tree")]).runner)).rejects.toThrow("snapshot Git tree resolution failed; check --repo");
});

test("snapshot streaming preserves binary archive chunks and hashes the exact transferred bytes", async () => {
  const chunks = [new Uint8Array([0, 255, 1]), new Uint8Array([128, 4, 10])], requests: ProcessRequest[] = [], received: Uint8Array[] = [];
  const result = await transferSnapshot("synthetic-repo", commit, local, "/private/executor/snapshot", chunksRunner(chunks, requests, received));
  expect(result).toEqual({ sha256: sha256(Buffer.concat(chunks)), bytes: 6 });
  expect(Buffer.concat(received)).toEqual(Buffer.concat(chunks));
  expect(requests[0]?.args).toEqual(["-C", "synthetic-repo", "archive", "--format=tar", commit]);
  expect(requests[1]?.command).toBe("tar");
  expect(requests[1]?.args).toEqual(["--no-same-owner", "-xf", "-", "-C", "/private/executor/snapshot"]);
  expect(requests[0]?.signal).toBe(requests[1]?.signal);
});

test("SSH extraction uses the existing quoted BatchMode transport", async () => {
  const requests: ProcessRequest[] = [], received: Uint8Array[] = [];
  await transferSnapshot("synthetic-repo", commit, { ...local, kind: "ssh", host: "fixture-host" }, "/private/executor/snapshot with space", chunksRunner([new Uint8Array([1])], requests, received));
  expect(requests[1]?.command).toBe("ssh");
  expect(requests[1]?.args.slice(0, 4)).toEqual(["-o", "BatchMode=yes", "fixture-host", "tar"]);
  expect(requests[1]?.args.at(-1)).toBe("'/private/executor/snapshot with space'");
});

test("snapshot stream refuses the first byte past 256 MiB without forwarding it", async () => {
  const chunk = new Uint8Array(1024 * 1024), requests: ProcessRequest[] = [];
  let emitted = 0, received = 0;
  const runner: ProcessRunner = async request => {
    requests.push(request);
    if (request.stdoutSink) {
      for (let i = 0; i < SNAPSHOT_BYTES / chunk.byteLength; i++) { await request.stdoutSink(chunk); emitted += chunk.byteLength; }
      await request.stdoutSink(new Uint8Array([1]));
    } else for await (const bytes of request.stdin as AsyncIterable<Uint8Array>) received += bytes.byteLength;
    return ok();
  };
  await expect(transferSnapshot("synthetic-repo", commit, local, "/private/executor/snapshot", runner)).rejects.toThrow(`snapshot archive: larger than ${SNAPSHOT_BYTES} bytes; reduce the committed snapshot`);
  expect(emitted).toBe(SNAPSHOT_BYTES); expect(received).toBeLessThanOrEqual(SNAPSHOT_BYTES);
  expect(requests.every(r => r.signal?.aborted)).toBe(true);
});

test("archive and extraction failures abort both sides and hide process diagnostics", async () => {
  for (const fail of ["source", "extract"] as const) {
    const requests: ProcessRequest[] = [], received: Uint8Array[] = [];
    try {
      await transferSnapshot("synthetic-private-repo", commit, local, "/private/executor/snapshot", chunksRunner([new Uint8Array(128 * 1024)], requests, received, fail));
      throw new Error("unexpected success");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("failed;"); expect(message).toContain("retry ares attempt run");
      expect(message).not.toContain("synthetic-private");
      expect(requests.every(r => r.signal?.aborted)).toBe(true);
    }
  }
});

test("task transfer archives only evaluator and returns bounded binary evidence", async () => {
  const requests: ProcessRequest[] = [], received: Uint8Array[] = [], content = new Uint8Array([0, 128, 255]);
  const task = tempDir(); mkdirSync(join(task, "evaluator")); writeFileSync(join(task, "evaluator", "run"), "synthetic evaluator");
  const result = await transferTask(task, local, "/private/executor/task", chunksRunner([content], requests, received));
  expect(result).toMatchObject({ sha256: sha256(content), bytes: 3 }); expect(result.treeHash).toHaveLength(64);
  expect(requests[0]?.command).toBe("tar");
  expect(requests[0]?.args.slice(2)).toEqual(["-cf", "-", "evaluator"]);
  expect(requests[0]?.args[1]).not.toBe(task); expect(existsSync(requests[0]!.args[1]!)).toBe(false);
});

test("task archive hashes captured bytes and transfers private staging despite later source edits", async () => {
  const study = tempDir(), task = join(study, "task"); mkdirSync(join(task, "evaluator"), { recursive: true });
  writeFileSync(join(task, "task.md"), "synthetic task"); writeFileSync(join(task, "evaluator", "run"), "approved evaluator", { mode: 0o751 });
  const expected = taskTreeHash(study), requests: ProcessRequest[] = [], received: Uint8Array[] = [];
  const runner = chunksRunner([new Uint8Array([1])], requests, received);
  const capturing: ProcessRunner = async request => {
    if (request.stdoutSink) {
      writeFileSync(join(task, "evaluator", "run"), "later edit");
      const staged = join(request.args[1]!, "evaluator", "run");
      expect(readBytesBounded(staged, 100).toString()).toBe("approved evaluator");
      expect(statSync(staged).mode & 0o777).toBe(0o751);
    }
    return runner(request);
  };
  expect((await transferTask(task, local, "/private/executor/task", capturing, expected)).treeHash).toBe(expected);
  expect(taskTreeHash(study)).not.toBe(expected);
  const unused = fakeDocker([]);
  await expect(transferTask(task, local, "/private/executor/task", unused.runner, expected)).rejects.toThrow("content changed since approval; set the protocol, approve design again");
  expect(unused.requests).toHaveLength(0);
});

test("spawn runner binary pumps transfer a synthetic git commit independent of dirty worktree", async () => {
  const repo = tempDir(), destination = tempDir();
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", repo, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.test", ...args], { env: processEnvironment(process.env), encoding: "utf8" });
    expect(result.status).toBe(0); return result.stdout.trim();
  };
  git(["init", "-q"]); const bytes = new Uint8Array([0, 255, 128, 10]);
  writeFileSync(join(repo, "synthetic.bin"), bytes); git(["add", "synthetic.bin"]); git(["commit", "-qm", "synthetic snapshot"]);
  const sha = git(["rev-parse", "HEAD"]), snapshot = await resolveSnapshot(repo, sha, spawnRunner);
  expect(snapshot.treeId).toBe(git(["rev-parse", "HEAD^{tree}"]));
  writeFileSync(join(repo, "synthetic.bin"), "dirty worktree");
  const transferred = await transferSnapshot(repo, sha, local, destination, spawnRunner);
  expect(transferred.bytes).toBeGreaterThan(0); expect(transferred.sha256).toHaveLength(64);
  expect(readBytesBounded(join(destination, "synthetic.bin"), 100)).toEqual(Buffer.from(bytes));
  const task = tempDir(), remoteTask = tempDir(); mkdirSync(join(task, "evaluator")); writeFileSync(join(task, "evaluator", "run"), "synthetic evaluator");
  await transferTask(task, local, remoteTask, spawnRunner);
  expect(readBytesBounded(join(remoteTask, "evaluator", "run"), 100).toString()).toBe("synthetic evaluator");
});
