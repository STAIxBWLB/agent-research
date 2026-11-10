import { plain } from "../src/study.ts";
import {validateSupervisionFacts, currentSupervisionRevision} from "./execution-supervision-facts.ts";
import {parseSupervisionIntentLabel, type SupervisionIntentLabel} from "./execution-supervision-amendment.ts";
import {types} from "node:util";
import { readShadowSnapshot, readSupervisionTrigger, type ShadowSnapshot, type SupervisionObservation, type SupervisionGap, type SupervisionRuleId, type EvaluatedRevision } from "./execution-supervision-records.ts";

export const SUPERVISION_PRODUCER_COMMIT = "f6f94528ac31ec67d1a8a8bcb8fcf25168d9cfc7";
const BATCH_BYTES = 1024 * 1024, MAX_BATCH = 100, MAX_TRUTH = 1024;
export interface SupervisionTruth {
  id: string; rule: SupervisionRuleId; task: number; revision: string; trigger: string;
  expected: boolean | null; coverage: "covered" | "unsupported"; reason?: string;
}
type Outcome = "helpful" | "false" | "missed" | "correct-non-trigger";
export interface SupervisionScore {
  authority: "synthetic-record-conformance";
  observations: SupervisionObservation[]; gap: SupervisionGap[]; evaluated: EvaluatedRevision[]; duplicates: number;
  producerCounts: ShadowSnapshot["counts"][]; retentionSuppressed: boolean; evaluatedSuppressed: boolean; unscoredObservations: number;
  coverage: {total: number; scored: number; insufficient: number; unsupported: number};
  scores: null | {helpful: number; false: number; missed: number | null; correctNonTriggers: number | null};
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
function text(raw: unknown, label: string, maximum = 1024): string {
  if (typeof raw !== "string" || !raw.length || raw.trim() !== raw || Buffer.byteLength(raw) > maximum || /\p{Cc}/u.test(raw)) fail(`${label} must be bounded nonempty text without controls`);
  return raw;
}
function object(raw: unknown, fields: readonly string[], label: string): Record<string, unknown> {
  if (types.isProxy(raw) || !plain(raw) || Reflect.ownKeys(raw).some(key => typeof key !== "string" || !fields.includes(key) || !Object.hasOwn(Object.getOwnPropertyDescriptor(raw, key)!, "value") || !Object.getOwnPropertyDescriptor(raw, key)!.enumerable)) fail(`${label} must contain only known JSON data fields`);
  return raw;
}
function list(raw: unknown, label: string, max = MAX_BATCH): unknown[] {
  if (types.isProxy(raw) || !Array.isArray(raw) || raw.length > max || Reflect.ownKeys(raw).length !== raw.length + 1) fail(`${label} must be a dense JSON array of at most ${max} items`);
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
  const observations = new Map<string, SupervisionObservation>(), gaps = new Map<string, SupervisionGap>(), evaluated = new Map<string, EvaluatedRevision>(), perRevision = new Map<string, number>();
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
    for (const row of snapshot.evaluated) {
      const identity = revision(row);
      if (!evaluated.has(identity) && evaluated.size >= 100) fail("combined evaluated revisions exceed 100");
      evaluated.set(identity, row);
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
  const evaluatedSuppressed = snapshots.some(snapshot => snapshot.counts.evaluatedSuppressed > 0);
  const mayInferAbsence = (row: EvaluatedRevision) => evaluated.has(revision(row)) && !gapRevisions.has(revision(row)) && !truncatedRevisions.has(revision(row)) && !retentionSuppressed && !evaluatedSuppressed;
  const scores = {helpful: 0, false: 0, missed: 0 as number | null, correctNonTriggers: 0 as number | null};
  let scored = 0, unsupported = 0, missedCovered = false, nonTriggerCovered = false;
  const rows: SupervisionScore["rows"] = truth.map(row => {
    const present = observations.has(key(row));
    const reason = row.coverage === "unsupported" ? "unsupported-case" : row.expected === null ? "truth-unavailable"
      : gapRevisions.has(revision(row)) ? "coverage-gap" : truncatedRevisions.has(revision(row)) ? "history-truncated" : retentionSuppressed ? "retention-suppressed"
      : !present && evaluatedSuppressed ? "evaluated-suppressed" : !present && !evaluated.has(revision(row)) ? "no-evaluation-coverage" : undefined;
    if (row.coverage === "unsupported") unsupported++;
    if (reason) return {id: row.id, state: "insufficient-evidence", reason, outcome: null};
    if (mayInferAbsence(row)) {if (row.expected) missedCovered = true; else nonTriggerCovered = true;}
    const outcome: Outcome = present ? row.expected ? "helpful" : "false" : row.expected ? "missed" : "correct-non-trigger";
    scored++;
    if (outcome === "correct-non-trigger") scores.correctNonTriggers = (scores.correctNonTriggers ?? 0) + 1;
    else if (outcome === "missed") scores.missed = (scores.missed ?? 0) + 1;
    else scores[outcome]++;
    return {id: row.id, state: "scored", outcome};
  });
  if (!missedCovered) scores.missed = null;
  if (!nonTriggerCovered) scores.correctNonTriggers = null;
  const scoredKeys = new Set(truth.filter((_, index) => rows[index]!.state === "scored").map(key));
  return {authority: "synthetic-record-conformance", observations: [...observations.values()], gap: [...gaps.values()], evaluated: [...evaluated.values()], duplicates,
    producerCounts: snapshots.map(snapshot => snapshot.counts), retentionSuppressed, evaluatedSuppressed,
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


/** Format coverage only. Compatible input facts do not prove that any rule was evaluated. */
export function classifySupervisionV2Fixture(input: unknown): {state: "covered"; reason: "supported-supervision-facts-shape"} {
  const value = object(input, ["request", "facts"], "Supervision v2 input");
  text(value.request, "Supervision v2 request", 4000);
  validateSupervisionFacts(value.facts);
  return {state: "covered", reason: "supported-supervision-facts-shape"};
}


export const SUPERVISION_INTENT_RULES = {escalate: "repeated_failure", recheck: "deliverable_invalidated_check", request_integration: "declared_overlap_without_integration"} as const;
type IntentProposalClass = "intended-action" | "false" | "wrong-action";
export interface SupervisionIntentRow {
  id: string; task: number; revision: string | null; nextAction: SupervisionIntentLabel["nextAction"]; rule: SupervisionRuleId | null;
  state: "scored" | "insufficient-evidence"; reason?: string; outcome: "helpful" | "missed" | "correct-non-trigger" | "insufficient";
  helpful: number | null; falseCases: number; falseProposals: number; wrongAction: number; falseProposalBudget: number; missed: number | null; correctNonTriggers: number | null;
  proposals: {identity: string; rule: SupervisionRuleId; action: SupervisionObservation["action"]; classification: IntentProposalClass}[];
}
export interface SupervisionIntentScore {
  authority: "synthetic-intent-join-conformance"; rows: SupervisionIntentRow[];
  records: Pick<SupervisionScore, "observations" | "gap" | "evaluated" | "duplicates" | "producerCounts" | "retentionSuppressed" | "evaluatedSuppressed">;
  evaluationCoverage: "explicit-evaluated-triples"; proposalCountScope: "present-observations-only";
  coverage: {total: number; formatCompatible: number; scored: number; insufficient: number};
  scores: null | {helpful: number; falseCases: number; falseProposals: number; wrongAction: number; falseProposalBudget: number; missed: number | null; correctNonTriggers: number | null};
  personDecisions: 0; workerTurns: 0; actionWrites: 0; notifications: 0;
}
/** Join approved scenario intent, never predict a rule trigger or manufacture evaluation coverage. */
export function scoreSupervisionIntentRecords(rawSnapshots: readonly unknown[], rawFacts: unknown, rawLabels: readonly unknown[]): SupervisionIntentScore {
  if (types.isProxy(rawSnapshots) || types.isProxy(rawLabels)) fail("intent join requires inert JSON lists");
  const facts = validateSupervisionFacts(rawFacts), labels = list(rawLabels, "intent labels", MAX_TRUTH).map(parseSupervisionIntentLabel);
  const normalized = scoreSupervisionRecords(rawSnapshots, []), records = {observations: normalized.observations, gap: normalized.gap, evaluated: normalized.evaluated,
    duplicates: normalized.duplicates, producerCounts: normalized.producerCounts, retentionSuppressed: normalized.retentionSuppressed, evaluatedSuppressed: normalized.evaluatedSuppressed};
  const byTask = new Map(facts.tasks.map(task => [task.id, task]));
  const identities = new Set<string>(), targets = new Set<string>(), coveredMisses = new Set<string>(), coveredNonTriggers = new Set<string>();
  const rows: SupervisionIntentRow[] = labels.map(label => {
    if (identities.has(label.id)) fail("intent case ids must be unique"); identities.add(label.id);
    const task = byTask.get(label.task), current = task ? currentSupervisionRevision(task).revision : null;
    const target = JSON.stringify([label.task, current]);
    if (targets.has(target)) fail("one task/revision may have only one intent label per fact set"); targets.add(target);
    const wanted = label.nextAction === "none" ? null : SUPERVISION_INTENT_RULES[label.nextAction];
    const observed = current === null ? [] : records.observations.filter(row => row.task === label.task && row.revision === current);
    const relevant = (row: Pick<SupervisionObservation, "task" | "revision" | "rule">) => row.task === label.task && row.revision === current && (wanted === null || row.rule === wanted);
    const matching = wanted === null ? [] : observed.filter(row => row.rule === wanted && row.action === label.nextAction);
    // Proposal burden is known from presence alone, independently of case/evaluation coverage.
    const proposals = observed.map(row => ({identity: key(row), rule: row.rule, action: row.action,
      classification: (!label.trigger ? "false" : row.action === label.nextAction ? "intended-action" : "wrong-action") as IntentProposalClass}));
    const wrongAction = proposals.filter(row => row.classification === "wrong-action").length;
    const falseProposals = label.trigger ? 0 : proposals.length, falseCases = falseProposals ? 1 : 0;
    const blocked = records.gap.some(relevant) ? "coverage-gap"
      : records.observations.some(row => relevant(row) && row.limits.truncated) ? "history-truncated"
      : records.retentionSuppressed ? "retention-suppressed" : records.evaluatedSuppressed ? "evaluated-suppressed" : undefined;
    const hasCoverage = current !== null && !blocked && (wanted === null ? RULES.every(rule => records.evaluated.some(row => row.task === label.task && row.revision === current && row.rule === rule))
      : records.evaluated.some(row => row.task === label.task && row.revision === current && row.rule === wanted));
    if (hasCoverage) {if (label.trigger) coveredMisses.add(label.id); else coveredNonTriggers.add(label.id);}
    const base = {id: label.id, task: label.task, revision: current, nextAction: label.nextAction, rule: wanted, proposals,
      falseCases, falseProposals, wrongAction, falseProposalBudget: falseProposals + wrongAction};
    if (matching.length) return {...base, state: "scored", outcome: "helpful", helpful: 1, missed: hasCoverage ? 0 : null, correctNonTriggers: null};
    if (hasCoverage && label.trigger) return {...base, state: "scored", outcome: "missed", helpful: 0, missed: 1, correctNonTriggers: null};
    if (hasCoverage && !observed.length) return {...base, state: "scored", outcome: "correct-non-trigger", helpful: 0, missed: null, correctNonTriggers: 1};
    const reason = current === null ? "target-task-unavailable" : blocked ?? (hasCoverage ? "non-trigger-proposals-present" : "no-evaluation-coverage");
    return {...base, state: "insufficient-evidence", reason, outcome: "insufficient", helpful: null, missed: null, correctNonTriggers: hasCoverage ? 0 : null};
  });
  const helpful = rows.filter(row => row.outcome === "helpful").length, scored = rows.filter(row => row.state === "scored").length, scores = rows.length ? {
    helpful, falseCases: rows.reduce((sum, row) => sum + row.falseCases, 0), falseProposals: rows.reduce((sum, row) => sum + row.falseProposals, 0),
    wrongAction: rows.reduce((sum, row) => sum + row.wrongAction, 0), falseProposalBudget: rows.reduce((sum, row) => sum + row.falseProposalBudget, 0),
    missed: coveredMisses.size ? rows.reduce((sum, row) => sum + (row.missed ?? 0), 0) : null,
    correctNonTriggers: coveredNonTriggers.size ? rows.reduce((sum, row) => sum + (row.correctNonTriggers ?? 0), 0) : null,
  } : null;
  return {authority: "synthetic-intent-join-conformance", rows, records, evaluationCoverage: "explicit-evaluated-triples", proposalCountScope: "present-observations-only",
    coverage: {total: rows.length, formatCompatible: rows.filter(row => row.revision !== null).length, scored, insufficient: rows.length - scored}, scores,
    personDecisions: 0, workerTurns: 0, actionWrites: 0, notifications: 0};
}
