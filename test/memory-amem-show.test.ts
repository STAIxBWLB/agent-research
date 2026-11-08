import {expect, test} from "bun:test";
import {join} from "node:path";
import {readScreenedAmem, supportsScreenedAmem, AMEM_SHOW_BYTES, AMEM_SHOW_MS} from "../src/memory/amem-show.ts";
import {type ProcessRunner, type ProcessRequest, type ProcessResult} from "../src/exp/executor.ts";
import {sha256} from "../src/study.ts";
import {canonical} from "../src/plan/state.ts";
import {deferred, tempDir} from "./helpers.ts";

const id = "a".repeat(32), timestamp = Date.parse("2030-01-01T01:02:03Z");
const view = () => ({id, kind: "finding", text: "Synthetic screened text 한글", at: "2030-01-01T00:00:00Z", project: "synthetic-private-project", title: null, source: "cli"});
const schema = () => ({type: "object", properties: {id: {type: "string", minLength: 1, maxLength: 80}}, required: ["id"], additionalProperties: false});
interface FakeOptions {version?: string; name?: string; schema?: unknown; show?: unknown; isError?: boolean; fragment?: boolean; partial?: boolean; truncate?: boolean; fail?: boolean; extraBytes?: boolean; onFrame?: (message: Record<string, any>) => void; onEof?: () => Promise<void>}
function server(options: FakeOptions = {}) {
  const requests: ProcessRequest[] = [], frames: Record<string, any>[] = [];
  let eof = false;
  const runner: ProcessRunner = async request => {
    requests.push(request); let buffer = "";
    const emit = async (value: unknown) => {
      const bytes = Buffer.from(JSON.stringify(value) + (options.partial ? "" : "\n"));
      if (options.extraBytes) {await request.stdoutSink!(Buffer.alloc(AMEM_SHOW_BYTES + 1)); return;}
      if (options.fragment) {for (let i = 0; i < bytes.length; i += 3) await request.stdoutSink!(bytes.subarray(i, i + 3));}
      else await request.stdoutSink!(bytes);
    };
    if (options.partial) {await emit({jsonrpc: "2.0", id: 1, result: {}}); return {exitCode: 0, stdout: "", stderr: ""};}
    for await (const chunk of request.stdin as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString("utf8");
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); frames.push(message); options.onFrame?.(message);
        if (message.method === "notifications/initialized") continue;
        let result: unknown;
        if (message.method === "initialize") result = {serverInfo: {name: options.name ?? "amem", version: options.version ?? "0.22.1"}};
        else if (message.method === "tools/list") result = {tools: [{name: "amem_show", inputSchema: options.schema === undefined ? schema() : options.schema}]};
        else if (message.method === "tools/call") result = {content: [{type: "text", text: JSON.stringify(Object.hasOwn(options, "show") ? options.show : view())}], ...(options.isError ? {isError: true} : {})};
        await emit({jsonrpc: "2.0", id: message.id, result});
      }
    }
    await options.onEof?.();
    eof = true;
    return {exitCode: options.fail ? 1 : 0, stdout: "", stderr: "", ...(options.truncate ? {truncated: true} : {})};
  };
  return {runner, frames, requests, eof: () => eof};
}
const options = (runner: ProcessRunner, home: string, now = () => timestamp) => ({runner, env: {HOME: home, AMEM_HOME: join(home, "amem")}, now});

test("fragmented MCP handshake gates exact-id screened read, hashes permitted view and closes EOF", async () => {
  const home = tempDir(), fake = server({fragment: true}), result = await readScreenedAmem(home, id, options(fake.runner, home));
  expect(result).toEqual({state: "available", digest: sha256(canonical(view())), sourceVersion: "0.22.1", observedAt: new Date(timestamp).toISOString(), kind: "finding"});
  expect(fake.frames.map(frame => frame.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"]);
  expect(fake.frames[3]!.params).toEqual({name: "amem_show", arguments: {id}}); expect(fake.eof()).toBe(true);
  expect(fake.requests).toHaveLength(1); expect(fake.requests[0]).toMatchObject({command: "amem", args: ["mcp"], cwd: home, timeoutMs: AMEM_SHOW_MS, maxOutputBytes: AMEM_SHOW_BYTES});
  const encoded = JSON.stringify(result); for (const privateValue of [view().text, view().project, home, "text", "title"]) expect(encoded).not.toContain(privateValue);
});

test("observable version and exact advertised schema are required before any show call", async () => {
  for (const config of [{version: "0.22.0"}, {version: "0.22.1-rc.1"}, {version: "unreleased"}, {name: "another-server"}, {schema: null}, {schema: {type: "object", properties: {prefix: {type: "string"}}, required: ["prefix"]}}, {schema: {...schema(), required: []}}, {schema: {...schema(), properties: {id: {type: "string", maxLength: 8}}}}, {schema: {...schema(), properties: {...schema().properties, project: {type: "string"}}}}]) {
    const home = tempDir(), fake = server(config), result = await readScreenedAmem(home, id, options(fake.runner, home));
    expect(result.state).toBe("unsupported"); expect(result.digest).toBeNull(); expect(fake.frames.some(frame => frame.method === "tools/call")).toBe(false); expect(fake.eof()).toBe(true);
  }
  for (const version of ["0.22.1", "0.22.2", "0.23.0", "1.0.0", "0.22.1+fixture"]) expect(supportsScreenedAmem(version)).toBe(true);
  for (const version of ["0.22.0", "0.22.1-rc.1", "00.22.1", "0.22.1+", "0.22.1-a..b", null]) expect(supportsScreenedAmem(version)).toBe(false);
});

test("missing, privacy denied, wrappers and mismatched returned ids share non-enumerating unavailable result", async () => {
  const home = tempDir(), variants: FakeOptions[] = [{show: null}, {isError: true, show: "opaque privacy refusal"}, {show: {source: "capture", evidence: false, capture: view()}}, {show: {source: "repo", evidence: false, view: view()}}, {show: {...view(), id: id.slice(0, 12)}}, {show: {...view(), id: "b".repeat(32)}}, {show: {...view(), kind: "capture"}}];
  const results = [];
  for (const config of variants) {const fake = server(config); results.push(await readScreenedAmem(home, id, options(fake.runner, home))); expect(fake.eof()).toBe(true);}
  for (const result of results) expect(result).toEqual({state: "unavailable", digest: null, sourceVersion: "0.22.1", observedAt: new Date(timestamp).toISOString()});
});

test("staleness is changed without body retention and read clock is observed after responses", async () => {
  const home = tempDir(); let time = timestamp;
  const fake = server({show: {...view(), stale: true}, onFrame: message => {if (message.method === "tools/call") time += 1234;}});
  expect(await readScreenedAmem(home, id, options(fake.runner, home, () => time))).toEqual({state: "changed", digest: sha256(canonical({...view(), stale: true})), sourceVersion: "0.22.1", observedAt: new Date(timestamp + 1234).toISOString(), kind: "finding"});
});

test("partial frames, total deadline, failed/truncated/overbound streams all fail closed", async () => {
  for (const config of [{partial: true}, {fail: true}, {truncate: true}, {extraBytes: true}]) {
    const home = tempDir(), fake = server(config), result = await readScreenedAmem(home, id, options(fake.runner, home));
    expect(result.state).toBe("unavailable"); expect(result.digest).toBeNull(); expect(fake.requests[0]!.signal!.aborted).toBe(true);
  }
  const home = tempDir(); let time = timestamp;
  const fake = server({onFrame: message => {if (message.method === "initialize") time += AMEM_SHOW_MS;}});
  expect((await readScreenedAmem(home, id, options(fake.runner, home, () => time))).state).toBe("unavailable"); expect(fake.frames.some(frame => frame.method === "tools/call")).toBe(false);
  const timedOut: ProcessRunner = async () => ({exitCode: 1, stdout: "", stderr: "private diagnostics", timedOut: true});
  expect((await readScreenedAmem(home, id, options(timedOut, home))).state).toBe("unavailable");
  const throwing: ProcessRunner = () => {throw new Error("private startup path");};
  expect((await readScreenedAmem(home, id, options(throwing, home))).state).toBe("unavailable");
});

test("identity/config environment is inherited only from allowlist, with no fabricated agent marker", async () => {
  const home = tempDir(), fake = server(), env = {HOME: home, PATH: "/synthetic/bin", AMEM_HOME: join(home, "amem"), AGENTHUB_HOME: join(home, "family"), CODEX_HOME: join(home, "codex"), CODEX_THREAD_ID: "synthetic-thread", AGENTHUB_PEER_ID: "synthetic-peer", CLAUDECODE: "1", ANTHROPIC_API_KEY: "forbidden", DOCKER_HOST: "forbidden", SSH_AUTH_SOCK: "forbidden"};
  await readScreenedAmem(home, id, {runner: fake.runner, env, now: () => timestamp});
  expect(fake.requests[0]!.env).toEqual({HOME: home, PATH: "/synthetic/bin", AMEM_HOME: env.AMEM_HOME, AGENTHUB_HOME: env.AGENTHUB_HOME, CODEX_HOME: env.CODEX_HOME, CODEX_THREAD_ID: env.CODEX_THREAD_ID, AGENTHUB_PEER_ID: env.AGENTHUB_PEER_ID, CLAUDECODE: env.CLAUDECODE});
  const plain = server(); await readScreenedAmem(home, id, {runner: plain.runner, env: {HOME: home}, now: () => timestamp});
  expect(plain.requests[0]!.env).toEqual({HOME: home});
});

test("only full lowercase32 ids enter transport, and relative project cwd is unsupported", async () => {
  const home = tempDir(); let calls = 0;
  const runner: ProcessRunner = async () => {calls++; return {exitCode: 1, stdout: "", stderr: ""};};
  for (const value of [id.slice(0, 8), id.toUpperCase(), `mem:${id}`, "b".repeat(33), "capture:1"]) expect((await readScreenedAmem(home, value, options(runner, home))).state).toBe("unsupported");
  expect((await readScreenedAmem("relative-study", id, options(runner, home))).state).toBe("unsupported"); expect(calls).toBe(0);
});


test("observedAt captures the show response before delayed EOF cleanup", async () => {
  const home = tempDir(), entered = deferred(), release = deferred(); let time = timestamp;
  const fake = server({onFrame: message => {if (message.method === "tools/call") time = timestamp + 1234;}, onEof: async () => {entered.resolve(); await release.promise;}});
  const reading = readScreenedAmem(home, id, options(fake.runner, home, () => time));
  try {
    await entered.promise; time += 10_000; release.resolve();
    expect(await reading).toMatchObject({state: "available", observedAt: new Date(timestamp + 1234).toISOString()});
  } finally {release.resolve(); await reading;}
  expect(fake.eof()).toBe(true);
});

test("a curated View source label is provenance text, not a capture/repo response discriminator", async () => {
  const home = tempDir();
  for (const source of ["capture", "repo"]) {
    const {runner} = server({show: {...view(), source}});
    expect((await readScreenedAmem(home, id, options(runner, home))).state).toBe("available");
  }
});
