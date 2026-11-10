import {types} from "node:util";

export const SUPERVISION_FACTS_BYTES = 256 * 1024;
export type TaskState = "backlog" | "proposed" | "in_progress" | "in_review" | "approved" | "changes_requested" | "cancelled";
export interface DeliverableRecord {id: string; path?: string; format: string; version?: string; sha256: string; bytes: number; private?: true}
export interface SupervisionHistoryFact {
  at: number; event: string; by?: string; checkKey?: string; noWrites?: true;
  planRevision?: {revision: number; fingerprint: string}; evidenceOnly?: true; deliverables?: readonly DeliverableRecord[];
}
export interface TaskRevisionFacts {id: number; state: TaskState; history: readonly SupervisionHistoryFact[]}
export interface DeliverableMeasurementFact {task: number; checked: boolean; changed: readonly string[]; missing?: readonly string[]}
export interface DeclaredOverlapFact {task: number; other: number}
export interface SupervisionFacts {tasks: readonly TaskRevisionFacts[]; deliverables?: readonly DeliverableMeasurementFact[]; overlaps?: readonly DeclaredOverlapFact[]}
export interface TaskRevision {revision: string; from: number; accepted: number}

function invalid(): never {throw new Error("execution supervision facts: invalid closed fact shape or consumer bound; restore complete bounded facts from the pinned producer contract and retry the fixture check");}
class Budget {
  bytes = 0;
  histories = 0;
  add(bytes: number): void {this.bytes += bytes; if (this.bytes > SUPERVISION_FACTS_BYTES) invalid();}
}
function object(raw: unknown, required: readonly string[], optional: readonly string[], budget: Budget): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) invalid();
  const keys = Reflect.ownKeys(raw), result: Record<string, unknown> = Object.create(null);
  if (keys.length > required.length + optional.length) invalid();
  budget.add(2 + Math.max(0, keys.length - 1));
  for (const key of keys) {
    if (typeof key !== "string" || !required.includes(key) && !optional.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable || descriptor.value === undefined) invalid();
    budget.add(Buffer.byteLength(JSON.stringify(key)) + 1);
    result[key] = descriptor.value;
  }
  if (required.some(key => !Object.hasOwn(result, key))) invalid();
  return result;
}
function array(raw: unknown, maximum: number, budget: Budget): unknown[] {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || !Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(raw, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maximum
    || Reflect.ownKeys(raw).length !== length.value + 1) invalid();
  budget.add(2 + Math.max(0, length.value - 1));
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}
function text(raw: unknown, budget: Budget, maximum = 1024): string {
  if (typeof raw !== "string" || !raw.length || raw.length > maximum || Buffer.byteLength(raw) > maximum || /[\p{Cc}\p{Cs}]/u.test(raw)) invalid();
  budget.add(Buffer.byteLength(JSON.stringify(raw))); return raw;
}
function number(raw: unknown, budget: Budget, minimum?: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || minimum !== undefined && (!Number.isSafeInteger(raw) || raw < minimum || raw > maximum)) invalid();
  budget.add(Buffer.byteLength(JSON.stringify(raw))); return raw;
}
function boolean(raw: unknown, budget: Budget, literal = false): boolean {
  if (typeof raw !== "boolean" || literal && raw !== true) invalid();
  budget.add(raw ? 4 : 5); return raw;
}
function record(raw: unknown, budget: Budget): DeliverableRecord {
  const row = object(raw, ["id", "format", "sha256", "bytes"], ["path", "version", "private"], budget);
  const id = text(row.id, budget), format = text(row.format, budget, 32), sha256 = text(row.sha256, budget, 64);
  if (!/^d-[a-f0-9]{12}$/.test(id) || !/^[a-z0-9][a-z0-9.+-]{0,31}$/.test(format) || !/^[a-f0-9]{64}$/.test(sha256)) invalid();
  const result: DeliverableRecord = {id, format, sha256, bytes: number(row.bytes, budget, 0, 256 * 1024 * 1024)};
  if (row.path !== undefined) result.path = text(row.path, budget, 512);
  if (row.version !== undefined) {result.version = text(row.version, budget, 64); if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(result.version)) invalid();}
  if (row.private !== undefined) {boolean(row.private, budget, true); result.private = true;}
  return result;
}
function history(raw: unknown, budget: Budget): SupervisionHistoryFact {
  if (++budget.histories > 4096) invalid();
  const row = object(raw, ["at", "event"], ["by", "checkKey", "noWrites", "planRevision", "evidenceOnly", "deliverables"], budget);
  const result: SupervisionHistoryFact = {at: number(row.at, budget), event: text(row.event, budget)};
  if (row.by !== undefined) result.by = text(row.by, budget);
  if (row.checkKey !== undefined) result.checkKey = text(row.checkKey, budget);
  if (row.noWrites !== undefined) {boolean(row.noWrites, budget, true); result.noWrites = true;}
  if (row.evidenceOnly !== undefined) {boolean(row.evidenceOnly, budget, true); result.evidenceOnly = true;}
  if (row.planRevision !== undefined) {
    const plan = object(row.planRevision, ["revision", "fingerprint"], [], budget);
    result.planRevision = {revision: number(plan.revision, budget, 1), fingerprint: text(plan.fingerprint, budget)};
  }
  if (row.deliverables !== undefined) result.deliverables = array(row.deliverables, 16, budget).map(value => record(value, budget));
  return result;
}
function refs(raw: unknown, budget: Budget): string[] {return array(raw, 16, budget).map(value => text(value, budget));}

/** Structural consumer contract only; performs no rule evaluation or source-path access. */
export function validateSupervisionFacts(raw: unknown): SupervisionFacts {
  const budget = new Budget(), row = object(raw, ["tasks"], ["deliverables", "overlaps"], budget);
  const tasks = array(row.tasks, 100, budget).map(value => {
    const task = object(value, ["id", "state", "history"], [], budget);
    const state = text(task.state, budget);
    if (!["backlog", "proposed", "in_progress", "in_review", "approved", "changes_requested", "cancelled"].includes(state)) invalid();
    return {id: number(task.id, budget, 1), state: state as TaskState, history: array(task.history, 4096, budget).map(entry => history(entry, budget))};
  });
  if (new Set(tasks.map(task => task.id)).size !== tasks.length) invalid();
  const result: SupervisionFacts = {tasks};
  if (row.deliverables !== undefined) result.deliverables = array(row.deliverables, 100, budget).map(value => {
    const item = object(value, ["task", "checked", "changed"], ["missing"], budget);
    return {task: number(item.task, budget, 1), checked: boolean(item.checked, budget), changed: refs(item.changed, budget), ...(item.missing !== undefined ? {missing: refs(item.missing, budget)} : {})};
  });
  if (row.overlaps !== undefined) result.overlaps = array(row.overlaps, 200, budget).map(value => {
    const item = object(value, ["task", "other"], [], budget);
    return {task: number(item.task, budget, 1), other: number(item.other, budget, 1)};
  });
  return result;
}

/** Identity only, matching the pinned producer's owner episodes and latest plan revision. */
export function currentSupervisionRevision(task: Pick<TaskRevisionFacts, "history">): TaskRevision {
  const budget = new Budget(), row = object(task, ["history"], ["id", "state"], budget);
  const entries = array(row.history, 4096, budget).map(value => history(value, budget));
  let episodes = 0, from = 0, plan = "none", accepted = -1;
  for (const [index, entry] of entries.entries()) {
    if (["accepted", "reassigned", "escalated", "reopened"].includes(entry.event)) {episodes++; from = index + 1; accepted = entry.event === "accepted" ? index : -1;}
    if (entry.planRevision) {plan = String(entry.planRevision.revision); from = index + 1;}
  }
  return {revision: `${episodes}:${plan}`, from, accepted};
}
