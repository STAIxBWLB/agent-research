import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { runPlan, type ControllerRuntime, type Observation } from "../src/plan/controller.ts";
import { readLedger, StudyLockBusyError, type LedgerEvent } from "../src/study.ts";
import { deferred, fakeHttp, fakeRunner, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const step = (id: string, phase?: string) => ({ id, kind: "step", command: "lit.bib", args: {}, ...(phase ? { phase } : {}) });
async function resume(dir: string, commandId: string) {
  for (let attempt = 0; ; attempt++) {
    try { return await ops.planControl(dir, { action: "resume", commandId, expectedRevision: ops.planShow(dir).revision }, ctx); }
    catch (error) {
      if (!(error instanceof StudyLockBusyError) || attempt >= 9) throw error;
      // The pause append can be visible before its short transaction releases the lock.
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
}
async function study(perPhase = false, attempt = false) {
  const dir = join(tempDir(), "study");
  ops.init(dir, { question: "Synthetic step boundaries", autonomy: perPhase ? "auto" : "step" }, ctx);
  if (perPhase) await ops.autonomySet(dir, "step", "literature", ctx);
  const phase = perPhase ? "literature" : undefined;
  await ops.planSet(dir, { v: 1, nodes: [
    attempt ? { id: "first", kind: "step", command: "attempt.run", args: { repo: "/synthetic", commit: "a".repeat(40) }, ...(phase ? { phase } : {}) } : step("first", phase),
    step("second", phase), step("third", phase),
  ], edges: [] }, ctx);
  return dir;
}
const observedDone: Observation = { status: "done", output: { sha256: "synthetic" } };
function runtime(overrides: Partial<ControllerRuntime>): ControllerRuntime {
  return { actor, prepare: async () => ({}), execute: async () => observedDone, reconcile: async () => { throw new Error("unexpected reconcile"); }, ...overrides };
}

for (const perPhase of [false, true]) test(`${perPhase ? "per-phase" : "default"} step admits one command per resume despite spare parallel slots`, async () => {
  const dir = await study(perPhase), stop = new AbortController(), first = deferred<Observation>();
  const calls: string[] = [], appendChunks: LedgerEvent[][] = [];
  const append = fs.appendFileSync;
  const spy = spyOn(fs, "appendFileSync").mockImplementation(((file, data, options) => {
    if (String(file) === join(dir, "ledger.jsonl")) appendChunks.push(String(data).trim().split("\n").map(line => JSON.parse(line) as LedgerEvent));
    return append(file, data, options);
  }) as typeof fs.appendFileSync);
  let initiallyResumed = false, resumedSecond = false, sleeps = 0;
  let resumingSecond: Promise<unknown> | undefined;
  try {
    const state = await runPlan(dir, { parallel: 3 }, runtime({ signal: stop.signal,
      execute: async definition => { calls.push(definition.id); return definition.id === "first" ? first.promise : observedDone; },
      sleep: async () => {
        if (++sleeps > 30) { stop.abort(); throw new Error("step controller failed to reach the expected boundary"); }
        if (resumingSecond) { await resumingSecond; return; }
        const current = ops.planShow(dir);
        if (!initiallyResumed) { initiallyResumed = true; await resume(dir, "first-resume"); return; }
        if (calls.length === 1 && current.nodes[0]!.status === "dispatched") {
          expect(current.state).toBe("running");
          expect(current.nodes.slice(1).every(node => node.status === "ready")).toBe(true);
          expect(readLedger(dir).filter(event => event.type === "node.intent")).toHaveLength(1);
          first.resolve(observedDone); return;
        }
        if (current.state === "paused" && current.pauseReason === "step") {
          expect(calls).toEqual(resumedSecond ? ["first", "second"] : ["first"]);
          expect(current.nodes[2]!.status).toBe("ready");
          if (!resumedSecond) {
            resumingSecond = resume(dir, "second-resume");
            await resumingSecond;
            resumedSecond = true;
            resumingSecond = undefined;
          }
          else stop.abort();
        }
      },
    }));
    expect(state.state).toBe("paused"); expect(state.pauseReason).toBe("step");
    expect(calls).toEqual(["first", "second"]);
    const events = readLedger(dir), pauses = events.filter(event => event.type === "plan.paused" && event.data.reason === "step");
    expect(pauses).toHaveLength(2);
    for (const id of calls) {
      const index = events.findIndex(event => event.type === "node.observed" && event.data.node === id && event.data.status === "done");
      expect(index).toBeGreaterThan(-1);
      expect(events[index + 1]).toMatchObject({ type: "plan.paused", data: { reason: "step" } });
      const chunk = appendChunks.find(chunk => chunk.some(event => event.type === "node.observed" && event.data.node === id && event.data.status === "done"));
      expect(chunk?.map(event => event.type)).toEqual(["node.observed", "plan.paused"]);
    }
  } finally { first.resolve(observedDone); stop.abort(); spy.mockRestore(); }
});

test("controller restart preserves the durable step pause without replay or another pause event", async () => {
  const dir = await study(), stop = new AbortController(); let resumed = false, sleeps = 0, executed = 0;
  const first = await runPlan(dir, { parallel: 3 }, runtime({ signal: stop.signal,
    execute: async () => { executed++; return observedDone; },
    sleep: async () => {
      if (++sleeps > 20) { stop.abort(); throw new Error("missing step pause"); }
      if (!resumed) { resumed = true; await resume(dir, "resume-before-restart"); }
      else if (ops.planShow(dir).pauseReason === "step") stop.abort();
    },
  }));
  expect(first.pauseReason).toBe("step"); expect(executed).toBe(1);
  const before = fs.readFileSync(join(dir, "ledger.jsonl")), restarted = new AbortController();
  const state = await runPlan(dir, { parallel: 3 }, runtime({ signal: restarted.signal,
    prepare: async () => { throw new Error("paused restart must not prepare a step"); },
    execute: async () => { executed++; throw new Error("paused restart must not replay"); },
    sleep: async () => { expect(ops.planShow(dir).pauseReason).toBe("step"); restarted.abort(); },
  }));
  expect(state.state).toBe("paused"); expect(state.pauseReason).toBe("step"); expect(executed).toBe(1);
  expect(fs.readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  expect(fs.existsSync(join(dir, ".ares.plan.lock"))).toBe(false);
});

test("detached step remains running at dispatched and pauses only on terminal completion", async () => {
  const dir = await study(false, true), stop = new AbortController(), reconcileRelease = deferred<Observation>();
  let now = 0, resumed = false, sleeps = 0, executions = 0, reconciliations = 0;
  const state = await runPlan(dir, { parallel: 3 }, runtime({ signal: stop.signal, clock: () => now,
    prepare: async () => ({ attemptId: "b".repeat(16) }),
    execute: async () => { executions++; return { status: "dispatched", reason: "synthetic detached attempt" }; },
    reconcile: async () => {
      reconciliations++;
      const current = ops.planShow(dir);
      expect(current.state).toBe("running"); expect(current.pauseReason).toBeUndefined();
      expect(readLedger(dir).some(event => event.type === "plan.paused" && event.data.reason === "step")).toBe(false);
      expect(current.nodes.slice(1).every(node => node.status === "ready")).toBe(true);
      reconcileRelease.resolve(observedDone);
      return reconcileRelease.promise;
    },
    sleep: async ms => {
      if (++sleeps > 20) { stop.abort(); throw new Error("detached step failed to reach completion pause"); }
      if (!resumed) { resumed = true; await resume(dir, "detached-resume"); return; }
      if (ops.planShow(dir).pauseReason === "step") stop.abort();
      now += ms;
    },
  }));
  expect(executions).toBe(1); expect(reconciliations).toBe(1);
  expect(state.state).toBe("paused"); expect(state.pauseReason).toBe("step");
  const observed = readLedger(dir).filter(event => event.type === "node.observed");
  expect(observed.map(event => event.data.status)).toEqual(["dispatched", "done"]);
  const events = readLedger(dir), pauseIndex = events.findIndex(event => event.type === "plan.paused" && event.data.reason === "step");
  expect(events[pauseIndex - 1]).toMatchObject({ type: "node.observed", data: { status: "done" } });
  expect(events.filter(event => event.type === "node.intent")).toHaveLength(1);
});

test("MCP resume changes durable state without starting a controller, process or network request", async () => {
  const dir = await study(), process = fakeRunner([]), server = createAresMcp({}, ctx.http, { runner: process.runner });
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () => { throw new Error("network forbidden"); }) as unknown as typeof fetch);
  const spawnSpy = spyOn(child, "spawn").mockImplementation((() => { throw new Error("process forbidden"); }) as typeof child.spawn);
  try {
    await server.handlers.ares_plan_control!({ study: dir, action: "resume", commandId: "mcp-resume", expectedRevision: ops.planShow(dir).revision });
    expect(ops.planShow(dir).state).toBe("running");
    expect(ops.planShow(dir).pauseReason).toBeUndefined();
    expect(readLedger(dir).some(event => event.type === "node.intent")).toBe(false);
    expect(fs.existsSync(join(dir, ".ares.plan.lock"))).toBe(false);
    expect(process.requests).toHaveLength(0); expect(fetchSpy).not.toHaveBeenCalled(); expect(spawnSpy).not.toHaveBeenCalled();
    await server.waitForIdle();
  } finally { fetchSpy.mockRestore(); spawnSpy.mockRestore(); server.terminate(); }
});

test("manual-only pending gate polling does not repeatedly acquire the study lock", async () => {
  const dir = join(tempDir(), "study"); ops.init(dir, { question: "Synthetic manual gate", autonomy: "gates" }, ctx);
  await ops.planSet(dir, { v: 1, nodes: [
    { id: "manual", kind: "gate", binds: [] }, { ...step("after"), needs: ["manual"] },
  ], edges: [] }, ctx);
  const stop = new AbortController(), open = fs.openSync;
  let lockOpens = 0, baseline = 0, sleeps = 0, executions = 0;
  const spy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
    if (String(file) === join(dir, ".ares.lock")) lockOpens++;
    return open(file, flags, mode);
  }) as typeof fs.openSync);
  try {
    const state = await runPlan(dir, {}, runtime({ signal: stop.signal,
      execute: async () => { executions++; return observedDone; },
      sleep: async () => {
        sleeps++;
        if (sleeps === 1) {
          expect(lockOpens).toBeGreaterThan(0); // Prove the spy observes the controller startup lock.
          await resume(dir, "manual-gate-resume"); baseline = lockOpens;
        } else {
          expect(ops.planShow(dir).nodes[0]!.gate!.state).toBe("pending");
          expect(lockOpens).toBe(baseline);
          if (sleeps === 4) stop.abort();
        }
      },
    }));
    expect(state.nodes[0]!.gate!.state).toBe("pending"); expect(executions).toBe(0); expect(sleeps).toBe(4);
  } finally { stop.abort(); spy.mockRestore(); }
});

const terminals = ["done", "failed", "cancelled", "uncertain"] as const;
for (const path of ["direct", "reconcile"] as const) test(`every terminal ${path} step outcome pauses atomically when work remains`, async () => {
  for (const status of terminals) {
    const dir = await study(false, path === "reconcile"), stop = new AbortController();
    const append = fs.appendFileSync, chunks: LedgerEvent[][] = [];
    const spy = spyOn(fs, "appendFileSync").mockImplementation(((file, data, options) => {
      if (String(file) === join(dir, "ledger.jsonl")) chunks.push(String(data).trim().split("\n").map(line => JSON.parse(line) as LedgerEvent));
      return append(file, data, options);
    }) as typeof fs.appendFileSync);
    let resumed = false, executions = 0, reconciliations = 0, sleeps = 0, now = 0;
    const terminal: Observation = { status, output: { sha256: "synthetic" }, ...(status === "done" ? {} : { reason: `Synthetic ${status}` }) };
    try {
      const state = await runPlan(dir, { parallel: 3 }, runtime({ signal: stop.signal, clock: () => now,
        prepare: async () => path === "reconcile" ? { attemptId: "c".repeat(16) } : {},
        execute: async () => { executions++; return path === "direct" ? terminal : { status: "dispatched" }; },
        reconcile: async () => { reconciliations++; return terminal; },
        sleep: async ms => {
          if (++sleeps > 30) { stop.abort(); throw new Error(`missing ${path} ${status} step boundary`); }
          if (!resumed) { resumed = true; await resume(dir, `resume-${path}-${status}`); }
          else if (ops.planShow(dir).pauseReason === "step") stop.abort();
          now += ms;
        },
      }));
      expect(state.state).toBe("paused"); expect(state.pauseReason).toBe("step");
      expect(state.nodes[0]!.status).toBe(status); expect(state.nodes.slice(1).every(node => node.status === "ready")).toBe(true);
      expect(executions).toBe(1); expect(reconciliations).toBe(path === "direct" ? 0 : 1);
      const events = readLedger(dir), pauses = events.filter(event => event.type === "plan.paused" && event.data.reason === "step");
      expect(pauses).toHaveLength(1); expect(events.filter(event => event.type === "node.intent")).toHaveLength(1);
      const chunk = chunks.find(chunk => chunk.some(event => event.type === "node.observed" && event.data.status === status));
      expect(chunk?.map(event => event.type)).toEqual(["node.observed", "plan.paused"]);
    } finally { stop.abort(); spy.mockRestore(); }
  }
});

for (const path of ["direct", "reconcile"] as const) test(`last ${path} step outcome completes without a pause or acknowledgement`, async () => {
  for (const status of terminals) {
    const dir = await study(false, path === "reconcile"), first = ops.planShow(dir).definition.nodes[0]!;
    await ops.planSet(dir, { v: 1, nodes: [first], edges: [] }, ctx);
    const stop = new AbortController(); let resumed = false, calls = 0, sleeps = 0, now = 0;
    try {
      const state = await runPlan(dir, { parallel: 3 }, runtime({ signal: stop.signal, clock: () => now,
        prepare: async () => path === "reconcile" ? { attemptId: "d".repeat(16) } : {},
        execute: async () => { calls++; return path === "direct" ? { status } : { status: "dispatched" }; },
        reconcile: async () => ({ status }),
        sleep: async ms => {
          if (++sleeps > 20) { stop.abort(); throw new Error(`last ${path} ${status} effect failed to complete`); }
          if (!resumed) { resumed = true; await resume(dir, `final-${path}-${status}`); }
          now += ms;
        },
      }));
      expect(state.state).toBe(status === "done" ? "done" : "failed");
      expect(state.pauseReason).toBeUndefined(); expect(calls).toBe(1);
      expect(readLedger(dir).filter(event => event.type === "plan.paused")).toHaveLength(0);
      const controls = readLedger(dir).filter(event => event.type === "plan.control");
      expect(controls).toHaveLength(1);
      expect(controls[0]).toMatchObject({ data: { request: { action: "resume" } } });
    } finally { stop.abort(); }
  }
});

test("hub effects use the study default despite a declared phase override", async () => {
  for (const defaultStep of [false, true]) {
    const dir = join(tempDir(), "study");
    ops.init(dir, { question: "Synthetic hub step", autonomy: defaultStep ? "step" : "auto" }, ctx);
    await ops.autonomySet(dir, defaultStep ? "auto" : "step", "literature", ctx);
    await ops.planSet(dir, { v: 1, nodes: [
      { id: "remote", kind: "hub", campaign: "synthetic", unit: "synthetic", phase: "literature" },
      { ...step("remaining"), needs: ["remote"] },
    ], edges: [] }, ctx);
    const stop = new AbortController(); let resumed = false, sleeps = 0, reads = 0, executions = 0;
    try {
      const state = await runPlan(dir, { parallel: 3 }, runtime({ signal: stop.signal,
        hub: { observe: async () => { reads++; return { status: "done", output: { sha256: "synthetic" } }; } },
        execute: async () => { executions++; return observedDone; },
        sleep: async () => {
          if (++sleeps > 20) { stop.abort(); throw new Error("hub default step boundary missing"); }
          if (!resumed) { resumed = true; await resume(dir, `hub-${defaultStep}`); }
          else if (ops.planShow(dir).pauseReason === "step") stop.abort();
        },
      }));
      expect(reads).toBe(1); expect(executions).toBe(defaultStep ? 0 : 1);
      expect(state.state).toBe(defaultStep ? "paused" : "done");
      expect(readLedger(dir).filter(event => event.type === "plan.paused" && event.data.reason === "step")).toHaveLength(defaultStep ? 1 : 0);
    } finally { stop.abort(); }
  }
});

test("approving a gate in step mode permits its effect without creating a gate pause", async () => {
  const dir = await study();
  await ops.planSet(dir, { v: 1, nodes: [
    { id: "manual", kind: "gate", binds: [] },
    { ...step("first"), needs: ["manual"] }, { ...step("remaining"), needs: ["first"] },
  ], edges: [] }, ctx);
  const stop = new AbortController(); let resumed = false, approved = false, executions = 0, sleeps = 0;
  try {
    const state = await runPlan(dir, {}, runtime({ signal: stop.signal,
      execute: async () => { executions++; return observedDone; },
      sleep: async () => {
        if (++sleeps > 20) { stop.abort(); throw new Error("manual gate prevented first step effect"); }
        if (!resumed) { resumed = true; await resume(dir, "gate-step-resume"); }
        else if (!approved) {
          approved = true;
          expect(readLedger(dir).some(event => event.type === "plan.paused" && event.data.reason === "step")).toBe(false);
          await ops.gateDecide(dir, "plan:manual", "approve", undefined, ctx);
        } else if (ops.planShow(dir).pauseReason === "step") stop.abort();
      },
    }));
    expect(executions).toBe(1); expect(state.nodes[0]!.status).toBe("done");
    const events = readLedger(dir), pauses = events.filter(event => event.type === "plan.paused" && event.data.reason === "step");
    expect(pauses).toHaveLength(1);
    expect(events[events.indexOf(pauses[0]!) - 1]).toMatchObject({ type: "node.observed", data: { node: "first", status: "done" } });
  } finally { stop.abort(); }
});

test("completion resolves the fresh policy when autonomy changes during an effect", async () => {
  for (const switchToStep of [false, true]) {
    const dir = join(tempDir(), "study");
    ops.init(dir, { question: "Synthetic fresh completion policy", autonomy: switchToStep ? "auto" : "step" }, ctx);
    await ops.planSet(dir, { v: 1, nodes: [step("first"), step("second"), step("third")], edges: [] }, ctx);
    const stop = new AbortController(); let resumed = false, sleeps = 0, executions = 0;
    try {
      const state = await runPlan(dir, { parallel: 1 }, runtime({ signal: stop.signal,
        execute: async () => {
          if (++executions === 1) await ops.autonomySet(dir, switchToStep ? "step" : "auto", undefined, ctx);
          return observedDone;
        },
        sleep: async () => {
          if (++sleeps > 20) { stop.abort(); throw new Error("fresh policy completion boundary missing"); }
          if (!resumed) { resumed = true; await resume(dir, `fresh-policy-${switchToStep}`); }
          else if (ops.planShow(dir).pauseReason === "step") stop.abort();
        },
      }));
      expect(executions).toBe(switchToStep ? 1 : 3);
      expect(state.state).toBe(switchToStep ? "paused" : "done");
      expect(readLedger(dir).filter(event => event.type === "plan.paused" && event.data.reason === "step")).toHaveLength(switchToStep ? 1 : 0);
    } finally { stop.abort(); }
  }
});
