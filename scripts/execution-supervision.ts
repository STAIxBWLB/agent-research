import { plain } from "../src/study.ts";
import { readShadowSnapshot, readSupervisionTrigger, type ShadowSnapshot, type SupervisionObservation, type SupervisionGap, type SupervisionRuleId } from "./execution-supervision-records.ts";

export const SUPERVISION_PRODUCER_COMMIT = "bc6f46b077dd3a255debaee8152fa17f1f13b79c";
const BATCH_BYTES = 1024 * 1024, MAX_BATCH = 100, MAX_TRUTH = 1024;
export interface SupervisionTruth {
  id: string; rule: SupervisionRuleId; task: number; revision: string; trigger: string;
  expected: boolean | null; coverage: "covered" | "unsupported"; reason?: string;
}
type Outcome = "helpful" | "false";
export interface SupervisionScore {
  authority: "synthetic-record-conformance";
  observations: SupervisionObservation[]; gap: SupervisionGap[]; duplicates: number;
  producerCounts: ShadowSnapshot["counts"][]; retentionSuppressed: boolean; unscoredObservations: number;
  coverage: {total: number; scored: number; insufficient: number; unsupported: number};
  scores: null | {helpful: number; false: number; missed: null; correctNonTriggers: null};
  rows: {id: string; state: "scored" | "insufficient-evidence"; reason?: string; outcome: Outcome | null}[];
  personDecisions: 0; workerTurns: 0; actionWrites: 0; notifications: 0;
}
function fail(cause: string): never {
  throw new Error(`execution supervision: ${cause}; restore bounded records from the pinned agent-hub#1221 T1 contract and supply separate rule-covered truth before scoring; do not launch a treatment trial`);
}
function size(raw: unknown, bound: number): void {
  let serialized: string | undefined;
  try { serialized = JSON.stringify(raw); } catch { fail("input is not serializable JSON"); }
  if (serialized === undefined || Buffer.byteLength(serialized) > bound) fail(`input exceeds the ${bound}-byte bound`);
}
function text(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !raw.length || raw.trim() !== raw || Buffer.byteLength(raw) > 1024 || /\p{Cc}/u.test(raw)) fail(`${label} must be bounded nonempty text without controls`);
  return raw;
}
function object(raw: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (!plain(raw) || Reflect.ownKeys(raw).some(key => typeof key !== "string" || !fields.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key)!, "value") || !Object.getOwnPropertyDescriptor(raw, key)!.enumerable)) fail(`${label} must contain only known JSON data fields`);
  return raw;
}
function list(raw: unknown, label: string, max = MAX_BATCH): unknown[] {
  if (!Array.isArray(raw) || raw.length > max || Reflect.ownKeys(raw).length !== raw.length + 1) fail(`${label} must be a dense JSON array of at most ${max} items`);
  const values: unknown[] = [];
  for (let index = 0; index < raw.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail(`${label} must contain JSON data items without getters`);
    values.push(descriptor.value);
  }
  return values;
}
const RULES = ["repeated_failure", "deliverable_invalidated_check", "declared_overlap_without_integration"] as const;
function truthRow(raw: unknown): SupervisionTruth {
  const fields = ["id", "rule", "task", "revision", "trigger", "expected", "coverage", "reason"];
  const value = object(raw, fields, "truth row");
  if (!RULES.includes(value.rule as SupervisionRuleId)) fail("truth row names an unsupported rule");
  if (!Number.isSafeInteger(value.task) || (value.task as number) <= 0) fail("truth task must be a positive safe integer");
  if (value.expected !== null && typeof value.expected !== "boolean") fail("truth expected must be boolean or explicit null");
  if (value.coverage !== "covered" && value.coverage !== "unsupported") fail("truth coverage must be covered or unsupported");
  return {id: text(value.id, "truth id"), rule: value.rule as SupervisionRuleId, task: value.task as number,
    revision: text(value.revision, "truth revision"), trigger: value.coverage === "covered" && typeof value.expected === "boolean" ? readSupervisionTrigger(value.rule as SupervisionRuleId, value.trigger) : text(value.trigger, "truth trigger"), expected: value.expected,
    coverage: value.coverage, ...(value.reason === undefined ? {} : {reason: text(value.reason, "truth reason")})};
}
const key = (row: Pick<SupervisionObservation, "rule" | "task" | "revision" | "trigger">) => JSON.stringify([row.rule, row.task, row.revision, row.trigger]);
const revision = (row: Pick<SupervisionObservation, "rule" | "task" | "revision">) => JSON.stringify([row.rule, row.task, row.revision]);
const gapKey = (row: SupervisionGap) => JSON.stringify([row.rule, row.task, row.revision, row.reason]);

/** Consume retained record snapshots only. This never evaluates hub facts, generates a proposal or executes an arm. */
export function scoreSupervisionRecords(rawSnapshots: readonly unknown[], rawTruth: readonly unknown[]): SupervisionScore {
  const snapshots = list(rawSnapshots, "snapshots").map(readShadowSnapshot), truth = list(rawTruth, "truth", MAX_TRUTH).map(truthRow);
  size({snapshots, truth}, BATCH_BYTES);
  const ids = new Set<string>(), truthKeys = new Set<string>();
  for (const row of truth) {
    if (ids.has(row.id) || truthKeys.has(key(row))) fail("truth ids and rule/task/revision/trigger identities must be unique");
    ids.add(row.id); truthKeys.add(key(row));
  }
  const observations = new Map<string, SupervisionObservation>(), gaps = new Map<string, SupervisionGap>(), perRevision = new Map<string, number>();
  let duplicates = 0;
  for (const snapshot of snapshots) {
    for (const observation of snapshot.observations) {
      const identity = key(observation), previous = observations.get(identity);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(observation)) fail("one retained observation identity changed across snapshots");
        duplicates++; continue;
      }
      const owner = revision(observation), count = (perRevision.get(owner) ?? 0) + 1;
      if (observations.size >= 100 || count > 3) fail("combined retained observations exceed 100 or 3 per rule/task/revision");
      perRevision.set(owner, count); observations.set(identity, observation);
    }
    for (const gap of snapshot.gap) {
      const identity = gapKey(gap);
      if (!gaps.has(identity) && gaps.size >= 100) fail("combined retained gaps exceed 100");
      gaps.set(identity, gap);
    }
  }
  const gapRevisions = new Set([...gaps.values()].map(revision));
  const truncatedRevisions = new Set([...observations.values()].filter(row => row.limits.truncated).map(revision));
  const retentionSuppressed = snapshots.some(snapshot => snapshot.counts.suppressed > 0);
  const scores = {helpful: 0, false: 0, missed: null, correctNonTriggers: null};
  let scored = 0, unsupported = 0;
  const rows: SupervisionScore["rows"] = truth.map(row => {
    const reason = row.coverage === "unsupported" ? "unsupported-case" : row.expected === null ? "truth-unavailable"
      : gapRevisions.has(revision(row)) ? "coverage-gap" : truncatedRevisions.has(revision(row)) ? "history-truncated" : retentionSuppressed ? "retention-suppressed" : !observations.has(key(row)) ? "no-evaluation-coverage" : undefined;
    if (row.coverage === "unsupported") unsupported++;
    if (reason) return {id: row.id, state: "insufficient-evidence", reason, outcome: null};
    // A retained observation proves its own identity was evaluated. Absence has no such source binding.
    const outcome: Outcome = row.expected ? "helpful" : "false";
    scored++; scores[outcome]++;
    return {id: row.id, state: "scored", outcome};
  });
  const scoredKeys = new Set(truth.filter((_, index) => rows[index]!.state === "scored").map(key));
  return {authority: "synthetic-record-conformance", observations: [...observations.values()], gap: [...gaps.values()], duplicates,
    producerCounts: snapshots.map(snapshot => snapshot.counts), retentionSuppressed,
    unscoredObservations: [...observations.keys()].filter(identity => !scoredKeys.has(identity)).length,
    coverage: {total: truth.length, scored, insufficient: truth.length - scored, unsupported}, scores: scored ? scores : null, rows,
    personDecisions: 0, workerTurns: 0, actionWrites: 0, notifications: 0};
}

/** The frozen state-based inputs are not the producer's admitted history/measurement/overlap fact sets. */
export function classifySupervisionFixture(input: unknown): {state: "unsupported"; reason: "task-state-not-admitted-rule-facts"} {
  const value = object(input, ["request", "task"], "frozen supervision input"), task = object(value.task, ["id", "observed"], "frozen task");
  text(value.request, "frozen request"); text(task.id, "frozen task id");
  if (!plain(task.observed)) fail("frozen task observed must be a JSON object");
  // Do not walk or reinterpret task-state facts; the sealed file reader already bounds their bytes.
  return {state: "unsupported", reason: "task-state-not-admitted-rule-facts"};
}
