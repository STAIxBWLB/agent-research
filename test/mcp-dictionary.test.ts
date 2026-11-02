import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { experimentTree } from "./exp-fixture.ts";
import { metricProtocol } from "./metric-fixtures.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

test("explicit string dictionaries preserve CLI/MCP protocol parity without accepting object-valued prototype keys", async () => {
  const protocol = metricProtocol(); protocol.candidate.env = Object.fromEntries(["constructor", "prototype", "__proto__"].map(key => [key, `synthetic-${key}`]));
  const schema = ARES_TOOLS.find(tool => tool.name === "ares_protocol_set")!.inputSchema, cli = tempDir(), mcp = tempDir(), http = fakeHttp([]).http;
  for (const dir of [cli, mcp]) { await run(["init", dir, "--question", "Synthetic?", "--mode", "experiment"], {}, { http }); experimentTree(dir); }
  expect(validArguments({ study: mcp, protocol }, schema)).toBe(true);
  await run(["protocol", cli, "--file", "-"], {}, { http, readStdin: async () => JSON.stringify(protocol) });
  await createAresMcp({}, http).handlers.ares_protocol_set!({ study: mcp, protocol });
  expect(readFileSync(join(cli, "design", "protocol.json"))).toEqual(readFileSync(join(mcp, "design", "protocol.json")));
  const parsed = JSON.parse(readFileSync(join(mcp, "design", "protocol.json"), "utf8")); expect(parsed.candidate.env.__proto__).toBe("synthetic-__proto__");
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  const unsafe = { ...protocol, candidate: { ...protocol.candidate, env: JSON.parse('{"__proto__":{"polluted":true}}') } };
  expect(validArguments({ study: mcp, protocol: unsafe }, schema)).toBe(false);
  expect(validArguments({ study: mcp, protocol, constructor: "unexpected" }, schema)).toBe(false);
});
