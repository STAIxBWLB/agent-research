import {expect, test} from "bun:test";
import {join} from "node:path";
import {existsSync} from "node:fs";
import * as ops from "../src/commands.ts";
import {candidateNote, FIXTURE_LESSON_STRENGTH, lessonEvidenceFingerprint} from "../src/harness/lesson-candidates.ts";
import {appendEvent, readLedger, writeAtomic, readTextBounded, sha256, openStudy} from "../src/study.ts";
import {canonical} from "../src/plan/state.ts";
import {lessonFixture, acceptedLesson, lessonLedger, screenedLessonRunner} from "./lesson-fixtures.ts";

const disposition = (row: Awaited<ReturnType<typeof ops.lessonPropose>>) => ({decision: "accept", proposalSha256: row.sha256, evidenceFingerprint: row.evidenceFingerprint, reason: "Synthetic reviewed limitation", acknowledgeStrength: FIXTURE_LESSON_STRENGTH});
test("closed negative fixture chain binds authored change, behavior and outcome, and review records strength separately", async () => {
  const f = await lessonFixture(), proposed = await ops.lessonPropose(f.dir, f.proposal, f.ctx, f.env), before = lessonLedger(f.dir);
  expect(proposed).toMatchObject({state: "proposed", current: true, exportable: false, proposal: {sourceStrength: "synthetic-fixture", transfer: "not-demonstrated"}});
  expect(proposed.proposal.inspections[0]).toMatchObject({state: "available", ref: {kind: "harness-closure", sha256: f.proposal.closureSha256}, outcome: {status: "closed", success: false}});
  expect((await ops.lessonCheck(f.dir, f.proposal.name, f.ctx, f.env)).acceptReady).toBe(true); expect(lessonLedger(f.dir)).toEqual(before);
  for (const raw of [{...disposition(proposed), acknowledgeStrength: undefined}, {...disposition(proposed), proposalSha256: "f".repeat(64)}, {...disposition(proposed), evidenceFingerprint: "f".repeat(64)}]) {
    await expect(ops.lessonDecide(f.dir, f.proposal.name, raw, f.ctx, f.env)).rejects.toThrow("lesson"); expect(lessonLedger(f.dir)).toEqual(before);
  }
  const accepted = await ops.lessonDecide(f.dir, f.proposal.name, disposition(proposed), f.ctx, f.env);
  expect(accepted).toMatchObject({state: "accepted", exportable: true, disposition: {actor: f.ctx.actor, acknowledgeStrength: FIXTURE_LESSON_STRENGTH, proposalSha256: proposed.sha256, evidenceFingerprint: proposed.evidenceFingerprint}});
  expect((await ops.lessonCheck(f.dir, f.proposal.name, f.ctx, f.env)).acceptReady).toBe(false);
  expect(candidateNote(accepted)).toMatchObject({kind: "fail", text: expect.stringContaining(FIXTURE_LESSON_STRENGTH)});
  expect(f.transport.requests).toEqual([]); expect(existsSync(join(f.dir, "runs"))).toBe(false);
});
test("no-lesson and rejected/withdrawn outcomes remain valid, with no automatic export", async () => {
  const f = await lessonFixture(), none = await acceptedLesson(f, {...f.proposal, name: "no-lesson", kind: "no-lesson", change: [], behavior: [], procedure: []});
  expect(none.state).toBe("accepted"); expect(none.exportable).toBe(false); expect(candidateNote(none)).toBeNull();
  const p = await ops.lessonPropose(f.dir, f.proposal, f.ctx, f.env);
  const rejected = await ops.lessonDecide(f.dir, p.proposal.name, {...disposition(p), decision: "reject"}, f.ctx, f.env);
  expect(rejected.state).toBe("rejected"); expect(rejected.exportable).toBe(false);
  await expect(ops.lessonDecide(f.dir, p.proposal.name, disposition(p), f.ctx, f.env)).rejects.toThrow("final");
  const a = await acceptedLesson(f, {...f.proposal, name: "withdraw-me"});
  const withdrawn = await ops.lessonDecide(f.dir, a.proposal.name, {...disposition(a), decision: "withdraw"}, f.ctx, f.env);
  expect(withdrawn.state).toBe("withdrawn"); expect(ops.lessonList(f.dir).every(row => !row.exportable)).toBe(true);
});
test("current closure, exact changes and behavior hashes are required before proposal write", async () => {
  const f = await lessonFixture(), before = lessonLedger(f.dir);
  for (const raw of [{...f.proposal, closureSha256: "f".repeat(64)}, {...f.proposal, change: [{...f.proposal.change[0], sha256: "f".repeat(64)}]}, {...f.proposal, behavior: [{...f.proposal.behavior[0], projectionSha256: "f".repeat(64)}]}, {...f.proposal, kind: "success"}, {...f.proposal, matched: true}]) {
    await expect(ops.lessonPropose(f.dir, raw, f.ctx, f.env)).rejects.toThrow("lesson"); expect(lessonLedger(f.dir)).toEqual(before); expect(existsSync(join(f.dir, "proposals", "lessons.json"))).toBe(false);
  }
});
test("stale evidence removes acceptance and export readiness without rewriting historical disposition", async () => {
  const f = await lessonFixture(), accepted = await acceptedLesson(f), old = lessonLedger(f.dir);
  await ops.harnessSet(f.dir, {...f.definition, hypothesis: {deficiency: "Changed synthetic input", predictedChange: "Recheck"}}, f.ctx);
  expect(ops.lessonList(f.dir)[0]).toMatchObject({state: "accepted", current: false, exportable: false, disposition: accepted.disposition});
  expect((await ops.lessonCheck(f.dir, f.proposal.name, f.ctx, f.env)).state).toBe("changed");
  expect(readLedger(f.dir).filter(event => event.type === "lesson.decided")).toHaveLength(1); expect(lessonLedger(f.dir).subarray(0, old.length)).toEqual(old);
});
test("privacy, exact shapes and 16KiB bounds refuse before any proposal or approval is written", async () => {
  const f = await lessonFixture(), before = lessonLedger(f.dir);
  for (const raw of [{...f.proposal, summary: "https://example.invalid/private"}, {...f.proposal, failure: "credential=synthetic-value"}, {...f.proposal, summary: "ghp_" + "s".repeat(40)}, {...f.proposal, procedure: Array(16).fill("x".repeat(1000))}, {...f.proposal, limitations: null}, {...f.proposal, inspections: []}, {...f.proposal, v: 99}, {...f.proposal, counterevidence: [{v: 1, tool: "ares", projectKey: "another-study", kind: "study", id: "another-study"}]}]) {
    await expect(ops.lessonPropose(f.dir, raw, f.ctx, f.env)).rejects.toThrow("lesson"); expect(lessonLedger(f.dir)).toEqual(before);
  }
});
test("64 proposals per study are bounded before a 65th write", async () => {
  const f = await lessonFixture();
  for (let i = 0; i < 64; i++) await ops.lessonPropose(f.dir, {...f.proposal, kind: "no-lesson", name: `lesson-${i}`, procedure: [], behavior: [], change: []}, f.ctx, f.env);
  const before = lessonLedger(f.dir); await expect(ops.lessonPropose(f.dir, {...f.proposal, name: "lesson-overflow"}, f.ctx, f.env)).rejects.toThrow("64-proposal"); expect(lessonLedger(f.dir)).toEqual(before); expect(ops.lessonList(f.dir)).toHaveLength(64);
});
test("unavailable counterevidence cannot disappear at review or archive preflight", async () => {
  const f = await lessonFixture(), id = "a".repeat(32), transport = screenedLessonRunner(() => ({id, kind: "finding", project: "synthetic", at: "2030-01-01T00:00:00Z", text: "Synthetic counterexample"}));
  const ctx = {...f.ctx, runner: transport.runner}, p = await ops.lessonPropose(f.dir, {...f.proposal, counterevidence: [{v: 1, tool: "amem", id}]}, ctx, f.env);
  const deny = screenedLessonRunner(() => null), before = lessonLedger(f.dir);
  await expect(ops.lessonDecide(f.dir, p.proposal.name, disposition(p), {...ctx, runner: deny.runner}, f.env)).rejects.toThrow("counterevidence"); expect(lessonLedger(f.dir)).toEqual(before);
  const accepted = await ops.lessonDecide(f.dir, p.proposal.name, disposition(p), ctx, f.env); expect(accepted.exportable).toBe(true);
  const preview = await ops.archive(f.dir, {}, ctx, f.env);
  await expect(ops.archive(f.dir, {confirm: preview.fingerprint}, {...ctx, runner: deny.runner}, f.env, undefined, {runner: deny.runner, env: f.env})).rejects.toThrow("counterevidence");
  expect(lessonLedger(f.dir).toString()).not.toContain('"type":"archive.exported"');
});
test("future/corrupt proposal index is never repaired and forged reviewed decisions fail replay", async () => {
  const f = await lessonFixture(), p = await ops.lessonPropose(f.dir, f.proposal, f.ctx, f.env), path = join(f.dir, "proposals", "lessons.json"), valid = readTextBounded(path, 1_048_576);
  for (const raw of [{v: 99, proposals: []}, {v: 1, proposals: []}]) {
    writeAtomic(path, JSON.stringify(raw), 1_048_576); const before = lessonLedger(f.dir);
    expect(() => ops.lessonList(f.dir)).toThrow("lesson"); expect(readTextBounded(path, 1_048_576)).toBe(JSON.stringify(raw)); expect(lessonLedger(f.dir)).toEqual(before);
  }
  writeAtomic(path, valid, 1_048_576);
  const body = {...disposition(p), inspections: p.proposal.inspections, acknowledgeStrength: "fixture is success"};
  appendEvent(f.dir, f.ctx.actor, "lesson.decided", {v: 1, name: p.proposal.name, ...body, sha256: sha256(canonical({...body, actor: f.ctx.actor}))});
  expect(() => ops.lessonList(f.dir)).toThrow("strength acknowledgement");
});
test("one accepted lesson enters the existing archive fingerprint and receipt path with explicit fixture text", async () => {
  const f = await lessonFixture(), p = await acceptedLesson(f), preview = await ops.archive(f.dir, {}, f.ctx, f.env), note = candidateNote(p)!;
  expect(preview.notes.map(row => row.note)).toContainEqual(note); expect(preview.recovery).toContain("Receipt-only");
  const writes: string[] = [], ctx = {...f.ctx, runner: async (req: import("../src/exp/executor.ts").ProcessRequest) => {writes.push(Buffer.from(req.stdin as Uint8Array).toString()); return {exitCode: 0, stdout: JSON.stringify({id: "a".repeat(32)}), stderr: ""};}};
  const exported = await ops.archive(f.dir, {confirm: preview.fingerprint}, ctx, f.env); expect("written" in exported && exported.written).toHaveLength(preview.notes.length);
  expect(writes).toContain(note.text); expect(writes.every(text => text.includes(FIXTURE_LESSON_STRENGTH))).toBe(true);
  const before = lessonLedger(f.dir), repeated = await ops.archive(f.dir, {confirm: preview.fingerprint}, ctx, f.env);
  expect("written" in repeated && repeated.written).toEqual([]); expect(lessonLedger(f.dir)).toEqual(before);
  expect(readLedger(f.dir).filter(event => event.type === "archive.exported")).toHaveLength(1);
  expect(openStudy(f.dir).study.mode).toBe("experiment");
});
