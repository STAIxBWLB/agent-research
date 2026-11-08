import { expect, test } from "bun:test";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { COMMANDS, findCommand } from "../src/commands-table.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { hashExecutorInput, readExecutor } from "../src/exp/executor.ts";
import { readBytesBounded } from "../src/study.ts";
import { fakeHttp, fakeRunner, tempDir } from "./helpers.ts";

const manifest = { sha256: "a".repeat(64), files: 3, bytes: 42 };
const response = () => ({ exitCode: 0, stdout: JSON.stringify(manifest), stderr: "" });
async function fixture(kind: "local" | "ssh" = "local", mode = "experiment") {
  const home = tempDir(), dir = join(home, "study"), env = { HOME: home, AGENTHUB_HOME: join(home, "family") };
  const ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic pre-staged executor inputs", mode }, ctx);
  if (mode === "experiment") await ops.executorSet(dir, { v: 1, kind, workdir: "/synthetic/work", ...(kind === "ssh" ? { host: "synthetic-host" } : {}) }, ctx);
  return { dir, env, ctx };
}
function before(dir: string) { return ["study.json", "ledger.jsonl", "executor.json"].map(name => [name, readBytesBounded(join(dir, name), 1024 * 1024)] as const); }
function unchanged(dir: string, original: ReturnType<typeof before>) { for (const [name, bytes] of original) expect(readBytesBounded(join(dir, name), 1024 * 1024)).toEqual(bytes); }

test("three-word executor hash command uses shared discovery without changing existing commands", () => {
  const args = ["executor", "inputs", "hash", "/synthetic/study", "/synthetic/input"];
  expect(findCommand(args)).toMatchObject({ spec: { name: "executor inputs hash", mutates: "network" }, rest: args.slice(3) });
  expect(findCommand(["executor", "check", "/synthetic/study"])?.spec.name).toBe("executor check");
  expect(findCommand(["manifest", "--json"])?.spec.name).toBe("manifest");
  expect(COMMANDS.find(command => command.name === "executor inputs hash")?.usage).toBe("executor inputs hash <dir> <path> [--json]");
});

for (const kind of ["local", "ssh"] as const) test(`${kind} configured hash response has helper/shared/CLI/MCP parity and writes no study bytes`, async () => {
  const f = await fixture(kind), original = before(f.dir), path = "/synthetic/pre-staged-input";
  const fake = fakeRunner([response(), response(), response(), response()]);
  expect(await hashExecutorInput(readExecutor(f.dir)!, path, fake.runner)).toEqual(manifest);
  expect(await ops.executorInputsHash(f.dir, path, { ...f.ctx, runner: fake.runner })).toEqual(manifest);
  const cli = await run(["executor", "inputs", "hash", f.dir, path, "--json"], f.env, { http: f.ctx.http, runner: fake.runner });
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toEqual(manifest); expect(cli.text).not.toContain(path);
  const server = createAresMcp(f.env, f.ctx.http, { runner: fake.runner });
  expect(await server.handlers.ares_executor_inputs_hash!({ study: f.dir, path })).toEqual(manifest);
  expect(fake.requests).toHaveLength(4); expect(fake.remaining()).toBe(0); unchanged(f.dir, original);
});

test("missing executor and survey modes refuse before calling any transport", async () => {
  const home = tempDir(), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http }, fake = fakeRunner([]);
  for (const mode of ["experiment", "survey"]) {
    const dir = join(home, mode); ops.init(dir, { question: "Synthetic refusal", mode }, ctx);
    const original = readBytesBounded(join(dir, "ledger.jsonl"), 1024 * 1024), reason = mode === "experiment" ? "ares executor set" : "experiment";
    await expect(ops.executorInputsHash(dir, "/synthetic/input", { ...ctx, runner: fake.runner })).rejects.toThrow(reason);
    await expect(run(["executor", "inputs", "hash", dir, "/synthetic/input", "--json"], { HOME: home, AGENTHUB_HOME: join(home, "family") }, { http: ctx.http, runner: fake.runner })).rejects.toThrow(reason);
    expect(readBytesBounded(join(dir, "ledger.jsonl"), 1024 * 1024)).toEqual(original);
  }
  expect(fake.requests).toHaveLength(0);
});

test("CLI enforces exact positional arity and leaves path validation to the shared executor helper", async () => {
  const f = await fixture(), fake = fakeRunner([]), original = before(f.dir);
  for (const positional of [[], [f.dir], [f.dir, "/synthetic/input", "extra"]])
    await expect(run(["executor", "inputs", "hash", ...positional, "--json"], f.env, { http: f.ctx.http, runner: fake.runner })).rejects.toThrow("usage:");
  await expect(ops.executorInputsHash(f.dir, "relative-input", { ...f.ctx, runner: fake.runner })).rejects.toThrow();
  expect(fake.requests).toHaveLength(0); unchanged(f.dir, original);
});

test("MCP advertises a bounded external-host read and family manifest marks it external", () => {
  const tool = ARES_TOOLS.find(tool => tool.name === "ares_executor_inputs_hash")!;
  expect(tool.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true, destructiveHint: false });
  expect(ops.manifest().mcp.tools.find(value => value.name === tool.name)?.readOnly).toBe(false);
  expect(validArguments({ study: "/synthetic/study", path: "/synthetic/input" }, tool.inputSchema)).toBe(true);
  for (const input of [{ study: "/synthetic/study" }, { study: "/synthetic/study", path: "" }, { study: "/synthetic/study", path: "x".repeat(4097) }, { study: "/synthetic/study", path: "/synthetic/input", extra: true }])
    expect(validArguments(input, tool.inputSchema)).toBe(false);
});
