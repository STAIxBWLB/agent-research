import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { runPlan, type ControllerRuntime } from "../src/plan/controller.ts";
import { nextDispatchId } from "../src/plan/state.ts";
import { appendEvent, processStart, readLedger, readPlanOwner, withPlanLock } from "../src/study.ts";
import { ARES_TOOLS } from "../src/mcp-tools.ts";
import { deferred, fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const step = (id: string, needs: string[] = []) => ({ id, kind: "step", command: "lit.bib", args: {}, needs });
async function study(nodes: unknown[] = [step("a")], autonomy = "gates") {
  const dir = join(tempDir(), "study"); ops.init(dir, { question: "synthetic", autonomy }, ctx); await ops.planSet(dir, { v: 1, nodes, edges: [] }, ctx); return dir;
}
const resume = (dir: string, id = "resume") => ops.planControl(dir, { action: "resume", commandId: id, expectedRevision: ops.planShow(dir).revision }, ctx);
const runtime = (overrides: Partial<ControllerRuntime> = {}): ControllerRuntime => ({ actor, prepare: async () => ({}), execute: async () => ({ status: "done", output: { sha256: "synthetic" } }), reconcile: async () => ({ status: "uncertain", reason: "missing attempt" }), ...overrides });

test("controller locks refuse live/foreign owners regardless of age; dead and reused-pid owners recover", async () => {
  const dir = await study(), file = join(dir, ".ares.plan.lock");
  await withPlanLock(dir, async owner => {
    expect(readPlanOwner(dir)).toEqual(owner); expect(ops.planShow(dir).controller).toEqual(owner);
    utimesSync(file, new Date(0), new Date(0));
    await expect(withPlanLock(dir, async () => {})).rejects.toThrow(`pid ${process.pid}`);
  });
  expect(existsSync(file)).toBe(false);
  writeFileSync(file, JSON.stringify({ pid: process.pid, host: "foreign-fixture", startedAt: "old", token: "foreign" }));
  await expect(withPlanLock(dir, async () => {})).rejects.toThrow("foreign-fixture");
  expect(JSON.parse(readFileSync(file, "utf8")).token).toBe("foreign");
  writeFileSync(file, JSON.stringify({ pid: process.pid, host: hostname(), startedAt: "different process start", token: "reused" }));
  await withPlanLock(dir, async owner => { expect(owner.startedAt).toBe(processStart(process.pid)!); });
  expect(existsSync(file)).toBe(false);
});

test("startup restores paused and makes unobservable steps uncertain without replay", async () => {
  const dir = await study(); await resume(dir);
  appendEvent(dir, actor, "node.intent", { revision: 1, node: "a", dispatchId: "lost" });
  const stop = new AbortController(); stop.abort(); let executions = 0;
  const state = await runPlan(dir, {}, runtime({ signal: stop.signal, execute: async () => { executions++; return { status: "done" }; } }));
  expect(state.state).toBe("paused"); expect(state.nodes[0]!.status).toBe("uncertain"); expect(executions).toBe(0);
  expect(readLedger(dir).filter(e => e.type === "plan.paused")).toHaveLength(1);
  expect(existsSync(join(dir, ".ares.plan.lock"))).toBe(false);
});

test("controller waits for explicit resume and respects committed intent, parallel slots and dependencies", async () => {
  const dir = await study([step("a"), step("b"), step("c", ["a", "b"])]), stop = new AbortController();
  const entered = deferred(), release = deferred(); let calls = 0, active = 0, peak = 0;
  const finished = runPlan(dir, { parallel: 2 }, runtime({ signal: stop.signal,
    sleep: async () => { if (!calls) await resume(dir); else await Bun.sleep(1); },
    execute: async (definition, state) => {
      expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
      expect(readLedger(dir).some(e => e.type === "node.intent" && e.data.dispatchId === state.dispatchId)).toBe(true);
      calls++; active++; peak = Math.max(peak, active);
      if (definition.id !== "c") { if (calls === 2) entered.resolve(); await release.promise; }
      active--; return { status: "done", output: { node: definition.id } };
    },
  }));
  await entered.promise; expect(calls).toBe(2); expect(ops.planShow(dir).nodes.find(n => n.id === "c")!.status).toBe("pending");
  release.resolve(); const state = await finished;
  expect(state.state).toBe("done"); expect(calls).toBe(3); expect(peak).toBe(2);
});

test("pause stops admission, preserves active work, and uncertain dispatches never replay on resume", async () => {
  const dir = await study([step("a"), step("b")]), stop = new AbortController(); let executed = 0;
  const state = await runPlan(dir, {}, runtime({ signal: stop.signal,
    sleep: async () => { if (!executed) await resume(dir); else stop.abort(); await Bun.sleep(1); },
    execute: async () => { executed++; await ops.planControl(dir, { action: "pause", commandId: "pause", expectedRevision: 1 }, ctx); return { status: "uncertain", reason: "lost result" }; },
  }));
  expect(executed).toBe(1); expect(state.nodes[0]!.status).toBe("uncertain"); expect(state.nodes[1]!.status).toBe("ready");
});

test("attempt intents keep expected ids; restart reconciles the expected attempt without launching", async () => {
  const dir = await study([{ id: "attempt", kind: "step", command: "attempt.run", args: { repo: "repo", commit: "a".repeat(40) } }]);
  await resume(dir); appendEvent(dir, actor, "node.intent", { revision: 1, node: "attempt", dispatchId: "attempt-1", attemptId: "b".repeat(16) });
  const stop = new AbortController(); stop.abort(); let calls = 0;
  const state = await runPlan(dir, {}, runtime({ signal: stop.signal,
    execute: async () => { throw new Error("must not execute"); },
    reconcile: async (_definition, node) => { calls++; expect(node.attemptId).toBe("b".repeat(16)); return { status: "done", output: { attemptId: node.attemptId } }; },
  }));
  expect(calls).toBe(1); expect(state.nodes[0]!.status).toBe("done");
});

test("auto plan approvals are committed by the controller and hub nodes are never dispatched", async () => {
  const dir = await study([step("a"), { id: "g", kind: "gate", needs: ["a"], binds: ["a"] }, { id: "hub", kind: "hub", campaign: "c", unit: "u", needs: ["g"] }], "auto");
  const stop = new AbortController(); let calls = 0;
  await runPlan(dir, {}, runtime({ signal: stop.signal,
    execute: async () => { calls++; return { status: "done", output: { sha256: "synthetic" } }; },
    sleep: async () => { if (!calls) await resume(dir); else if (ops.planShow(dir).nodes.find(n => n.id === "g")!.status === "done") stop.abort(); await Bun.sleep(1); },
  }));
  expect(calls).toBe(1); expect(ops.planShow(dir).nodes.find(n => n.id === "hub")!.status).toBe("ready");
  expect(readLedger(dir).find(e => e.type === "gate.approve")!.actor.kind).toBe("auto");
});

test("CLI run is not an MCP tool and validates parallel; pre-aborted run leaves a paused definition", async () => {
  const dir = await study(), stop = new AbortController(); stop.abort();
  expect(ARES_TOOLS.some(t => t.name === "ares_run")).toBe(false);
  for (const parallel of ["0", "9"]) await expect(run(["run", dir, "--parallel", parallel], {}, { http: ctx.http })).rejects.toThrow("1..8");
  const result = await run(["run", dir, "--json"], {}, { http: ctx.http, signal: stop.signal });
  expect(JSON.parse(result.text).state).toBe("paused"); expect(result.code).toBe(0);
});

test("killed controller leaves a recoverable same-host owner and restart pauses its unobserved dispatch", async () => {
  const dir = await study(), script = join(tempDir(), "controller-child.ts");
  writeFileSync(script, `
    const { runPlan } = await import(process.argv[2]!);
    const ops = await import(process.argv[3]!);
    let resumed = false;
    await runPlan(process.argv[4]!, {}, {
      actor: {kind:"person"}, prepare: async () => ({}),
      execute: async () => { console.log("dispatched"); return await new Promise(() => {}); },
      reconcile: async () => { throw new Error("no attempt"); },
      sleep: async () => {
        if (!resumed) { resumed = true; await ops.planControl(process.argv[4]!, {action:"resume", commandId:"child-resume", expectedRevision:1}, {actor:{kind:"person"}, http:{}}); }
        await Bun.sleep(5);
      }
    });
  `);
  const child = Bun.spawn([process.execPath, script, join(import.meta.dir, "../src/plan/controller.ts"), join(import.meta.dir, "../src/commands.ts"), dir], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader(), first = await reader.read(); reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain("dispatched");
    expect(ops.planShow(dir).nodes[0]!.status).toBe("dispatched");
    await expect(withPlanLock(dir, async () => {})).rejects.toThrow(`pid ${child.pid}`);
    child.kill("SIGKILL"); await child.exited;
    expect(readPlanOwner(dir)?.pid).toBe(child.pid);
    const stop = new AbortController(); stop.abort(); let executed = 0;
    const restored = await runPlan(dir, {}, runtime({ signal: stop.signal, execute: async () => { executed++; return { status: "done" }; } }));
    expect(restored.state).toBe("paused"); expect(restored.nodes[0]!.status).toBe("uncertain"); expect(executed).toBe(0);
    expect(readPlanOwner(dir)).toBeUndefined();
  } finally { if (child.exitCode === null) { child.kill("SIGKILL"); await child.exited; } }
}, 10_000);

test("production CLI executes a study-relative cite step and records a bounded output reference", async () => {
  const dir = await study([{ id: "cite", kind: "step", command: "cite.check", args: { draft: "draft.md" } }]);
  writeFileSync(join(dir, "draft.md"), "Synthetic draft without citations.");
  let resumed = false;
  const result = await run(["run", dir, "--json"], {}, { http: ctx.http, sleep: async () => { if (!resumed) { resumed = true; await resume(dir); } await Bun.sleep(1); } });
  expect(JSON.parse(result.text).state).toBe("done");
  const intent = readLedger(dir).find(e => e.type === "node.intent")!, observed = readLedger(dir).find(e => e.type === "node.observed")!;
  expect(observed.data.dispatchId).toBe(intent.data.dispatchId);
  expect(observed.data.output).toEqual({ sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
});


test("pause during read-only preparation prevents intent and execution", async () => {
  const dir = await study(), stop = new AbortController(); let preparations = 0, executions = 0;
  const state = await runPlan(dir, {}, runtime({ signal: stop.signal,
    sleep: async () => { if (!preparations) await resume(dir); else stop.abort(); await Bun.sleep(1); },
    prepare: async () => { preparations++; await ops.planControl(dir, { action: "pause", commandId: "pause-preparation", expectedRevision: 1 }, ctx); return {}; },
    execute: async () => { executions++; return { status: "done" }; },
  }));
  expect(state.state).toBe("paused"); expect(executions).toBe(0);
  expect(readLedger(dir).filter(e => e.type === "node.intent")).toHaveLength(0);
});

test("parallel admission preserves the existing one-active-attempt invariant", async () => {
  const attempt = (id: string) => ({ id, kind: "step", command: "attempt.run", args: { repo: "repo", commit: "a".repeat(40) } });
  const dir = await study([attempt("first"), attempt("second"), step("other")]), stop = new AbortController();
  const executed: string[] = []; let resumed = false;
  await runPlan(dir, { parallel: 2 }, runtime({ signal: stop.signal,
    prepare: async n => n.command === "attempt.run" ? { attemptId: "b".repeat(16) } : {},
    execute: async n => { executed.push(n.id); return n.command === "attempt.run" ? { status: "dispatched" } : { status: "done", output: {} }; },
    reconcile: async () => ({ status: "dispatched" }),
    sleep: async () => { if (!resumed) { resumed = true; await resume(dir); } else if (executed.includes("other")) stop.abort(); await Bun.sleep(1); },
  }));
  expect(executed).toEqual(["first", "other"]);
  expect(ops.planShow(dir).nodes.find(n => n.id === "second")!.status).toBe("ready");
  expect(readLedger(dir).filter(e => e.type === "node.observed" && e.data.node === "first")).toHaveLength(1);
});
