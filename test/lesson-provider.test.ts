import {expect, test} from "bun:test";
import {realpathSync} from "node:fs";
import {join} from "node:path";
import {createPlugin} from "../src/ui/plugin.ts";
import {addStudy} from "../src/console/registry.ts";
import * as ops from "../src/commands.ts";
import {lessonFixture, acceptedLesson, lessonLedger} from "./lesson-fixtures.ts";
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
