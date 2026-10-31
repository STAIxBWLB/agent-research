import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { serveMcp } from "../src/mcp.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { fakeHttp, searchRoutes, tempDir } from "./helpers.ts";

async function session(frames: unknown[]): Promise<Record<string, any>[]> {
  const input = new PassThrough(), output = new PassThrough(), chunks: string[] = [];
  output.on("data", c => chunks.push(String(c)));
  const server = createAresMcp({}, fakeHttp(searchRoutes()).http);
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output, name: "ares", version: "test" });
  for (const frame of frames) input.write(JSON.stringify(frame) + "\n");
  input.end();
  await done;
  return chunks.join("").split("\n").filter(Boolean).map(line => JSON.parse(line));
}
const init = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }];

describe("AC9 MCP", () => {
  test("initialize, list tools, run ares_status against a fixture study; scope set through MCP records an agent", async () => {
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?" }, { actor: { kind: "person" } });
    const replies = await session([...init,
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ares_scope_set", arguments: { study: dir, scope: { question: "Q?", subquestions: ["a"] } } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ares_status", arguments: { study: dir } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ares_status", arguments: { study: "relative/path" } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ares_scope_set", arguments: { study: dir, scope: { question: "Q?", bogus: 1 } } } },
    ]);
    expect(replies[0]!.result.serverInfo.name).toBe("ares");
    expect(replies[1]!.result.tools.map((t: { name: string }) => t.name)).toContain("ares_lit_verify");
    const status = JSON.parse(replies[3]!.result.content[0].text);
    expect(status.gates[0]).toMatchObject({ gate: "scope", state: "pending" });
    expect(replies[4]!.result.isError).toBe(true);
    expect(replies[5]!.error.code).toBe(-32602);
    const { readLedger } = await import("../src/study.ts");
    expect(readLedger(dir).find(e => e.type === "scope.set")!.actor).toEqual({ kind: "agent", id: "mcp" });
  });
});
