import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { foldPlan, planGateBinding } from "../src/plan/state.ts";
import { appendEvent, commit, readLedger, requireGate, openStudy, type Actor } from "../src/study.ts";
import { run } from "../src/cli.ts";
import { createAresMcp, ARES_TOOLS } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor: Actor = { kind: "person" }, ctx = { actor, http: fakeHttp([]).http };
const step = (id: string, needs: string[] = [], query = "synthetic") => ({ id, kind: "step", command: "lit.search", args: { query }, needs });
const definition = () => ({ v: 1, nodes: [step("base"), { id: "approve", kind: "gate", needs: ["base"], binds: ["base"] }, step("final", ["approve"])], edges: [] });
async function study(raw: unknown = definition(), autonomy = "gates") {
  const dir = join(tempDir(), "study"); ops.init(dir, { question: "synthetic", autonomy }, ctx); await ops.planSet(dir, raw, ctx); return dir;
}
const control = (dir: string, action: "pause" | "resume" | "retry" | "cancel" | "skip", commandId: string, node?: string, expectedRevision = 1) => ops.planControl(dir, { action, commandId, expectedRevision, ...(node ? { node } : {}) }, ctx);
const node = (dir: string, id: string) => ops.planShow(dir).nodes.find(n => n.id === id)!;
function observe(dir: string, id: string, status = "done", output: unknown = { hash: "synthetic" }) {
  const revision = ops.planShow(dir).revision;
  appendEvent(dir, actor, "node.intent", { revision, node: id });
  appendEvent(dir, actor, "node.observed", { revision, node: id, status, output });
}

test("ledger fold restores states, readiness and pause without touching study bytes", async () => {
  const dir = await study();
  expect(node(dir, "base").status).toBe("ready"); expect(node(dir, "final").status).toBe("pending");
  await control(dir, "resume", "resume"); observe(dir, "base");
  expect(node(dir, "approve").status).toBe("pending");
  await ops.gateDecide(dir, "plan:approve", "approve", undefined, ctx);
  expect(node(dir, "approve").status).toBe("done"); expect(node(dir, "final").status).toBe("ready");
  observe(dir, "final"); expect(ops.planShow(dir).state).toBe("done");
  const bytes = readFileSync(join(dir, "ledger.jsonl"));
  writeFileSync(join(dir, ".ares.lock"), "live"); writeFileSync(join(dir, ".ares.plan.lock"), "live");
  expect(foldPlan(readLedger(dir))).toEqual(ops.planShow(dir));
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(bytes);
});

test("command-id replay returns original receipt across controls and definition revisions", async () => {
  const dir = await study(); const first = await control(dir, "resume", "id-1");
  const before = readFileSync(join(dir, "ledger.jsonl"));
  expect(await control(dir, "resume", "id-1")).toEqual(first);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  await control(dir, "pause", "id-2"); await ops.planSet(dir, definition(), ctx);
  expect(await control(dir, "resume", "id-1")).toEqual(first);
  expect(ops.planShow(dir).state).toBe("paused");
  const current = readFileSync(join(dir, "ledger.jsonl"));
  await expect(control(dir, "pause", "id-1")).rejects.toThrow("different payload");
  await expect(control(dir, "resume", "fresh", undefined, 1)).rejects.toThrow("stale revision");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(current);
});

test("definition edits invalidate consumed descendants, preserve unrelated work and require explicit retries", async () => {
  const raw = { v: 1, nodes: [step("base"), step("child", ["base"]), step("other")], edges: [] };
  const dir = await study(raw); observe(dir, "base"); observe(dir, "child"); observe(dir, "other");
  await ops.planSet(dir, { ...raw, nodes: [step("base", [], "changed"), step("child", ["base"]), step("other")] }, ctx);
  expect(node(dir, "base").status).toBe("stale"); expect(node(dir, "child").status).toBe("stale"); expect(node(dir, "other").status).toBe("done");
  await control(dir, "resume", "resume-v2", undefined, 2); expect(node(dir, "base").status).toBe("stale");
  await control(dir, "retry", "retry-base", "base", 2); expect(node(dir, "base").status).toBe("ready");
  observe(dir, "base"); expect(node(dir, "child").status).toBe("stale");
  await control(dir, "retry", "retry-child", "child", 2); expect(node(dir, "child").status).toBe("ready");
  appendEvent(dir, actor, "node.observed", { revision: 1, node: "base", status: "failed" });
  expect(node(dir, "base").status).toBe("done");
});

test("skip releases ordinary control dependencies but cannot satisfy any upstream gate", async () => {
  const dir = await study({ v: 1, nodes: [step("base"), step("child", ["base"]), { id: "g", kind: "gate", needs: ["child"], binds: ["base"] }], edges: [] });
  await control(dir, "skip", "skip-base", "base"); expect(node(dir, "child").status).toBe("ready");
  observe(dir, "child");
  expect(node(dir, "g").status).toBe("pending");
  await expect(ops.gateDecide(dir, "plan:g", "approve", undefined, ctx)).rejects.toThrow("nothing to decide");
  await expect(control(dir, "skip", "skip-gate", "g")).rejects.toThrow("cannot skip gate");
  expect(planGateBinding(ops.planShow(dir), "plan:g")).toBeUndefined();
});

test("gate binding changes on upstream output edits and pending auto approvals commit only with success", async () => {
  const dir = await study(definition(), "auto"); observe(dir, "base", "done", { hash: "old" });
  const first = planGateBinding(ops.planShow(dir), "plan:approve");
  const before = readFileSync(join(dir, "ledger.jsonl"));
  const approval = requireGate(dir, openStudy(dir).study, "plan:approve", ops.binder(dir));
  expect(approval[0]?.actor.kind).toBe("auto");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  commit(dir, [], approval); expect(node(dir, "approve").status).toBe("done");
  await control(dir, "retry", "retry-base", "base");
  observe(dir, "base", "done", { hash: "new" });
  expect(planGateBinding(ops.planShow(dir), "plan:approve")).not.toBe(first);
  expect(ops.gateList(dir).find(g => g.gate === "plan:approve")?.state).toBe("pending");
  expect(node(dir, "approve").status).toBe("stale");
  await control(dir, "retry", "retry-gate", "approve");
  expect(node(dir, "approve").status).toBe("pending");

});

test("failed, cancelled and uncertain nodes remain visible; uncertain needs explicit control", async () => {
  const dir = await study({ v: 1, nodes: [step("failed"), step("cancelled"), step("uncertain"), step("active")], edges: [] });
  observe(dir, "failed", "failed"); observe(dir, "cancelled", "cancelled"); observe(dir, "uncertain", "uncertain");
  appendEvent(dir, actor, "node.intent", { revision: 1, node: "active" });
  expect(ops.planShow(dir).uncertain).toEqual(["uncertain"]);
  expect(ops.planShow(dir).nodes.map(n => n.status)).toEqual(["failed", "cancelled", "uncertain", "dispatched"]);
  await control(dir, "pause", "pause"); expect(node(dir, "active").status).toBe("dispatched");
  await control(dir, "resume", "resume"); expect(node(dir, "uncertain").status).toBe("uncertain");
  await control(dir, "retry", "retry", "uncertain"); expect(node(dir, "uncertain").status).toBe("ready");
});

test("CLI and MCP controls and plan gates share receipts and agent attribution", async () => {
  const dir = await study(); const mcp = createAresMcp({}, ctx.http);
  const args = { study: dir, action: "resume", commandId: "shared", expectedRevision: 1 };
  const tool = ARES_TOOLS.find(t => t.name === "ares_plan_control")!;
  expect(validArguments(args, tool.inputSchema)).toBe(true);
  const result = await mcp.handlers.ares_plan_control!(args);
  expect(JSON.parse((await run(["plan", "control", dir, "resume", "--command-id", "shared", "--expected-revision", "1", "--json"], {}, { http: ctx.http })).text)).toEqual(result);
  expect(readLedger(dir).filter(e => e.type === "plan.control")).toHaveLength(1);
  expect(readLedger(dir).find(e => e.type === "plan.control")!.actor.kind).toBe("agent");
  observe(dir, "base"); await mcp.handlers.ares_gate!({ study: dir, action: "approve", gate: "plan:approve" });
  expect(node(dir, "approve").status).toBe("done");
});


test("skipping an intermediate step cannot release work past a pending ancestor gate", async () => {
  const dir = await study({ v: 1, nodes: [step("base"), { id: "g", kind: "gate", needs: ["base"], binds: ["base"] }, step("middle", ["g"]), step("last", ["middle"])], edges: [] });
  await control(dir, "skip", "skip-middle", "middle");
  expect(node(dir, "last").status).toBe("pending");
  observe(dir, "base"); expect(node(dir, "last").status).toBe("pending");
  await ops.gateDecide(dir, "plan:g", "approve", undefined, ctx);
  expect(node(dir, "last").status).toBe("ready");
});

test("gate rejection invalidates completed consumers and done without output references cannot pass a gate", async () => {
  const dir = await study(); observe(dir, "base");
  await ops.gateDecide(dir, "plan:approve", "approve", undefined, ctx); observe(dir, "final");
  await ops.gateDecide(dir, "plan:approve", "reject", "recheck", ctx);
  expect(node(dir, "final").status).toBe("stale");
  const other = await study();
  appendEvent(other, actor, "node.intent", { revision: 1, node: "base" });
  appendEvent(other, actor, "node.observed", { revision: 1, node: "base", status: "done" });
  expect(planGateBinding(ops.planShow(other), "plan:approve")).toBeUndefined();
  await expect(ops.gateDecide(other, "plan:approve", "approve", undefined, ctx)).rejects.toThrow("nothing to decide");
});


test("unconsumed definition edits stay ready, and invalid controls leave the ledger unchanged", async () => {
  const dir = await study();
  const raw = definition(); raw.nodes[0] = step("base", [], "edited before consumption");
  await ops.planSet(dir, raw, ctx); expect(node(dir, "base").status).toBe("ready");
  const before = readFileSync(join(dir, "ledger.jsonl"));
  for (const input of [
    { action: "retry", node: "base", commandId: "retry", expectedRevision: 2 },
    { action: "skip", node: "missing", commandId: "missing", expectedRevision: 2 },
    { action: "pause", node: "base", commandId: "extra-node", expectedRevision: 2 },
    { action: "cancel", commandId: "no-node", expectedRevision: 2 },
  ] as const) await expect(ops.planControl(dir, input, ctx)).rejects.toThrow("run ares plan show");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});


test("uncertain missing attempt records can be explicitly retried or cancelled", async () => {
  for (const action of ["retry", "cancel"] as const) {
    const dir = join(tempDir(), "study"); ops.init(dir, { question: "synthetic", mode: "experiment" }, ctx);
    await ops.planSet(dir, { v: 1, nodes: [step("base")], edges: [] }, ctx);
    appendEvent(dir, actor, "node.intent", { revision: 1, node: "base", attemptId: "a".repeat(16) });
    appendEvent(dir, actor, "node.observed", { revision: 1, node: "base", status: "uncertain", reason: "missing record" });
    const result = await control(dir, action, action, "base");
    expect(result.status).toBe(action === "retry" ? "ready" : "cancelled");
    expect(readLedger(dir).filter(e => e.type === "attempt.started")).toHaveLength(0);
  }
});


test("cancelling an undispatched step never touches attempt storage or any runner", async () => {
  const dir = await study();
  const forbidden = async () => { throw new Error("runner must not be called"); };
  const result = await ops.planControl(dir, { action: "cancel", node: "base", commandId: "cancel-undispatched", expectedRevision: 1 }, { ...ctx, runner: forbidden });
  expect(result.status).toBe("cancelled");
  expect(node(dir, "base").status).toBe("cancelled");
  expect(readLedger(dir).filter(e => e.type.startsWith("attempt."))).toHaveLength(0);
});

test("cancelling a dispatched hub node is local only and preserves the referenced task", async () => {
  const dir = await study({ v: 1, nodes: [{ id: "hub", kind: "hub", campaign: "c-7", unit: "u2" }], edges: [] });
  appendEvent(dir, actor, "node.intent", { revision: 1, node: "hub", taskId: 42 });
  let calls = 0;
  const runner = async () => { calls++; throw new Error("hub subprocess must not be called"); };
  const result = await ops.planControl(dir, { action: "cancel", node: "hub", commandId: "cancel-hub", expectedRevision: 1 }, { ...ctx, runner });
  expect(result.status).toBe("cancelled"); expect(calls).toBe(0);
  expect(node(dir, "hub").taskId).toBe(42);
  expect(readLedger(dir).filter(e => e.type.startsWith("attempt."))).toHaveLength(0);
});

test("stale and uncertain retry admits a new current-revision intent while preserving old observations", async () => {
  for (const outcome of ["done", "uncertain"] as const) {
    const dir = await study({ v: 1, nodes: [step("base")], edges: [] });
    observe(dir, "base", outcome, { hash: "old-reference" });
    const observed = readLedger(dir).find(e => e.type === "node.observed")!;
    if (outcome === "done") await ops.planSet(dir, { v: 1, nodes: [step("base", [], "changed")], edges: [] }, ctx);
    const revision = ops.planShow(dir).revision;
    expect(node(dir, "base").status).toBe(outcome === "done" ? "stale" : "uncertain");
    await control(dir, "retry", "explicit-retry", "base", revision);
    expect(node(dir, "base").status).toBe("ready");
    expect(node(dir, "base").output).toBeUndefined();
    appendEvent(dir, actor, "node.intent", { revision, node: "base" });
    expect(node(dir, "base").status).toBe("dispatched");
    expect(node(dir, "base").lastObserved).toMatchObject({ revision: 1, status: outcome, output: { hash: "old-reference" } });
    expect(readLedger(dir).filter(e => e.type === "node.observed")).toEqual([observed]);
    expect(readLedger(dir).filter(e => e.type === "node.intent").at(-1)!.data.revision).toBe(revision);
  }
});
