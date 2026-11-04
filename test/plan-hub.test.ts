import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { runPlan, type ControllerRuntime } from "../src/plan/controller.ts";
import { createHubClient, HUB_READ_BYTES } from "../src/plan/hub.ts";
import { readLedger } from "../src/study.ts";
import { fakeDocker, fakeHubClient, fakeHttp, tempDir, deferred } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, campaign = "rc-0123456789ab";
const projection = (state = "in_progress", taskId: number | null = 42) => ({ id: campaign, revision: 1, held: false, reasons: [], units: [{ unitId: "u1", taskId, state }] });
const reply = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
const hubNode = () => ({ id: "hub", kind: "hub", campaign, unit: "u1" });
async function study(nodes: unknown[] = [hubNode()]) {
  const dir = join(tempDir(), "study"); ops.init(dir, { question: "synthetic" }, ctx); await ops.planSet(dir, { v: 1, nodes, edges: [] }, ctx); return dir;
}
const resume = (dir: string, id = "resume") => ops.planControl(dir, { action: "resume", commandId: id, expectedRevision: ops.planShow(dir).revision }, ctx);
const runtime = (overrides: Partial<ControllerRuntime> = {}): ControllerRuntime => ({ actor, prepare: async () => ({}), execute: async () => ({ status: "done", output: { sha256: "synthetic" } }), reconcile: async () => { throw new Error("no attempt calls allowed"); }, ...overrides });

test("hub client uses only bounded argv study-show reads and keeps output references free of response content", async () => {
  const fake = fakeDocker([reply({ ...projection("approved"), question: "synthetic-private-body", urls: ["https://private.test/?key=synthetic"] })]);
  const result = await createHubClient("/synthetic/project", fake.runner).observe(campaign, "u1");
  expect(fake.requests).toEqual([{ command: "ahub", args: ["--project", "/synthetic/project", "study", "show", campaign, "--json"], timeoutMs: 10000, maxOutputBytes: HUB_READ_BYTES }]);
  expect(result.status).toBe("done"); expect(result.taskId).toBe(42);
  expect(result.output).toMatchObject({ campaign, unit: "u1", taskId: 42, campaignRevision: 1 });
  expect(JSON.stringify(result)).not.toContain("synthetic-private-body"); expect(JSON.stringify(result)).not.toContain("private.test");
});

test("only approved child tasks complete; missing units/tasks, cancelled tasks and changed bindings fail", async () => {
  for (const state of ["backlog", "proposed", "in_progress", "in_review", "changes_requested"]) {
    expect((await createHubClient("/synthetic", fakeDocker([reply(projection(state))]).runner).observe(campaign, "u1")).status).toBe("dispatched");
  }
  const cases: [unknown, number | undefined, string][] = [
    [{ ...projection(), units: [] }, undefined, "unit missing"],
    [projection("unknown", null), undefined, "task missing"],
    [projection("cancelled"), undefined, "task cancelled"],
    [projection("approved", 43), 42, "binding changed"],
    [{ ...projection("approved"), held: true, reasons: ["campaign approval is not current"] }, undefined, "approval is not current"],
  ];
  for (const [value, expected, reason] of cases) {
    const result = await createHubClient("/synthetic", fakeDocker([reply(value)]).runner).observe(campaign, "u1", expected);
    expect(result.status).toBe("failed"); expect(result.reason).toContain(reason);
  }
});

test("unreachable, timeout, oversized, malformed and future read responses retain dispatched with safe error classes", async () => {
  const cases = [
    [new Error("synthetic-private-diagnostic"), "unavailable"],
    [{ ...reply(projection()), timedOut: true }, "timeout"],
    [{ ...reply(projection()), truncated: true }, "oversize"],
    [{ exitCode: 0, stdout: "x".repeat(HUB_READ_BYTES + 1), stderr: "" }, "oversize"],
    [{ exitCode: 1, stdout: "synthetic-private-body", stderr: "synthetic-private-diagnostic" }, "exit"],
    [{ exitCode: 0, stdout: "malformed", stderr: "" }, "format"],
    [reply(projection("future")), "unsupported"],
    [reply({ ...projection(), id: "wrong-campaign" }), "format"],
  ] as const;
  for (const [value, kind] of cases) {
    const result = await createHubClient("/synthetic", fakeDocker([value]).runner).observe(campaign, "u1");
    expect(result.status).toBe("dispatched"); expect(result.reason).toContain(`hub read ${kind}`);
    expect(JSON.stringify(result)).not.toContain("synthetic-private");
  }
});

test("controller waits for upstream, records one bound intent and only releases downstream on task approval", async () => {
  const dir = await study([{ id: "upstream", kind: "step", command: "lit.bib", args: {} }, { ...hubNode(), needs: ["upstream"] }, { id: "after", kind: "step", command: "lit.bib", args: {}, needs: ["hub"] }]);
  let time = 0, resumed = false, reads = 0; const executed: string[] = [];
  const fake = fakeHubClient(async (_campaign, _unit, expected) => {
    expect(ops.planShow(dir).nodes[0]!.status).toBe("done");
    if (++reads === 1) return { status: "dispatched", taskId: 42 };
    expect(expected).toBe(42); expect(executed).toEqual(["upstream"]);
    return { status: "done", taskId: 42, output: { campaign, unit: "u1", taskId: 42 } };
  });
  const state = await runPlan(dir, {}, runtime({ hub: fake.client, clock: () => time,
    sleep: async ms => { time += ms; if (!resumed) { resumed = true; await resume(dir); } await Bun.sleep(1); },
    execute: async n => { executed.push(n.id); return { status: "done", output: {} }; },
  }));
  expect(state.state).toBe("done"); expect(executed).toEqual(["upstream", "after"]);
  const intents = readLedger(dir).filter(e => e.type === "node.intent" && e.data.node === "hub");
  expect(intents).toHaveLength(1); expect(intents[0]!.data.taskId).toBe(42);
});

test("restart observes the pinned task without recording a second intent", async () => {
  const dir = await study(), stop = new AbortController(); let resumed = false;
  const fake = fakeHubClient(async () => ({ status: "dispatched", taskId: 42 }));
  await runPlan(dir, {}, runtime({ hub: fake.client, signal: stop.signal,
    sleep: async () => { if (!resumed) { resumed = true; await resume(dir); } else stop.abort(); await Bun.sleep(1); },
  }));
  const before = readLedger(dir).filter(e => e.type === "node.intent");
  const stopped = new AbortController(); stopped.abort();
  const next = fakeHubClient(async (_c, _u, taskId) => { expect(taskId).toBe(42); return { status: "done", taskId: 42, output: { taskId: 42 } }; });
  const state = await runPlan(dir, {}, runtime({ hub: next.client, signal: stopped.signal }));
  expect(state.nodes[0]!.status).toBe("done"); expect(readLedger(dir).filter(e => e.type === "node.intent")).toEqual(before);
});

test("an initially unreachable hub remains dispatched and binds its first successful task read exactly once", async () => {
  const dir = await study(), fake = fakeDocker([{ ...reply(projection()), timedOut: true }, reply(projection()), reply(projection("approved"))]);
  const client = createHubClient(dir, fake.runner), seen: (number | undefined)[] = []; let time = 0, resumed = false;
  const state = await runPlan(dir, {}, runtime({ clock: () => time, hub: { observe: async (c, u, expected) => { seen.push(expected); return client.observe(c, u, expected); } },
    sleep: async ms => {
      if (seen.length === 1) { expect(ops.planShow(dir).nodes[0]!.status).toBe("dispatched"); expect(ops.planShow(dir).nodes[0]!.reason).toContain("hub read timeout"); }
      time += ms; if (!resumed) { resumed = true; await resume(dir); } await Bun.sleep(1);
    },
  }));
  expect(state.state).toBe("done"); expect(state.nodes[0]!.taskId).toBe(42); expect(state.nodes[0]!.reason).toBeUndefined();
  expect(seen).toEqual([undefined, undefined, 42]);
  expect(readLedger(dir).filter(e => e.type === "node.intent")).toHaveLength(1);
  expect(readLedger(dir).filter(e => e.type === "node.observed" && e.data.taskId === 42).length).toBe(2);
});

test("hub read failures and missing bindings are visible without any hub write or fabricated completion", async () => {
  for (const value of [{ ...projection(), units: [] }, projection("cancelled")]) {
    const dir = await study(), stop = new AbortController(), fake = fakeDocker([reply(value)]); let resumed = false;
    const result = await runPlan(dir, {}, runtime({ hub: createHubClient(dir, fake.runner), signal: stop.signal,
      sleep: async () => { if (!resumed) { resumed = true; await resume(dir); } else stop.abort(); await Bun.sleep(1); },
    }));
    expect(result.nodes[0]!.status).toBe("failed"); expect(result.nodes[0]!.output).toBeUndefined();
    expect(fake.requests.every(r => r.command === "ahub" && r.args[2] === "study" && r.args[3] === "show")).toBe(true);
    expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).not.toContain("synthetic-private");
  }
});

test("a waiting hub node does not consume the parallel step slot and local cancellation never contacts the hub", async () => {
  const dir = await study([hubNode(), { id: "other", kind: "step", command: "lit.bib", args: {} }]), stop = new AbortController(); let resumed = false, executed = false;
  const fake = fakeHubClient(async () => ({ status: "dispatched", taskId: 42 }));
  await runPlan(dir, { parallel: 1 }, runtime({ hub: fake.client, signal: stop.signal,
    execute: async () => { executed = true; return { status: "done", output: {} }; },
    sleep: async () => { if (!resumed) { resumed = true; await resume(dir); } else if (executed) stop.abort(); await Bun.sleep(1); },
  }));
  expect(executed).toBe(true); const count = fake.calls.length;
  await ops.planControl(dir, { action: "cancel", node: "hub", commandId: "cancel-hub", expectedRevision: 1 }, ctx);
  expect(fake.calls).toHaveLength(count); expect(ops.planShow(dir).nodes[0]!.status).toBe("cancelled");
});


test("a full step slot does not hide a later ready hub reference", async () => {
  const a = (id: string) => ({ id, kind: "step", command: "lit.bib", args: {} });
  const dir = await study([a("busy"), a("queued"), hubNode()]), release = deferred(); let resumed = false, hubRead = false;
  const fake = fakeHubClient(async () => { hubRead = true; release.resolve(); return { status: "done", taskId: 42, output: { taskId: 42 } }; });
  const result = await runPlan(dir, { parallel: 1 }, runtime({ hub: fake.client,
    execute: async n => { if (n.id === "busy") await release.promise; return { status: "done", output: {} }; },
    sleep: async () => { if (!resumed) { resumed = true; await resume(dir); } await Bun.sleep(1); },
  }));
  expect(hubRead).toBe(true); expect(result.state).toBe("done");
});

test("task binding stays pinned through retry within one plan revision and only a new revision may bind a different task", async () => {
  const dir = await study();
  async function runOnce(value: unknown, commandId: string) {
    const stop = new AbortController(), fake = fakeDocker([reply(value)]); let resumed = false;
    const result = await runPlan(dir, {}, runtime({ signal: stop.signal, hub: createHubClient(dir, fake.runner),
      sleep: async () => { if (!resumed) { resumed = true; await resume(dir, commandId); } else stop.abort(); await Bun.sleep(1); },
    }));
    return result;
  }
  const first = await runOnce(projection("cancelled"), "resume-first");
  expect(first.nodes[0]!.taskId).toBe(42);
  await ops.planControl(dir, { action: "retry", node: "hub", commandId: "retry-same", expectedRevision: 1 }, ctx);
  const second = await runOnce(projection("approved", 43), "resume-same");
  expect(second.nodes[0]!.status).toBe("failed"); expect(second.nodes[0]!.taskId).toBe(42);
  expect(second.nodes[0]!.reason).toContain("binding changed");
  await ops.planSet(dir, { v: 1, nodes: [hubNode()], edges: [] }, ctx);
  await ops.planControl(dir, { action: "retry", node: "hub", commandId: "retry-new", expectedRevision: 2 }, ctx);
  const third = await runOnce({ ...projection("approved", 43), revision: 2 }, "resume-new");
  expect(third.nodes[0]!.status).toBe("done"); expect(third.nodes[0]!.taskId).toBe(43);
});

test("production planRun wires the bounded runner hub client without a daemon", async () => {
  const dir = await study(), fake = fakeDocker([reply(projection("approved"))]); let resumed = false;
  const result = await ops.planRun(dir, {}, { ...ctx, runner: fake.runner,
    sleep: async () => { if (!resumed) { resumed = true; await resume(dir); } await Bun.sleep(1); },
  });
  expect(result.state).toBe("done"); expect(fake.remaining()).toBe(0);
  expect(fake.requests).toHaveLength(1); expect(fake.requests[0]!.args).toEqual(["--project", dir, "study", "show", campaign, "--json"]);
});
