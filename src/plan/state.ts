import { gateState, plain, sha256, boundedText, onlyKeys, type Actor, type GateName, type GateState, type LedgerEvent, type PendingEvent } from "../study.ts";
import { readPlan, validatePlan, type PlanDefinition, type PlanNode } from "./definition.ts";

export type NodeStatus = "pending" | "ready" | "dispatched" | "done" | "failed" | "cancelled" | "uncertain" | "stale" | "skipped";
export interface NodeState { id: string; kind: PlanNode["kind"]; status: NodeStatus; dispatchId?: string; dispatchCount?: number; retryOf?: string; output?: unknown; attemptId?: string; taskId?: number; reason?: string; gate?: GateState; lastObserved?: { revision: number; dispatchId: string; status: NodeStatus; at: string; output?: unknown; reason?: string } }
export interface ControlRequest { action: "pause" | "resume" | "retry" | "cancel" | "skip"; node?: string; commandId: string; expectedRevision: number }
export interface ControlResult { commandId: string; revision: number; action: ControlRequest["action"]; node?: string; state: "paused" | "running" | "done"; status?: NodeStatus }
export interface PlanState { definition: PlanDefinition; revision: number; state: "paused" | "running" | "done"; nodes: NodeState[]; uncertain: string[] }
const statuses: readonly NodeStatus[] = ["pending", "ready", "dispatched", "done", "failed", "cancelled", "uncertain", "stale", "skipped"];
const recovery = "; run ares plan show and retry with its revision and a new --command-id";
function bad(message: string): never { throw new Error(`plan: ${message}${recovery}`); }
/** Stable JSON ordering makes hashes independent of dictionary insertion order. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function dependencies(definition: PlanDefinition, id: string): string[] {
  return [...new Set([...(definition.nodes.find(n => n.id === id)?.needs ?? []), ...definition.edges.filter(e => e[1] === id).map(e => e[0])])].sort();
}
export function ancestors(definition: PlanDefinition, id: string): string[] {
  const found = new Set<string>();
  function visit(node: string) { for (const parent of dependencies(definition, node)) if (!found.has(parent)) { found.add(parent); visit(parent); } }
  visit(id); return [...found].sort();
}
function descendants(definition: PlanDefinition, roots: Set<string>): Set<string> {
  const found = new Set(roots);
  for (let changed = true; changed;) {
    changed = false;
    for (const node of definition.nodes) if (!found.has(node.id) && dependencies(definition, node.id).some(p => found.has(p))) { found.add(node.id); changed = true; }
  }
  return found;
}
function reset(node: NodeState, status: NodeStatus): void {
  node.status = status; delete node.output; delete node.reason; delete node.gate;
  delete node.dispatchId;
  // A retry must create a child attempt, while hub task references stay read-only.
  if (status === "pending" && node.attemptId) { node.retryOf = node.attemptId; delete node.attemptId; }
}
function consumed(node: NodeState): boolean { return node.status !== "pending" && node.status !== "ready"; }
export function nextDispatchId(state: PlanState, id: string): string {
  const node = state.nodes.find(n => n.id === id);
  if (!node) bad(`dispatch references missing node ${id}`);
  return `${state.revision}:${id}:${(node.dispatchCount ?? 0) + 1}`;
}
function dispatchIdentity(value: unknown, node: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 256) bad(`node ${node}: dispatchId must be nonempty text of at most 256 bytes; record the intent id on its observation`);
  return value;
}
export function planGateBinding(state: PlanState, gate: GateName): string | undefined {
  if (!gate.startsWith("plan:")) return undefined;
  const id = gate.slice(5), node = state.definition.nodes.find(n => n.id === id);
  if (!node || node.kind !== "gate") return undefined;
  const upstream = ancestors(state.definition, id);
  const refs = [];
  for (const parent of upstream) {
    const value = state.nodes.find(n => n.id === parent)!;
    if (value.status !== "done" || value.output === undefined) return undefined;
    refs.push({ node: parent, output: value.output ?? null });
  }
  return sha256(canonical({ gate: node, upstream: refs }));
}
function refresh(state: PlanState, decisions: Map<string, LedgerEvent>): void {
  // A topological traversal prevents declaration order from changing gate release.
  const visited = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    for (const parent of dependencies(state.definition, id)) visit(parent);
    visited.add(id);
    const definition = state.definition.nodes.find(n => n.id === id)!, node = state.nodes.find(n => n.id === id)!;
    if (definition.kind === "gate") {
      const gate: GateName = `plan:${id}`;
      const oldStatus = node.status;
      node.gate = gateState(gate, [...decisions.values()], name => planGateBinding(state, name));
      if (node.status === "stale" || node.status === "cancelled") return;
      if (node.gate.state === "approved") { node.status = "done"; node.output = { binding: node.gate.current }; }
      else { node.status = "pending"; delete node.output; }
      if (oldStatus === "done" && node.status !== "done") for (const child of state.nodes) if (child.id !== id && descendants(state.definition, new Set([id])).has(child.id) && !["pending", "ready"].includes(child.status)) reset(child, "stale");
    } else if (node.status === "pending" || node.status === "ready") {
      node.status = dependencies(state.definition, id).every(parent => {
        const previous = state.nodes.find(n => n.id === parent)!;
        return previous.status === "done" || (previous.kind !== "gate" && previous.status === "skipped");
      }) && ancestors(state.definition, id).every(parent => {
        const previous = state.nodes.find(n => n.id === parent)!;
        return previous.kind !== "gate" || previous.status === "done";
      }) ? "ready" : "pending";
    }
  }
  for (const node of state.definition.nodes) visit(node.id);
  state.uncertain = state.nodes.filter(n => n.status === "uncertain").map(n => n.id);
  if (state.nodes.length && state.nodes.every(n => n.status === "done" || n.status === "skipped")) state.state = "done";
  else if (state.state === "done") state.state = "paused";
}
/** Sole state authority: replay ledger events; no cache or snapshot is written. */
export function foldPlan(events: LedgerEvent[]): PlanState | undefined {
  let state: PlanState | undefined;
  const decisions = new Map<string, LedgerEvent>();
  const dispatches = new Set<string>();
  for (const event of events) {
    const d = event.data;
    if (event.type === "gate.approve" || event.type === "gate.reject") {
      if (typeof d.gate === "string") decisions.set(d.gate, event);
      if (state) refresh(state, decisions);
      continue;
    }
    if (event.type === "plan.set") {
      const definition = validatePlan(d.definition);
      if (definition.revision !== d.revision || (state && definition.revision <= state.revision)) bad("plan.set has invalid revision; restore the last valid ledger");
      const previous = state;
      const changed = new Set<string>();
      if (previous) for (const node of previous.definition.nodes) {
        const next = definition.nodes.find(n => n.id === node.id);
        if ((!next || canonical(node) !== canonical(next) || canonical(dependencies(previous.definition, node.id)) !== canonical(dependencies(definition, node.id))) && !["pending", "ready"].includes(previous.nodes.find(n => n.id === node.id)!.status)) changed.add(node.id);
      }
      const stale = descendants(definition, descendants(previous?.definition ?? definition, changed));
      state = { definition, revision: definition.revision, state: "paused", nodes: definition.nodes.map(n => {
        const old = previous?.nodes.find(p => p.id === n.id);
        if (!old) return { id: n.id, kind: n.kind, status: "pending" };
        const value = { ...old, kind: n.kind };
        if (stale.has(n.id) && consumed(value)) reset(value, "stale");
        return value;
      }), uncertain: [] };
      refresh(state, decisions); continue;
    }
    if (!state) continue;
    if (!["plan.control", "plan.paused", "node.intent", "node.observed", "node.stale"].includes(event.type)) continue;
    if (event.type !== "node.observed" && d.revision !== state.revision) continue;
    if (event.type === "plan.paused") state.state = "paused";
    else if (event.type === "plan.control") {
      const request = validateControl(d.request);
      if (request.expectedRevision !== state.revision) bad("plan.control revision mismatch; restore the last valid ledger");
      if (request.action === "pause") state.state = "paused";
      else if (request.action === "resume") state.state = "running";
      else {
        const target = state.nodes.find(n => n.id === request.node);
        if (!target) bad(`control references missing node ${request.node}`);
        const affected = descendants(state.definition, new Set([target.id]));
        for (const node of state.nodes) if (affected.has(node.id) && node.id !== target.id && consumed(node)) reset(node, "stale");
        reset(target, request.action === "retry" ? "pending" : request.action === "skip" ? "skipped" : "cancelled");
      }
    } else {
      const node = state.nodes.find(n => n.id === d.node);
      if (!node) {
        if (event.type === "node.observed") continue; // Removed nodes have no current dispatch.
        bad(`${event.type} references missing node ${String(d.node)}`);
      }
      if (event.type === "node.stale") {
        for (const value of state.nodes) if (descendants(state.definition, new Set([node.id])).has(value.id) && consumed(value)) reset(value, "stale");
      } else if (event.type === "node.intent") {
        if (node.status !== "ready") bad(`node.intent ${node.id} is ${node.status}, not ready; reconcile the ledger before dispatch`);
        const dispatchId = dispatchIdentity(d.dispatchId, node.id), key = canonical([node.id, dispatchId]);
        if (dispatches.has(key)) bad(`node ${node.id}: dispatchId ${dispatchId} is already used; choose a fresh dispatch id`);
        dispatches.add(key); node.dispatchId = dispatchId; node.dispatchCount = (node.dispatchCount ?? 0) + 1;
        node.status = "dispatched";
        if (typeof d.attemptId === "string") node.attemptId = d.attemptId;
        if (Number.isSafeInteger(d.taskId)) node.taskId = d.taskId as number;
      } else {
        const dispatchId = dispatchIdentity(d.dispatchId, node.id);
        if (dispatchId !== node.dispatchId || !Number.isSafeInteger(d.revision) || (d.revision as number) > state.revision) continue;
        if (!statuses.includes(d.status as NodeStatus) || !["done", "failed", "cancelled", "uncertain", "dispatched"].includes(d.status as string)) bad(`node.observed ${node.id} has unknown status ${String(d.status)}`);
        if (node.status !== "dispatched" && node.status !== "uncertain") continue;
        if (d.taskId !== undefined) {
          if (node.kind !== "hub" || !Number.isSafeInteger(d.taskId) || (d.taskId as number) < 1 || (node.taskId !== undefined && node.taskId !== d.taskId)) bad(`node.observed ${node.id}: child task binding changed or invalid; restore the committed binding before retry`);
          node.taskId = d.taskId as number;
        }
        node.status = d.status as NodeStatus;
        if (node.status === "done" && d.output !== undefined) node.output = d.output;
        delete node.reason;
        if (typeof d.reason === "string") node.reason = boundedText(d.reason, `node ${node.id} reason`, 500);
        node.lastObserved = { revision: d.revision as number, dispatchId, status: node.status, at: event.at, ...(d.output !== undefined ? { output: d.output } : {}), ...(node.reason !== undefined ? { reason: node.reason } : {}) };
      }
    }
    refresh(state, decisions);
  }
  return state;
}
export function readPlanState(dir: string, events: LedgerEvent[]): PlanState {
  const definition = readPlan(dir), state = foldPlan(events);
  if (!definition || !state) bad("no committed definition; run ares plan set first");
  if (canonical(definition) !== canonical(state.definition)) bad("plan.json and ledger definition differ; restore the last committed plan.json");
  return state;
}
export function validateControl(raw: unknown): ControlRequest {
  try { return controlRequest(raw); }
  catch (error) {
    const message = error instanceof Error ? error.message : "plan control: invalid request";
    throw new Error(message.includes(recovery) ? message : `${message}${recovery}`);
  }
}
function controlRequest(raw: unknown): ControlRequest {
  if (!plain(raw)) bad("control requires an object");
  onlyKeys(raw, ["action", "node", "commandId", "expectedRevision"], "plan control");
  if (!["pause", "resume", "retry", "cancel", "skip"].includes(raw.action as string)) bad(`unknown control action ${String(raw.action)}`);
  const commandId = boundedText(raw.commandId, "plan control command-id", 128);
  if (Buffer.byteLength(commandId) > 128) bad("control command-id exceeds 128 bytes");
  if (!Number.isSafeInteger(raw.expectedRevision) || (raw.expectedRevision as number) < 1) bad("control expected-revision must be a positive safe integer");
  const action = raw.action as ControlRequest["action"];
  const node = raw.node === undefined ? undefined : boundedText(raw.node, "plan control node", 128);
  if (node !== undefined && Buffer.byteLength(node) > 128) bad("control node exceeds 128 bytes");
  if ((action === "pause" || action === "resume") ? node !== undefined : node === undefined) bad(`control ${action} ${node === undefined ? "requires a node" : "takes no node"}`);
  return { action, commandId, expectedRevision: raw.expectedRevision as number, ...(node !== undefined ? { node } : {}) };
}
export function prepareControl(state: PlanState, events: LedgerEvent[], raw: unknown, actor: Actor): { result: ControlResult; event?: PendingEvent } {
  const request = validateControl(raw);
  for (const e of events) if (e.type === "plan.control" && plain(e.data.request) && e.data.request.commandId === request.commandId) {
    if (canonical(e.data.request) !== canonical(request)) bad(`command-id ${request.commandId} already has a different payload`);
    if (!plain(e.data.result)) bad(`command-id ${request.commandId} has no receipt; restore its ledger entry`);
    return { result: e.data.result as unknown as ControlResult };
  }
  if (request.expectedRevision !== state.revision) bad(`stale revision ${request.expectedRevision}, current is ${state.revision}`);
  if (request.node !== undefined) {
    const node = state.nodes.find(n => n.id === request.node);
    if (!node) bad(`control references missing node ${request.node}`);
    if (request.action === "cancel" && node.status === "done") bad(`cannot cancel completed node ${node.id}; retry it explicitly if another execution is needed`);
    if (request.action === "skip" && (node.kind === "gate" || node.status === "dispatched" || node.status === "done")) bad(`cannot skip ${node.kind} node ${node.id} in ${node.status}; approve its gate or cancel running work first`);
    if (request.action === "retry" && (node.status === "dispatched" || node.status === "ready" || node.status === "pending")) bad(`cannot retry node ${node.id} in ${node.status}; wait for an outcome first`);
  }
  const pending: PendingEvent = { actor, type: "plan.control", data: { revision: state.revision, request } };
  const next = foldPlan([...events, { v: 1, at: new Date().toISOString(), ...pending }])!;
  const result: ControlResult = { commandId: request.commandId, revision: state.revision, action: request.action, ...(request.node ? { node: request.node, status: next.nodes.find(n => n.id === request.node)!.status } : {}), state: next.state };
  pending.data.result = result;
  return { result, event: pending };
}
