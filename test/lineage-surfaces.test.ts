import { expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { COMMANDS, help } from "../src/commands-table.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { readProvenance, compareLineage, type ExecutionReferenceV1 } from "../src/provenance.ts";
import { commit, readBytesBounded } from "../src/study.ts";
import { provenanceFixture } from "./provenance-fixtures.ts";

const LEDGER_BYTES = 64 * 1024 * 1024;
function client(f: Awaited<ReturnType<typeof provenanceFixture>>) {
  return createAresMcp({ HOME: f.dir, AGENTHUB_HOME: join(f.dir, "family") }, f.ctx.http, { runner: async () => { throw new Error("lineage read must not start an executor or hub"); } });
}
const tool = (name: string) => ARES_TOOLS.find(value => value.name === name)!;

test("CLI, MCP and shared operations expose the identical unrooted and rooted source graph", async () => {
  const f = await provenanceFixture(), server = client(f), before = readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES);
  const full = readProvenance(f.dir);
  expect(ops.lineageShow(f.dir)).toEqual(full);
  expect(JSON.parse((await run(["lineage", "show", f.dir, "--json"], {}, { http: f.ctx.http })).text)).toEqual(full);
  expect(await server.handlers.ares_lineage_show!({ study: f.dir })).toEqual(full);
  const root: ExecutionReferenceV1 = { v: 1, tool: "ares", projectKey: f.studyId, kind: "plan-revision", id: "1", revision: "1" };
  const rooted = readProvenance(f.dir, { root }); expect(rooted.status).toBe("ok");
  expect(JSON.parse((await run(["lineage", "show", f.dir, "--root", root.kind, "--id", root.id, "--revision", "1", "--json"], {}, { http: f.ctx.http })).text)).toEqual(rooted);
  expect(await server.handlers.ares_lineage_show!({ study: f.dir, root })).toEqual(rooted);
  const artifact: ExecutionReferenceV1 = { v: 1, tool: "ares", projectKey: f.studyId, kind: "artifact", id: f.outputSHA, sha256: f.outputSHA };
  expect(JSON.parse((await run(["lineage", "show", f.dir, "--root", "artifact", "--id", artifact.id, "--sha256", artifact.sha256!, "--json"], {}, { http: f.ctx.http })).text)).toEqual(readProvenance(f.dir, { root: artifact }));
  expect(readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES)).toEqual(before);
});

test("CLI/MCP opaque cursor continuations match and refuse a different root", async () => {
  const f = await provenanceFixture(), server = client(f);
  commit(f.dir, [], Array.from({ length: 100 }, (_, i) => ({ actor: f.ctx.actor, type: "idea.added", data: { idea: { id: `synthetic-extra-${i}`, title: "Synthetic extra idea", hypothesis: "Synthetic untested idea" } } })));
  const first = ops.lineageShow(f.dir); expect(first.nextCursor).toBeDefined();
  const cursor = first.nextCursor!, next = ops.lineageShow(f.dir, { cursor });
  expect(JSON.parse((await run(["lineage", "show", f.dir, "--cursor", cursor, "--json"], {}, { http: f.ctx.http })).text)).toEqual(next);
  expect(await server.handlers.ares_lineage_show!({ study: f.dir, cursor })).toEqual(next);
  const root: ExecutionReferenceV1 = { v: 1, tool: "ares", projectKey: f.studyId, kind: "idea", id: f.ids.childIdea };
  const mismatched = ops.lineageShow(f.dir, { root, cursor }); expect(mismatched.status).toBe("changed");
  expect(JSON.parse((await run(["lineage", "show", f.dir, "--root", "idea", "--id", root.id, "--cursor", cursor, "--json"], {}, { http: f.ctx.http })).text)).toEqual(mismatched);
  expect(await server.handlers.ares_lineage_show!({ study: f.dir, root, cursor })).toEqual(mismatched);
});

test("attempt and closed-candidate comparison CLI/MCP delegate existing rows without new verdicts", async () => {
  const f = await provenanceFixture(), server = client(f), before = readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES);
  for (const options of [{ attempts: [f.ids.interruptedAttempt, f.ids.retryAttempt] }, { candidates: [f.commits.winner] }]) {
    const expected = compareLineage(f.dir, options), flags = "attempts" in options ? ["--attempts", options.attempts!.join(",")] : "candidates" in options ? ["--candidates", options.candidates!.join(",")] : [];
    expect(ops.lineageCompare(f.dir, options)).toEqual(expected);
    const cli = await run(["lineage", "compare", f.dir, ...flags, "--json"], {}, { http: f.ctx.http });
    expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toEqual(expected);
    expect(await server.handlers.ares_lineage_compare!({ study: f.dir, ...options })).toEqual(expected);
    expect(expected.aggregation.performed).toBe(false);
    expect(Object.hasOwn(expected, "winner")).toBe(false); expect(Object.hasOwn(expected, "verdict")).toBe(false);
  }
  expect(readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES)).toEqual(before);
});

test("lineage surfaces reject partial roots and conflicting, empty or oversized selections without writes", async () => {
  const f = await provenanceFixture(), server = client(f), before = readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES);
  for (const flags of [["--id", "native"], ["--root", "attempt"], ["--revision", "1"], ["--sha256", "a".repeat(64)]])
    await expect(run(["lineage", "show", f.dir, ...flags, "--json"], {}, { http: f.ctx.http })).rejects.toThrow("partial root reference");
  for (const flags of [[], ["--attempts", f.ids.retryAttempt, "--candidates", f.commits.winner], ["--attempts", ""], ["--attempts", `${f.ids.retryAttempt},`], ["--candidates", Array(9).fill(f.commits.winner).join(",")]])
    await expect(run(["lineage", "compare", f.dir, ...flags, "--json"], {}, { http: f.ctx.http })).rejects.toThrow("lineage compare:");
  for (const values of [{}, { attempts: [], candidates: [f.commits.winner] }, { attempts: [f.ids.retryAttempt], candidates: [f.commits.winner] }, { attempts: Array(9).fill(f.ids.retryAttempt) }])
    await expect(Promise.resolve().then(() => server.handlers.ares_lineage_compare!({ study: f.dir, ...values }))).rejects.toThrow();
  expect(readBytesBounded(join(f.dir, "ledger.jsonl"), LEDGER_BYTES)).toEqual(before);
});

test("manifest discovery marks both tools local read-only and schemas bound their structured inputs", () => {
  for (const name of ["ares_lineage_show", "ares_lineage_compare"]) {
    const entry = tool(name); expect(entry.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false, destructiveHint: false });
    expect(ops.manifest().mcp.tools.find(value => value.name === name)?.readOnly).toBe(true);
  }
  expect(COMMANDS.filter(value => value.name.startsWith("lineage ")).every(value => value.mutates === false)).toBe(true);
  expect(help()).toContain("ares lineage show"); expect(help()).toContain("ares lineage compare");
  const study = "/synthetic/study", show = tool("ares_lineage_show").inputSchema, compare = tool("ares_lineage_compare").inputSchema;
  expect(validArguments({ study, root: { v: 1, tool: "ares", projectKey: "synthetic", kind: "attempt", id: "a".repeat(16) }, cursor: "opaque" }, show)).toBe(true);
  for (const root of [{ kind: "attempt", id: "a" }, { v: 2, tool: "ares", projectKey: "synthetic", kind: "attempt", id: "a" }, { v: 1, tool: "ares", projectKey: "synthetic", kind: "unknown", id: "a" }]) expect(validArguments({ study, root }, show)).toBe(false);
  expect(validArguments({ study, attempts: ["a".repeat(16)] }, compare)).toBe(true);
  expect(validArguments({ study, candidates: ["a".repeat(40)] }, compare)).toBe(true);
  for (const attempts of [[], Array(9).fill("a".repeat(16)), ["x".repeat(17)]]) expect(validArguments({ study, attempts }, compare)).toBe(false);
});

test("repeated CLI/MCP reads write no files, take no locks and launch no process/search/model", async () => {
  const f = await provenanceFixture(), server = client(f), open = fs.openSync, outputPaths = new Set(Object.values(f.outputs).map(output => fs.realpathSync(output.path)));
  const forbidden = (): never => { throw new Error("lineage read side effect forbidden"); }, preconnect = mock(forbidden);
  const writes = [spyOn(fs, "writeSync").mockImplementation(forbidden), spyOn(fs, "writeFileSync").mockImplementation(forbidden), spyOn(fs, "appendFileSync").mockImplementation(forbidden), spyOn(fs, "mkdirSync").mockImplementation(forbidden), spyOn(fs, "renameSync").mockImplementation(forbidden), spyOn(fs, "unlinkSync").mockImplementation(forbidden), spyOn(fs, "chmodSync").mockImplementation(forbidden)];
  const openSpy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
    const name = String(file), writing = typeof flags === "number" ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC)) !== 0 : flags !== "r" && flags !== "rs";
    if (writing || outputPaths.has(name) || name.endsWith("/.ares.lock") || name.endsWith("/.ares.plan.lock")) return forbidden();
    return open(file, flags, mode);
  }) as typeof fs.openSync);
  const processes = [spyOn(child, "spawn").mockImplementation(forbidden), spyOn(child, "spawnSync").mockImplementation(forbidden), spyOn(Bun, "spawn").mockImplementation(forbidden), spyOn(Bun, "spawnSync").mockImplementation(forbidden)], fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(forbidden, {preconnect}));
  try {
    for (let repeat = 0; repeat < 2; repeat++) {
      expect(JSON.parse((await run(["lineage", "show", f.dir, "--json"], {}, {http: f.ctx.http})).text).status).toBe("ok");
      expect((await server.handlers.ares_lineage_show!({study: f.dir}) as {status: string}).status).toBe("ok");
      expect(JSON.parse((await run(["lineage", "compare", f.dir, "--attempts", f.ids.retryAttempt, "--json"], {}, {http: f.ctx.http})).text).status).toBe("ok");
      expect((await server.handlers.ares_lineage_compare!({study: f.dir, candidates: [f.commits.winner]}) as {status: string}).status).toBe("ok");
    }
    for (const spy of [...writes, ...processes, fetch, preconnect]) expect(spy).not.toHaveBeenCalled();
  } finally { openSpy.mockRestore(); for (const spy of [...writes, ...processes, fetch]) spy.mockRestore(); }
});
