import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, utimesSync, mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { runPlan, type ControllerRuntime } from "../src/plan/controller.ts";
import { nextDispatchId } from "../src/plan/state.ts";
import { appendEvent, processStart, readLedger, readPlanOwner, withPlanLock, StudyLockBusyError, openStudy, sha256 } from "../src/study.ts";
import { readProtocol, protocolHash } from "../src/exp/protocol.ts";
import { investigateResultPath } from "../src/exp/investigate.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { deferred, fakeHttp, tempDir, fixture } from "./helpers.ts";
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


test("cleanup preserves the original failure if the controller lock becomes malformed", async () => {
  const dir = await study();
  await expect(withPlanLock(dir, async () => { writeFileSync(join(dir, ".ares.plan.lock"), "malformed"); throw new Error("original failure"); })).rejects.toThrow("original failure");
  expect(readFileSync(join(dir, ".ares.plan.lock"), "utf8")).toBe("malformed");
});

test("lock-busy at step entry backs off without uncertain or duplicate dispatch", async () => {
  const dir = await study(), waits: number[] = []; let attempts = 0, resumed = false;
  const state = await runPlan(dir, {}, runtime({
    sleep: async ms => { waits.push(ms); if (!resumed) { resumed = true; await resume(dir); } await Bun.sleep(1); },
    execute: async () => { if (++attempts < 3) throw new StudyLockBusyError("study is locked by another ares command"); return { status: "done", output: {} }; },
  }));
  expect(state.state).toBe("done"); expect(attempts).toBe(3);
  expect(waits).toContain(1000); expect(waits).toContain(2000);
  expect(readLedger(dir).filter(e => e.type === "node.intent")).toHaveLength(1);
  expect(readLedger(dir).filter(e => e.type === "node.observed" && e.data.status === "uncertain")).toHaveLength(0);
});

test("attempt observation grows from 1s to 30s, resets on progress, and unchanged polls do not write", async () => {
  const dir = await study([{ id: "work", kind: "step", command: "attempt.run", args: { repo: "repo", commit: "a".repeat(40) } }]);
  const stop = new AbortController(); let time = 0, resumed = false;
  const calls: number[] = [], bytes: string[] = [];
  await runPlan(dir, {}, runtime({ signal: stop.signal, clock: () => time,
    sleep: async ms => { time += ms; if (!resumed) { resumed = true; await resume(dir); } await Bun.sleep(1); },
    prepare: async () => ({ attemptId: "a".repeat(16) }),
    execute: async () => ({ status: "dispatched", progress: "candidate" }),
    reconcile: async () => {
      calls.push(time); bytes.push(readFileSync(join(dir, "ledger.jsonl"), "utf8"));
      if (calls.length === 9) return { status: "done", output: {} };
      return { status: "dispatched", progress: calls.length >= 7 ? "evaluator" : "candidate" };
    },
  }));
  const intervals = calls.slice(1).map((value, i) => value - calls[i]!);
  expect(intervals).toEqual([2000, 4000, 8000, 16000, 30000, 30000, 1000, 2000]);
  expect(bytes.slice(0, 7).every(value => value === bytes[0])).toBe(true);
});

test("slow search study locks never stop the controller at parallel 1 or 2", async () => {
  for (const parallel of [1, 2]) {
    const dir = await study([
      { id: "search", kind: "step", command: "lit.search", args: { query: "synthetic", source: "openalex" } },
      { id: "cite", kind: "step", command: "cite.check", args: { draft: "draft.md" }, needs: parallel === 1 ? ["search"] : [] },
    ], "auto");
    writeFileSync(join(dir, "draft.md"), "Synthetic draft.");
    await ops.scope(dir, { question: "synthetic" }, ctx);
    const fake = fakeHttp([["https://api.openalex.org/works", { status: 200, body: fixture("openalex.json") }]]);
    const http = { ...fake.http, json: async (...args: Parameters<typeof fake.http.json>) => { await Bun.sleep(2600); return fake.http.json(...args); } };
    let resumed = false;
    const result = await ops.planRun(dir, { parallel }, { ...ctx, http,
      sleep: async ms => { if (!resumed) { resumed = true; await resume(dir); } await Bun.sleep(Math.min(ms, 50)); },
    });
    expect(result.state).toBe("done"); expect(result.nodes.map(n => n.status)).toEqual(["done", "done"]);
    expect(fake.requested).toHaveLength(1);
  }
}, 15_000);


test("production investigate.close step emits saved-result sha/winner and a downstream gate binds winner and no-winner outcomes", async () => {
  for (const withWinner of [false, true]) {
    const dir = join(tempDir(), "experiment"); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
    mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
    await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 10, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
    await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: "a".repeat(40) }, minSeeds: 1, minDelta: 1 }, ctx);
    if (withWinner) for (const [index, commit, value] of [[1, "a".repeat(40), 10], [2, "b".repeat(40), 12]] as const) {
      const id = String(index).padStart(16, "0"), protocol = readProtocol(dir)!, run = "investigate";
      const folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit, seed: 1, protocolHash: protocolHash(protocol), protocol, executor: {}, stages: {}, stage: "evaluator", status: "succeeded", startedAt: "2030-01-01T00:00:00Z", metrics: [{ name: "score", value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
      appendEvent(dir, actor, "attempt.started", { id, run, commit, seed: 1 });
    }
    await ops.planSet(dir, { v: 1, nodes: [{ id: "close", kind: "step", command: "investigate.close", args: {} }, { id: "review", kind: "gate", needs: ["close"], binds: ["close"] }], edges: [] }, ctx);
    let resumed = false, approved = false;
    const forbidden = async () => { throw new Error("investigate close must not execute Docker/hub"); };
    const state = await ops.planRun(dir, {}, { ...ctx, runner: forbidden,
      sleep: async () => {
        if (!resumed) { resumed = true; await resume(dir); }
        else if (!approved && ops.gateList(dir).find(g => g.gate === "plan:review")?.state === "pending") { approved = true; await ops.gateDecide(dir, "plan:review", "approve", undefined, ctx); }
        await Bun.sleep(1);
      },
    });
    const bytes = readFileSync(investigateResultPath(dir, "investigate")), saved = JSON.parse(bytes.toString());
    const output = state.nodes.find(n => n.id === "close")!.output;
    expect(output).toEqual({ sha256: sha256(bytes), winner: saved.winner });
    expect(saved.winner === null).toBe(!withWinner); expect(state.state).toBe("done");
    expect(ops.gateList(dir).find(g => g.gate === "plan:review")!.state).toBe("approved");
    expect(readLedger(dir).filter(e => e.type === "investigate.closed")).toHaveLength(1);
  }
});

test("survey CLI and MCP refuse every investigation command without writing events", async () => {
  const dir = await study(), before = readFileSync(join(dir, "ledger.jsonl"));
  const selection = { v: 1, run: "investigate", metric: "score", baseline: { commit: "a".repeat(40) }, minSeeds: 1, minDelta: 1 };
  const idea = { id: "idea", title: "Synthetic", hypothesis: "Untested" };
  for (const [args, payload] of [
    [["selection", dir, "--file", "-"], selection], [["idea", "add", dir, "--file", "-"], idea],
    [["idea", "decide", dir, "idea", "pivot", "--reason", "synthetic"], {}],
    [["investigate", "show", dir], {}], [["investigate", "close", dir], {}],
    [["final", "seeds", dir, "--file", "-"], { v: 1, seeds: [2] }], [["final", "close", dir], {}],
    [["ablate", "add", dir, "--file", "-"], { id: "without", commit: "c".repeat(40), removes: "synthetic" }],
    [["ablate", "show", dir], {}], [["ablate", "close", dir], {}], [["posthoc", "show", dir], {}],
  ] as [string[], unknown][]) await expect(run(args, {}, { http: ctx.http, readStdin: async () => JSON.stringify(payload) })).rejects.toThrow("experiment");
  const server = createAresMcp({}, ctx.http);
  for (const [name, args] of [
    ["ares_selection_set", { study: dir, selection }], ["ares_idea_add", { study: dir, idea }],
    ["ares_idea_decide", { study: dir, id: "idea", decision: "pivot", reason: "synthetic" }],
    ["ares_investigate_show", { study: dir }], ["ares_investigate_close", { study: dir }],
    ["ares_final_seeds", { study: dir, final: { v: 1, seeds: [2] } }], ["ares_final_close", { study: dir }],
    ["ares_ablate_add", { study: dir, ablation: { id: "without", commit: "c".repeat(40), removes: "synthetic" } }],
    ["ares_ablate_show", { study: dir }], ["ares_ablate_close", { study: dir }], ["ares_posthoc_show", { study: dir }],
  ] as [string, Record<string, unknown>][]) {
    let error: unknown;
    try { await server.handlers[name]!(args); } catch (failure) { error = failure; }
    expect((error as Error).message).toContain("experiment");
  }
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});


test("production phase close steps bind committed result sha/status to a gate for either final qualification", async () => {
  for (const qualified of [true, false]) {
    const dir = tempDir(), baseline = "a".repeat(40), winner = "b".repeat(40); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
    mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
    const image = `fixture@sha256:${"a".repeat(64)}`;
    await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image, command: ["candidate"] }, evaluator: { image, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1, 2], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
    await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx);
    await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: baseline }, minSeeds: 1, minDelta: 1 }, ctx);
    let serial = 0;
    const sample = (run: string, commit: string, seed: number, value: number) => {
      const id = String(++serial).padStart(16, "0"), protocol = readProtocol(dir)!, folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit, seed, protocolHash: protocolHash(protocol), protocol, executor: {}, stages: {}, stage: "evaluator", status: "succeeded", startedAt: "2030-01-01T00:00:00Z", metrics: [{ name: "score", value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
      appendEvent(dir, actor, "attempt.started", { id, run, commit, seed });
    };
    sample("investigate", baseline, 1, 10); sample("investigate", winner, 1, 12); await ops.investigateClose(dir, ctx);
    await ops.ablateAdd(dir, { id: "without", commit: "c".repeat(40), removes: "synthetic component" }, ctx);
    // A closed no-data ablation is valid; every declaration remains listed.
    await ops.ablateClose(dir, ctx); await ops.gateDecide(dir, "final", "approve", undefined, ctx);
    sample("final", baseline, 2, 10); sample("final", winner, 2, qualified ? 12 : 10);
    await ops.planSet(dir, { v: 1, nodes: [
      { id: "ablate", kind: "step", command: "ablate.close", args: {} },
      { id: "final", kind: "step", command: "final.close", args: {}, needs: ["ablate"] },
      { id: "review", kind: "gate", needs: ["final"], binds: ["ablate", "final"] },
    ], edges: [] }, ctx);
    let resumed = false, approved = false;
    const state = await ops.planRun(dir, {}, { ...ctx, runner: async () => { throw new Error("close steps must not start executor or hub"); }, sleep: async () => {
      if (!resumed) { resumed = true; await resume(dir); }
      else if (!approved && ops.gateList(dir).find(g => g.gate === "plan:review")?.state === "pending") { approved = true; await ops.gateDecide(dir, "plan:review", "approve", undefined, ctx); }
      await Bun.sleep(1);
    } });
    expect(state.state).toBe("done");
    for (const [id, status] of [["ablate", "closed"], ["final", qualified ? "qualified" : "not_qualified"]]) {
      const bytes = readFileSync(join(dir, "runs", id!, `${id}.json`));
      expect(state.nodes.find(n => n.id === id)!.output).toEqual({ sha256: sha256(bytes), status });
      expect(state.nodes.find(n => n.id === id)!.status).toBe("done");
    }
    expect(ops.gateList(dir).find(g => g.gate === "plan:review")!.state).toBe("approved");
    // New consumed outputs invalidate the downstream approval binding.
    await ops.planControl(dir, { action: "retry", node: "final", commandId: "refresh-final", expectedRevision: 1 }, ctx);
    appendEvent(dir, actor, "node.intent", { revision: 1, node: "final", dispatchId: "1:final:2" });
    appendEvent(dir, actor, "node.observed", { revision: 1, node: "final", dispatchId: "1:final:2", status: "done", output: { sha256: "changed", status: "not_qualified" } });
    expect(ops.gateList(dir).find(g => g.gate === "plan:review")!.state).toBe("pending");
  }
});
