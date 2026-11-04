import { boundHubTask, type HubClient, type HubObservation } from "./hub.ts";
import { assertPlanOwner, commit, openStudy, readLedger, requireGate, withLock, withPlanLock, StudyLockBusyError, type Actor, type PendingEvent, type PlanOwner } from "../study.ts";
import { canonical, nextDispatchId, planGateBinding, readPlanState, type NodeState, type PlanState } from "./state.ts";
import type { PlanNode } from "./definition.ts";

export type StepNode = Extract<PlanNode, { kind: "step" }>;
export type HubNode = Extract<PlanNode, { kind: "hub" }>;
export interface Observation { status: "dispatched" | "done" | "failed" | "cancelled" | "uncertain"; output?: unknown; reason?: string; progress?: string; taskId?: number }
export interface ControllerRuntime {
  actor: Actor;
  hub?: HubClient;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
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
async function tryTransaction<T>(dir: string, fn: () => T): Promise<{ value: T } | undefined> {
  try { return { value: await withLock(dir, fn) }; }
  catch (error) { if (error instanceof StudyLockBusyError) return undefined; throw error; }
}
async function transaction<T>(dir: string, fn: () => T): Promise<T> {
  let wait = 50;
  for (;;) {
    const result = await tryTransaction(dir, fn);
    if (result) return result.value;
    await delay(wait); wait = Math.min(wait * 2, 1000);
  }
}
/** One controller, short transactional study locks, and no replay of unobserved actions. */
export async function runPlan(dirArg: string, options: ControllerOptions, runtime: ControllerRuntime): Promise<PlanState> {
  const { dir, study } = openStudy(dirArg), parallel = options.parallel ?? 1;
  if (!Number.isSafeInteger(parallel) || parallel < 1 || parallel > 8) throw new Error("run --parallel: integer in 1..8 required; run ares run <dir> --parallel 1..8");
  return withPlanLock(dir, async owner => {
    const state = () => readPlanState(dir, readLedger(dir));
    const clock = runtime.clock ?? (() => performance.now());
    const sleep = (ms: number) => runtime.sleep ? runtime.sleep(ms) : delay(ms, runtime.signal);
    const polls = new Map<string, { at: number; wait: number; signature: string }>();
    const schedule = (node: NodeState, observation: Observation) => {
      if (!node.dispatchId) return;
      if (observation.status !== "dispatched") { polls.delete(node.dispatchId); return; }
      const previous = polls.get(node.dispatchId), signature = canonical(observation);
      const wait = previous?.signature === signature ? Math.min(previous.wait * 2, 30_000) : 1000;
      polls.set(node.dispatchId, { at: clock() + wait, wait, signature });
    };
    const locked = <T>(fn: () => T) => transaction(dir, () => { assertPlanOwner(dir, owner); return fn(); });
    const observe = async (node: NodeState, observation: Observation) => {
      const target = state().nodes.find(n => n.id === node.id);
      if (!target || target.dispatchId !== node.dispatchId || !["dispatched", "uncertain"].includes(target.status)) return;
      if (observation.status === "dispatched" && target.lastObserved?.dispatchId === node.dispatchId && target.reason === observation.reason && (observation.taskId === undefined || target.taskId === observation.taskId)) return;
      return locked(() => {
      const current = state(), target = current.nodes.find(n => n.id === node.id);
      if (!target || target.dispatchId !== node.dispatchId || !["dispatched", "uncertain"].includes(target.status)) return;
      if (observation.status === "dispatched" && target.status === "dispatched" && target.lastObserved && target.lastObserved.dispatchId === node.dispatchId && target.lastObserved.status === "dispatched" && target.reason === observation.reason && (observation.taskId === undefined || target.taskId === observation.taskId)) return;
      commit(dir, [], [{ actor: runtime.actor, type: "node.observed", data: { revision: current.revision, node: node.id, dispatchId: node.dispatchId, status: observation.status, ...(observation.output !== undefined ? { output: observation.output } : {}), ...(observation.reason !== undefined ? { reason: observation.reason } : {}), ...(observation.taskId !== undefined ? { taskId: observation.taskId } : {}) } }]);
      });
    };
    const reconcile = async (node: NodeState): Promise<void> => {
      const definition = state().definition.nodes.find(n => n.id === node.id);
      if (!definition || (definition.kind === "hub" && !runtime.hub)) return;
      let observation: Observation;
      if (definition.kind === "hub") {
        try { observation = await runtime.hub!.observe(definition.campaign, definition.unit, node.taskId); }
        catch { observation = { status: "dispatched", reason: "hub read unavailable; check ahub study show and restore hub access" }; }
      } else if (definition.kind !== "step" || definition.command !== "attempt.run") observation = { status: "uncertain", reason: "step result unavailable after interruption; explicitly retry or skip this node" };
      else {
        try { observation = await runtime.reconcile(definition, node); }
        catch (error) { if (error instanceof StudyLockBusyError) { schedule(node, { status: "dispatched", reason: node.reason }); return; } observation = { status: "dispatched", reason: "attempt observation unavailable; check the executor and run ares attempt reconcile" }; }
      }
      await observe(node, observation); schedule(node, observation);
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
        let wait = 1000;
        for (;;) {
          const current = state().nodes.find(n => n.id === node.id);
          if (runtime.signal?.aborted || !current || current.dispatchId !== node.dispatchId || current.status !== "dispatched") return;
          assertPlanOwner(dir, owner);
          try { observation = await runtime.execute(definition, node); break; }
          catch (error) {
            if (error instanceof StudyLockBusyError) { await sleep(wait); wait = Math.min(wait * 2, 30_000); continue; }
            if (definition.command === "attempt.run") { await reconcile(node); return; }
            observation = { status: "uncertain", reason: "step execution interrupted or failed without an observable result; inspect inputs, then retry or skip this node" }; break;
          }
        }
        await observe(node, observation); schedule(node, observation);
      })();
      active.set(node.id, work);
      // The main loop awaits every task; failures are consumed immediately to prevent unhandled rejection.
      void work.catch(() => {});
    };
    let failure: unknown, wait = 500, fingerprint = canonical(state());
    try {
      while (!runtime.signal?.aborted) {
        let current = state();
        if (current.state === "done") break;
        if (current.state === "running") {
          // Pending auto gates are approved only inside a successful controller transaction.
          if (study.autonomy === "auto" && current.nodes.some(n => n.kind === "gate" && n.status === "pending" && n.gate?.state === "pending")) await tryTransaction(dir, () => {
            assertPlanOwner(dir, owner);
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
            if (node.status !== "ready" || active.has(node.id)) continue;
            if (definition.kind === "hub" && runtime.hub) {
              const binding = boundHubTask(readLedger(dir), current.revision, node.id);
              let result: HubObservation;
              try { result = await runtime.hub.observe(definition.campaign, definition.unit, binding); }
              catch { result = { status: "dispatched", reason: "hub read unavailable; check ahub study show and restore hub access" }; }
              const intent = await admit(dir, owner, runtime.actor, current, node, definition, result.taskId !== undefined ? { taskId: result.taskId } : {}, parallel);
              if (intent) { await observe(intent, result); schedule(intent, result); }
              current = state(); continue;
            }
            if (definition.kind !== "step") continue;
            const slots = stepSlots(current);
            if (slots >= parallel) continue;
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
        for (const node of state().nodes.filter(n => n.status === "dispatched" && !active.has(n.id))) {
          if (clock() >= (polls.get(node.dispatchId!)?.at ?? 0)) await reconcile(node);
        }
        if (state().state === "done") break;
        const next = canonical(state());
        wait = next === fingerprint ? Math.min(wait * 2, 30_000) : 1000; fingerprint = next;
        const live = new Set(state().nodes.filter(n => n.status === "dispatched").map(n => n.dispatchId));
        for (const id of polls.keys()) if (!live.has(id)) polls.delete(id);
        const due = [...polls.values()].map(p => Math.max(1, p.at - clock()));
        const interval = Math.min(wait, ...(due.length ? due : [30_000]));
        if (active.size) {
          const settled = await Promise.race([...active].map(async ([id, work]) => { await work; return id; }).concat([sleep(interval).then(() => "")]));
          if (settled) { await active.get(settled); active.delete(settled); }
        } else await sleep(interval);
      }
    } catch (error) { failure = error; }
    // Pause stops admission, drains this process's command calls, and leaves detached attempts alive.
    await Promise.allSettled(active.values());
    await locked(() => { const current = state(); if (current.state === "running") commit(dir, [], [{ actor: runtime.actor, type: "plan.paused", data: { revision: current.revision, reason: "controller stopped" } }]); });
    if (failure) throw failure;
    return state();
  });
}
async function admit(dir: string, owner: PlanOwner, actor: Actor, snapshot: PlanState, node: NodeState, definition: StepNode | HubNode, prepared: { attemptId?: string; taskId?: number }, parallel: number): Promise<NodeState | undefined> {
  const result = await tryTransaction(dir, () => {
    assertPlanOwner(dir, owner);
    const current = readPlanState(dir, readLedger(dir)), target = current.nodes.find(n => n.id === node.id);
    if (current.state !== "running" || current.revision !== snapshot.revision || target?.status !== "ready" || canonical(current.definition.nodes.find(n => n.id === node.id)) !== canonical(definition) || (definition.kind === "step" && stepSlots(current) >= parallel)) return undefined;
    const dispatchId = nextDispatchId(current, node.id);
    commit(dir, [], [{ actor, type: "node.intent", data: { revision: current.revision, node: node.id, dispatchId, ...prepared } }]);
    return readPlanState(dir, readLedger(dir)).nodes.find(n => n.id === node.id)!;
  });
  return result?.value;
}

function stepSlots(state: PlanState): number {
  return state.nodes.filter(n => n.kind === "step" && n.status === "dispatched").length;
}
