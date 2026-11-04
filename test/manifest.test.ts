import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { version } from "../package.json";
import { COMMANDS } from "../src/commands-table.ts";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { serveMcp } from "../src/mcp.ts";
import { fakeHttp } from "./helpers.ts";

test("manifest CLI and MCP publish the package version, all commands and implemented format versions without I/O", async () => {
  const expected = ops.manifest();
  expect(expected.v).toBe(1); expect(expected.version).toBe(version);
  expect(expected.commands).toEqual(COMMANDS.map(({ name, usage }) => ({ name, usage })));
  expect(expected.formats).toEqual({ manifest: 1, study: 1, studyPlan: 1, ledgerEvent: 1, experimentProtocol: 1, experimentSelection: 1, experimentFinalSeeds: 1, ablateResult: 1, finalResult: 1, investigateResult: 1, executor: 1, experimentAttempt: 1 });
  const forbidden = async () => { throw new Error("manifest must not start a process"); };
  const cli = await run(["manifest", "--json"], {}, { http: fakeHttp([]).http, runner: forbidden });
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toEqual(expected);
  const server = createAresMcp({}, fakeHttp([]).http, { runner: forbidden });
  const tool = ARES_TOOLS.find(tool => tool.name === "ares_manifest")!;
  expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const input = new PassThrough(), output = new PassThrough(), chunks: string[] = [];
  output.on("data", chunk => chunks.push(String(chunk)));
  const done = serveMcp({ ...server, input, output });
  for (const frame of [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ares_manifest", arguments: {} } },
  ]) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done;
  const reply = chunks.join("").split("\n").filter(Boolean).map(line => JSON.parse(line)).find(reply => reply.id === 2);
  expect(reply.error).toBeUndefined(); expect(JSON.parse(reply.result.content[0].text)).toEqual(expected);
  // A caller cannot alter later discovery results by modifying a returned manifest.
  expected.commands.length = 0; Object.assign(expected.formats, { study: 999 });
  expect(ops.manifest().commands.length).toBe(COMMANDS.length); expect(ops.manifest().formats.study).toBe(1);
});

test("manifest rejects positional arguments and unsupported options", async () => {
  await expect(run(["manifest", "/synthetic"])).rejects.toThrow("usage:");
  await expect(run(["manifest", "--file", "synthetic"])).rejects.toThrow("unknown or repeated option");
});
