import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp, ARES_TOOLS } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { validateProtocol, designBinding, protocolHash, readProtocol, taskTreeHash } from "../src/exp/protocol.ts";
import { readSelection, selectionHash, selectionPath, validateSelection, SELECTION_BYTES } from "../src/exp/selection.ts";
import { readLedger, sha256 } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const fixture = () => validateProtocol({ v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1, 2], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 10, maxWallHours: 1, maxGpuHours: 0 } });
const rule = () => ({ v: 1, run: "investigate", metric: "score", baseline: { commit: "a".repeat(40) }, minSeeds: 2, minDelta: 0.01 });
async function study(autonomy = "gates") {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment", autonomy }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeFileSync(join(dir, "task", "task.md"), "synthetic task"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic evaluator");
  await ops.protocol(dir, fixture(), ctx); return dir;
}

test("selection-free studies retain the exact two-hash design binding and approval", async () => {
  const dir = await study(), file = join(dir, "design", "protocol.json");
  const expected = sha256(JSON.stringify([sha256(readFileSync(file)), taskTreeHash(dir)]));
  expect(designBinding(dir)).toBe(expected); expect(selectionHash(dir, readProtocol(dir)!)).toBeUndefined();
  expect(readSelection(dir, readProtocol(dir)!)).toBeUndefined();
  await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  expect(ops.gateList(dir).find(g => g.gate === "design")!.state).toBe("approved");
  expect(designBinding(dir)).toBe(expected); expect(existsSync(selectionPath(dir))).toBe(false);
});

test("setting and changing selection seals its raw bytes, commits one event and reopens design", async () => {
  const dir = await study(); await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  const protocol = readProtocol(dir)!, identity = protocolHash(protocol), initial = designBinding(dir);
  const result = await ops.selection(dir, rule(), ctx);
  expect(result.changed).toBe(true); expect(result.gate.state).toBe("pending"); expect(designBinding(dir)).not.toBe(initial);
  expect(readLedger(dir).filter(e => e.type === "selection.set")).toHaveLength(1);
  const raw = readFileSync(selectionPath(dir));
  expect(result.sha256).toBe(sha256(raw));
  expect(designBinding(dir)).toBe(sha256(JSON.stringify([sha256(readFileSync(join(dir, "design", "protocol.json"))), taskTreeHash(dir), sha256(raw)])));
  await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  const changed = await ops.selection(dir, { ...rule(), minDelta: 0.02 }, ctx);
  expect(changed.gate.state).toBe("pending"); expect(protocolHash(readProtocol(dir)!)).toBe(identity);
  expect(readSelection(dir, protocol)?.minDelta).toBe(0.02);
});

test("identical selection bytes do not shift the counting cutoff or invalidate approval", async () => {
  const dir = await study(); await ops.selection(dir, rule(), ctx); await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  const before = readFileSync(join(dir, "ledger.jsonl")), binding = designBinding(dir);
  expect((await ops.selection(dir, rule(), ctx)).changed).toBe(false);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(designBinding(dir)).toBe(binding);
  expect(ops.gateList(dir).find(g => g.gate === "design")!.state).toBe("approved");
});

test("invalid selection fields name the cause and recovery, changing no selection or ledger bytes", async () => {
  const dir = await study(); await ops.selection(dir, rule(), ctx);
  const file = selectionPath(dir), before = readFileSync(file), ledger = readFileSync(join(dir, "ledger.jsonl"));
  const cases: [unknown, string][] = [
    [{ ...rule(), metric: "undeclared" }, "selection.metric"],
    [{ ...rule(), baseline: { commit: "abc" } }, "baseline.commit"],
    [{ ...rule(), baseline: { commit: "g".repeat(40) } }, "40-hex"],
    ...[0, 3, 1.5].map(minSeeds => [{ ...rule(), minSeeds }, "minSeeds"] as [unknown, string]),
    ...[-1, NaN, Infinity, "0.1"].map(minDelta => [{ ...rule(), minDelta }, "minDelta"] as [unknown, string]),
    [{ ...rule(), unknown: true }, "unknown field unknown"],
    [{ ...rule(), baseline: { ...rule().baseline, branch: "main" } }, "unknown field branch"],
    [{ ...rule(), run: "../escape" }, "selection.run"], [{ ...rule(), run: "x".repeat(65) }, "selection.run"],
  ];
  for (const [raw, reason] of cases) {
    await expect(ops.selection(dir, raw, ctx)).rejects.toThrow(reason);
    await expect(ops.selection(dir, raw, ctx)).rejects.toThrow("ares selection");
    expect(readFileSync(file)).toEqual(before); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  }
  expect(validateSelection({ ...rule(), run: "x".repeat(64), minSeeds: 1, minDelta: 0, baseline: { commit: "A".repeat(40) } }, fixture()).baseline.commit).toBe("a".repeat(40));
});

test("unsupported stored versions refuse reads and replacement without changing original bytes", async () => {
  const dir = await study(); await ops.selection(dir, rule(), ctx);
  const file = selectionPath(dir), text = JSON.stringify({ ...rule(), v: 99 }); writeFileSync(file, text);
  const ledger = readFileSync(join(dir, "ledger.jsonl"));
  expect(() => readSelection(dir, fixture())).toThrow("supports this selection");
  expect(() => designBinding(dir)).toThrow("selection.v");
  await expect(ops.selection(dir, rule(), ctx)).rejects.toThrow("selection.v");
  await expect(ops.protocol(dir, fixture(), ctx)).rejects.toThrow("selection.v");
  expect(readFileSync(file, "utf8")).toBe(text); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
});

test("bounded reads and design preflight refuse oversized/corrupt/missing inputs before a selection write", async () => {
  const dir = await study(); await ops.selection(dir, rule(), ctx); const ledger = readFileSync(join(dir, "ledger.jsonl"));
  for (const value of ["x".repeat(SELECTION_BYTES + 1), "{malformed"]) {
    writeFileSync(selectionPath(dir), value);
    await expect(ops.selection(dir, rule(), ctx)).rejects.toThrow();
    expect(readFileSync(selectionPath(dir), "utf8")).toBe(value); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  }
  rmSync(selectionPath(dir)); rmSync(join(dir, "task"), { recursive: true });
  await expect(ops.selection(dir, rule(), ctx)).rejects.toThrow("task/");
  expect(existsSync(selectionPath(dir))).toBe(false); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
});

test("protocol edits incompatible with an existing selection refuse before writing", async () => {
  const dir = await study(); await ops.selection(dir, rule(), ctx);
  const file = join(dir, "design", "protocol.json"), bytes = readFileSync(file), ledger = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.protocol(dir, { ...fixture(), seeds: [1] }, ctx)).rejects.toThrow("selection.minSeeds");
  await expect(ops.protocol(dir, { ...fixture(), metrics: [{ name: "other", unit: "points", direction: "max" }] }, ctx)).rejects.toThrow("selection.metric");
  expect(readFileSync(file)).toEqual(bytes); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
});

test("CLI and MCP share selection validation, agent attribution and non-executing annotations", async () => {
  const a = await study(), b = await study(); const forbidden = async () => { throw new Error("selection must start no process"); };
  const cli = await run(["selection", a, "--file", "-", "--json"], { CODEX_THREAD_ID: "synthetic" }, { http: ctx.http, runner: forbidden, readStdin: async () => JSON.stringify(rule()) });
  const server = createAresMcp({}, ctx.http, { runner: forbidden }), tool = ARES_TOOLS.find(t => t.name === "ares_selection_set")!;
  expect(tool.annotations.openWorldHint).toBe(false); expect(validArguments({ study: b, selection: rule() }, tool.inputSchema)).toBe(true);
  const result = await server.handlers.ares_selection_set!({ study: b, selection: rule() });
  expect((result as {selection:unknown}).selection).toEqual(JSON.parse(cli.text).selection);
  for (const dir of [a, b]) expect(readLedger(dir).find(e => e.type === "selection.set")!.actor.kind).toBe("agent");
  const before = readFileSync(join(b, "ledger.jsonl"));
  await expect(server.handlers.ares_selection_set!({ study: b, selection: { ...rule(), metric: "foreign" } })).rejects.toThrow("selection.metric");
  expect(readFileSync(join(b, "ledger.jsonl"))).toEqual(before);
  expect(ops.manifest().formats).toMatchObject({ experimentSelection: 1, investigateResult: 1 });
});

test("survey mode and missing protocol refuse selection without writes", async () => {
  for (const mode of ["survey", "experiment"]) {
    const dir = tempDir(); ops.init(dir, { question: "synthetic", mode }, ctx); const before = readFileSync(join(dir, "ledger.jsonl"));
    await expect(ops.selection(dir, rule(), ctx)).rejects.toThrow(mode === "survey" ? "experiment" : "protocol missing");
    expect(existsSync(selectionPath(dir))).toBe(false); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  }
});


test("raw selection formatting is sealed and failed auto-mode validation records no approval", async () => {
  const dir = await study("auto"); await ops.selection(dir, rule(), ctx);
  await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  const old = designBinding(dir), before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.selection(dir, { ...rule(), minDelta: -1 }, ctx)).rejects.toThrow("minDelta");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  writeFileSync(selectionPath(dir), JSON.stringify(rule()));
  expect(designBinding(dir)).not.toBe(old);
  expect(ops.gateList(dir).find(g => g.gate === "design")!.state).toBe("pending");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});
