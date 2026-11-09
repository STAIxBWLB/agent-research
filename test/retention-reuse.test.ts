import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { retainedOperation, type RetainedIdentity, type RetainedRef, type RetentionRequest } from "../src/exp/retention.ts";
import { spawnRunner, type Executor, type ProcessRunner } from "../src/exp/executor.ts";
import { sha256 } from "../src/study.ts";

type WithoutStudy<T> = T extends { studyId: string } ? Omit<T, "studyId"> : never;
const roots: string[] = [];
afterEach(() => {
  const unlock = (root: string): void => {
    if (!lstatSync(root).isDirectory()) return;
    chmodSync(root, 0o700);
    for (const name of readdirSync(root)) { const child = join(root, name); if (lstatSync(child).isDirectory()) unlock(child); }
  };
  for (const root of roots.splice(0)) { unlock(root); rmSync(root, { recursive: true, force: true }); }
});
const studyId = "synthetic-reuse", sourceId = "a".repeat(16), consumerId = "b".repeat(16), reuseKey = "c".repeat(64);
const identity: RetainedIdentity = { definitionHash: "d".repeat(64), inputHashes: { input: "e".repeat(64) }, codeTree: "f".repeat(40), image: `synthetic@sha256:${"1".repeat(64)}`, argvHash: "2".repeat(64), envHash: "3".repeat(64), seed: 1, producerVersion: "synthetic-1" };
const observed = { containerId: "4".repeat(64), endedAt: "2030-01-01T00:00:01Z", exitCode: 0 as const };
async function fixture(options: { tagged?: boolean; releaseSource?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ares-reuse-store-"))); roots.push(root); chmodSync(root, 0o700);
  const source = join(root, studyId, sourceId, "stages", "prepare", "output"); mkdirSync(source, { recursive: true, mode: 0o700 });
  const executor: Executor = { v: 1, kind: "local", workdir: root };
  const run = (request: WithoutStudy<RetentionRequest>, runner: ProcessRunner = spawnRunner) => retainedOperation(executor, { studyId, ...request }, runner);
  await run({ op: "reserve", attemptId: sourceId }); writeFileSync(join(source, "rows.txt"), "synthetic rows");
  const sealed = await run({ op: "seal", attemptId: sourceId, stage: "prepare", source, outputs: { rows: "rows.txt" }, identity, observed, ...(options.tagged === false ? {} : { reuseKey }) });
  const ref: RetainedRef = { attemptId: sourceId, stage: "prepare", sha256: sealed.sha256! };
  if (options.releaseSource !== false) await run({ op: "release", attemptId: sourceId });
  await run({ op: "reserve", attemptId: consumerId });
  const request = { op: "lookup" as const, attemptId: consumerId, stage: "prepare", key: reuseKey, expected: identity, outputs: { rows: "rows.txt" } };
  const lookup = () => run(request);
  const store = join(root, studyId, ".retained"), archive = join(store, "archive", sourceId.slice(0, 2), `${sourceId}.json`);
  const mutateArchive = (change: (record: { entries: Record<string, Record<string, unknown>> }) => void) => {
    const record = JSON.parse(readFileSync(archive, "utf8")); change(record); chmodSync(archive, 0o600); writeFileSync(archive, JSON.stringify(record));
  };
  return { root, source, executor, run, request, lookup, ref, sealed, store, archive, mutateArchive };
}

test("reuse lookup verifies an archived source, pins before returning and is idempotent", async () => {
  const f = await fixture(), hit = await f.lookup();
  expect(hit.hit).toBe(true); expect(hit.ref).toEqual(f.ref); expect(hit.sha256).toBe(f.ref.sha256);
  expect(hit.manifest?.identity).toEqual(identity); expect(hit.manifest?.reuseKey).toBe(reuseKey);
  const stateFile = join(f.store, "state.json"), state = readFileSync(stateFile);
  expect(await f.lookup()).toEqual(hit); expect(readFileSync(stateFile)).toEqual(state);
  expect((await f.run({ op: "inspect" })).entries?.find(entry => entry.ref.attemptId === sourceId)?.active).toBe(true);
  await expect(f.run({ op: "prune", refs: [f.ref] })).rejects.toThrow("active producer or consumer");
  await f.run({ op: "release", attemptId: consumerId });
  const preview = await f.run({ op: "prune", refs: [f.ref] });
  expect((await f.run({ op: "prune", refs: [f.ref], fingerprint: preview.fingerprint })).pruned).toBe(1);
});

test("changed keys or expected execution fields are reasoned misses, never false hits", async () => {
  const f = await fixture();
  const variants: Partial<RetainedIdentity>[] = [
    { definitionHash: "5".repeat(64) }, { inputHashes: { input: "5".repeat(64) } }, { codeTree: "5".repeat(40) },
    { image: `other@sha256:${"5".repeat(64)}` }, { argvHash: "5".repeat(64) }, { envHash: "5".repeat(64) }, { seed: 2 }, { producerVersion: "synthetic-2" },
  ];
  for (const variant of variants) expect(await f.run({ ...f.request, expected: { ...identity, ...variant } })).toMatchObject({ hit: false, reason: "ineligible-source" });
  expect(await f.run({ ...f.request, key: "5".repeat(64) })).toMatchObject({ hit: false, reason: "missing" });
  expect(await f.run({ ...f.request, outputs: { rows: "other.txt" } })).toMatchObject({ hit: false, reason: "ineligible-source" });
  expect(await f.run({ ...f.request, stage: "evaluator" })).toMatchObject({ hit: false, reason: "ineligible-source" });
  expect(await f.run({ ...f.request, stage: "train" })).toMatchObject({ hit: false, reason: "ineligible-source" });
  expect(JSON.parse(readFileSync(join(f.store, "state.json"), "utf8")).attempts[consumerId].consumers).toEqual([]);
});

test("corrupt, pruned, unsupported and forged indexed sources never become hits", async () => {
  const corrupt = await fixture(), payload = join(corrupt.store, "objects", sourceId, "prepare", "data", "rows.txt");
  chmodSync(payload, 0o600); writeFileSync(payload, "tampered rows");
  expect(await corrupt.lookup()).toMatchObject({ hit: false, reason: "corrupt" });
  const pruned = await fixture(), preview = await pruned.run({ op: "prune", refs: [pruned.ref] });
  await pruned.run({ op: "prune", refs: [pruned.ref], fingerprint: preview.fingerprint });
  expect(await pruned.lookup()).toMatchObject({ hit: false, reason: "pruned" });
  const legacy = await fixture({ tagged: false });
  expect(await legacy.lookup()).toMatchObject({ hit: false, reason: "missing" });
  legacy.mutateArchive(record => { record.entries[`${sourceId}/prepare`]!.reuseKey = reuseKey; });
  expect(await legacy.lookup()).toMatchObject({ hit: false, reason: "unsupported" });
  const forged = await fixture(), otherKey = "5".repeat(64);
  forged.mutateArchive(record => { record.entries[`${sourceId}/prepare`]!.reuseKey = otherKey; });
  expect(await forged.run({ ...forged.request, key: otherKey })).toMatchObject({ hit: false, reason: "corrupt" });
  const future = await fixture(), manifestFile = join(future.store, "objects", sourceId, "prepare", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")); manifest.v = 2;
  const bytes = JSON.stringify(manifest); chmodSync(manifestFile, 0o600); writeFileSync(manifestFile, bytes);
  future.mutateArchive(record => { record.entries[`${sourceId}/prepare`]!.sha256 = sha256(bytes); });
  expect(await future.lookup()).toMatchObject({ hit: false, reason: "unsupported" });
});

test("lookup excludes active/current producers and preserves a pin after a lost result acknowledgement", async () => {
  const active = await fixture({ releaseSource: false });
  expect(await active.lookup()).toMatchObject({ hit: false, reason: "ineligible-source" });
  expect(await active.run({ ...active.request, attemptId: sourceId })).toMatchObject({ hit: false, reason: "ineligible-source" });
  const f = await fixture();
  const lostAck: ProcessRunner = async request => { await spawnRunner(request); return { exitCode: 255, stdout: "", stderr: "synthetic lost acknowledgement" }; };
  await expect(f.run(f.request, lostAck)).rejects.toThrow("executor operation failed");
  await expect(f.run({ op: "prune", refs: [f.ref] })).rejects.toThrow("active producer or consumer");
  expect((await f.lookup()).ref).toEqual(f.ref);
  expect((await f.lookup()).manifest?.observed).toEqual(observed);
});

test("lookup scanning is explicitly capped even when history has no indexed entries", async () => {
  const f = await fixture(), prefix = join(f.store, "archive", "00"); mkdirSync(prefix, { mode: 0o700 });
  for (let i = 100; i < 170; i++) {
    const id = i.toString(16).padStart(16, "0");
    writeFileSync(join(prefix, `${id}.json`), JSON.stringify({ v: 1, attemptId: id, entries: {}, reservation: { active: false, reservation: 0, consumers: [] }, syntheticPadding: "x".repeat(62_000) }), { mode: 0o400 });
  }
  expect(await f.run({ ...f.request, key: "5".repeat(64) })).toMatchObject({ hit: false, reason: "scan-cap" });
  expect(existsSync(join(f.store, "state.json"))).toBe(true);
}, 20_000);


test("reuse selection refusals name the 16-selection bound and retention recovery", async () => {
  const f = await fixture(), file = join(f.store, "state.json"), original = readFileSync(file);
  for (const entries of [null, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`other${i}`, { key: reuseKey, ref: f.ref }])), Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`other${i}`, { key: reuseKey, ref: f.ref }]))]) {
    const state = JSON.parse(original.toString()); state.attempts[consumerId].reuseSelections = entries;
    writeFileSync(file, JSON.stringify(state));
    const before = readFileSync(file);
    await expect(f.lookup()).rejects.toThrow(entries && Object.keys(entries).length === 16 ? "reuse selection bound exceeded (16 active selections)" : "invalid reuse selections (at most 16 active selections)");
    await expect(f.lookup()).rejects.toThrow("finish or cancel attempts holding selections, inspect with ares retention inspect");
    await expect(f.lookup()).rejects.toThrow("ares retention prune");
    expect(readFileSync(file)).toEqual(before);
  }
});
