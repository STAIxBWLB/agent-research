import {expect, test} from "bun:test";
import {resolve} from "node:path";
import {readTextBounded} from "../src/study.ts";
import {classifySupervisionV2Fixture, scoreSupervisionIntentRecords} from "../scripts/execution-supervision.ts";
import type {SupervisionIntentLabel} from "../scripts/execution-supervision-amendment.ts";
import type {SupervisionFacts, SupervisionHistoryFact} from "../scripts/execution-supervision-facts.ts";
import type {ShadowSnapshot, SupervisionObservation, SupervisionRuleId} from "../scripts/execution-supervision-records.ts";

// Independent synthetic records, not expected corpus output and not an implementation of hub rules.
const TASK = 911;
const facts = (extra: SupervisionHistoryFact[] = []): SupervisionFacts => ({tasks: [{id: TASK, state: "in_progress", history: [{at: 1, event: "accepted"}, ...extra]}]});
function label(nextAction: SupervisionIntentLabel["nextAction"] = "escalate"): SupervisionIntentLabel {
  return {v: 1, id: "synthetic-intent", trial: "supervision", scenario: nextAction === "none" ? "ordinary-progress" : "true-trigger", trigger: nextAction !== "none", task: TASK, nextAction, reason: "synthetic-intent-only", mustNot: ["execute task"]};
}
function observation(rule: SupervisionRuleId = "repeated_failure", trigger?: string, revision = "1:none"): SupervisionObservation {
  const contract = {
    repeated_failure: {action: "escalate", reason: "repeated_failure", trigger: "failures:check:fixture-a", refs: ["history:1", "history:2"]},
    deliverable_invalidated_check: {action: "recheck", reason: "stale_check", trigger: "check:d-0123456789ab", refs: ["history:2", "deliverable:d-0123456789ab"]},
    declared_overlap_without_integration: {action: "request_integration", reason: "unintegrated_overlap", trigger: "overlap:911:912", refs: ["task:912", "history:0", "history:0"]},
  } as const;
  const row = contract[rule];
  return {rule, version: 1, task: TASK, revision, trigger: trigger ?? row.trigger, action: row.action, reason: row.reason, refs: [...row.refs], limits: {records: 3, truncated: false}};
}
function snapshot(observations: SupervisionObservation[] = [], extras: Partial<ShadowSnapshot["counts"]> = {}): ShadowSnapshot {
  return {observations, gap: [], counts: {evaluations: 1, observations: observations.length, deduped: 0, suppressed: 0, gap: 0, workerTurns: 0, actionWrites: 0, notifications: 0, ...extras}};
}

test("all intended actions join their rule/task/current revision without any trigger string in the label", () => {
  for (const [action, rule] of [["escalate", "repeated_failure"], ["recheck", "deliverable_invalidated_check"], ["request_integration", "declared_overlap_without_integration"]] as const) {
    const result = scoreSupervisionIntentRecords([snapshot([observation(rule)])], facts(), [label(action)]);
    expect(result.authority).toBe("synthetic-intent-join-conformance");
    expect(result.evaluationCoverage).toBe("positive-observations-only");
    expect(result.coverage).toEqual({total: 1, formatCompatible: 1, scored: 1, insufficient: 0});
    expect(result.rows[0]).toMatchObject({task: TASK, revision: "1:none", nextAction: action, rule, state: "scored", outcome: "helpful", helpful: 1, false: 0, wrongAction: 0, falseProposalBudget: 0});
    expect(result.scores).toEqual({helpful: 1, false: 0, wrongAction: 0, falseProposalBudget: 0, missed: null, correctNonTriggers: null});
    expect(result.personDecisions).toBe(0); expect(result.workerTurns).toBe(0); expect(result.actionWrites).toBe(0); expect(result.notifications).toBe(0);
  }
  const changed = scoreSupervisionIntentRecords([snapshot([observation("repeated_failure", "failures:check:another-opaque-class")])], facts(), [label()]);
  expect(changed.rows[0]?.outcome).toBe("helpful");
});

test("case helpfulness is one while additional deduplicated proposals carry their own wrong-action budget", () => {
  const observations = [observation(), observation("repeated_failure", "failures:check:second-class"), observation("deliverable_invalidated_check"), observation("declared_overlap_without_integration")];
  const first = snapshot(observations), replay = snapshot(observations, {evaluations: 2, deduped: 4});
  const result = scoreSupervisionIntentRecords([first, replay], facts(), [label()]);
  expect(result.records.duplicates).toBe(4); expect(result.records.observations).toHaveLength(4);
  expect(result.records.producerCounts).toEqual([first.counts, replay.counts]);
  expect(result.rows[0]?.proposals.map(row => row.classification)).toEqual(["helpful", "helpful", "wrong-action", "wrong-action"]);
  expect(result.scores).toEqual({helpful: 1, false: 0, wrongAction: 2, falseProposalBudget: 2, missed: null, correctNonTriggers: null});
});

test("none intent counts every present proposal as false regardless of rule", () => {
  const records = snapshot([observation(), observation("deliverable_invalidated_check"), observation("declared_overlap_without_integration")]);
  const result = scoreSupervisionIntentRecords([records], facts(), [label("none")]);
  expect(result.rows[0]).toMatchObject({rule: null, state: "scored", outcome: "false", helpful: 0, false: 3, wrongAction: 0, falseProposalBudget: 3});
  expect(result.rows[0]?.proposals.every(row => row.classification === "false")).toBe(true);
  expect(result.scores).toEqual({helpful: 0, false: 3, wrongAction: 0, falseProposalBudget: 3, missed: null, correctNonTriggers: null});
});

test("wrong-action-only and absent records never prove the desired rule's evaluation coverage", () => {
  for (const records of [[], [snapshot()], [snapshot([], {evaluations: 0})], [snapshot([observation("deliverable_invalidated_check")])]]) {
    const result = scoreSupervisionIntentRecords(records, facts(), [label()]);
    expect(result.rows[0]).toMatchObject({state: "insufficient-evidence", reason: "no-evaluation-coverage", outcome: null, helpful: null, false: null, wrongAction: null, falseProposalBudget: null});
    expect(result.scores).toBeNull();
    expect(result.rows[0]?.proposals.every(row => row.classification === "unscored")).toBe(true);
  }
  const nonTriggerAbsent = scoreSupervisionIntentRecords([snapshot()], facts(), [label("none")]);
  expect(nonTriggerAbsent.scores).toBeNull(); expect(nonTriggerAbsent.rows[0]?.reason).toBe("no-evaluation-coverage");
});

test("handover and plan revisions prevent old observations from joining the current source facts", () => {
  const handover = facts([{at: 2, event: "reassigned"}, {at: 3, event: "accepted"}]);
  const plan = facts([{at: 2, event: "planned", planRevision: {revision: 2, fingerprint: "synthetic-plan"}}]);
  for (const [source, revision] of [[handover, "3:none"], [plan, "1:2"]] as const) {
    const stale = scoreSupervisionIntentRecords([snapshot([observation()])], source, [label()]);
    expect(stale.rows[0]).toMatchObject({revision, state: "insufficient-evidence", reason: "no-evaluation-coverage"});
    expect(stale.rows[0]?.proposals).toEqual([]); expect(stale.scores).toBeNull();
    const current = scoreSupervisionIntentRecords([snapshot([observation("repeated_failure", undefined, revision)])], source, [label()]);
    expect(current.rows[0]?.outcome).toBe("helpful");
  }
  const missing = scoreSupervisionIntentRecords([snapshot([observation()])], {tasks: []}, [label()]);
  expect(missing.rows[0]).toMatchObject({revision: null, state: "insufficient-evidence", reason: "target-task-unavailable"});
});

test("matching gaps, truncated prefixes and suppressed retention remain insufficient with positive records", () => {
  const gap = snapshot([observation()]);
  gap.gap = [{rule: "repeated_failure", version: 1, task: TASK, revision: "1:none", reason: "history-truncated"}]; gap.counts.gap = 1;
  const truncated = snapshot([{...observation(), limits: {records: 64, truncated: true}}]);
  const suppressed = snapshot([observation()], {suppressed: 1});
  for (const [records, reason] of [[gap, "coverage-gap"], [truncated, "history-truncated"], [suppressed, "retention-suppressed"]] as const) {
    for (const intended of [label(), label("none")]) {
      const result = scoreSupervisionIntentRecords([records], facts(), [intended]);
      expect(result.rows[0]).toMatchObject({state: "insufficient-evidence", reason, outcome: null});
      expect(result.scores).toBeNull(); expect(result.rows[0]?.proposals[0]?.classification).toBe("unscored");
    }
  }
});

test("intent labels refuse ambiguous bindings, unsupported fields and inconsistent false/action forms", () => {
  const valid = label(), records = [snapshot([observation()])];
  for (const invalid of [{...valid, unknown: true}, {...valid, trigger: "failures:check:fixture-a"}, {...valid, trigger: false}, {...valid, nextAction: "none"}, {...valid, task: 0}, {...valid, v: 2}]) {
    expect(() => scoreSupervisionIntentRecords(records, facts(), [invalid])).toThrow();
  }
  expect(() => scoreSupervisionIntentRecords(records, facts(), [valid, {...valid, id: "another-intent"}])).toThrow("one task/revision");
  expect(() => scoreSupervisionIntentRecords(records, facts(), [valid, {...valid, task: TASK + 1}])).toThrow("case ids");
});

test("all twelve frozen v2 inputs have format coverage without reading their expected output", () => {
  const root = resolve(import.meta.dir, ".."), corpus = JSON.parse(readTextBounded(resolve(root, "test/fixtures/execution-eval-supervision-v2/corpus.json"), 65_536)) as {cases: {input: string}[]};
  expect(corpus.cases).toHaveLength(12);
  let clipped = 0, unmeasured = 0;
  for (const row of corpus.cases) {
    expect(row.input.startsWith("test/fixtures/execution-eval-supervision-v2/")).toBe(true);
    const file = JSON.parse(readTextBounded(resolve(root, row.input), 16_384)) as {input: {request: string; facts: SupervisionFacts}};
    expect(classifySupervisionV2Fixture(file.input)).toEqual({state: "covered", reason: "supported-supervision-facts-shape"});
    for (const task of file.input.facts.tasks) if (task.history.length === 66) clipped++;
    if (!file.input.facts.deliverables?.length || file.input.facts.deliverables.some(item => !item.checked)) unmeasured++;
  }
  expect(clipped).toBeGreaterThan(0); expect(unmeasured).toBeGreaterThan(0);
  expect(() => classifySupervisionV2Fixture({request: "Synthetic", facts: {tasks: []}, expected: {trigger: true}})).toThrow();
});

test("closed task states do not hide present false proposals or manufacture coverage from absence", () => {
  for (const state of ["approved", "cancelled"] as const) {
    const source: SupervisionFacts = {tasks: [{...facts().tasks[0]!, state}]};
    const present = scoreSupervisionIntentRecords([snapshot([observation()])], source, [label("none")]);
    expect(present.rows[0]).toMatchObject({revision: "1:none", state: "scored", outcome: "false", false: 1, falseProposalBudget: 1});
    expect(present.rows[0]?.proposals[0]?.classification).toBe("false");
    const absent = scoreSupervisionIntentRecords([snapshot()], source, [label("none")]);
    expect(absent.rows[0]).toMatchObject({state: "insufficient-evidence", reason: "no-evaluation-coverage", outcome: null});
    expect(absent.scores).toBeNull();
  }
});

test("closed fact shapes and unambiguous task identity are required before intent scoring", () => {
  const source = facts(), records = [snapshot([observation()])];
  expect(() => scoreSupervisionIntentRecords(records, {...source, privateBody: "synthetic withheld text"}, [label()])).toThrow();
  expect(() => scoreSupervisionIntentRecords(records, {tasks: [{...source.tasks[0]!, unknown: true}]}, [label()])).toThrow();
  expect(() => scoreSupervisionIntentRecords(records, {tasks: [source.tasks[0]!, {...source.tasks[0]!, history: [{at: 1, event: "reassigned"}]}]}, [label()])).toThrow();
});
