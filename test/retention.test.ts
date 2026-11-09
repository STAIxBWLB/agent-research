import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { spawnRunner, type Executor } from "../src/exp/executor.ts";
import { retainedOperation, RETENTION_RESERVATION, type RetainedIdentity, type RetainedRef, type RetentionRequest } from "../src/exp/retention.ts";
import { sha256 } from "../src/study.ts";

const roots: string[] = [];
afterEach(() => {
  const unlock = (root: string): void => {
    if (!lstatSync(root).isDirectory()) return;
    chmodSync(root, 0o700);
    for (const name of readdirSync(root)) { const child = join(root, name); if (lstatSync(child).isDirectory()) unlock(child); }
  };
  for (const root of roots.splice(0)) { unlock(root); rmSync(root, { recursive: true, force: true }); }
});
const studyId = "synthetic-retention", attemptId = "a".repeat(16), otherId = "b".repeat(16);
const identity: RetainedIdentity = {
  definitionHash: "1".repeat(64), inputHashes: {}, codeTree: "2".repeat(40), image: `synthetic@sha256:${"3".repeat(64)}`,
  argvHash: "4".repeat(64), envHash: "5".repeat(64), seed: 1, producerVersion: "synthetic-1",
};
const observed = { containerId: "6".repeat(64), endedAt: "2030-01-01T00:00:01Z", exitCode: 0 as const };
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ares-retention-"))); roots.push(root); chmodSync(root, 0o700);
  const workspace = join(root, studyId, attemptId), stage = join(workspace, "stages", "prepare"), source = join(stage, "output");
  mkdirSync(source, { recursive: true, mode: 0o700 }); chmodSync(join(root, studyId), 0o700); chmodSync(workspace, 0o700);
  mkdirSync(join(workspace, "task"), { mode: 0o700 }); writeFileSync(join(workspace, "task", "data.txt"), "synthetic input");
  const executor: Executor = { v: 1, kind: "local", workdir: root };
  const run = (request: Omit<RetentionRequest, "studyId">) => retainedOperation(executor, { expectedTaskTreeHash: sha256(JSON.stringify([["data.txt", sha256("synthetic input")]])), ...request, studyId } as RetentionRequest, spawnRunner);
  const seal = () => run({ op: "seal", attemptId, stage: "prepare", source, outputs: { rows: "rows.txt" }, identity, observed } as Omit<RetentionRequest, "studyId">);
  return { root, workspace, stage, source, executor, run, seal };
}

test("retention seals bounded terminated outputs atomically, verifies before consumption and never overwrites", async () => {
  const f = fixture(); writeFileSync(join(f.source, "rows.txt"), "synthetic rows");
  await f.run({ op: "reserve", attemptId } as Omit<RetentionRequest, "studyId">);
  const sealed = await f.seal(), ref: RetainedRef = { attemptId, stage: "prepare", sha256: sealed.sha256! };
  expect(sealed.manifest?.identity).toEqual(identity);
  expect(sealed.manifest?.files).toHaveLength(1);
  expect((await f.seal()).sha256).toBe(ref.sha256);
  const inputs = { rows: { ref, output: "rows" }, data: { task: "data.txt" } };
  const target = join(f.stage, "inputs");
  const receipt = await f.run({ op: "materialize", attemptId, stage: "train", target, taskRoot: join(f.workspace, "task"), inputs } as Omit<RetentionRequest, "studyId">);
  expect(Object.keys(receipt.inputHashes ?? {}).sort()).toEqual(["data", "rows"]);
  expect(receipt.inputHashes?.rows).toBe(ref.sha256);
  expect(readFileSync(join(target, "rows"), "utf8")).toBe("synthetic rows");
  expect((await f.run({ op: "materialize", attemptId, stage: "train", target, taskRoot: join(f.workspace, "task"), inputs } as Omit<RetentionRequest, "studyId">)).inputHashes).toEqual(receipt.inputHashes);
  await expect(f.run({ op: "seal", attemptId, stage: "prepare", source: f.source, outputs: { rows: "rows.txt" }, identity: { ...identity, seed: 2 }, observed } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("different provenance");
  chmodSync(join(target, "rows"), 0o600); writeFileSync(join(target, "rows"), "tampered");
  await expect(f.run({ op: "materialize", attemptId, stage: "train", target, taskRoot: join(f.workspace, "task"), inputs } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("snapshot integrity");
  const marker = JSON.parse(readFileSync(`${target}.retention.json`, "utf8"));
  marker.files = marker.files.map((file: { path: string; bytes: number; sha256: string }) => file.path === "rows" ? { ...file, bytes: 8, sha256: sha256("tampered") } : file);
  writeFileSync(`${target}.retention.json`, JSON.stringify(marker));
  await expect(f.run({ op: "materialize", attemptId, stage: "train", target, taskRoot: join(f.workspace, "task"), inputs } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("source or payload changed");
  expect((await f.run({ op: "verify", ref } as Omit<RetentionRequest, "studyId">)).sha256).toBe(ref.sha256);
});

test("retention reservations include in-flight capacity; prune refuses active refs and keeps tombstones", async () => {
  const f = fixture(); writeFileSync(join(f.source, "rows.txt"), "synthetic rows");
  await f.run({ op: "reserve", attemptId, reservationBytes: 4096, capBytes: 5000 } as Omit<RetentionRequest, "studyId">);
  await expect(f.run({ op: "reserve", attemptId: otherId, reservationBytes: 4096 } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("cap full");
  const sealed = await f.seal(), ref: RetainedRef = { attemptId, stage: "prepare", sha256: sealed.sha256! };
  await expect(f.run({ op: "prune", refs: [ref] } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("active producer or consumer");
  await f.run({ op: "release", attemptId } as Omit<RetentionRequest, "studyId">);
  const preview = await f.run({ op: "prune", refs: [ref] } as Omit<RetentionRequest, "studyId">);
  await expect(f.run({ op: "prune", refs: [ref], fingerprint: "0".repeat(64) } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("stale prune fingerprint");
  expect((await f.run({ op: "prune", refs: [ref], fingerprint: preview.fingerprint } as Omit<RetentionRequest, "studyId">)).pruned).toBe(1);
  expect((await f.run({ op: "inspect" })).entries?.[0]?.tombstone).toBe(true);
  await expect(f.run({ op: "verify", ref } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("pruned");
  expect(existsSync(join(f.root, studyId, ".retained", "objects", attemptId, "prepare", "data"))).toBe(false);
  expect(existsSync(join(f.root, studyId, ".retained", "objects", attemptId, "prepare", "manifest.json"))).toBe(true);
});

test("retention refuses links, missing declared bytes, invalid termination and same-user source tampering", async () => {
  const f = fixture(); writeFileSync(join(f.source, "rows.txt"), "synthetic rows");
  await f.run({ op: "reserve", attemptId } as Omit<RetentionRequest, "studyId">);
  symlinkSync("rows.txt", join(f.source, "unsafe"));
  await expect(f.run({ op: "seal", attemptId, stage: "prepare", source: f.source, outputs: { rows: "unsafe" }, identity, observed } as Omit<RetentionRequest, "studyId">)).rejects.toThrow();
  await expect(f.run({ op: "seal", attemptId, stage: "prepare", source: f.source, outputs: { rows: "absent" }, identity, observed } as Omit<RetentionRequest, "studyId">)).rejects.toThrow();
  await expect(f.run({ op: "seal", attemptId, stage: "prepare", source: f.source, outputs: { rows: "rows.txt" }, identity, observed: { ...observed, exitCode: 1 } } as unknown as Omit<RetentionRequest, "studyId">)).rejects.toThrow("successful termination");
  const sealed = await f.seal(), ref: RetainedRef = { attemptId, stage: "prepare", sha256: sealed.sha256! };
  const payload = join(f.root, studyId, ".retained", "objects", attemptId, "prepare", "data", "rows.txt");
  chmodSync(payload, 0o600); writeFileSync(payload, "synthetic tamper");
  await expect(f.run({ op: "verify", ref } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("payload integrity");
});

test("retention orphan publication and interrupted consumption never create a false availability receipt", async () => {
  const f = fixture(); writeFileSync(join(f.source, "rows.txt"), "synthetic rows");
  await f.run({ op: "reserve", attemptId } as Omit<RetentionRequest, "studyId">);
  const sealed = await f.seal(), ref: RetainedRef = { attemptId, stage: "prepare", sha256: sealed.sha256! };
  const stateFile = join(f.root, studyId, ".retained", "state.json"), state = JSON.parse(readFileSync(stateFile, "utf8"));
  delete state.entries[`${attemptId}/prepare`]; writeFileSync(stateFile, JSON.stringify(state));
  await expect(f.run({ op: "verify", ref } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("source missing");
  expect((await f.seal()).sha256).toBe(ref.sha256);
  const target = join(f.stage, "inputs");
  mkdirSync(target, { mode: 0o700 }); writeFileSync(join(target, "rows"), "partial");
  await expect(f.run({ op: "materialize", attemptId, stage: "train", target, taskRoot: join(f.workspace, "task"), inputs: { rows: { ref, output: "rows" } } } as Omit<RetentionRequest, "studyId">)).rejects.toThrow();
  // A malformed lock cannot be used or replaced; evidence remains untouched.
  const lock = join(f.root, studyId, ".retained", "lock"); unlinkSync(lock); mkdirSync(lock, { mode: 0o700 });
  await expect(f.run({ op: "verify", ref } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("active or invalid lock");
});

test("retention shares metadata budget, rechecks frozen tasks and pins cross-attempt consumers", async () => {
  const f = fixture(); writeFileSync(join(f.source, "rows.txt"), "synthetic rows");
  await f.run({ op: "reserve", attemptId } as Omit<RetentionRequest, "studyId">);
  await expect(f.run({ op: "seal", attemptId, stage: "prepare", source: f.source, outputs: { rows: "rows.txt" }, identity, observed, metadataLimit: 0 } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("cumulative attempt output or metadata");
  expect((await f.run({ op: "inspect" })).entries).toEqual([]);
  const sealed = await f.seal(), ref: RetainedRef = { attemptId, stage: "prepare", sha256: sealed.sha256! };
  expect(sealed.sidecarBytes).toBe(sealed.manifestBytes);
  writeFileSync(join(f.workspace, "task", "data.txt"), "tampered frozen input");
  await expect(f.run({ op: "materialize", attemptId, stage: "train", target: join(f.stage, "inputs"), taskRoot: join(f.workspace, "task"), inputs: { data: { task: "data.txt" } } } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("frozen task snapshot integrity");
  expect(existsSync(join(f.stage, "inputs"))).toBe(false);
  const other = join(f.root, studyId, otherId); mkdirSync(join(other, "stages", "train"), { recursive: true, mode: 0o700 }); chmodSync(other, 0o700);
  mkdirSync(join(other, "task"), { mode: 0o700 });
  await f.run({ op: "reserve", attemptId: otherId } as Omit<RetentionRequest, "studyId">);
  await f.run({ op: "materialize", attemptId: otherId, stage: "train", target: join(other, "stages", "train", "inputs"), taskRoot: join(other, "task"), inputs: { rows: { ref, output: "rows" } } } as Omit<RetentionRequest, "studyId">);
  await f.run({ op: "release", attemptId } as Omit<RetentionRequest, "studyId">);
  await expect(f.run({ op: "prune", refs: [ref] } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("active producer or consumer");
  await f.run({ op: "release", attemptId: otherId } as Omit<RetentionRequest, "studyId">);
  expect((await f.run({ op: "prune", refs: [ref] } as Omit<RetentionRequest, "studyId">)).fingerprint).toHaveLength(64);
});

test("retention stage limits draw from cumulative file allowance including zero-byte files", async () => {
  const f = fixture(), rows = join(f.source, "rows"); mkdirSync(rows, { mode: 0o700 });
  for (let i = 0; i < 500; i++) writeFileSync(join(rows, `row-${i}`), "");
  await f.run({ op: "reserve", attemptId } as Omit<RetentionRequest, "studyId">);
  const sealed = await f.run({ op: "seal", attemptId, stage: "prepare", source: f.source, outputs: { rows: "rows" }, identity, observed } as Omit<RetentionRequest, "studyId">);
  expect(sealed.manifest?.files).toHaveLength(500);
  const next = join(f.workspace, "stages", "next", "output"); mkdirSync(next, { recursive: true, mode: 0o700 }); writeFileSync(join(next, "extra"), "");
  await expect(f.run({ op: "seal", attemptId, stage: "next", source: next, outputs: { extra: "extra" }, identity, observed } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("cumulative attempt output or metadata");
  expect((await f.run({ op: "inspect" })).entries).toHaveLength(1);
});

test("retention rechecks the frozen code snapshot beyond the artifact file-count limit", async () => {
  const f = fixture(), code = join(f.workspace, "snapshot"); mkdirSync(code, { mode: 0o700 });
  for (let i = 0; i < 501; i++) writeFileSync(join(code, `source-${i}.txt`), `synthetic ${i}`);
  await f.run({ op: "reserve", attemptId } as Omit<RetentionRequest, "studyId">);
  const baseline = await f.run({ op: "snapshot", attemptId, source: code } as Omit<RetentionRequest, "studyId">);
  expect(baseline.sha256).toHaveLength(64);
  const target = join(f.stage, "inputs"), request = { op: "materialize", attemptId, stage: "train", target, taskRoot: join(f.workspace, "task"), codeRoot: code, expectedCodeHash: baseline.sha256, inputs: {} };
  await f.run(request as Omit<RetentionRequest, "studyId">);
  writeFileSync(join(code, "source-0.txt"), "tampered frozen source");
  await expect(f.run(request as Omit<RetentionRequest, "studyId">)).rejects.toThrow("frozen code snapshot integrity mismatch");
  const state = await f.run({ op: "inspect" });
  expect(state.reservations).toEqual([{ attemptId, active: true, reservationBytes: RETENTION_RESERVATION }]);
});

test("synthetic prune crash state keeps tombstones authoritative before physical disposal", async () => {
  const f = fixture(); writeFileSync(join(f.source, "rows.txt"), "synthetic rows");
  await f.run({ op: "reserve", attemptId } as Omit<RetentionRequest, "studyId">);
  const sealed = await f.seal(), ref: RetainedRef = { attemptId, stage: "prepare", sha256: sealed.sha256! };
  await f.run({ op: "release", attemptId } as Omit<RetentionRequest, "studyId">);
  // Synthetic state injection models the committed immutable tombstone before byte deletion, without killing a process.
  writeFileSync(join(f.root, studyId, ".retained", "objects", attemptId, "prepare", "tombstone.json"), JSON.stringify({ ref: { attemptId: ref.attemptId, sha256: ref.sha256, stage: ref.stage }, v: 1 }));
  const data = join(f.root, studyId, ".retained", "objects", attemptId, "prepare", "data");
  expect(existsSync(data)).toBe(true);
  await expect(f.run({ op: "verify", ref } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("pruned");
  const before = await f.run({ op: "inspect" });
  expect(before.usedBytes).toBeGreaterThan(sealed.manifestBytes!);
  const preview = await f.run({ op: "prune", refs: [ref] } as Omit<RetentionRequest, "studyId">);
  await f.run({ op: "prune", refs: [ref], fingerprint: preview.fingerprint } as Omit<RetentionRequest, "studyId">);
  expect(existsSync(data)).toBe(false);
  const disposed = await f.run({ op: "inspect" });
  expect(disposed.usedBytes).toBe(sealed.manifestBytes! + disposed.administrativeBytes!);
  expect(disposed.administrativeBytes).toBeGreaterThan(0);
});


test("retention refuses an impossible new-store reservation before creating directories", async () => {
  const f = fixture(), absentStudy = "synthetic-absent";
  await expect(retainedOperation(f.executor, { op: "reserve", studyId: absentStudy, attemptId, capBytes: 1 }, spawnRunner)).rejects.toThrow("cap full");
  expect(existsSync(join(f.root, absentStudy))).toBe(false);
  await expect(retainedOperation(f.executor, { op: "reserve", studyId: absentStudy, attemptId, capBytes: 0 }, spawnRunner)).rejects.toThrow("invalid retention cap");
  expect(existsSync(join(f.root, absentStudy))).toBe(false);
});


test("code snapshot hashes tracked symlinks and unusual Git names without following link targets", async () => {
  const f = fixture(), repo = join(f.workspace, "repo"), code = join(f.workspace, "snapshot");
  mkdirSync(repo, { mode: 0o700 }); mkdirSync(code, { mode: 0o700 });
  writeFileSync(join(f.workspace, "outside.txt"), "outside snapshot bytes");
  writeFileSync(join(repo, "source.txt"), "synthetic source");
  writeFileSync(join(repo, "odd\\name.txt"), "synthetic unusual filename");
  symlinkSync("../outside.txt", join(repo, "reference"));
  const git = (args: string[]) => {
    const result = spawnSync("git", ["-C", repo, "-c", "commit.gpgsign=false", ...args], { maxBuffer: 1024 * 1024, env: { ...process.env, HOME: f.root, GIT_CONFIG_GLOBAL: join(f.root, "synthetic-git-config"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Synthetic", GIT_AUTHOR_EMAIL: "synthetic@example.invalid", GIT_COMMITTER_NAME: "Synthetic", GIT_COMMITTER_EMAIL: "synthetic@example.invalid" } });
    expect(result.status).toBe(0); return result;
  };
  git(["init", "-q"]); git(["add", "."]);
  git(["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic snapshot"]);
  const archive = git(["archive", "HEAD"]);
  expect(spawnSync("tar", ["-xf", "-", "-C", code], { input: archive.stdout }).status).toBe(0);
  await f.run({ op: "reserve", attemptId } as Omit<RetentionRequest, "studyId">);
  const first = await f.run({ op: "snapshot", attemptId, source: code } as Omit<RetentionRequest, "studyId">);
  writeFileSync(join(f.workspace, "outside.txt"), "changed outside snapshot");
  expect((await f.run({ op: "snapshot", attemptId, source: code } as Omit<RetentionRequest, "studyId">)).sha256).toBe(first.sha256);
  unlinkSync(join(code, "reference")); symlinkSync("../different.txt", join(code, "reference"));
  expect((await f.run({ op: "snapshot", attemptId, source: code } as Omit<RetentionRequest, "studyId">)).sha256).not.toBe(first.sha256);
});

test("near-bound retention history compacts into immutable shards without bricking new work", async () => {
  const f = fixture(); writeFileSync(join(f.source, "rows.txt"), "synthetic rows");
  await f.run({ op: "reserve", attemptId } as Omit<RetentionRequest, "studyId">);
  const stateFile = join(f.root, studyId, ".retained", "state.json"), state = JSON.parse(readFileSync(stateFile, "utf8"));
  for (let i = 1; i <= 250; i++) {
    const archivedId = i.toString(16).padStart(16, "0");
    state.attempts[archivedId] = { reservation: 0, active: false, consumers: [] };
    for (let stage = 0; stage < 16; stage++) {
      const name = `stage${stage}`;
      state.entries[`${archivedId}/${name}`] = { attemptId: archivedId, stage: name, sha256: "7".repeat(64), bytes: 1, payloadBytes: 0, metadataBytes: 1, files: 0, tombstone: true };
    }
  }
  const legacy = JSON.stringify(state);
  expect(Buffer.byteLength(legacy)).toBeGreaterThan(850_000);
  expect(Buffer.byteLength(legacy)).toBeLessThan(1024 * 1024);
  writeFileSync(stateFile, legacy);
  await f.run({ op: "reserve", attemptId: otherId } as Omit<RetentionRequest, "studyId">);
  expect(readFileSync(stateFile).length).toBeLessThan(10_000);
  const sealed = await f.seal(), ref: RetainedRef = { attemptId, stage: "prepare", sha256: sealed.sha256! };
  const page = await f.run({ op: "inspect", limit: 2 } as Omit<RetentionRequest, "studyId">);
  expect(page.entries).toHaveLength(2); expect(page.total).toBe(4001); expect(page.remaining).toBe(3999);
  expect(page.archivedReservations).toBe(250);
  const archiveFile = join(f.root, studyId, ".retained", "archive", "00", "0000000000000001.json");
  expect(JSON.parse(readFileSync(archiveFile, "utf8")).entries["0000000000000001/stage0"].tombstone).toBe(true);
  await f.run({ op: "release", attemptId } as Omit<RetentionRequest, "studyId">);
  const preview = await f.run({ op: "prune", refs: [ref] } as Omit<RetentionRequest, "studyId">);
  expect((await f.run({ op: "prune", refs: [ref], fingerprint: preview.fingerprint } as Omit<RetentionRequest, "studyId">)).pruned).toBe(1);
  expect((await f.run({ op: "inspect", offset: 4000, limit: 2 } as Omit<RetentionRequest, "studyId">)).entries).toHaveLength(1);
  await expect(f.run({ op: "verify", ref } as Omit<RetentionRequest, "studyId">)).rejects.toThrow("pruned");
}, 60_000);
