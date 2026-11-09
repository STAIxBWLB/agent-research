import { plain, readTextBounded } from "../src/study.ts";

/** Consumer-owned readers for the pinned shadow producer records, not its rule implementation. */
export const SUPERVISION_RECORD_BYTES = 256 * 1024, SUPERVISION_STRING_BYTES = 1024;
export const MAX_SHADOW_OBSERVATIONS = 100, MAX_SHADOW_GAPS = 100, MAX_SHADOW_REFS = 8, MAX_SHADOW_PER_REVISION = 3;
export type SupervisionRuleId = "repeated_failure" | "deliverable_invalidated_check" | "declared_overlap_without_integration";
export type SupervisionAction = "escalate" | "recheck" | "request_integration";
export type SupervisionReasonCode = "repeated_failure" | "stale_check" | "unintegrated_overlap";
export type SupervisionGapReason = "no-history" | "no-deliverable-measurement" | "history-truncated";
export interface ObservationLimits { records: number; truncated: boolean }
export interface SupervisionObservation {
  rule: SupervisionRuleId; version: 1; task: number; revision: string; trigger: string;
  refs: string[]; limits: ObservationLimits; action: SupervisionAction; reason: SupervisionReasonCode;
}
export interface SupervisionGap { rule: SupervisionRuleId; version: 1; task: number; revision: string; reason: SupervisionGapReason }
export interface ShadowCounts { evaluations: number; observations: number; deduped: number; suppressed: number; gap: number; workerTurns: 0; actionWrites: 0; notifications: 0 }
export interface ShadowSnapshot { observations: SupervisionObservation[]; gap: SupervisionGap[]; counts: ShadowCounts }
const RULES: Record<SupervisionRuleId, { action: SupervisionAction; reason: SupervisionReasonCode; trigger: string; records: number }> = {
  repeated_failure: { action: "escalate", reason: "repeated_failure", trigger: "failures:", records: 64 },
  deliverable_invalidated_check: { action: "recheck", reason: "stale_check", trigger: "check:", records: 64 },
  declared_overlap_without_integration: { action: "request_integration", reason: "unintegrated_overlap", trigger: "overlap:", records: 128 },
};
function invalid(cause: string): never { throw new Error(`execution supervision records: ${cause}; restore a complete bounded snapshot from the pinned shadow producer and retry the fixture integration check`); }
function object(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plain(raw)) invalid(`${label} must be a plain object`);
  const own = Reflect.ownKeys(raw);
  if (own.some(key => {
    const field = Object.getOwnPropertyDescriptor(raw, key);
    return typeof key !== "string" || !keys.includes(key) || !field?.enumerable || !Object.hasOwn(field, "value");
  }) || keys.some(key => !Object.hasOwn(raw, key))) invalid(`${label} has missing, unknown or non-data fields; use exactly ${keys.join(", ")}`);
  return raw;
}
function array(raw: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(raw)) invalid(`${label} must be an array within the producer bound`);
  const length = Object.getOwnPropertyDescriptor(raw, "length");
  if (!length || !Object.hasOwn(length, "value") || typeof length.value !== "number" || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > max) invalid(`${label} must be an array of at most ${max} entries`);
  const result: unknown[] = [], own = Reflect.ownKeys(raw);
  if (own.length !== length.value + 1) invalid(`${label} must be a dense JSON data array without extra fields`);
  for (const key of own) {
    if (key === "length") continue;
    const field = Object.getOwnPropertyDescriptor(raw, key);
    if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key) || Number(key) >= length.value || !field?.enumerable || !Object.hasOwn(field, "value")) invalid(`${label} must contain only enumerable index data fields`);
  }
  for (let index = 0; index < length.value; index++) {
    const field = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!field || !Object.hasOwn(field, "value")) invalid(`${label} must be a dense JSON data array`);
    result.push(field.value);
  }
  return result;
}
function text(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.trim() || /\p{Cc}/u.test(raw) || Buffer.byteLength(raw) > SUPERVISION_STRING_BYTES) invalid(`${label} must be nonblank control-free text of at most 1024 UTF-8 bytes`);
  return raw;
}
function nonnegative(raw: unknown, label: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0 || raw > max) invalid(`${label} must be a nonnegative safe integer within the producer bound`);
  return raw;
}
function identity(value: Record<string, unknown>): { rule: SupervisionRuleId; version: 1; task: number; revision: string } {
  if (typeof value.rule !== "string" || !Object.hasOwn(RULES, value.rule)) invalid("rule is unsupported");
  if (value.version !== 1) invalid("rule version is unsupported");
  const task = nonnegative(value.task, "task"); if (!task) invalid("task must be a positive safe integer");
  return { rule: value.rule as SupervisionRuleId, version: 1, task, revision: text(value.revision, "revision") };
}
function recordReference(raw: unknown): string {
  const ref = text(raw, "record reference");
  if (ref.startsWith("deliverable:") && ref.slice(12).trim()) return ref;
  const match = /^(history|task):([0-9]+)$/.exec(ref);
  if (!match || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < (match[1] === "task" ? 1 : 0)) invalid("record reference must address history:<index>, deliverable:<id> or task:<positive id>");
  return ref;
}
export function readSupervisionTrigger(rule: SupervisionRuleId, raw: unknown): string {
  if (!Object.hasOwn(RULES, rule)) invalid("trigger rule is unsupported");
  const trigger = text(raw, "trigger"), contract = RULES[rule];
  if (rule === "repeated_failure") {
    const checked = trigger.startsWith("failures:check:") && !!trigger.slice("failures:check:".length).trim();
    if (!checked && trigger !== "failures:review:changes_requested" && trigger !== "failures:integration:unresolved" && trigger !== "failures:done:no-writes") invalid("repeated failure trigger must name a classified check, review, integration or no-write failure");
  } else if (!trigger.startsWith(contract.trigger) || !trigger.slice(contract.trigger.length).trim()) invalid("observation trigger prefix does not match its rule");
  return trigger;
}
export function readSupervisionObservation(raw: unknown): SupervisionObservation {
  const value = object(raw, ["rule", "version", "task", "revision", "trigger", "refs", "limits", "action", "reason"], "observation"), base = identity(value), contract = RULES[base.rule];
  if (value.action !== contract.action || value.reason !== contract.reason) invalid("observation action/reason does not match its rule");
  const trigger = readSupervisionTrigger(base.rule, value.trigger);
  const refs = array(value.refs, MAX_SHADOW_REFS, "observation refs").map(recordReference), limits = object(value.limits, ["records", "truncated"], "observation limits");
  if (typeof limits.truncated !== "boolean") invalid("observation limits.truncated must be boolean");
  return { ...base, trigger, refs, limits: { records: nonnegative(limits.records, "observation limits.records", contract.records), truncated: limits.truncated }, action: contract.action, reason: contract.reason };
}
export function readSupervisionGap(raw: unknown): SupervisionGap {
  const value = object(raw, ["rule", "version", "task", "revision", "reason"], "gap"), base = identity(value);
  if (value.reason !== "no-history" && value.reason !== "no-deliverable-measurement" && value.reason !== "history-truncated") invalid("gap reason is unsupported");
  return { ...base, reason: value.reason };
}
export function readShadowCounts(raw: unknown): ShadowCounts {
  const value = object(raw, ["evaluations", "observations", "deduped", "suppressed", "gap", "workerTurns", "actionWrites", "notifications"], "shadow counts");
  if (value.workerTurns !== 0 || value.actionWrites !== 0 || value.notifications !== 0) invalid("shadow workerTurns/actionWrites/notifications must each be literal zero");
  const result: ShadowCounts = { evaluations: nonnegative(value.evaluations, "counts.evaluations"), observations: nonnegative(value.observations, "counts.observations", MAX_SHADOW_OBSERVATIONS), deduped: nonnegative(value.deduped, "counts.deduped"), suppressed: nonnegative(value.suppressed, "counts.suppressed"), gap: nonnegative(value.gap, "counts.gap", MAX_SHADOW_GAPS), workerTurns: 0, actionWrites: 0, notifications: 0 };
  if (result.evaluations === 0 && [result.observations, result.deduped, result.suppressed, result.gap].some(count => count !== 0)) invalid("zero evaluations requires empty retained and activity counts");
  return result;
}
export function readShadowSnapshot(raw: unknown): ShadowSnapshot {
  const value = object(raw, ["observations", "gap", "counts"], "shadow snapshot");
  const observations = array(value.observations, MAX_SHADOW_OBSERVATIONS, "shadow observations").map(readSupervisionObservation), gap = array(value.gap, MAX_SHADOW_GAPS, "shadow gaps").map(readSupervisionGap), counts = readShadowCounts(value.counts);
  const seen = new Set<string>(), revisions = new Map<string, number>();
  for (const observation of observations) {
    const key = JSON.stringify([observation.rule, observation.task, observation.revision, observation.trigger]), revision = JSON.stringify([observation.rule, observation.task, observation.revision]);
    if (seen.has(key)) invalid("retained snapshot contains a duplicate observation key"); seen.add(key);
    const held = (revisions.get(revision) ?? 0) + 1; if (held > MAX_SHADOW_PER_REVISION) invalid("retained snapshot exceeds three observations per rule/task/revision"); revisions.set(revision, held);
  }
  const gaps = new Set<string>();
  for (const entry of gap) { const key = JSON.stringify([entry.rule, entry.task, entry.revision, entry.reason]); if (gaps.has(key)) invalid("retained snapshot contains a duplicate gap key"); gaps.add(key); }
  if (counts.observations !== observations.length || counts.gap !== gap.length) invalid("snapshot counts do not match retained observation/gap lengths");
  const snapshot = { observations, gap, counts };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > SUPERVISION_RECORD_BYTES) invalid("aggregate shadow snapshot exceeds 256 KiB");
  return snapshot;
}
/** Explicit bounded local file only; no task/rule evaluation, child process, provider or external lookup. */
export function readShadowSnapshotFile(file: string): ShadowSnapshot {
  let raw: unknown;
  try { raw = JSON.parse(readTextBounded(file, SUPERVISION_RECORD_BYTES, { noFollow: true })); }
  catch { invalid("snapshot file must be regular, readable UTF-8 JSON of at most 256 KiB without a final symlink"); }
  return readShadowSnapshot(raw);
}
