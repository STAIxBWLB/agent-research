import {afterAll, expect, mock, spyOn, test} from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
import {join} from "node:path";
import {tmpdir} from "node:os";
import type {ConsolePlugin} from "@staix/agent-console/contract";
import {registerConsoleConformance} from "@staix/agent-console/conformance";
import {createPlugin} from "../src/ui/plugin.ts";
import * as ops from "../src/commands.ts";
import {run} from "../src/cli.ts";
import {createAresMcp} from "../src/mcp-tools.ts";
import {addStudy} from "../src/console/registry.ts";
import {commit, readTextBounded, writeAtomic} from "../src/study.ts";
import {provenanceFixture} from "./provenance-fixtures.ts";
import {tempDir} from "./helpers.ts";
const persistent = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ares-console-lineage-"))), fixedHome = join(persistent, "family"), fixed = await provenanceFixture(join(persistent, "study")); addStudy(fixedHome, fixed.dir);
afterAll(() => fs.rmSync(persistent, {recursive: true, force: true}));
const plugin = createPlugin({env: {HOME: fixedHome, AGENTHUB_HOME: fixedHome}, runner: async () => { throw new Error("no console executor or hub"); }}) as unknown as ConsolePlugin;
registerConsoleConformance(plugin, {home: fixedHome, destructive: []});
async function fixture() {
  const f = await provenanceFixture(), home = fs.realpathSync(tempDir()); f.dir = fs.realpathSync(f.dir); addStudy(home, f.dir);
  const runtime = createPlugin({env: {HOME: home, AGENTHUB_HOME: home}, runner: async () => { throw new Error("no executor"); }});
  return {f, home, provider: await runtime.open({home, log: () => {}})};
}

test("producer lineage and comparison panels equal CLI/MCP native source reads", async () => {
  const {f, provider} = await fixture(), mcp = createAresMcp({HOME: f.dir, AGENTHUB_HOME: f.dir}, f.ctx.http);
  const full = ops.lineageShow(f.dir), consoleFull = await provider.snapshot({panel: "lineage", study: f.dir, after: 0});
  expect(consoleFull.lineage).toEqual(full); expect(consoleFull.lineage).toEqual(JSON.parse((await run(["lineage", "show", f.dir, "--json"], {}, {http: f.ctx.http})).text));
  expect(consoleFull.lineage).toEqual(await mcp.handlers.ares_lineage_show!({study: f.dir}));
  expect(full.nodes.some(row => row.ref.kind === "plan-revision" && row.state === "historical")).toBe(true);
  const root = {v: 1 as const, tool: "ares" as const, projectKey: f.studyId, kind: "attempt" as const, id: f.ids.retryAttempt};
  expect((await provider.snapshot({panel: "lineage", study: f.dir, rootKind: root.kind, rootId: root.id, after: 0})).lineage).toEqual(ops.lineageShow(f.dir, {root}));
  for (const options of [{attempts: [f.ids.interruptedAttempt, f.ids.retryAttempt]}, {candidates: [f.commits.winner]}]) {
    const params = "attempts" in options ? {attempts: options.attempts!.join(",")} : {candidates: options.candidates!.join(",")};
    const result = await provider.snapshot({panel: "compare", study: f.dir, ...params, after: 0});
    expect(result.comparison).toEqual(ops.lineageCompare(f.dir, options)); expect(result.comparison).toEqual(await mcp.handlers.ares_lineage_compare!({study: f.dir, ...options}));
    const flags = "attempts" in options ? ["--attempts", options.attempts!.join(",")] : ["--candidates", options.candidates!.join(",")];
    expect(result.comparison).toEqual(JSON.parse((await run(["lineage", "compare", f.dir, ...flags, "--json"], {}, {http: f.ctx.http})).text));
  }
});

test("shell cursor stays ledger-byte based while graph cursor and view parameters retain independent identity", async () => {
  const {f, provider} = await fixture(); commit(f.dir, [], Array.from({length: 100}, (_, i) => ({actor: f.ctx.actor, type: "idea.added", data: {idea: {id: `console-extra-${i}`, title: "Synthetic", hypothesis: "Synthetic"}}})));
  const first = await provider.snapshot({panel: "lineage", study: f.dir, after: 0}), graph = first.lineage as ReturnType<typeof ops.lineageShow>;
  expect(graph.nextCursor).toBeDefined(); expect((await provider.snapshot({panel: "lineage", study: f.dir, after: first.cursor as number})).changed).toBe(false);
  const next = await provider.snapshot({panel: "lineage", study: f.dir, graphCursor: graph.nextCursor, after: first.cursor as number});
  expect(next.cursor).toBe(first.cursor); expect(next.changed).toBe(true); expect(next.lineage).toEqual(ops.lineageShow(f.dir, {cursor: graph.nextCursor!}));
  const switched = await provider.snapshot({panel: "lineage", study: f.dir, rootKind: "idea", rootId: f.ids.childIdea, graphCursor: graph.nextCursor, after: next.cursor as number});
  expect((switched.lineage as {status: string}).status).toBe("changed"); expect(switched.changed).toBe(true);
  writeAtomic(join(f.dir, "hypotheses.md"), "Synthetic change without a ledger event", 2 * 1024 * 1024);
  const stale = await provider.snapshot({panel: "lineage", study: f.dir, graphCursor: graph.nextCursor, after: first.cursor as number});
  expect(stale.cursor).toBe(first.cursor); expect((stale.lineage as {status: string}).status).toBe("changed"); expect(stale.changed).toBe(true);
});

test("missing, corrupt, future and capped sources remain explicit and never use a recalculated close", async () => {
  const {f, provider} = await fixture(), path = join(f.dir, "runs/investigate/investigate.json"), saved = readTextBounded(path, 1_048_576), show = spyOn(ops, "investigateShow").mockImplementation(() => { throw new Error("no recalculated fallback"); });
  try {
    fs.unlinkSync(path); let value = await provider.snapshot({panel: "lineage", study: f.dir, after: 0});
    expect(value.lineage).toEqual(ops.lineageShow(f.dir)); expect((value.lineage as {issues: {code: string}[]}).issues.some(issue => issue.code === "missing-closed-artifact")).toBe(true);
    writeAtomic(path, saved + " ", 1_048_576); value = await provider.snapshot({panel: "lineage", study: f.dir, after: 0}); expect((value.lineage as {issues: {code: string}[]}).issues.some(issue => issue.code === "close-receipt-mismatch")).toBe(true);
    writeAtomic(path, saved, 1_048_576); expect(show).not.toHaveBeenCalled();
  } finally { show.mockRestore(); }
  const file = join(f.dir, "study.json"), raw = JSON.parse(readTextBounded(file, 65_536)), future = JSON.stringify({...raw, v: 99}); writeAtomic(file, future, 65_536);
  const unsupported = await provider.snapshot({panel: "lineage", study: f.dir, after: 0}); expect((unsupported.lineage as {status: string}).status).toBe("unavailable"); expect(readTextBounded(file, 65_536)).toBe(future); writeAtomic(file, JSON.stringify(raw), 65_536);
  commit(f.dir, [], Array.from({length: 998}, (_, i) => ({actor: f.ctx.actor, type: "idea.added", data: {idea: {id: `console-cap-${i}`, title: "Synthetic", hypothesis: "Synthetic"}}})));
  expect(((await provider.snapshot({panel: "lineage", study: f.dir, after: 0})).lineage as {status: string}).status).toBe("capped");
});

test("read panels authorize registration and validate parameters before selecting arbitrary files", async () => {
  const {f, provider} = await fixture(), outside = tempDir(), spy = spyOn(ops, "lineageShow");
  try { const unavailable = await provider.snapshot({panel: "lineage", study: outside, after: 0}); expect(unavailable.study).toBeNull(); expect(unavailable.error).toContain("not registered"); expect(spy).not.toHaveBeenCalled(); }
  finally { spy.mockRestore(); }
  for (const input of [{panel: "lineage", rootId: "native"}, {panel: "lineage", graphCursor: 123}, {panel: "compare", attempts: Array(9).fill(f.ids.retryAttempt).join(",")}, {panel: "compare", attempts: f.ids.retryAttempt, candidates: f.commits.winner}]) expect((await provider.snapshot({...input, study: f.dir, after: 0})).error).toBeDefined();
  expect((await provider.snapshot({panel: "compare", study: f.dir, after: 0})).comparison).toBeNull();
});

test("overview, study and inbox polling do not evaluate lineage or comparison", async () => {
  const {f, provider} = await fixture(), lineage = spyOn(ops, "lineageShow"), comparison = spyOn(ops, "lineageCompare");
  try {
    for (const panel of ["studies", "study", "inbox"]) await provider.snapshot({panel, study: f.dir, after: 0});
    expect(lineage).not.toHaveBeenCalled(); expect(comparison).not.toHaveBeenCalled();
  } finally { lineage.mockRestore(); comparison.mockRestore(); }
});

test("repeated console read panels take no locks, write no files and launch no executor/model/search", async () => {
  const {f, provider} = await fixture(), original = fs.openSync, outputs = new Set(Object.values(f.outputs).map(output => fs.realpathSync(output.path)));
  const forbidden = (): never => { throw new Error("console lineage read effect forbidden"); }, preconnect = mock(forbidden);
  const writes = [spyOn(fs, "writeSync").mockImplementation(forbidden), spyOn(fs, "writeFileSync").mockImplementation(forbidden), spyOn(fs, "appendFileSync").mockImplementation(forbidden), spyOn(fs, "mkdirSync").mockImplementation(forbidden), spyOn(fs, "renameSync").mockImplementation(forbidden), spyOn(fs, "unlinkSync").mockImplementation(forbidden), spyOn(fs, "chmodSync").mockImplementation(forbidden)];
  const processes = [spyOn(child, "spawn").mockImplementation(forbidden), spyOn(child, "spawnSync").mockImplementation(forbidden), spyOn(Bun, "spawn").mockImplementation(forbidden), spyOn(Bun, "spawnSync").mockImplementation(forbidden)], fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(forbidden, {preconnect}));
  const open = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
    const name = String(file), writing = typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0 : flags !== "r" && flags !== "rs";
    if (writing || outputs.has(name) || name.endsWith("/.ares.lock") || name.endsWith("/.ares.plan.lock")) return forbidden();
    return original(file, flags, mode);
  }) as typeof fs.openSync);
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(((await provider.snapshot({panel: "lineage", study: f.dir, after: 0})).lineage as {status: string}).status).toBe("ok");
      expect(((await provider.snapshot({panel: "compare", study: f.dir, attempts: `${f.ids.interruptedAttempt},${f.ids.retryAttempt}`, after: 0})).comparison as {status: string}).status).toBe("ok");
    }
    for (const spy of [...writes, ...processes, fetch, preconnect]) expect(spy).not.toHaveBeenCalled();
  } finally { open.mockRestore(); for (const spy of [...writes, ...processes, fetch]) spy.mockRestore(); }
});

test("same-cursor polls expose record corruption and repair without stale or false-empty views", async () => {
  const {f, provider} = await fixture(), file = join(f.dir, `runs/investigate/attempts/${f.ids.retryAttempt}.json`), saved = readTextBounded(file, 1_048_576);
  const first = await provider.snapshot({panel: "lineage", study: f.dir, after: 0}); expect((first.lineage as {status: string}).status).toBe("ok");
  writeAtomic(file, "not valid JSON", 1_048_576);
  const bad = await provider.snapshot({panel: "lineage", study: f.dir, after: first.cursor as number}); expect(bad.cursor).toBe(first.cursor); expect(bad.changed).toBe(true); expect((bad.lineage as {status: string}).status).toBe("unavailable");
  writeAtomic(file, saved, 1_048_576);
  const repaired = await provider.snapshot({panel: "lineage", study: f.dir, after: first.cursor as number}); expect(repaired.changed).toBe(true); expect(repaired.lineage).toEqual(first.lineage);
  expect((await provider.snapshot({panel: "lineage", study: f.dir, after: first.cursor as number})).changed).toBe(false);
  const ledger = join(f.dir, "ledger.jsonl"), original = readTextBounded(ledger, 64 * 1024 * 1024); writeAtomic(ledger, original + "not-json\n", 64 * 1024 * 1024);
  const malformed = await provider.snapshot({panel: "lineage", study: f.dir, after: 0}); expect((malformed.lineage as {issues: {code: string}[]}).issues.some(issue => issue.code === "malformed-ledger")).toBe(true);
});

test("standalone old survey studies remain readable without attempts, hub or executor", async () => {
  const home = fs.realpathSync(tempDir()), dir = join(home, "legacy-study"); ops.init(dir, {question: "Synthetic legacy survey", autonomy: "gates"}, {actor: {kind: "person"}}); addStudy(home, dir);
  const provider = await createPlugin({env: {HOME: home, AGENTHUB_HOME: home}}).open({home, log: () => {}}), result = await provider.snapshot({panel: "lineage", study: dir, after: 0});
  expect(result.lineage).toEqual(ops.lineageShow(dir)); expect((result.lineage as {status: string}).status).toBe("ok");
});

for (const damage of ["missing", "malformed"] as const) test(`#107 rooted CLI/MCP/console parity with ${damage} study.json`, async () => {
  const {f, provider} = await fixture(), file = join(f.dir, "study.json"), root = {v: 1 as const, tool: "ares" as const, projectKey: f.studyId, kind: "attempt" as const, id: f.ids.retryAttempt}, mcp = createAresMcp({HOME: f.dir, AGENTHUB_HOME: f.dir}, f.ctx.http);
  if (damage === "missing") fs.unlinkSync(file); else writeAtomic(file, "{ malformed JSON", 65_536);
  const expected = await mcp.handlers.ares_lineage_show!({study: f.dir, root}), cli = await run(["lineage", "show", f.dir, "--root", root.kind, "--id", root.id, "--json"], {}, {http: f.ctx.http});
  expect(JSON.parse(cli.text)).toEqual(expected); expect((expected as {status: string}).status).toBe("unavailable"); expect((expected as {issues: {code: string}[]}).issues[0]?.code).toBe(damage === "missing" ? "missing-study" : "malformed-study");
  expect((await provider.snapshot({panel: "lineage", study: f.dir, rootKind: root.kind, rootId: root.id, after: 0})).lineage).toEqual(expected);
  if (damage === "missing") expect(fs.existsSync(file)).toBe(false); else expect(readTextBounded(file, 65_536)).toBe("{ malformed JSON");
});
