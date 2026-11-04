import { assertPlanOwner, commit, openStudy, readLedger, requireGate, withLock, withPlanLock, type Actor, type PendingEvent, type PlanOwner } from "../study.ts";
import { canonical, nextDispatchId, planGateBinding, readPlanState, type NodeState, type PlanState } from "./state.ts";
import type { PlanNode } from "./definition.ts";

export type StepNode = Extract<PlanNode, { kind: "step" }>;
export interface Observation { status: "dispatched" | "done" | "failed" | "cancelled" | "uncertain"; output?: unknown; reason?: string }
export interface ControllerRuntime {
  actor: Actor;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  prepare: (node: StepNode, state: NodeState) => Promise<{ attemptId?: string }>;
  execute: (node: StepNode, state: NodeState) => Promise<Observation>;
  reconcile: (node: StepNode, state: NodeState) => Promise<Observation>;
}
export interface ControllerOptions { parallel?: number }
const delay = (ms: number, signal?: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve(); };
  const timer = setTimeout(finish, ms); signal?.addEventListener("abort", finish, { once: true });
});
async function transaction<T>(dir: string, fn: () => T): Promise<T> {
  const deadline = performance.now() + 2000;
  for (;;) {
    try { return await withLock(dir, fn); }
    catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("study is locked by another ares command") || performance.now() >= deadline) throw error;
      await delay(50);
    }
  }
}
/** One controller, short transactional study locks, and no replay of unobserved actions. */
export async function runPlan(dirArg: string, options: ControllerOptions, runtime: ControllerRuntime): Promise<PlanState> {
  const { dir, study } = openStudy(dirArg), parallel = options.parallel ?? 1;
  if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 8) throw new Error("run --parallel: integer in 1..8 required; run ares run <dir> --parallel 1..8");
  return withPlanLock(dir, async owner => {
    const state = () => readPlanState(dir, readLedger(dir));
    const locked = <T>(fn: () => T) => transaction(dir, () => { assertPlanOwner(dir, owner); return fn(); });
    const observe = async (node: NodeState, observation: Observation) => locked(() => {
      const current = state(), target = current.nodes.find(n => n.id === node.id);
      if (!target || target.dispatchId !== node.dispatchId || !["dispatched", "uncertain"].includes(target.status)) return;
      if (observation.status === "dispatched" && target.status === "dispatched" && target.lastObserved && target.lastObserved.dispatchId === node.dispatchId && target.lastObserved.status === "dispatched" && target.reason === observation.reason) return;
      commit(dir, [], [{ actor: runtime.actor, type: "node.observed", data: { revision: current.revision, node: node.id, dispatchId: node.dispatchId, ...observation } }]);
    });
    const reconcile = async (node: NodeState): Promise<void> => {
      const definition = state().definition.nodes.find(n => n.id === node.id);
      if (!definition || definition.kind === "hub") return; // T4 owns read-only hub observations.
      let observation: Observation;
      if (definition.kind !== "step" || definition.command !== "attempt.run") observation = { status: "uncertain", reason: "step result unavailable after interruption; explicitly retry or skip this node" };
      else {
        try { observation = await runtime.reconcile(definition, node); }
        catch { observation = { status: "dispatched", reason: "attempt observation unavailable; check the executor and run ares attempt reconcile" }; }
      }
      await observe(node, observation);
    };
    await locked(() => {
      const current = state();
      if (current.state === "running") commit(dir, [], [{ actor: runtime.actor, type: "plan.paused", data: { revision: current.revision, reason: "controller startup restores paused" } }]);
    });
    for (const node of state().nodes.filter(n => n.status === "dispatched")) await reconcile(node);
    const active = new Map<string, Promise<void>>();
    const launch = (definition: StepNode, node: NodeState) => {
      const work = (async () => {
        let observation: Observation;
        try { observation = await runtime.execute(definition, node); }
        catch {
          if (definition.command === "attempt.run") { await reconcile(node); return; }
          observation = { status: "uncertain", reason: "step execution interrupted or failed without an observable result; inspect inputs, then retry or skip this node" };
        }
        await observe(node, observation);
      })();
      active.set(node.id, work);
      // The main loop awaits every task; failures are consumed immediately to prevent unhandled rejection.
      void work.catch(() => {});
    };
    let failure: unknown;
    try {
      while (!runtime.signal?.aborted) {
        let current = state();
        if (current.state === "done") break;
        if (current.state === "running") {
          // Pending auto gates are approved only inside a successful controller transaction.
          await locked(() => {
            const events = readLedger(dir), value = readPlanState(dir, events), approvals: PendingEvent[] = [];
            if (value.state !== "running") return;
            for (const gate of value.nodes.filter(n => n.kind === "gate" && n.status === "pending" && n.gate?.state === "pending")) {
              if (study.autonomy === "auto") approvals.push(...requireGate(dir, study, `plan:${gate.id}`, name => planGateBinding(value, name)));
            }
            if (approvals.length) commit(dir, [], [...approvals, { actor: runtime.actor, type: "plan.gates", data: { revision: value.revision } }]);
          });
          current = state();
          for (const node of current.nodes) {
            if (runtime.signal?.aborted || current.state !== "running") break;
            const definition = current.definition.nodes.find(n => n.id === node.id)!;
            if (definition.kind !== "step" || node.status !== "ready" || active.has(node.id)) continue;
            const slots = current.nodes.filter(n => n.status === "dispatched").length;
            if (slots >= parallel) break;
            // A2 permits one active experiment attempt per study.
            if (definition.command === "attempt.run" && current.nodes.some(n => n.status === "dispatched" && current.definition.nodes.find(d => d.id === n.id)?.kind === "step" && (current.definition.nodes.find(d => d.id === n.id) as StepNode).command === "attempt.run")) continue;
            let prepared: { attemptId?: string };
            try { prepared = await runtime.prepare(definition, node); }
            catch { // Preparation is read-only; still record a correlated failed dispatch for visibility.
              prepared = {};
              const intent = await admit(dir, owner, runtime.actor, current, node, definition, prepared, parallel);
              if (intent) await observe(intent, { status: "failed", reason: "step preparation failed; check command inputs and retry this node" });
              current = state(); continue;
            }
            const intent = await admit(dir, owner, runtime.actor, current, node, definition, prepared, parallel);
            if (intent) launch(definition, intent);
            current = state();
          }
        }
        // Detached attempts are observed while paused too, without admitting new work.
        for (const node of state().nodes.filter(n => n.status === "dispatched" && !active.has(n.id))) await reconcile(node);
        if (state().state === "done") break;
        if (active.size) {
          const settled = await Promise.race([...active].map(async ([id, work]) => { await work; return id; }).concat([(runtime.sleep ? runtime.sleep(50) : delay(50, runtime.signal)).then(() => "")]));
          if (settled) { await active.get(settled); active.delete(settled); }
        } else await (runtime.sleep ? runtime.sleep(250) : delay(250, runtime.signal));
      }
    } catch (error) { failure = error; }
    // Pause stops admission, drains this process's command calls, and leaves detached attempts alive.
    await Promise.allSettled(active.values());
    await locked(() => { const current = state(); if (current.state === "running") commit(dir, [], [{ actor: runtime.actor, type: "plan.paused", data: { revision: current.revision, reason: "controller stopped" } }]); });
    if (failure) throw failure;
    return state();
  });
}
async function admit(dir: string, owner: PlanOwner, actor: Actor, snapshot: PlanState, node: NodeState, definition: StepNode, prepared: { attemptId?: string }, parallel: number): Promise<NodeState | undefined> {
  return transaction(dir, () => {
    assertPlanOwner(dir, owner);
    const current = readPlanState(dir, readLedger(dir)), target = current.nodes.find(n => n.id === node.id);
    if (current.state !== "running" || current.revision !== snapshot.revision || target?.status !== "ready" || canonical(current.definition.nodes.find(n => n.id === node.id)) !== canonical(definition) || current.nodes.filter(n => n.status === "dispatched").length >= parallel) return undefined;
    const dispatchId = nextDispatchId(current, node.id);
    commit(dir, [], [{ actor, type: "node.intent", data: { revision: current.revision, node: node.id, dispatchId, ...prepared } }]);
    return readPlanState(dir, readLedger(dir)).nodes.find(n => n.id === node.id)!;
  });
}
