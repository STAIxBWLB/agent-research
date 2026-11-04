import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { canonical } from "../src/plan/state.ts";
import { previewArchive } from "../src/memory/archive.ts";
import { deriveLessons, readLessonSources } from "../src/memory/lessons.ts";
import { appendEvent, commit, readLedger, sha256 } from "../src/study.ts";
import { fakeRunner, tempDir, deferred } from "./helpers.ts";
import type { ProcessResult } from "../src/exp/executor.ts";

const actor = { kind: "agent" as const, id: "synthetic-agent" }, secret = "PRIVATE AMEM OUTPUT", first = "a".repeat(32), second = "b".repeat(32);
const result = (id: string): ProcessResult => ({ exitCode: 0, stdout: JSON.stringify({ id, kind: "fail", private: secret }), stderr: secret });
async function setup(count = 2) {
  const dir = tempDir(); ops.init(dir, { question: "Synthetic question", mode: "experiment" }, { actor });
  const pending = Array.from({ length: count }, (_, i) => [
    { actor, type: "idea.added", data: { idea: { id: `idea-${i}`, title: `Synthetic title ${i}`, hypothesis: "Synthetic hypothesis" } } },
    { actor, type: "idea.decided", data: { id: `idea-${i}`, decision: "pivot", reason: "Synthetic failure", attempts: [], cause: "Synthetic cause", retryWhen: "Synthetic new evidence" } },
  ]).flat();
  if (pending.length) commit(dir, [], pending);
  return dir;
}
function ledger(dir: string) { return readFileSync(join(dir, "ledger.jsonl"), "utf8"); }

test("preview contains exact pending notes and a canonical full-list fingerprint without writes or processes", async () => {
  const dir = await setup(), before = ledger(dir), files = readdirSync(dir), fake = fakeRunner([]);
  const preview = await ops.archive(dir, {}, { actor, runner: fake.runner });
  const notes = deriveLessons(readLessonSources(dir));
  expect(preview).toEqual({ fingerprint: sha256(canonical(notes)), notes: notes.map(note => ({ sha256: sha256(canonical(note)), note })) });
  expect(previewArchive(dir)).toEqual(preview); expect(ledger(dir)).toBe(before); expect(readdirSync(dir)).toEqual(files);
  expect(fake.requests).toEqual([]); expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
});

test("confirmation writes exact fields once and persists only hashes and ids in one event", async () => {
  const dir = await setup(), preview = previewArchive(dir), before = readLedger(dir).length, fake = fakeRunner([result(first), result(second)]);
  const output = await ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: fake.runner }, { AGENTHUB_PEER_ID: "synthetic-agent", AMEM_HOME: "/synthetic/memory" });
  expect("written" in output && output.written).toEqual(preview.notes.map((note, i) => ({ sha256: note.sha256, id: [first, second][i]! })));
  expect(fake.requests).toHaveLength(2);
  for (const [index, request] of fake.requests.entries()) {
    const note = preview.notes[index]!.note;
    expect(request.cwd).toBe(dir); expect(request.command).toBe("amem");
    expect(request.args).toEqual(["note", "add", note.text, "--kind", note.kind, "--approach", note.approach!, "--symptom", note.symptom!, "--cause", note.cause!, "--retry-when", note.retryWhen!, "--title", note.title!, "--json"]);
    expect(request.env).toMatchObject({ AGENTHUB_PEER_ID: "synthetic-agent", AMEM_HOME: "/synthetic/memory" });
  }
  const events = readLedger(dir); expect(events).toHaveLength(before + 1);
  expect(events.at(-1)).toMatchObject({ actor, type: "archive.exported", data: { fingerprint: preview.fingerprint, notes: preview.notes.map((note, i) => ({ sha256: note.sha256, id: [first, second][i]! })) } });
  expect(ledger(dir)).not.toContain(secret); expect(JSON.stringify(output)).not.toContain(secret);
  expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
});

test("successful repeats skip exported hashes and write no second event", async () => {
  const dir = await setup(), preview = previewArchive(dir), fake = fakeRunner([result(first), result(second)]);
  await ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: fake.runner });
  const before = ledger(dir), next = previewArchive(dir);
  expect(next.notes).toEqual([]); expect(next.fingerprint).toBe(preview.fingerprint);
  expect(await ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: fake.runner })).toEqual({ ...next, written: [], remaining: 0 });
  expect(ledger(dir)).toBe(before); expect(fake.requests).toHaveLength(2);
});

test("stale and malformed confirmations refuse before process or receipt writes", async () => {
  const dir = await setup(1), stale = previewArchive(dir).fingerprint;
  await ops.ideaAdd(dir, { id: "new", title: "Synthetic", hypothesis: "Synthetic" }, { actor });
  await ops.ideaDecide(dir, "new", { decision: "pivot", reason: "Synthetic new failure" }, { actor });
  const before = ledger(dir), fake = fakeRunner([]);
  for (const confirm of [stale, "bad", "f".repeat(64), ""]) await expect(ops.archive(dir, { confirm }, { actor, runner: fake.runner })).rejects.toThrow("stale fingerprint");
  expect(fake.requests).toEqual([]); expect(ledger(dir)).toBe(before);
});

test("a partial amem failure persists successful ids, stops immediately and resumes the remainder", async () => {
  const dir = await setup(3), preview = previewArchive(dir), fake = fakeRunner([result(first), { exitCode: 2, stdout: secret, stderr: secret }, result(second), result("c".repeat(32))]);
  const before = readLedger(dir).length;
  await expect(ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: fake.runner })).rejects.toThrow("nonzero exit");
  expect(fake.requests).toHaveLength(2); expect(readLedger(dir)).toHaveLength(before + 1);
  expect(readLedger(dir).at(-1)!.data.notes).toEqual([{ sha256: preview.notes[0]!.sha256, id: first }]);
  expect(ledger(dir)).not.toContain(secret); expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
  const remaining = previewArchive(dir); expect(remaining.notes).toEqual(preview.notes.slice(1)); expect(remaining.fingerprint).toBe(preview.fingerprint);
  await ops.archive(dir, { confirm: remaining.fingerprint }, { actor, runner: fake.runner });
  expect(fake.requests).toHaveLength(4); expect(fake.requests[2]!.args[2]).toBe(preview.notes[1]!.note.text);
  expect(previewArchive(dir).notes).toEqual([]); expect(readLedger(dir)).toHaveLength(before + 2);
});

test("failure on the first call writes no receipt and never copies raw diagnostics", async () => {
  for (const response of [new Error(secret), { exitCode: 0, stdout: secret, stderr: secret }]) {
    const dir = await setup(1), preview = previewArchive(dir), before = ledger(dir), fake = fakeRunner([response]);
    try { await ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: fake.runner }); throw new Error("expected rejection"); }
    catch (error) { expect((error as Error).message).toContain("amem"); expect((error as Error).message).not.toContain(secret); }
    expect(ledger(dir)).toBe(before); expect(fake.requests).toHaveLength(1);
  }
});

test("empty archive is a read-only no-op on confirmation", async () => {
  const dir = await setup(0), preview = previewArchive(dir), before = ledger(dir), fake = fakeRunner([]);
  expect(preview).toEqual({ fingerprint: sha256("[]"), notes: [] });
  expect(await ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: fake.runner })).toEqual({ ...preview, written: [], remaining: 0 });
  expect(ledger(dir)).toBe(before); expect(fake.requests).toEqual([]);
});

test("exports 200 pending notes per batch and continues with the same fingerprint", async () => {
  const dir = await setup(201), preview = previewArchive(dir);
  expect(preview.notes).toHaveLength(201);
  const fake = fakeRunner(Array.from({ length: 201 }, (_, i) => result(i.toString(16).padStart(32, "0"))));
  const firstBatch = await ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: fake.runner });
  expect("remaining" in firstBatch && firstBatch.remaining).toBe(1); expect(fake.requests).toHaveLength(200);
  expect(readLedger(dir).filter(event => event.type === "archive.exported")).toHaveLength(1);
  expect((readLedger(dir).at(-1)!.data.notes as unknown[]).length).toBe(200);
  const next = previewArchive(dir);
  expect(next.fingerprint).toBe(preview.fingerprint); expect(next.notes).toEqual(preview.notes.slice(200));
  const lastBatch = await ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: fake.runner });
  expect("remaining" in lastBatch && lastBatch.remaining).toBe(0); expect(fake.requests).toHaveLength(201);
  expect(fake.requests.map(request => request.args[2])).toEqual(preview.notes.map(item => item.note.text));
  expect(readLedger(dir).filter(event => event.type === "archive.exported")).toHaveLength(2);
  expect((readLedger(dir).at(-1)!.data.notes as unknown[]).length).toBe(1); expect(previewArchive(dir).notes).toEqual([]);
});

test("malformed and conflicting stored receipts fail closed before new exports", async () => {
  for (const notes of [[{ sha256: "bad", id: first }], [{ sha256: "a".repeat(64), id: secret }],
    [{ sha256: "a".repeat(64), id: first }, { sha256: "a".repeat(64), id: second }]]) {
    const dir = await setup(1); appendEvent(dir, actor, "archive.exported", { fingerprint: "a".repeat(64), notes });
    expect(() => previewArchive(dir)).toThrow("archive receipt");
  }
});

test("CLI preview and confirmed export preserve JSON and actor/env forwarding", async () => {
  const dir = await setup(1), fake = fakeRunner([result(first)]), env = { AGENTHUB_PEER_ID: "synthetic-agent", AMEM_HOME: "/synthetic/memory" };
  const preview = JSON.parse((await run(["archive", dir, "--json"], env, { runner: fake.runner })).text);
  expect(fake.requests).toHaveLength(0);
  const confirmed = await run(["archive", dir, "--confirm", preview.fingerprint, "--json"], env, { runner: fake.runner });
  expect(confirmed.code).toBe(0); expect(JSON.parse(confirmed.text).written[0].id).toBe(first);
  expect(fake.requests[0]!.env).toMatchObject(env); expect(readLedger(dir).at(-1)!.actor).toEqual({ kind: "agent", id: "synthetic-agent" });
});

test("a confirmed export holds the study lock until its receipts are committed", async () => {
  const dir = await setup(1), preview = previewArchive(dir), entered = deferred(), release = deferred(), fake = fakeRunner([result(first)]);
  const pending = ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: async request => {
    entered.resolve(); await release.promise; return fake.runner(request);
  } });
  await entered.promise;
  try {
    await expect(ops.archive(dir, { confirm: preview.fingerprint }, { actor, runner: fake.runner })).rejects.toThrow("study is locked");
    expect(readLedger(dir).some(event => event.type === "archive.exported")).toBe(false);
  } finally { release.resolve(); }
  await pending;
  expect(fake.requests).toHaveLength(1); expect(previewArchive(dir).notes).toEqual([]);
});

test("receipt bounds are checked before the first outward write", async () => {
  const dir = await setup(1), before = ledger(dir), fake = fakeRunner([result(first)]), preview = previewArchive(dir);
  await expect(ops.archive(dir, { confirm: preview.fingerprint }, { actor: { kind: "agent", id: "x".repeat(65_536) }, runner: fake.runner }))
    .rejects.toThrow("archive receipt: capacity check failed");
  expect(fake.requests).toEqual([]); expect(ledger(dir)).toBe(before);
});
