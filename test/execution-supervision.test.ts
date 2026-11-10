import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { scoreSupervisionRecords, SUPERVISION_PRODUCER_COMMIT, type SupervisionTruth } from "../scripts/execution-supervision.ts";
import type { ShadowSnapshot } from "../scripts/execution-supervision-records.ts";
import { readTextBounded } from "../src/study.ts";

// Separate synthetic producer outputs, not the frozen trial corpus or an embedded rule evaluator.
interface Vector { id: string; sourceVector: string; snapshot: ShadowSnapshot; truth: SupervisionTruth[] }
interface Vectors {
  v: number;
  provenance: { repository: string; commit: string; paths: string[]; kind: string; frozenCorpus: boolean; generation: {facts: string; snapshots: string; truth: string; trials: number; producerModuleSha256: string; generatorSha256: string} };
  vectors: Vector[];
}
const fixture = JSON.parse(readTextBounded(resolve(import.meta.dir, "fixtures/execution-supervision/producer-vectors.json"), 196_608)) as Vectors;
function vector(id: string): Vector {
  const found = fixture.vectors.find(row => row.id === id);
  if (!found) throw new Error("synthetic supervision vector missing");
  return found;
}
const score = (id: string) => { const row = vector(id); return scoreSupervisionRecords([row.snapshot], row.truth); };

test("producer vectors name the exact pinned public contract outside the frozen corpus", () => {
  expect(fixture.v).toBe(1);
  expect(fixture.provenance.repository).toBe("STAIxBWLB/agent-hub");
  expect(fixture.provenance.commit).toBe(SUPERVISION_PRODUCER_COMMIT);
  expect(fixture.provenance.paths).toEqual(["docs/design/supervision.md", "src/hub/supervision-rules.ts", "test/supervision-rules.test.ts"]);
  expect(fixture.provenance.frozenCorpus).toBe(false);
  expect(fixture.vectors).toHaveLength(14);
  expect(fixture.provenance.generation).toMatchObject({facts: "hand-authored", snapshots: "producer-generated", truth: "hand-authored-preserved", trials: 0});
  expect(fixture.provenance.generation.producerModuleSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(fixture.provenance.generation.generatorSha256).toMatch(/^[a-f0-9]{64}$/);
});

test("each producer observation rule scores only the supplied covered truth identity", () => {
  for (const id of ["repeated-first", "deliverable-invalidated", "declared-overlap"]) {
    const result = score(id);
    expect(result.observations).toEqual(vector(id).snapshot.observations);
    expect(result.scores).toEqual({ helpful: 1, false: 0, missed: 0, correctNonTriggers: null });
    expect(result.coverage).toEqual({ total: 1, scored: 1, insufficient: 0, unsupported: 0 });
    expect(result.rows[0]).toMatchObject({ state: "scored", outcome: "helpful" });
    expect(result.personDecisions).toBe(0);
    expect(result.workerTurns).toBe(0); expect(result.actionWrites).toBe(0); expect(result.notifications).toBe(0);
  }
  expect(score("ordinary-progress").scores).toEqual({helpful: 0, false: 0, missed: null, correctNonTriggers: 1});
  expect(score("ordinary-progress").rows[0]).toMatchObject({state: "scored", outcome: "correct-non-trigger"});
});

test("replay and third equal failure keep original retained evidence and do not inflate counts", () => {
  const rows = ["repeated-first", "repeated-replay", "repeated-third-equal"].map(vector);
  expect(rows[0]!.snapshot.observations[0]).toEqual({
    rule: "repeated_failure", version: 1, task: 7, revision: "1:none", trigger: "failures:check:implement",
    refs: ["history:4", "history:6"], limits: { records: 5, truncated: false }, action: "escalate", reason: "repeated_failure",
  });
  expect(rows[1]!.snapshot.observations).toEqual(rows[0]!.snapshot.observations);
  expect(rows[2]!.snapshot.observations).toEqual(rows[0]!.snapshot.observations);
  expect(rows.map(row => row.snapshot.counts.evaluations)).toEqual([1, 2, 3]);
  expect(rows.map(row => row.snapshot.counts.deduped)).toEqual([0, 1, 2]);
  const result = scoreSupervisionRecords(rows.map(row => row.snapshot), rows[0]!.truth);
  expect(result.observations).toHaveLength(1); expect(result.duplicates).toBe(2);
  expect(result.producerCounts).toEqual(rows.map(row => row.snapshot.counts));
  expect(result.scores).toEqual({ helpful: 1, false: 0, missed: 0, correctNonTriggers: null });
});

test("all three producer coverage gaps remain unsupported rather than clean numeric outcomes", () => {
  const result = score("coverage-gaps");
  expect(result.gap).toHaveLength(5);
  expect([...new Set(result.gap.map(row => row.reason))].sort()).toEqual(["history-truncated", "no-deliverable-measurement", "no-history"]);
  expect(result.scores).toBeNull();
  expect(result.coverage).toMatchObject({ total: 3, scored: 0, unsupported: 3 });
  expect(result.rows.every(row => row.state === "insufficient-evidence" && row.outcome === null)).toBe(true);
});

test("per-rule revision and retention refusal counters preserve unknown score coverage", () => {
  for (const [id, observations, gap] of [["per-rule-revision-cap", 3, 0], ["observation-retention-cap", 100, 0], ["gap-retention-cap", 0, 100]] as const) {
    const row = vector(id), result = score(id);
    expect(row.snapshot.counts).toMatchObject({ evaluations: 1, observations, gap, suppressed: 1 });
    expect(result.retentionSuppressed).toBe(true);
    expect(result.observations).toHaveLength(observations); expect(result.gap).toHaveLength(gap);
    expect(result.coverage.scored).toBe(0); expect(result.scores).toBeNull();
    expect(result.rows.every(item => item.state === "insufficient-evidence" && item.outcome === null)).toBe(true);
  }
});

test("present observations can score false while absence and unmatched observations remain unknown", () => {
  const row = vector("repeated-first"), identity = row.truth[0]!;
  expect(scoreSupervisionRecords([row.snapshot], [{ ...identity, expected: false }]).scores).toEqual({ helpful: 0, false: 1, missed: null, correctNonTriggers: 0 });
  const clean = vector("ordinary-progress").snapshot;
  const missing = scoreSupervisionRecords([clean], [identity]);
  expect(missing.scores).toBeNull(); expect(missing.rows[0]).toMatchObject({state: "insufficient-evidence", reason: "no-evaluation-coverage", outcome: null});
  const unknown = scoreSupervisionRecords([row.snapshot], []);
  expect(unknown.unscoredObservations).toBe(1); expect(unknown.scores).toBeNull();
  const absent = scoreSupervisionRecords([], [identity]);
  expect(absent.scores).toBeNull(); expect(absent.rows[0]).toMatchObject({ state: "insufficient-evidence", outcome: null });
});

test("explicit unknown truth remains unavailable even when a matching producer observation exists", () => {
  const row = vector("repeated-first"), result = scoreSupervisionRecords([row.snapshot], [{ ...row.truth[0]!, expected: null }]);
  expect(result.observations).toHaveLength(1);
  expect(result.scores).toBeNull();
  expect(result.coverage).toEqual({ total: 1, scored: 0, insufficient: 1, unsupported: 0 });
  expect(result.rows[0]).toMatchObject({ state: "insufficient-evidence", reason: "truth-unavailable", outcome: null });
});

test("each matching producer gap blocks numeric scoring even for a declared covered truth row", () => {
  const source = vector("coverage-gaps");
  for (const gap of source.snapshot.gap) {
    const truth = {id: `covered-gap-${gap.rule}-${gap.task}`, rule: gap.rule, task: gap.task, revision: gap.revision};
    const snapshot: ShadowSnapshot = {
      observations: [], gap: [gap], evaluated: [{rule: gap.rule, task: gap.task, revision: gap.revision}],
      counts: { evaluations: 1, observations: 0, deduped: 0, suppressed: 0, evaluatedSuppressed: 0, gap: 1, workerTurns: 0, actionWrites: 0, notifications: 0 },
    };
    const result = scoreSupervisionRecords([snapshot], [{ ...truth, coverage: "covered", expected: true, trigger: gap.rule === "repeated_failure" ? "failures:check:implement" : gap.rule === "deliverable_invalidated_check" ? "check:d-0123456789ab" : "overlap:28:29" }]);
    expect(result.gap).toEqual([gap]); expect(result.retentionSuppressed).toBe(false);
    expect(result.scores).toBeNull();
    expect(result.coverage).toEqual({ total: 1, scored: 0, insufficient: 1, unsupported: 0 });
    expect(result.rows[0]).toMatchObject({ state: "insufficient-evidence", reason: "coverage-gap", outcome: null });
  }
});

test("a truncated observed prefix leaves both observed and unseen failure classes insufficient without a gap", () => {
  const source = vector("repeated-first"), original = source.snapshot.observations[0]!;
  const snapshot: ShadowSnapshot = {
    ...source.snapshot,
    observations: [{ ...original, limits: { records: 64, truncated: true } }],
    gap: [],
  };
  const observed = source.truth[0]!;
  const unseen: SupervisionTruth = { ...observed, id: "truncated:unseen-class", trigger: "failures:check:other" };
  const result = scoreSupervisionRecords([snapshot], [observed, unseen]);
  expect(result.observations).toHaveLength(1); expect(result.gap).toEqual([]);
  expect(result.retentionSuppressed).toBe(false); expect(result.scores).toBeNull();
  expect(result.coverage).toEqual({ total: 2, scored: 0, insufficient: 2, unsupported: 0 });
  expect(result.rows.map(row => ({ id: row.id, state: row.state, reason: row.reason, outcome: row.outcome }))).toEqual([
    { id: observed.id, state: "insufficient-evidence", reason: "history-truncated", outcome: null },
    { id: unseen.id, state: "insufficient-evidence", reason: "history-truncated", outcome: null },
  ]);
});


test("malformed or conflicting truth and changed retained identities refuse rather than inventing scores", () => {
  const source = vector("repeated-first"), identity = source.truth[0]!;
  for (const invalid of [
    {...identity, extra: true}, {...identity, rule: "unsupported"}, {...identity, expected: "yes"},
    {...identity, task: 0}, {...identity, coverage: "guessed"}, {...identity, trigger: "check:implement"},
    {...identity, trigger: "failures:invented-class"},
  ]) expect(() => scoreSupervisionRecords([source.snapshot], [invalid])).toThrow("execution supervision");
  expect(() => scoreSupervisionRecords([source.snapshot], [identity, {...identity, id: "other", expected: false}])).toThrow("identities must be unique");
  const changed: ShadowSnapshot = {...source.snapshot, observations: [{...source.snapshot.observations[0]!, refs: ["history:3", "history:6"]}]};
  expect(() => scoreSupervisionRecords([source.snapshot, changed], [identity])).toThrow("identity changed");
  let read = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, "0", {enumerable: true, get() {read++; return source.snapshot;}});
  expect(() => scoreSupervisionRecords(accessor, [identity])).toThrow("without getters"); expect(read).toBe(0);
});


test("task 7 evaluations cannot score absence for task 999 revision 99:none", () => {
  const source = vector("repeated-first"), original = source.truth[0]!;
  for (const expected of [true, false]) {
    const other: SupervisionTruth = {...original, id: "unobserved-task", task: 999, revision: "99:none", expected};
    const result = scoreSupervisionRecords([source.snapshot], [original, other]);
    expect(result.rows[0]).toMatchObject({state: "scored", outcome: "helpful"});
    expect(result.rows[1]).toMatchObject({id: "unobserved-task", state: "insufficient-evidence", reason: "no-evaluation-coverage", outcome: null});
    expect(result.coverage).toEqual({total: 2, scored: 1, insufficient: 1, unsupported: 0});
    expect(result.scores).toEqual({helpful: 1, false: 0, missed: 0, correctNonTriggers: null});
    // Neither another task nor another revision nor an impossible rule coverage claim is proven by batch counters.
    const sameTaskOtherRevision = scoreSupervisionRecords([source.snapshot], [{...other, task: original.task}]);
    expect(sameTaskOtherRevision.rows[0]!.reason).toBe("no-evaluation-coverage");
    expect(sameTaskOtherRevision.scores).toBeNull();
  }
  expect(source.snapshot.evaluated.some(row => row.task === 999)).toBe(false);
});

test("explicit rule/task/revision evaluation proves missed or correct non-trigger for an absent exact key", () => {
  const row = vector("repeated-first"), identity = row.truth[0]!;
  const evaluated = [{rule: identity.rule, task: identity.task, revision: identity.revision}];
  const complete: ShadowSnapshot = {observations: [], gap: [], evaluated, counts: {evaluations: 1, observations: 0, deduped: 0, suppressed: 0, evaluatedSuppressed: 0, gap: 0, workerTurns: 0, actionWrites: 0, notifications: 0}};
  expect(scoreSupervisionRecords([complete], [identity]).scores).toEqual({helpful: 0, false: 0, missed: 1, correctNonTriggers: null});
  expect(scoreSupervisionRecords([complete], [{...identity, expected: false}]).scores).toEqual({helpful: 0, false: 0, missed: null, correctNonTriggers: 1});
  const replay = scoreSupervisionRecords([complete, complete], [identity]);
  expect(replay.evaluated).toEqual(evaluated); expect(replay.scores?.missed).toBe(1);
  const noCoverage: ShadowSnapshot = {...complete, evaluated: []};
  expect(scoreSupervisionRecords([noCoverage], [identity]).rows[0]?.reason).toBe("no-evaluation-coverage");
  for (const incomplete of [
    {...complete, counts: {...complete.counts, evaluatedSuppressed: 1}},
    {...complete, counts: {...complete.counts, suppressed: 1}},
    {...complete, evaluated: [{...evaluated[0]!, rule: "deliverable_invalidated_check" as const}]},
    {...complete, evaluated: [{...evaluated[0]!, revision: "2:none"}]},
  ]) expect(scoreSupervisionRecords([incomplete], [identity]).scores).toBeNull();
});

test("producer evaluated-retention overflow leaves absent rows unknown even if their triple survived", () => {
  const source = vector("evaluated-retention-cap"), result = score("evaluated-retention-cap");
  expect(source.snapshot.counts.evaluatedSuppressed).toBeGreaterThan(0);
  expect(result.evaluatedSuppressed).toBe(true); expect(result.retentionSuppressed).toBe(false);
  expect(result.rows[0]).toMatchObject({state: "insufficient-evidence", reason: "evaluated-suppressed", outcome: null});
  expect(result.scores).toBeNull();
});

test("generated closed-side overlap records establish no R3 coverage; missing open-side gaps override coverage", () => {
  for (const id of ["closed-overlap", "missing-and-closed-overlap"]) {
    const row = vector(id), identity = row.truth[0]!;
    expect(row.snapshot.evaluated.filter(entry => entry.rule === "declared_overlap_without_integration")).toEqual([]);
    expect(row.snapshot.gap).toEqual([]); expect(row.snapshot.observations).toEqual([]);
    const result = scoreSupervisionRecords([row.snapshot], [{...identity, coverage: "covered"}]);
    expect(result.rows[0]).toMatchObject({state: "insufficient-evidence", reason: "no-evaluation-coverage", outcome: null});
    expect(result.scores).toBeNull();
  }
  const missing = vector("missing-overlap");
  expect(missing.snapshot.evaluated).toContainEqual({rule: "declared_overlap_without_integration", task: 28, revision: "1:none"});
  expect(missing.snapshot.gap).toContainEqual({rule: "declared_overlap_without_integration", version: 1, task: 28, revision: "1:none", reason: "no-history"});
  const result = scoreSupervisionRecords([missing.snapshot], [{...missing.truth[0]!, trigger: "overlap:28:29", coverage: "covered"}]);
  expect(result.rows[0]).toMatchObject({state: "insufficient-evidence", reason: "coverage-gap", outcome: null});
  expect(result.scores).toBeNull();
});
