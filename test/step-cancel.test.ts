import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { runPlan } from "../src/plan/controller.ts";
import { appendEvent, readLedger, StudyLockBusyError } from "../src/study.ts";
import { fakeHttp, fakeRunner, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
async function fixture(mode = "step", remaining = true) {
  const home = tempDir(), dir = join(home, "study"); ops.init(dir, { question: "Synthetic controlled step cancellation", autonomy: mode }, ctx);
  await ops.planSet(dir, { v: 1, nodes: [{ id: "remote", kind: "hub", campaign: "synthetic", unit: "unit" }, ...(remaining ? [{ id: "next", kind: "step", command: "lit.bib", args: {} }] : [])], edges: [] }, ctx);
  return { dir, home };
}
async function control(dir: string, action: "resume" | "cancel", commandId: string) {
  for (let attempt = 0; ; attempt++) {
    try { return await ops.planControl(dir, { action, commandId, expectedRevision: ops.planShow(dir).revision, ...(action === "cancel" ? { node: "remote" } : {}) }, ctx); }
    catch (error) { if (!(error instanceof StudyLockBusyError) || attempt >= 9) throw error; await new Promise<void>(resolve => setImmediate(resolve)); }
  }
}

test("cancelled step hub consumes its resume boundary before an independent effect starts", async () => {
  const { dir } = await fixture(), stop = new AbortController(); let started = false, cancelled = false, resumed = false, quiet = 0, executions = 0, sleeps = 0;
  const chunks: string[] = [], append = fs.appendFileSync;
  const spy = spyOn(fs, "appendFileSync").mockImplementation(((file, data, options) => { if (String(file) === join(dir, "ledger.jsonl")) chunks.push(String(data)); return append(file, data, options); }) as typeof fs.appendFileSync);
  try {
    const result = await runPlan(dir, { parallel: 3 }, { actor, signal: stop.signal, prepare: async () => ({}), execute: async () => { executions++; return { status: "done", output: { sha256: "synthetic" } }; }, reconcile: async () => { throw new Error("unexpected reconcile"); }, hub: { observe: async () => ({ status: "dispatched", taskId: 1 }) }, sleep: async () => {
      if (++sleeps > 30) { stop.abort(); throw new Error("cancellation boundary missing"); }
      if (!started) { started = true; await control(dir, "resume", "start"); return; }
      if (!cancelled) {
        expect(ops.planShow(dir).nodes[0]!.status).toBe("dispatched"); cancelled = true;
        const cancel = await control(dir, "cancel", "cancel"); expect(cancel.state).toBe("paused"); return;
      }
      if (!resumed) {
        expect(ops.planShow(dir)).toMatchObject({ state: "paused", pauseReason: "step" });
        expect(executions).toBe(0); expect(readLedger(dir).filter(event => event.type === "node.intent")).toHaveLength(1);
        if (++quiet >= 2) { resumed = true; await control(dir, "resume", "next"); }
      }
      await new Promise<void>(resolve => setImmediate(resolve));
    } });
    expect(result.state).toBe("failed"); expect(executions).toBe(1);
    const pair = chunks.map(text => text.trim().split("\n").map(line => JSON.parse(line))).find(events => events.some(event => event.type === "plan.control" && event.data.request.commandId === "cancel"))!;
    expect(pair.map(event => event.type)).toEqual(["plan.control", "plan.paused"]);
    expect(pair[1].data).toMatchObject({ reason: "step", node: "remote", dispatchId: pair[0].data.stepCancel, commandId: "cancel", revision: 1 });
  } finally { stop.abort(); spy.mockRestore(); }
});

test("CLI/MCP step cancellation return the same paused result, replay is inert and non-step stays unchanged", async () => {
  let expected: unknown;
  for (const channel of ["cli", "mcp"] as const) {
    const { dir, home } = await fixture(); await control(dir, "resume", "start");
    appendEvent(dir, actor, "node.intent", { revision: 1, node: "remote", dispatchId: "synthetic-dispatch", taskId: 1 });
    const env = { HOME: home, AGENTHUB_HOME: join(home, "family") }, fake = fakeRunner([]), server = createAresMcp(env, ctx.http, { runner: fake.runner });
    const request = { action: "cancel", node: "remote", commandId: "cancel", expectedRevision: 1 };
    const value = channel === "cli" ? JSON.parse((await run(["plan", "control", dir, "cancel", "remote", "--command-id", "cancel", "--expected-revision", "1", "--json"], env, { http: ctx.http, runner: fake.runner })).text) : await server.handlers.ares_plan_control!({ study: dir, ...request });
    expect(value).toMatchObject({ state: "paused", status: "cancelled" });
    if (expected) expect(value).toEqual(expected); else expected = value;
    await control(dir, "resume", "next"); const before = fs.readFileSync(join(dir, "ledger.jsonl"));
    expect(await ops.planControl(dir, request as Parameters<typeof ops.planControl>[1], ctx)).toEqual(value);
    expect(fs.readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(ops.planShow(dir).state).toBe("running");
    expect(fake.requests).toEqual([]); await server.waitForIdle();
  }
  const { dir } = await fixture("gates"); await control(dir, "resume", "start");
  appendEvent(dir, actor, "node.intent", { revision: 1, node: "remote", dispatchId: "ordinary", taskId: 1 });
  expect((await control(dir, "cancel", "cancel")).state).toBe("running");
  expect(ops.planShow(dir).pauseReason).toBeUndefined(); expect(readLedger(dir).some(event => event.type === "plan.paused" && event.data.reason === "step")).toBe(false);
});

test("final step cancellation ends failed without acknowledgement and repeated cancel retains the outcome", async () => {
  const { dir } = await fixture("step", false); await control(dir, "resume", "start");
  appendEvent(dir, actor, "node.intent", { revision: 1, node: "remote", dispatchId: "final", taskId: 1 });
  expect((await control(dir, "cancel", "cancel")).state).toBe("failed"); expect(ops.planShow(dir).pauseReason).toBeUndefined();
  expect((await control(dir, "cancel", "cancel-again")).state).toBe("failed");
  expect(readLedger(dir).some(event => event.type === "plan.paused" && event.data.reason === "step")).toBe(false);
});
