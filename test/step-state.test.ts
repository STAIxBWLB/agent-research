import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
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
const done = (dir: string, dispatchId: string) => event(dir, "node.observed", { dispatchId, status: "done", step: true, output: { sha256: "synthetic" } });
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

test("last step outcomes end done or failed without pause, and explicit retry can recover", async () => {
  for (const status of ["done", "failed", "cancelled", "uncertain"] as const) {
    const dir = join(tempDir(), "study"); ops.init(dir, { question: "Synthetic final boundary", autonomy: "step" }, ctx);
    await ops.planSet(dir, { ...definition, nodes: [definition.nodes[0]] }, ctx);
    await ops.planControl(dir, { action: "resume", commandId: "start", expectedRevision: 1 }, ctx);
    intent(dir, "final"); event(dir, "node.observed", { dispatchId: "final", status, step: true, ...(status === "done" ? { output: { sha256: "synthetic" } } : {}) });
    const expected = status === "done" ? "done" : "failed";
    expect(ops.planShow(dir).state).toBe(expected); expect(ops.planShow(dir).pauseReason).toBeUndefined();
    const repeated = await ops.planControl(dir, { action: "resume", commandId: "not-needed", expectedRevision: 1 }, ctx);
    expect(repeated.state).toBe(expected);
    await ops.planControl(dir, { action: "retry", commandId: "retry-final", node: "first", expectedRevision: 1 }, ctx);
    expect(ops.planShow(dir).state).toBe("paused");
    await ops.planControl(dir, { action: "resume", commandId: "restart-final", expectedRevision: 1 }, ctx);
    expect(ops.planShow(dir).state).toBe("running");
  }
});

test("non-step terminal failures retain the earlier recovery behavior", async () => {
  const dir = join(tempDir(), "study"); ops.init(dir, { question: "Synthetic legacy failure", autonomy: "gates" }, ctx);
  await ops.planSet(dir, { ...definition, nodes: [definition.nodes[0]] }, ctx);
  await ops.planControl(dir, { action: "resume", commandId: "start", expectedRevision: 1 }, ctx);
  intent(dir, "legacy"); event(dir, "node.observed", { dispatchId: "legacy", status: "failed" });
  expect(ops.planShow(dir).state).toBe("running"); expect(ops.planShow(dir).pauseReason).toBeUndefined();
});

test("a step hub binding conflict reaches failed terminal state without corrupting the fold", async () => {
  const dir = join(tempDir(), "study"); ops.init(dir, { question: "Synthetic hub failure", autonomy: "step" }, ctx);
  await ops.planSet(dir, { v: 1, nodes: [{ id: "first", kind: "hub", campaign: "synthetic", unit: "unit", needs: [] }], edges: [] }, ctx);
  await ops.planControl(dir, { action: "resume", commandId: "start", expectedRevision: 1 }, ctx);
  event(dir, "node.intent", { dispatchId: "bound", taskId: 1 });
  event(dir, "node.observed", { dispatchId: "bound", status: "dispatched", taskId: 2, step: true });
  const state = ops.planShow(dir);
  expect(state.state).toBe("failed"); expect(state.nodes[0]!.status).toBe("failed");
  expect(state.nodes[0]!.reason).toContain("binding changed");
  expect(state.pauseReason).toBeUndefined();
});

test("production CLI returns nonzero for a failed final step without waiting for acknowledgement", async () => {
  const home = tempDir(), dir = join(home, "study");
  ops.init(dir, { question: "Synthetic CLI step failure", autonomy: "step" }, ctx);
  await ops.planSet(dir, { v: 1, nodes: [{ id: "first", kind: "step", command: "cite.check", args: { draft: "missing.md" } }], edges: [] }, ctx);
  let resumed = false, sleeps = 0;
  const result = await run(["run", dir, "--json"], { HOME: home, AGENTHUB_HOME: join(home, "family") }, { http: ctx.http, sleep: async () => {
    if (++sleeps > 20) throw new Error("synthetic final step did not terminate");
    if (!resumed) { resumed = true; await ops.planControl(dir, { action: "resume", commandId: "start", expectedRevision: 1 }, ctx); }
    await new Promise<void>(resolve => setImmediate(resolve));
  } });
  expect(result.code).toBe(1); expect(JSON.parse(result.text).state).toBe("failed");
  expect(ops.planShow(dir).pauseReason).toBeUndefined();
});

test("a prior step outcome cannot finish a cancelled replacement dispatch", async () => {
  const dir = await fixture(); intent(dir, "old"); done(dir, "old"); pause(dir, "old");
  await ops.planControl(dir, { action: "retry", commandId: "retry-old", node: "first", expectedRevision: 1 }, ctx);
  await ops.planControl(dir, { action: "resume", commandId: "resume-replacement", expectedRevision: 1 }, ctx);
  intent(dir, "replacement");
  await ops.planControl(dir, { action: "cancel", commandId: "cancel-replacement", node: "first", expectedRevision: 1 }, ctx);
  const current = ops.planShow(dir);
  expect(current.pauseReason).toBe("step");
  pause(dir, "old");
  expect(ops.planShow(dir)).toEqual(current);
  expect(ops.planShow(dir).nodes[0]!.stepCancellation?.dispatchId).toBe("replacement");
  expect(ops.planShow(dir).nodes[0]!.status).toBe("cancelled");
  expect(ops.planShow(dir).nodes[0]!.dispatchId).toBeUndefined();
});
