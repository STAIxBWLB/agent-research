import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { experimentTree } from "./exp-fixture.ts";
import { metricProtocol } from "./metric-fixtures.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

test("CLI and MCP both refuse reserved env names without changing protocol or ledger", async () => {
  const protocol = metricProtocol();
  const schema = ARES_TOOLS.find(tool => tool.name === "ares_protocol_set")!.inputSchema, cli = tempDir(), mcp = tempDir(), http = fakeHttp([]).http;
  for (const dir of [cli, mcp]) { await run(["init", dir, "--question", "Synthetic?", "--mode", "experiment"], {}, { http }); experimentTree(dir); }
  await run(["protocol", cli, "--file", "-"], {}, { http, readStdin: async () => JSON.stringify(protocol) });
  const server = createAresMcp({}, http); await server.handlers.ares_protocol_set!({ study: mcp, protocol });
  const before = [cli, mcp].map(dir => ({ protocol: readFileSync(join(dir, "design", "protocol.json")), ledger: readFileSync(join(dir, "ledger.jsonl")) }));
  for (const key of ["constructor", "prototype", "__proto__"]) {
    const refused = { ...protocol, candidate: { ...protocol.candidate, env: Object.fromEntries([[key, `synthetic-${key}`]]) } };
    expect(validArguments({ study: mcp, protocol: refused }, schema)).toBe(false);
    await expect(run(["protocol", cli, "--file", "-"], {}, { http, readStdin: async () => JSON.stringify(refused) })).rejects.toThrow(`key ${key} is reserved for object internals; remove or rename`);
    // Direct dispatch keeps the same domain refusal even if a caller bypasses transport validation.
    await expect(server.handlers.ares_protocol_set!({ study: mcp, protocol: refused })).rejects.toThrow(`key ${key} is reserved for object internals; remove or rename`);
    for (const [index, dir] of [cli, mcp].entries()) {
      expect(readFileSync(join(dir, "design", "protocol.json"))).toEqual(before[index]!.protocol);
      expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before[index]!.ledger);
    }
  }
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  const unsafe = { ...protocol, candidate: { ...protocol.candidate, env: JSON.parse('{"__proto__":{"polluted":true}}') } };
  expect(validArguments({ study: mcp, protocol: unsafe }, schema)).toBe(false);
  expect(validArguments({ study: mcp, protocol, constructor: "unexpected" }, schema)).toBe(false);
});
