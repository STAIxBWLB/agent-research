import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { hashExecutorInput, INPUT_MANIFEST_SCRIPT, INPUT_MANIFEST_FILES, INPUT_MANIFEST_TIMEOUT_MS, INPUT_MANIFEST_OUTPUT_BYTES, shellQuote, type Executor, type ProcessResult } from "../src/exp/executor.ts";
import { sha256, writeAtomic } from "../src/study.ts";
import { fakeRunner, tempDir } from "./helpers.ts";

const local: Executor = { v: 1, kind: "local", workdir: "/synthetic/work" }, remote: Executor = { ...local, kind: "ssh", host: "synthetic-host" };
const metadata = { sha256: "a".repeat(64), files: 2, bytes: 23 }, privatePath = "/synthetic/private-input-name", privateError = "synthetic confidential stderr body";
const result = (stdout = JSON.stringify(metadata), extra: Partial<ProcessResult> = {}): ProcessResult => ({ exitCode: 0, stdout, stderr: privateError, ...extra });

for (const executor of [local, remote]) test(`${executor.kind} input manifest transport uses isolated Python and bounded metadata output`, async () => {
  const path = "/synthetic/input with ' quote", fake = fakeRunner([result()]);
  expect(await hashExecutorInput(executor, path, fake.runner)).toEqual(metadata);
  expect(fake.requests).toHaveLength(1); const request = fake.requests[0]!;
  expect(request.timeoutMs).toBe(INPUT_MANIFEST_TIMEOUT_MS); expect(request.timeoutMs).toBe(300_000);
  expect(request.maxOutputBytes).toBe(INPUT_MANIFEST_OUTPUT_BYTES); expect(request.maxOutputBytes).toBe(4096);
  const args = ["-I", "-S", "-c", INPUT_MANIFEST_SCRIPT, path];
  if (executor.kind === "local") expect(request).toMatchObject({ command: "python3", args });
  else expect(request).toMatchObject({ command: "ssh", args: ["-o", "BatchMode=yes", executor.host, "python3", ...args.map(shellQuote)] });
  expect(request.stdoutSink).toBeUndefined(); expect(request.stdin).toBeUndefined();
});

test("transport failures and malformed metadata refuse without exposing paths, stdout or stderr", async () => {
  const invalidJson = [null, [], {}, { ...metadata, path: privatePath }, { ...metadata, sha256: "A".repeat(64) }, { ...metadata, sha256: "a".repeat(63) }, { ...metadata, sha256: "g".repeat(64) },
    { ...metadata, files: -1 }, { ...metadata, files: INPUT_MANIFEST_FILES + 1 }, { ...metadata, files: 1.5 }, { ...metadata, files: "2" },
    { ...metadata, bytes: -1 }, { ...metadata, bytes: 1.5 }, { ...metadata, bytes: Number.MAX_SAFE_INTEGER + 1 }, { ...metadata, bytes: "23" }, { ...metadata, bytes: null }];
  const cases: (ProcessResult | Error)[] = [new Error(`${privateError} ${privatePath}`), result(undefined, { timedOut: true }), result(undefined, { truncated: true }), result(undefined, { exitCode: 1 }), result(undefined, { exitCode: 137 }),
    result(`${privatePath} not JSON`), result("x".repeat(INPUT_MANIFEST_OUTPUT_BYTES + 1)), ...invalidJson.map(value => result(JSON.stringify(value)))];
  for (const outcome of cases) {
    const fake = fakeRunner([outcome]); let message = "";
    try { await hashExecutorInput(local, privatePath, fake.runner); } catch (error) { message = (error as Error).message; }
    expect(message).toContain("executor input manifest: hashing failed"); expect(message).toContain("rerun ares executor inputs hash");
    expect(message).not.toContain(privatePath); expect(message).not.toContain(privateError); expect(fake.requests).toHaveLength(1);
  }
});

test("inclusive metadata count bounds pass and relative input paths refuse before transport", async () => {
  for (const value of [{ ...metadata, files: 0, bytes: 0 }, { ...metadata, files: INPUT_MANIFEST_FILES, bytes: Number.MAX_SAFE_INTEGER }]) {
    const fake = fakeRunner([result(JSON.stringify(value))]); expect(await hashExecutorInput(local, privatePath, fake.runner)).toEqual(value);
  }
  const fake = fakeRunner([]);
  for (const path of ["relative/input", "", "/synthetic/input\nline"]) await expect(hashExecutorInput(local, path, fake.runner)).rejects.toThrow();
  expect(fake.requests).toHaveLength(0);
});

const python = spawnSync("python3", ["-I", "-S", "-c", "import sys;sys.stdout.write('available')"], { env: { PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 5000, maxBuffer: 4096 });
const pythonTest = python.status === 0 ? test : test.skip;
function runScript(path: string) {
  const home = realpathSync(tempDir());
  return spawnSync("python3", ["-I", "-S", "-c", INPUT_MANIFEST_SCRIPT, path], { env: { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: home }, cwd: home, encoding: "utf8", timeout: 5000, maxBuffer: INPUT_MANIFEST_OUTPUT_BYTES });
}
pythonTest("manifest script hashes UTF-8 sorted canonical JSON lines and counts actual regular bytes", () => {
  const dir = realpathSync(tempDir()), files = [{ path: "z-last.txt", text: "Synthetic last\n" }, { path: "nested/a\nquote\".txt", text: "Synthetic 한글\n" }, { path: "猫.txt", text: "Synthetic empty tail" }];
  mkdirSync(join(dir, "nested"));
  for (const file of files) writeAtomic(join(dir, file.path), file.text, 65_536);
  const expected = [...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map(file => JSON.stringify([file.path, Buffer.byteLength(file.text), sha256(file.text)]) + "\n").join("");
  const actual = runScript(dir); expect(actual.status).toBe(0); expect(actual.stderr).toBe("");
  expect(JSON.parse(actual.stdout)).toEqual({ sha256: sha256(expected), files: files.length, bytes: files.reduce((sum, file) => sum + Buffer.byteLength(file.text), 0) });
  expect(actual.stdout).not.toContain(dir); expect(actual.stdout).not.toContain("Synthetic");
});
pythonTest("manifest script supports empty directories and refuses file/root/ancestor links", () => {
  const dir = realpathSync(tempDir()), empty = join(dir, "empty"); mkdirSync(empty);
  expect(JSON.parse(runScript(empty).stdout)).toEqual({ sha256: sha256(""), files: 0, bytes: 0 });
  const sources = join(dir, "sources"), outside = join(dir, "outside.txt"); mkdirSync(sources); writeAtomic(outside, "Synthetic outside bytes\n", 65_536);
  symlinkSync(outside, join(sources, "private-input-link"));
  const alias = join(dir, "alias"); symlinkSync(empty, alias);
  const parentAlias = join(dir, "parent-alias"); symlinkSync(dir, parentAlias);
  for (const input of [sources, alias, join(parentAlias, "empty")]) {
    const actual = runScript(input); expect(actual.status).toBe(1); expect(actual.stdout).toBe(""); expect(actual.stderr).toContain("input manifest refused");
    expect(actual.stderr).not.toContain(input); expect(actual.stderr).not.toContain("private-input-link");
  }
});
