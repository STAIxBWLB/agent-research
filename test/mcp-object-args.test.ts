import {expect, test} from "bun:test";
import {join} from "node:path";
import {PassThrough} from "node:stream";
import * as ops from "../src/commands.ts";
import {serveMcp, type McpHandler, type McpTool} from "../src/mcp.ts";
import {ARES_TOOLS, createAresMcp} from "../src/mcp-tools.ts";
import {parseProbeFixture} from "../src/harness/receipts.ts";
import {readTextBounded} from "../src/study.ts";
import {fakeHttp, fakeRunner, tempDir} from "./helpers.ts";

/** #198: the ten object arguments whose closed shape the handler validates. */
const OBJECT_ARGS: Record<string, string> = {
  ares_lesson_propose: "proposal", ares_harness_close: "closure", ares_harness_contrast: "contrast", ares_harness_compose: "composition",
  ares_harness_adopt: "decision", ares_harness_stream_set: "stream", ares_experience_select: "selection", ares_experience_freeze: "context",
  ares_harness_set: "round", ares_harness_import: "fixture",
};
const nested = {id: "synthetic", v: 1, items: [{key: "a", n: 2}], flags: {on: true}, note: null};

async function serve(tools: readonly McpTool[], handlers: Record<string, McpHandler>, calls: {name: string; arguments: unknown}[]) {
  const input = new PassThrough(), output = new PassThrough(), chunks: string[] = [];
  output.on("data", chunk => chunks.push(String(chunk)));
  const done = serveMcp({tools, handlers, input, output});
  const frames = [
    {jsonrpc: "2.0", id: 0, method: "initialize", params: {protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {name: "synthetic", version: "1"}}},
    {jsonrpc: "2.0", method: "notifications/initialized"},
    ...calls.map((params, index) => ({jsonrpc: "2.0", id: index + 1, method: "tools/call", params})),
  ];
  for (const frame of frames) input.write(JSON.stringify(frame) + "\n"); input.end(); await done;
  const replies = chunks.join("").split("\n").filter(Boolean).map(line => JSON.parse(line));
  return calls.map((_, index) => replies.find(reply => reply.id === index + 1));
}
function requiredArgs(tool: McpTool, object: unknown): Record<string, unknown> {
  const schema = tool.inputSchema as {properties: Record<string, {type?: string; enum?: unknown[]; minLength?: number}>; required: string[]};
  const args: Record<string, unknown> = {};
  for (const key of schema.required) {
    const field = schema.properties[key]!;
    args[key] = key === OBJECT_ARGS[tool.name] ? object : key === "study" ? "/synthetic/study" : field.enum ? field.enum[0] : field.type === "boolean" ? true : field.type === "integer" || field.type === "number" ? 1 : "a".repeat(Math.max(1, field.minLength ?? 1));
  }
  return args;
}

test("#198 the ten object arguments advertise an explicit open schema that the MCP validator accepts", async () => {
  const tools = ARES_TOOLS.filter(tool => tool.name in OBJECT_ARGS);
  expect(tools.map(tool => tool.name).sort()).toEqual(Object.keys(OBJECT_ARGS).sort());
  const seen: Record<string, unknown> = {}, handlers: Record<string, McpHandler> = {};
  for (const tool of tools) {
    const field = (tool.inputSchema as {properties: Record<string, unknown>}).properties[OBJECT_ARGS[tool.name]!];
    expect(field).toEqual({type: "object", additionalProperties: {}});
    expect(tool.description).toContain(`The handler validates the ${OBJECT_ARGS[tool.name]} shape`);
    handlers[tool.name] = args => { seen[tool.name] = args[OBJECT_ARGS[tool.name]!]; return {ok: true}; };
  }
  const replies = await serve(tools, handlers, tools.map(tool => ({name: tool.name, arguments: requiredArgs(tool, nested)})));
  for (const reply of replies) { expect(reply.error).toBeUndefined(); expect(reply.result.isError).toBeUndefined(); }
  for (const name of Object.keys(OBJECT_ARGS)) expect(seen[name]).toEqual(nested);
  // Only objects pass: the argument stays typed.
  const wrong = await serve(tools, handlers, tools.map(tool => ({name: tool.name, arguments: requiredArgs(tool, "not-an-object")})));
  for (const reply of wrong) expect(reply.error.code).toBe(-32602);
});

test("#198 real handlers behind the MCP server refuse an unknown field and accept a real round", async () => {
  const home = tempDir(), dir = join(home, "study"), transport = fakeRunner([]), ctx = {actor: {kind: "person" as const}, http: fakeHttp([]).http, runner: transport.runner};
  ops.init(dir, {question: "Synthetic MCP object arguments", mode: "experiment", autonomy: "gates"}, ctx);
  const server = createAresMcp({HOME: home, AGENTHUB_HOME: join(home, "family")}, ctx.http, ctx);
  const tools = server.tools.filter(tool => tool.name in OBJECT_ARGS);
  const refused = await serve(tools, server.handlers, tools.map(tool => ({name: tool.name, arguments: {...requiredArgs(tool, {syntheticUnknownField: 1}), study: dir}})));
  for (const reply of refused) { expect(reply.error).toBeUndefined(); expect(reply.result.isError).toBe(true); }
  const source = (name: string) => parseProbeFixture(JSON.parse(readTextBounded(join(import.meta.dir, "fixtures", "harness-rounds", name + ".json"), 65536)));
  const baseline = source("baseline"), candidate = source("candidate");
  const round = {v: 1, id: "round-one", task: {id: baseline.taskId, inputSha256: baseline.taskInputHash}, baseline: {guidanceSha256: baseline.baselineHash}, candidates: [{id: candidate.arm, guidanceSha256: candidate.guidanceHash, category: "procedure"}], hypothesis: {deficiency: "Synthetic output omits a required check", predictedChange: "The synthetic candidate names that check"}, experience: [], authoring: "uncontrolled-authoring"};
  const [set] = await serve(tools, server.handlers, [{name: "ares_harness_set", arguments: {study: dir, round}}]);
  expect(set.error).toBeUndefined();
  expect(set.result.isError ? JSON.parse(set.result.content[0].text) : "accepted").toBe("accepted");
});
