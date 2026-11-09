import {expect, test} from "bun:test";
import {join} from "node:path";
import {ARES_TOOLS, createAresMcp} from "../src/mcp-tools.ts";
import {validArguments} from "../src/mcp.ts";
import {run} from "../src/cli.ts";
import * as ops from "../src/commands.ts";
import {candidateNote} from "../src/harness/lesson-candidates.ts";
import {readTextBounded, readLedger, openStudy} from "../src/study.ts";
import type {ProcessRunner} from "../src/exp/executor.ts";
import {canonical} from "../src/plan/state.ts";
import {fakeRunner} from "./helpers.ts";
import {lessonFixture, acceptedLesson, screenedLessonRunner, lessonIdentity} from "./lesson-fixtures.ts";
async function archived(withLocalCounterevidence = false, model = lessonIdentity.model, amemCounterevidence = false, tasks?: string[]) {
  const f = await lessonFixture(true, model, tasks), studyId = openStudy(f.dir).study.id;
  const counter = screenedLessonRunner(id => ({id, kind: "finding", text: "Synthetic counterevidence", at: "2030-01-01T00:00:00Z", project: "synthetic-project"}));
  const accepted = await acceptedLesson(amemCounterevidence ? {...f, ctx: {...f.ctx, runner: counter.runner}} : f, {...f.proposal, ...(withLocalCounterevidence ? {counterevidence: [{v: 1, tool: "ares", projectKey: studyId, kind: "study", id: studyId}]} : {}), ...(amemCounterevidence ? {counterevidence: [{v: 1, tool: "amem", id: "a".repeat(32)}]} : {})}), note = candidateNote(accepted)!;
  const preview = await ops.archive(f.dir, {}, f.ctx, f.env);
  const index = preview.notes.findIndex(row => canonical(row.note) === canonical(note)); expect(index).toBeGreaterThanOrEqual(0);
  const ids = preview.notes.map((_, i) => (i + 1).toString(16).padStart(32, "0")), transport = fakeRunner(ids.map(id => ({exitCode: 0, stdout: JSON.stringify({id, kind: note.kind}), stderr: ""})));
  await ops.archive(f.dir, {confirm: preview.fingerprint}, {...f.ctx, runner: transport.runner}, f.env, undefined, amemCounterevidence ? {runner: counter.runner, env: f.env} : undefined);
  const id = ids[index]!, view = {id, kind: note.kind, text: note.text, at: "2030-01-01T00:00:00Z", project: "synthetic-project"};
  const screened = screenedLessonRunner(() => view), ctx = {...f.ctx, runner: screened.runner};
  const request = {v: 1, round: "round-later", taskId: "task-later", condition: "prior-experience", ...lessonIdentity, model, selected: [{id, reason: "Earlier synthetic procedure within the same stream"}]};
  return {...f, accepted, note, id, view, screened, ctx, request};
}
const durable = (dir: string) => ["ledger.jsonl", "design/harness-experience.json"].map(name => readTextBounded(join(dir, name), 1_048_576)).join("\n");
test("accepted archived earlier same-study fixture lesson freezes identities and serves only transient screened context", async () => {
  const f = await archived(), frozen = await ops.experienceFreeze(f.dir, f.request, f.ctx, f.env), before = durable(f.dir);
  expect(frozen).toMatchObject({sourceStrength: "synthetic-fixture", transfer: "not-demonstrated", entries: [{id: f.id, lesson: f.proposal.name, lessonSha256: f.accepted.sha256, closureSha256: f.proposal.closureSha256, sourceStrength: "synthetic-fixture", transfer: "not-demonstrated"}]});
  const checked = await ops.experienceCheck(f.dir, f.request.round, lessonIdentity, f.ctx, f.env);
  expect(checked).toMatchObject({state: "available", context: f.note.text, sourceStrength: "synthetic-fixture", transfer: "not-demonstrated", prepareOnly: true, workerContext: "baseline-only"});
  expect(checked.context).toContain("synthetic-fixture; not evidence of real agent behavior"); expect(checked.bytes).toBe(Buffer.byteLength(f.note.text));
  expect(f.screened.ids.length).toBeGreaterThan(0); expect(f.screened.ids.every(id => id === f.id)).toBe(true);
  expect(durable(f.dir)).toBe(before); expect(before).not.toContain(JSON.stringify(f.note.text)); expect(before).not.toContain('"text":');
  const snapshots = readLedger(f.dir).filter(event => event.type === "experience.frozen").map(event => event.data.snapshot);
  expect(JSON.stringify(snapshots)).not.toContain('"context":'); expect(JSON.stringify(snapshots)).not.toContain('"body":');
  expect(f.transport.requests).toEqual([]);
});
test("valid controlled-lane source declarations cannot promote frozen synthetic fixture context", async () => {
  const f = await archived(), frozen = await ops.experienceFreeze(f.dir, f.request, f.ctx, f.env), before = durable(f.dir);
  const sourceRef = {v: 1, tool: "ahub", projectKey: "synthetic-hub-project", kind: "guidance-probe", id: "synthetic-authoring-receipt", revision: "1", sha256: "b".repeat(64)};
  await expect(ops.harnessSet(f.dir, {...f.definition, id: f.request.round, task: {id: f.request.taskId, inputSha256: "d".repeat(64)}, authoring: "controlled-lane", sourceExecutions: {proposal1: sourceRef}, context: {streamSha256: frozen.streamSha256, improverContextHash: frozen.improverContextHash}}, f.ctx)).rejects.toThrow("controlled-lane refuses synthetic-fixture context");
  expect(durable(f.dir)).toBe(before);
});
for (const condition of ["denied", "forgotten", "changed-digest", "changed-version", "superseded", "withdrawn", "stale"] as const) test(`frozen chain ${condition} refuses handoff without durable writes or context`, async () => {
  const f = await archived(); await ops.experienceFreeze(f.dir, f.request, f.ctx, f.env);
  if (condition === "withdrawn") await ops.lessonDecide(f.dir, f.proposal.name, {decision: "withdraw", proposalSha256: f.accepted.sha256, evidenceFingerprint: f.accepted.evidenceFingerprint, reason: "Synthetic withdrawal"}, f.ctx, f.env);
  if (condition === "stale") await ops.harnessSet(f.dir, {...f.definition, hypothesis: {deficiency: "Synthetic revised omission", predictedChange: "Synthetic new check"}}, f.ctx);
  const screen = screenedLessonRunner(() => condition === "forgotten" ? null : condition === "denied" ? {source: "capture", evidence: false, capture: {id: f.id}} : {...f.view, ...(condition === "changed-digest" ? {text: f.note.text + " changed"} : {}), ...(condition === "superseded" ? {stale: true} : {})}, condition === "changed-version" ? "0.23.0" : "0.22.1");
  const runner: ProcessRunner = request => screen.runner(condition !== "denied" ? request : {...request, stdoutSink: async chunk => {
    const frame = JSON.parse(Buffer.from(chunk).toString());
    if (frame.result?.content) frame.result = {isError: true, content: [{type: "text", text: "Synthetic privacy refusal"}]};
    await request.stdoutSink!(Buffer.from(JSON.stringify(frame) + "\n"));
  }});
  const ctx = {...f.ctx, runner};
  const before = durable(f.dir), checked = await ops.experienceCheck(f.dir, f.request.round, lessonIdentity, ctx, f.env);
  expect(checked).toMatchObject({state: "unavailable", context: null, bytes: 0}); expect(checked.nextStep).toContain("Restore the exact screened source"); expect(durable(f.dir)).toBe(before); expect(JSON.stringify(checked)).not.toContain(f.note.text);
});
for (const field of ["model", "runtime", "toolsetSha256"] as const) test(`incompatible ${field} cannot freeze or receive the archived lesson`, async () => {
  const f = await archived(), incompatible = {...lessonIdentity, [field]: field === "model" ? "other-model" : "f".repeat(64)}, before = durable(f.dir);
  await expect(ops.experienceFreeze(f.dir, {...f.request, ...incompatible}, f.ctx, f.env)).rejects.toThrow("experience"); expect(durable(f.dir)).toBe(before);
  await ops.experienceFreeze(f.dir, f.request, f.ctx, f.env); const frozen = durable(f.dir);
  expect(await ops.experienceCheck(f.dir, f.request.round, incompatible, f.ctx, f.env)).toMatchObject({state: "unavailable", context: null, bytes: 0}); expect(durable(f.dir)).toBe(frozen);
});

test("local counterevidence changing during screened amem read blocks the same handoff", async () => {
  const f = await archived(true); await ops.experienceFreeze(f.dir, f.request, f.ctx, f.env);
  let changed = false;
  const runner: ProcessRunner = request => f.screened.runner({...request, stdoutSink: async chunk => {
    const frame = JSON.parse(Buffer.from(chunk).toString());
    if (frame.id === 3 && !changed) {await ops.autonomySet(f.dir, "gates", undefined, f.ctx); changed = true;}
    await request.stdoutSink!(chunk);
  }});
  const checked = await ops.experienceCheck(f.dir, f.request.round, lessonIdentity, {...f.ctx, runner}, f.env);
  expect(changed).toBe(true); expect(openStudy(f.dir).study.autonomy).toBe("gates");
  expect(checked).toMatchObject({state: "unavailable", context: null, bytes: 0}); expect(checked.nextStep).toContain("Restore the exact screened source");
  const before = durable(f.dir), next = await ops.experienceCheck(f.dir, f.request.round, lessonIdentity, f.ctx, f.env);
  expect(next).toMatchObject({state: "unavailable", context: null, bytes: 0}); expect(durable(f.dir)).toBe(before);
});

for (const field of ["model", "runtime", "toolsetSha256"] as const) test(`ineligible ${field} skips counterevidence and selected exact-id reads`, async () => {
  const f = await archived(false, lessonIdentity.model, true), blocked = fakeRunner([]), ctx = {...f.ctx, runner: blocked.runner};
  const incompatible = {...lessonIdentity, [field]: field === "model" ? "other-model" : "f".repeat(64)}, before = durable(f.dir);
  await expect(ops.experienceFreeze(f.dir, {...f.request, ...incompatible}, ctx, f.env)).rejects.toThrow("nonempty experience unavailable");
  expect(blocked.requests).toEqual([]); expect(durable(f.dir)).toBe(before);
  const search = fakeRunner([{exitCode: 0, stdout: "[]", stderr: ""}]);
  expect(await ops.experienceSelect(f.dir, {...f.request, ...incompatible}, {...ctx, runner: search.runner}, f.env)).toMatchObject({state: "unavailable", eligible: false});
  expect(search.requests.map(value => value.args[0])).toEqual(["search"]);
});
for (const position of ["current", "future"] as const) test(`${position}-task lesson selection refuses before counterevidence reads`, async () => {
  const tasks = position === "future" ? ["task-later", "synthetic-task", "task-last"] : undefined;
  const f = await archived(false, lessonIdentity.model, true, tasks), raw = {...f.request, taskId: position === "current" ? "synthetic-task" : "task-later"};
  const before = durable(f.dir), transport = fakeRunner([{exitCode: 0, stdout: "[]", stderr: ""}]);
  expect(await ops.experienceSelect(f.dir, raw, {...f.ctx, runner: transport.runner}, f.env)).toMatchObject({state: "unavailable", eligible: false});
  expect(transport.requests.map(value => value.args[0])).toEqual(["search"]); expect(durable(f.dir)).toBe(before);
  if (position === "future") {
    const blocked = fakeRunner([]); await expect(ops.experienceFreeze(f.dir, raw, {...f.ctx, runner: blocked.runner}, f.env)).rejects.toThrow("nonempty experience unavailable");
    expect(blocked.requests).toEqual([]); expect(durable(f.dir)).toBe(before);
  }
});
test("incompatible handoff identity refuses locally before any source read", async () => {
  const f = await archived(false, lessonIdentity.model, true);
  const counter = screenedLessonRunner(id => id === "a".repeat(32) ? {id, kind: "finding", text: "Synthetic counterevidence", at: "2030-01-01T00:00:00Z", project: "synthetic-project"} : f.view);
  await ops.experienceFreeze(f.dir, f.request, {...f.ctx, runner: counter.runner}, f.env);
  const blocked = fakeRunner([]), before = durable(f.dir);
  expect(await ops.experienceCheck(f.dir, f.request.round, {...lessonIdentity, model: "other-model"}, {...f.ctx, runner: blocked.runner}, f.env)).toMatchObject({state: "unavailable", context: null, bytes: 0});
  expect(blocked.requests).toEqual([]); expect(durable(f.dir)).toBe(before);
});
test("200-byte fixture model survives lesson, select, freeze and CLI/MCP check", async () => {
  const model = "m".repeat(200), f = await archived(false, model), identity = {...lessonIdentity, model};
  expect(f.accepted.proposal.compatibility?.model).toBe(model);
  expect(await ops.experienceSelect(f.dir, f.request, f.ctx, f.env)).toMatchObject({state: "available", eligible: true});
  const frozen = await ops.experienceFreeze(f.dir, f.request, f.ctx, f.env); expect(frozen.model).toBe(model); expect(frozen.entries[0]?.model).toBe(model);
  const checked = JSON.parse((await run(["experience", "check", f.dir, f.request.round, "--model", model, "--runtime", identity.runtime, "--toolset-sha256", identity.toolsetSha256, "--json"], f.env, f.ctx)).text);
  expect(checked).toMatchObject({state: "available", model, context: f.note.text});
  const tool = ARES_TOOLS.find(tool => tool.name === "ares_experience_check")!, args = {study: f.dir, round: f.request.round, ...identity};
  expect(validArguments(args, tool.inputSchema)).toBe(true);
  expect(await createAresMcp(f.env, f.ctx.http, f.ctx).handlers.ares_experience_check!(args)).toMatchObject({state: "available", model, context: f.note.text});
  expect(validArguments({...args, model: "m".repeat(257)}, tool.inputSchema)).toBe(false);
});
