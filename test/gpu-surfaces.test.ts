import { expect, test } from "bun:test";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { readBytesBounded } from "../src/study.ts";
import { fakeHttp, fakeRunner, tempDir } from "./helpers.ts";

const settings = { devices: [1, "0"], minFreeMemoryMb: 4096, maxLoadRatio: 0.8 };
function fixture() {
  const home = tempDir(), dir = join(home, "study"), env = { HOME: home, AGENTHUB_HOME: join(home, "family") };
  const transport = fakeRunner([]), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http, runner: transport.runner };
  ops.init(dir, { mode: "experiment", question: "Synthetic GPU configuration" }, ctx);
  return { home, dir, env, ctx, transport };
}
test("GPU executor settings share CLI/MCP normalization and perform no host probe", async () => {
  const f = fixture(), raw = { v: 1, kind: "local", workdir: "/synthetic/work", gpu: settings };
  const expected = await ops.executorSet(f.dir, raw, f.ctx);
  expect(expected.gpu?.devices).toEqual(["1", "0"]);
  const cli = await run(["executor", "set", f.dir, "--kind", "local", "--workdir", raw.workdir, "--gpu-devices", "1,0", "--gpu-min-free-memory-mb", "4096", "--gpu-max-load-ratio", "0.8", "--json"], f.env, f.ctx);
  expect(JSON.parse(cli.text)).toEqual(expected); expect(cli.code).toBe(0);
  const mcp = createAresMcp(f.env, f.ctx.http, f.ctx);
  expect(await mcp.handlers.ares_executor_set!({ study: f.dir, kind: "local", workdir: raw.workdir, gpu: settings })).toEqual(expected);
  const schema = ARES_TOOLS.find(tool => tool.name === "ares_executor_set")!.inputSchema;
  expect(validArguments({ study: f.dir, kind: "local", workdir: raw.workdir, gpu: settings }, schema)).toBe(true);
  expect(f.transport.requests).toHaveLength(0);
});
test("partial or invalid GPU flags and MCP settings preserve the existing config and ledger", async () => {
  const f = fixture(); await ops.executorSet(f.dir, { v: 1, kind: "local", workdir: "/synthetic/work" }, f.ctx);
  const before = ["executor.json", "ledger.jsonl"].map(name => readBytesBounded(join(f.dir, name), 1024 * 1024));
  const base = ["executor", "set", f.dir, "--kind", "local", "--workdir", "/synthetic/work"];
  for (const flags of [["--gpu-devices", "0"], ["--gpu-devices", "0", "--gpu-min-free-memory-mb", "4096"], ["--gpu-devices", "", "--gpu-min-free-memory-mb", "4096", "--gpu-max-load-ratio", "0.8"], ["--gpu-devices", "0", "--gpu-min-free-memory-mb", "0x20", "--gpu-max-load-ratio", "0.8"]])
    await expect(run([...base, ...flags, "--json"], f.env, f.ctx)).rejects.toThrow();
  const mcp = createAresMcp(f.env, f.ctx.http, f.ctx);
  for (const gpu of [{ devices: [0] }, { ...settings, extra: true }, { ...settings, devices: [0, "0"] }, { ...settings, maxLoadRatio: 0 }])
    await expect(mcp.handlers.ares_executor_set!({ study: f.dir, kind: "local", workdir: "/synthetic/work", gpu })).rejects.toThrow("executor.gpu");
  ["executor.json", "ledger.jsonl"].forEach((name, i) => expect(readBytesBounded(join(f.dir, name), 1024 * 1024)).toEqual(before[i]!));
  expect(f.transport.requests).toHaveLength(0);
});
