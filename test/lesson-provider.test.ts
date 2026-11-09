import {expect, test} from "bun:test";
import {realpathSync} from "node:fs";
import {join} from "node:path";
import {createPlugin} from "../src/ui/plugin.ts";
import {addStudy} from "../src/console/registry.ts";
import {archiveExportBatch} from "../src/memory/archive.ts";
import * as ops from "../src/commands.ts";
import {lessonFixture, acceptedLesson, lessonLedger, screenedLessonRunner} from "./lesson-fixtures.ts";
test("explicit harness producer panel delegates stored lesson rows and unchanged polling never checks sources or writes", async () => {
  const f = await lessonFixture(), accepted = await acceptedLesson(f), family = join(realpathSync(f.home), "family"), dir = realpathSync(f.dir); addStudy(family, dir);
  const before = lessonLedger(f.dir), runtime = {...f.ctx, env: f.env, runner: async () => {throw new Error("source process forbidden during console polling");}};
  const provider = await createPlugin(runtime).open({home: family, log: () => {}, features: []});
  const first = await provider.snapshot({panel: "harness", study: dir, round: f.proposal.round, after: 0});
  expect(first.error).toBeUndefined(); expect(first.lessonCandidates).toEqual([accepted]); expect(first.remainingLessonCandidates).toBe(0);
  const second = await provider.snapshot({panel: "harness", study: dir, round: f.proposal.round, after: first.cursor as number});
  expect(second.changed).toBe(false);
  const normal = await provider.snapshot({panel: "study", study: dir, after: 0}); expect(normal.lessonCandidates).toBeUndefined();
  expect(ops.lessonList(f.dir)[0]).toEqual(accepted); expect(lessonLedger(f.dir)).toEqual(before); expect(f.transport.requests).toEqual([]);
});

test("console archive preview counts the actual source-bounded export prefix", async () => {
  const f = await lessonFixture(), screen = screenedLessonRunner(id => ({id, kind: "finding", project: "synthetic", at: "2030-01-01T00:00:00Z", text: "Synthetic counterevidence"}));
  const checked = {...f, ctx: {...f.ctx, runner: screen.runner}};
  for (let i = 0; i < 4; i++) await acceptedLesson(checked, {...f.proposal, name: `lesson-${i}`, counterevidence: Array.from({length: 16}, (_, j) => ({v: 1, tool: "amem", id: (i * 16 + j + 1).toString(16).padStart(32, "0")}))});
  const archive = await ops.archive(f.dir, {}, f.ctx, f.env), batch = archiveExportBatch(f.dir, archive.notes);
  expect(archive.notes).toHaveLength(4); expect(batch).toHaveLength(3);
  const family = join(realpathSync(f.home), "family"), dir = realpathSync(f.dir); addStudy(family, dir);
  const provider = await createPlugin({env: f.env, runner: async () => {throw new Error("source read forbidden during preview");}}).open({home: family, log: () => {}, features: []});
  const before = lessonLedger(f.dir), preview = await provider.action({action: "archive.confirm", study: dir});
  expect(preview).toMatchObject({needsConfirm: true, preview: expect.arrayContaining(["Export 3 of 4 pending lesson(s) to amem"])}); expect(lessonLedger(f.dir)).toEqual(before);
  const writes: string[] = [], runner: import("../src/exp/executor.ts").ProcessRunner = async request => {writes.push(request.args[0]!); return {exitCode: 0, stdout: JSON.stringify({id: (writes.length + 100).toString(16).padStart(32, "0")}), stderr: ""};};
  const exported = await ops.archive(f.dir, {confirm: archive.fingerprint}, {...f.ctx, runner}, f.env, undefined, {runner: screen.runner, env: f.env});
  expect("written" in exported && exported.written).toHaveLength(batch.length); expect(writes).toHaveLength(3); expect("remaining" in exported && exported.remaining).toBe(1);
});
