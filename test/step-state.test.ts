import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { appendEvent } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const definition = { v: 1, nodes: [{ id: "first", kind: "step", command: "lit.bib", args: {} }, { id: "second", kind: "step", command: "lit.bib", args: {}, needs: ["first"] }], edges: [] };
async function fixture() {
  const dir = join(tempDir(), "study"); ops.init(dir, { question: "Synthetic step replay", autonomy: "step" }, ctx);
  await ops.planSet(dir, definition, ctx);
  await ops.planControl(dir, { action: "resume", commandId: "resume-initial", expectedRevision: 1 }, ctx);
  return dir;
}
const event = (dir: string, type: string, data: Record<string, unknown>) => appendEvent(dir, actor, type, { revision: 1, node: "first", ...data });
const intent = (dir: string, dispatchId: string) => event(dir, "node.intent", { dispatchId });
const done = (dir: string, dispatchId: string) => event(dir, "node.observed", { dispatchId, status: "done", output: { sha256: "synthetic" } });
const pause = (dir: string, dispatchId: unknown, extra: Record<string, unknown> = {}) => event(dir, "plan.paused", { dispatchId, reason: "step", ...extra });

test("step pause correlates with the accepted dispatch and cannot be replayed after resume", async () => {
  const dir = await fixture(); intent(dir, "old"); event(dir, "node.observed", { dispatchId: "old", status: "uncertain" });
  await ops.planControl(dir, { action: "retry", node: "first", commandId: "retry", expectedRevision: 1 }, ctx);
  intent(dir, "current"); done(dir, "current");
  for (const [dispatch, extra] of [["old", {}], ["current", { revision: 3 }], ["current", { node: "missing" }], [null, {}]] as const) {
    pause(dir, dispatch, extra);
    expect(ops.planShow(dir).state).toBe("running"); expect(ops.planShow(dir).pauseReason).toBeUndefined();
  }
  pause(dir, "current"); expect(ops.planShow(dir)).toMatchObject({ state: "paused", pauseReason: "step" });
  const bytes = readFileSync(join(dir, "ledger.jsonl")); ops.planShow(dir); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(bytes);
  await ops.planControl(dir, { action: "resume", commandId: "resume-next", expectedRevision: 1 }, ctx);
  pause(dir, "current"); expect(ops.planShow(dir).state).toBe("running"); expect(ops.planShow(dir).pauseReason).toBeUndefined();
});

test("retained dispatch completion and step pause survive an unchanged definition revision", async () => {
  const dir = await fixture(); intent(dir, "retained"); await ops.planSet(dir, definition, ctx);
  await ops.planControl(dir, { action: "resume", commandId: "resume-revision", expectedRevision: 2 }, ctx);
  done(dir, "retained"); pause(dir, "retained");
  expect(ops.planShow(dir)).toMatchObject({ revision: 2, state: "paused", pauseReason: "step" });
  expect(ops.planShow(dir).nodes[0]!.status).toBe("done");
});

test("a stale dispatch cannot set step pause after its consumed definition changes", async () => {
  const dir = await fixture(); intent(dir, "stale");
  await ops.planSet(dir, { ...definition, nodes: [{ ...definition.nodes[0], command: "lit.verify", args: { ids: [] } }, definition.nodes[1]] }, ctx);
  await ops.planControl(dir, { action: "resume", commandId: "resume-stale", expectedRevision: 2 }, ctx);
  done(dir, "stale"); pause(dir, "stale", { revision: 2 });
  expect(ops.planShow(dir).state).toBe("running"); expect(ops.planShow(dir).pauseReason).toBeUndefined();
  expect(ops.planShow(dir).nodes[0]!.status).toBe("stale");
});
