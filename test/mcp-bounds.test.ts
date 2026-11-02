import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { DEFAULT_STRING_LENGTH, FRAME_BYTES, serveMcp, validArguments, type McpTool } from "../src/mcp.ts";

test("a larger MCP envelope preserves the legacy default per-string bound", async () => {
  expect(FRAME_BYTES).toBe(128 * 1024); expect(DEFAULT_STRING_LENGTH).toBe(65_536);
  expect(validArguments("x".repeat(DEFAULT_STRING_LENGTH), { type: "string" })).toBe(true);
  expect(validArguments("x".repeat(DEFAULT_STRING_LENGTH + 1), { type: "string" })).toBe(false);
  const tool: McpTool = { name: "legacy_string", description: "Synthetic legacy schema without an explicit maxLength", inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, annotations: { readOnlyHint: true } };
  const input = new PassThrough(), output = new PassThrough(), chunks: string[] = []; let calls = 0;
  output.on("data", chunk => chunks.push(String(chunk)));
  const done = serveMcp({ tools: [tool], handlers: { legacy_string: () => { calls++; return { ok: true }; } }, input, output });
  const frames = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool.name, arguments: { value: "allowed" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: tool.name, arguments: { value: "x".repeat(DEFAULT_STRING_LENGTH + 1) } } },
  ];
  for (const frame of frames) input.write(JSON.stringify(frame) + "\n"); input.end(); await done;
  const replies = chunks.join("").split("\n").filter(Boolean).map(line => JSON.parse(line));
  expect(calls).toBe(1); expect(replies.find(reply => reply.id === 2).result.isError).toBeUndefined(); expect(replies.find(reply => reply.id === 3).error.code).toBe(-32602);
});
