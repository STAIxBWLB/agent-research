import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { serveMcp, validArguments } from "../src/mcp.ts";
import { loadCandidates } from "../src/lit/candidates.ts";
import { watchPath, type WatchConfig, type WatchRun } from "../src/lit/watch.ts";
import { readLedger, sha256 } from "../src/study.ts";
import { deferred, fakeHttp, fakeRunner, ok, status, tempDir, type Route } from "./helpers.ts";

const actor = { kind: "agent" as const, id: "synthetic" };
const watch: WatchConfig = { v: 1, queries: [{ id: "first", query: "synthetic first", source: "openalex" }, { id: "second", query: "synthetic second", source: "openalex" }], rubric: "Synthetic display-only rubric" };
const body = JSON.stringify({ results: [{ title: "Synthetic A6 record", doi: "https://doi.org/10.0000/synthetic-a6", publication_year: 2024, authorships: [] }] });
const routes = (open: Route = ok(body), s2: Route = ok('{"data":[]}'), arxiv: Route = ok('<feed></feed>')): [string, Route][] => [["https://api.openalex.org/works", open], ["https://api.semanticscholar.org/graph/v1/paper/search", s2], ["https://export.arxiv.org/api/query", arxiv]];
async function fixture(mode: "survey" | "experiment" = "survey", answers: [string, Route][] = routes(), autonomy: "gates" | "auto" = "gates", credentials: Record<string, string> = {}) {
  const home = realpathSync(tempDir()), dir = join(home, "study"), family = join(home, "family");
  const env = { HOME: home, AGENTHUB_HOME: family, AGENTHUB_PEER_ID: "synthetic", ...credentials }, http = fakeHttp(answers, env), runner = fakeRunner([]), ctx = { actor, http: http.http, runner: runner.runner };
  ops.init(dir, { question: "Synthetic A6 question", mode, autonomy }, ctx);
  await ops.scope(dir, { question: "Synthetic A6 question", yearFrom: 2020, yearTo: 2025, maxCandidates: 100 }, ctx);
  if (autonomy === "gates") await ops.gateDecide(dir, "scope", "approve", undefined, ctx);
  const server = createAresMcp(env, http.http, { runner: runner.runner });
  return { home, dir, family, env, http, runner, ctx, server, io: { http: http.http, runner: runner.runner } };
}
const call = (server: ReturnType<typeof createAresMcp>, name: string, args: Record<string, unknown> = {}) => Promise.resolve().then(() => server.handlers[name]!(args));
const tool = (name: string) => ARES_TOOLS.find(tool => tool.name === name)!;
const journal = (dir: string) => readFileSync(join(dir, "ledger.jsonl"));

function latestRun(dir: string): WatchRun {
  const data = readLedger(dir).findLast(event => event.type === "watch.ran")?.data;
  if (!data) throw new Error("expected a completed watch receipt");
  return { configSha256: data.configSha256 as string, queries: data.queries as WatchRun["queries"], added: data.added as number,
    addedIds: data.addedIds as string[], addedIdsTotal: data.addedIdsTotal as number, ok: data.ok as boolean };
}
async function finishedRun(server: ReturnType<typeof createAresMcp>, dir: string): Promise<WatchRun> {
  const ack = await call(server, "ares_watch_run", { study: dir });
  try { expect(ack).toEqual({ started: true, configSha256: sha256(readFileSync(watchPath(dir))) }); }
  finally { await server.waitForIdle(); }
  return latestRun(dir);
}

test("A6 MCP discovery grants only local reads and schemas enforce bounded closed inputs", () => {
  const expected = {
    ares_watch_set: [false, false], ares_watch_run: [false, true], ares_watch_show: [true, false],
    ares_console_add: [false, false], ares_console_remove: [false, false], ares_console_list: [true, false],
  } as const;
  for (const [name, [readOnly, external]] of Object.entries(expected)) {
    expect(tool(name).annotations).toMatchObject({ readOnlyHint: readOnly, openWorldHint: external });
    expect(ops.manifest().mcp.tools.find(row => row.name === name)!.readOnly).toBe(readOnly && !external);
  }
  expect(validArguments({ study: "/synthetic", watch }, tool("ares_watch_set").inputSchema)).toBe(true);
  for (const invalid of [{ ...watch, v: 2 }, { ...watch, unknown: true }, { ...watch, queries: [] }, { ...watch, queries: Array(21).fill(watch.queries[0]) },
    { ...watch, queries: [{ id: "q", query: "x".repeat(4097) }] }, { ...watch, queries: [{ id: "q", query: "x", limit: 51 }] },
    { ...watch, queries: [{ id: "q", query: "x", yearFrom: 999 }] }, { ...watch, queries: [{ id: "q", query: "x", source: "unknown" }] },
    { ...watch, queries: [{ id: "q", query: "x", unknown: true }] }, { ...watch, rubric: "x".repeat(8001) }]) {
    expect(validArguments({ study: "/synthetic", watch: invalid }, tool("ares_watch_set").inputSchema)).toBe(false);
  }
  expect(validArguments({ study: "/synthetic", watch, unknown: true }, tool("ares_watch_set").inputSchema)).toBe(false);
  expect(validArguments({ study: "/synthetic", query: "not accepted" }, tool("ares_watch_run").inputSchema)).toBe(false);
  expect(validArguments({ study: "/synthetic" }, tool("ares_console_list").inputSchema)).toBe(false);
});

test("watch config, no-op and read-only show have CLI/MCP parity", async () => {
  const f = await fixture();
  expect(await call(f.server, "ares_watch_set", { study: f.dir, watch })).toEqual({ config: watch, changed: true });
  const before = journal(f.dir), bytes = readFileSync(watchPath(f.dir));
  const cli = await run(["watch", "set", f.dir, "--file", "-", "--json"], f.env, { http: f.http.http, runner: f.runner.runner, readStdin: async () => JSON.stringify(watch) });
  expect(JSON.parse(cli.text)).toEqual({ config: watch, changed: false });
  expect(await call(f.server, "ares_watch_set", { study: f.dir, watch })).toEqual(JSON.parse(cli.text));
  await expect(call(f.server, "ares_watch_set", { study: f.dir, watch: { ...watch, unknown: true } })).rejects.toThrow("unknown field");
  const untrimmedTooLong = { v: 1, queries: [{ id: "long", query: "x".repeat(501) }] };
  expect(validArguments({ study: f.dir, watch: untrimmedTooLong }, tool("ares_watch_set").inputSchema)).toBe(true);
  await expect(call(f.server, "ares_watch_set", { study: f.dir, watch: untrimmedTooLong })).rejects.toThrow("500");
  expect(await call(f.server, "ares_watch_show", { study: f.dir })).toEqual(JSON.parse((await run(["watch", "show", f.dir, "--json"], f.env, f.io)).text));
  expect(journal(f.dir)).toEqual(before); expect(readFileSync(watchPath(f.dir))).toEqual(bytes); expect(f.http.requested).toEqual([]); expect(f.runner.requests).toEqual([]);
  expect(existsSync(join(f.dir, ".ares.lock"))).toBe(false);
});

test("survey and experiment watch runs share results, record each query and never screen", async () => {
  for (const mode of ["survey", "experiment"] as const) {
    const mcp = await fixture(mode), cli = await fixture(mode);
    await call(mcp.server, "ares_watch_set", { study: mcp.dir, watch });
    await run(["watch", "set", cli.dir, "--file", "-"], cli.env, { ...cli.io, readStdin: async () => JSON.stringify(watch) });
    const output = await finishedRun(mcp.server, mcp.dir);
    const command = await run(["watch", "run", cli.dir, "--json"], cli.env, { http: cli.http.http, runner: cli.runner.runner });
    expect(command.code).toBe(0); expect(output).toEqual(JSON.parse(command.text)); expect(output.ok).toBe(true); expect(output.added).toBe(1);
    const events = readLedger(mcp.dir), searches = events.filter(event => event.type === "lit.search"), runs = events.filter(event => event.type === "watch.ran");
    expect(searches).toHaveLength(2); expect(runs).toHaveLength(1); expect([...searches, ...runs].every(event => event.actor.kind === "agent" && event.actor.id === "synthetic")).toBe(true);
    expect(events.some(event => event.type === "lit.screen")).toBe(false); expect(loadCandidates(mcp.dir).every(row => row.status === "new")).toBe(true);
    expect(mcp.http.requested).toHaveLength(2); expect(mcp.runner.requests).toEqual([]); expect(cli.runner.requests).toEqual([]);
    const before = journal(mcp.dir), candidates = readFileSync(join(mcp.dir, "literature", "candidates.json"));
    expect(await call(mcp.server, "ares_watch_show", { study: mcp.dir })).toEqual(JSON.parse((await run(["watch", "show", mcp.dir, "--json"], mcp.env, mcp.io)).text));
    expect(journal(mcp.dir)).toEqual(before); expect(readFileSync(join(mcp.dir, "literature", "candidates.json"))).toEqual(candidates); expect(mcp.http.requested).toHaveLength(2);
  }
});

test("watch source errors are host/status only and credentials/response bodies never enter study records", async () => {
  const f = await fixture("survey", routes(ok(body), { status: 503, body: "PRIVATE_SERVER_BODY" }, "network"), "gates", { OPENALEX_API_KEY: "PRIVATE_API_KEY", S2_API_KEY: "PRIVATE_API_KEY" });
  await call(f.server, "ares_watch_set", { study: f.dir, watch: { v: 1, queries: [{ id: "all", query: "synthetic" }] } });
  const result = await finishedRun(f.server, f.dir);
  expect(result.ok).toBe(true); expect(result.queries[0]!.errors).toEqual([{ host: "api.semanticscholar.org", status: 503 }, { host: "export.arxiv.org", status: null }]);
  expect(result.queries[0]!.errors.every(error => Object.keys(error).sort().join(",") === "host,status")).toBe(true);
  const bytes = journal(f.dir).toString("utf8") + readFileSync(watchPath(f.dir), "utf8") + readFileSync(join(f.dir, "literature", "candidates.json"), "utf8");
  for (const secret of ["PRIVATE_API_KEY", "PRIVATE_SERVER_BODY", "https://api.openalex.org/works", "api_key="]) expect(bytes).not.toContain(secret);
  expect(f.http.requested.some(request => request.url.includes("PRIVATE_API_KEY"))).toBe(true); expect(f.runner.requests).toEqual([]);
});

test("all-source failure is acknowledged then recorded as ok:false while CLI stays exit1", async () => {
  const answers = routes(status(429), status(503), "network"), mcp = await fixture("survey", answers, "auto"), cli = await fixture("survey", answers, "auto");
  const input = { v: 1, queries: [{ id: "all", query: "synthetic" }] };
  await call(mcp.server, "ares_watch_set", { study: mcp.dir, watch: input }); await ops.watchSet(cli.dir, input, cli.ctx);
  const result = await finishedRun(mcp.server, mcp.dir);
  expect(result.ok).toBe(false); expect(readLedger(mcp.dir).at(-1)!.type).toBe("watch.ran"); expect(readLedger(mcp.dir).some(event => event.type === "gate.approve")).toBe(false);
  const command = await run(["watch", "run", cli.dir, "--json"], cli.env, cli.io); expect(command.code).toBe(1); expect(JSON.parse(command.text)).toEqual(result);
  expect(loadCandidates(mcp.dir)).toEqual([]); expect(mcp.runner.requests).toEqual([]);
});

test("console registry CLI/MCP parity keeps moved studies listed and removes only registrations", async () => {
  const f = await fixture("survey", []);
  const added = await call(f.server, "ares_console_add", { study: f.dir });
  expect(added).toEqual({ v: 1, studies: [f.dir] });
  const registry = join(f.family, "research", "studies.json"), before = readFileSync(registry);
  expect(JSON.parse((await run(["console", "add", f.dir, "--json"], f.env, f.io)).text)).toEqual(added); expect(readFileSync(registry)).toEqual(before);
  expect(await call(f.server, "ares_console_list")).toEqual(JSON.parse((await run(["console", "list", "--json"], f.env, f.io)).text));
  const moved = join(f.home, "moved-study"); renameSync(f.dir, moved);
  expect(await call(f.server, "ares_console_list")).toEqual(added); expect(readFileSync(registry)).toEqual(before);
  expect(await call(f.server, "ares_console_remove", { study: f.dir })).toEqual({ v: 1, studies: [] });
  expect(JSON.parse((await run(["console", "remove", f.dir, "--json"], f.env, f.io)).text)).toEqual({ v: 1, studies: [] });
  await run(["console", "add", moved], f.env, f.io); expect(await call(f.server, "ares_console_list")).toEqual({ v: 1, studies: [moved] });
  await run(["console", "remove", moved], f.env, f.io); expect(await call(f.server, "ares_console_list")).toEqual({ v: 1, studies: [] });
  expect(existsSync(join(moved, "study.json"))).toBe(true); expect(f.http.requested).toEqual([]); expect(f.runner.requests).toEqual([]);
});

test("absolute MCP study arguments refuse before registry/study mutations", async () => {
  const f = await fixture("survey", []), before = journal(f.dir);
  for (const name of ["ares_watch_set", "ares_watch_run", "ares_watch_show", "ares_console_add", "ares_console_remove"]) await expect(call(f.server, name, { study: "relative", ...(name === "ares_watch_set" ? { watch } : {}) })).rejects.toThrow("absolute path");
  expect(journal(f.dir)).toEqual(before); expect(existsSync(f.family)).toBe(false); expect(f.http.requested).toEqual([]); expect(f.runner.requests).toEqual([]);
});

test("future stored watch and registry versions refuse reads/mutations without changing bytes", async () => {
  const f = await fixture("survey", []); await call(f.server, "ares_watch_set", { study: f.dir, watch }); await call(f.server, "ares_console_add", { study: f.dir });
  const configFile = watchPath(f.dir), registryFile = join(f.family, "research", "studies.json");
  writeFileSync(configFile, JSON.stringify({ ...watch, v: 2 })); writeFileSync(registryFile, JSON.stringify({ v: 2, studies: [f.dir] }));
  const configBytes = readFileSync(configFile), registryBytes = readFileSync(registryFile), before = journal(f.dir);
  for (const name of ["ares_watch_set", "ares_watch_run", "ares_watch_show"]) await expect(call(f.server, name, { study: f.dir, ...(name === "ares_watch_set" ? { watch } : {}) })).rejects.toThrow("unsupported version");
  for (const name of ["ares_console_add", "ares_console_remove", "ares_console_list"]) await expect(call(f.server, name, name === "ares_console_list" ? {} : { study: f.dir })).rejects.toThrow("unsupported registry version");
  expect(readFileSync(configFile)).toEqual(configBytes); expect(readFileSync(registryFile)).toEqual(registryBytes); expect(journal(f.dir)).toEqual(before);
  expect(f.http.requested).toEqual([]); expect(f.runner.requests).toEqual([]);
});


test("MCP accepts padded raw query text and shares the trimmed 500-character runtime rule", async () => {
  const f = await fixture(), cli = await fixture(), query = " ".repeat(1500) + "x".repeat(500) + " ".repeat(1500), input = { v: 1, queries: [{ id: "padded", query, source: "openalex" }] };
  expect(query.length).toBeGreaterThan(500); expect(query.length).toBeLessThanOrEqual(4096);
  expect(validArguments({ study: f.dir, watch: input }, tool("ares_watch_set").inputSchema)).toBe(true);
  const expected = { config: { v: 1, queries: [{ id: "padded", query: "x".repeat(500), source: "openalex" }] }, changed: true };
  expect(await call(f.server, "ares_watch_set", { study: f.dir, watch: input })).toEqual(expected);
  const output = await run(["watch", "set", cli.dir, "--file", "-", "--json"], cli.env, { ...cli.io, readStdin: async () => JSON.stringify(input) });
  expect(JSON.parse(output.text)).toEqual(expected); expect(readFileSync(watchPath(f.dir))).toEqual(readFileSync(watchPath(cli.dir)));
  expect(f.http.requested).toEqual([]); expect(cli.http.requested).toEqual([]);
});

test("MCP acknowledges a slow watch pass and keeps ping/list responsive while rejecting a second pass", async () => {
  const f = await fixture(), entered = deferred(), release = deferred(); let startedRequests = 0;
  const http = { ...f.http.http, json: async (...args: Parameters<typeof f.http.http.json>) => { startedRequests++; entered.resolve(); await release.promise; return f.http.http.json(...args); } };
  const server = createAresMcp(f.env, http, { runner: f.runner.runner });
  await call(server, "ares_watch_set", { study: f.dir, watch: { v: 1, queries: [{ id: "slow", query: "synthetic", source: "openalex" }] } });
  type Reply = { id: number; error?: { code: number; message: string }; result?: { isError?: boolean; content?: { type: string; text: string }[]; tools?: { name: string }[] } };
  const pending = new Map([1, 2, 3, 4, 5].map(id => [id, deferred<Reply>()])), fatal = deferred<never>(), input = new PassThrough(), output = new PassThrough();
  let buffer = "";
  output.on("data", chunk => {
    buffer += String(chunk);
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      try { const reply = JSON.parse(line) as Reply; pending.get(reply.id)?.resolve(reply); } catch (error) { fatal.reject(error); }
    }
  });
  const done = serveMcp({ ...server, input, output }), watchdog = setTimeout(() => fatal.reject(new Error("MCP response deadline exceeded before releasing slow HTTP")), 2000);
  const wait = <T>(promise: Promise<T>) => Promise.race([promise, fatal.promise]);
  const send = (frame: Record<string, unknown>) => input.write(JSON.stringify(frame) + "\n");
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } });
    expect((await wait(pending.get(1)!.promise)).error).toBeUndefined();
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ares_watch_run", arguments: { study: f.dir } } });
    const ack = await wait(pending.get(2)!.promise); expect(ack.error).toBeUndefined(); expect(ack.result?.isError).not.toBe(true);
    expect(JSON.parse(ack.result!.content![0]!.text)).toEqual({ started: true, configSha256: sha256(readFileSync(watchPath(f.dir))) });
    await wait(entered.promise);
    send({ jsonrpc: "2.0", id: 3, method: "ping" }); send({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
    send({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ares_watch_run", arguments: { study: f.dir } } });
    const [ping, list, second] = await wait(Promise.all([pending.get(3)!.promise, pending.get(4)!.promise, pending.get(5)!.promise]));
    expect(ping.result).toEqual({}); expect(list.result!.tools!.map(tool => tool.name)).toContain("ares_watch_run");
    expect(second.result?.isError).toBe(true); expect(JSON.stringify(second.result)).toContain("locked");
    expect(startedRequests).toBe(1); expect(readLedger(f.dir).some(event => event.type === "watch.ran")).toBe(false); expect(existsSync(join(f.dir, ".ares.lock"))).toBe(true);
    release.resolve(); await wait(server.waitForIdle());
    expect(startedRequests).toBe(1); expect(f.http.requested).toHaveLength(1); expect(readLedger(f.dir).filter(event => event.type === "watch.ran")).toHaveLength(1);
    expect(latestRun(f.dir).ok).toBe(true); expect(existsSync(join(f.dir, ".ares.lock"))).toBe(false);
  } finally {
    clearTimeout(watchdog); release.resolve(); input.end();
    try { await done; } finally { await server.waitForIdle(); output.end(); }
  }
});

test("detached watch admission refuses missing config, pending scope and invalid years before HTTP", async () => {
  for (const failure of ["config", "scope", "year"] as const) {
    const f = await fixture();
    if (failure !== "config") await ops.watchSet(f.dir, failure === "year" ? { v: 1, queries: [{ id: "late", query: "synthetic", yearFrom: 2026 }] } : watch, f.ctx);
    if (failure === "scope") await ops.scope(f.dir, { question: "Changed scope", yearFrom: 2020, yearTo: 2025 }, f.ctx);
    const before = journal(f.dir);
    try { await expect(call(f.server, "ares_watch_run", { study: f.dir })).rejects.toThrow(failure === "config" ? "no config" : failure === "scope" ? "scope" : "watch query late"); }
    finally { await f.server.waitForIdle(); }
    expect(journal(f.dir)).toEqual(before); expect(f.http.requested).toEqual([]); expect(existsSync(join(f.dir, ".ares.lock"))).toBe(false);
  }
});
