import { expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readEvaluatedRevision, readShadowCounts, readShadowSnapshot, readShadowSnapshotFile, readSupervisionGap, readSupervisionObservation, MAX_SHADOW_EVALUATED, SUPERVISION_RECORD_BYTES, type ShadowCounts, type ShadowSnapshot, type SupervisionGap, type SupervisionObservation } from "../scripts/execution-supervision-records.ts";
import { readBytesBounded, writeAtomic } from "../src/study.ts";
import { tempDir } from "./helpers.ts";

function observation(): SupervisionObservation { return { rule: "repeated_failure", version: 1, task: 1, revision: "1:none", trigger: "failures:check:synthetic", refs: ["history:1", "history:2"], limits: { records: 64, truncated: false }, action: "escalate", reason: "repeated_failure" }; }
function gap(): SupervisionGap { return { rule: "repeated_failure", version: 1, task: 1, revision: "1:none", reason: "history-truncated" }; }
function counts(observations = 1, gaps = 0): ShadowCounts { return { evaluations: 3, observations, gap: gaps, deduped: 4, suppressed: 7, evaluatedSuppressed: 0, workerTurns: 0, actionWrites: 0, notifications: 0 }; }
function snapshot(): ShadowSnapshot { return { observations: [observation()], gap: [], counts: counts(), evaluated: [{rule: "repeated_failure", task: 1, revision: "1:none"}] }; }

test("locally owned readers preserve the three pinned rule/action/reason contracts without evaluating facts", () => {
  const repeated = observation(), stale: SupervisionObservation = { ...repeated, rule: "deliverable_invalidated_check", action: "recheck", reason: "stale_check", trigger: "check:synthetic-deliverable", refs: ["history:0", "deliverable:synthetic-deliverable"] };
  const overlap: SupervisionObservation = { ...repeated, rule: "declared_overlap_without_integration", action: "request_integration", reason: "unintegrated_overlap", trigger: "overlap:1:2", refs: ["task:2", "history:2", "history:2"], limits: { records: 128, truncated: false } };
  for (const value of [repeated, stale, overlap]) expect(readSupervisionObservation(value)).toEqual(value);
  expect(readSupervisionObservation(overlap).refs).toEqual(["task:2", "history:2", "history:2"]);
  for (const reason of ["no-history", "no-deliverable-measurement", "history-truncated"] as const) expect(readSupervisionGap({ ...gap(), reason }).reason).toBe(reason);
  expect(readShadowSnapshot(snapshot())).toEqual(snapshot()); expect(readShadowCounts(counts()).suppressed).toBe(7);
});

test("observation/gap shape, versions, rule combinations, string and record bounds refuse malformed records", () => {
  const base = observation();
  for (const value of [null, [], { ...base, note: "synthetic-private-body" }, { ...base, version: 2 }, { ...base, task: 0 }, { ...base, task: Number.MAX_SAFE_INTEGER + 1 }, { ...base, revision: "" }, { ...base, revision: "한".repeat(342) }, { ...base, trigger: "failures:bad\ntrigger" }, { ...base, trigger: "check:wrong-rule" }, { ...base, action: "recheck" }, { ...base, reason: "stale_check" }, { ...base, rule: "future-rule" }, { ...base, refs: Array(9).fill("history:1") }, { ...base, refs: ["file:/private/unrelated"] }, { ...base, refs: ["task:0"] }, { ...base, refs: ["history:-1"] }, { ...base, refs: ["deliverable:"] }, { ...base, limits: { records: 65, truncated: false } }, { ...base, limits: { records: 1, truncated: "no" } }, { ...base, limits: { records: 1, truncated: false, body: "private" } }]) expect(() => readSupervisionObservation(value)).toThrow("execution supervision records:");
  const overlap = { ...base, rule: "declared_overlap_without_integration", action: "request_integration", reason: "unintegrated_overlap", trigger: "overlap:1:2", limits: { records: 129, truncated: false } };
  expect(() => readSupervisionObservation(overlap)).toThrow("producer bound");
  for (const value of [{ ...gap(), reason: "future-gap" }, { ...gap(), version: 2 }, { ...gap(), task: -1 }, { ...gap(), notes: "private" }]) expect(() => readSupervisionGap(value)).toThrow("execution supervision records:");
  const sparse = Array(1); expect(() => readShadowSnapshot({ evaluated: [], observations: sparse, gap: [], counts: counts(1) })).toThrow("dense JSON data array");
});

test("literal zero effect counters and consistent retained counts are mandatory, while suppression remains explicit", () => {
  const base = counts();
  for (const value of [{ ...base, workerTurns: 1 }, { ...base, actionWrites: false }, { ...base, notifications: "0" }, { ...base, suppressed: -1 }, { ...base, deduped: 1.5 }, { ...base, evaluations: Infinity }, { ...base, gap: 101 }, { ...base, observations: 101 }, { ...base, extra: true }]) expect(() => readShadowCounts(value)).toThrow("execution supervision records:");
  expect(() => readShadowSnapshot({ ...snapshot(), counts: counts(0) })).toThrow("lengths");
  expect(() => readShadowSnapshot({ ...snapshot(), gap: [gap()], counts: counts(1, 0) })).toThrow("lengths");
  expect(readShadowSnapshot({ evaluated: [], observations: [], gap: [], counts: { ...counts(0, 0), suppressed: 99, evaluatedSuppressed: 17 } }).counts.evaluatedSuppressed).toBe(17);
});

test("retained keys are unique and at most three observation triggers per rule/task/revision survive", () => {
  const base = observation();
  expect(() => readShadowSnapshot({ evaluated: [], observations: [base, { ...base, refs: ["history:3"] }], gap: [], counts: counts(2) })).toThrow("duplicate observation key");
  const four = Array.from({ length: 4 }, (_, index) => ({ ...base, trigger: `failures:check:class-${index}` }));
  expect(() => readShadowSnapshot({ evaluated: [], observations: four, gap: [], counts: counts(4) })).toThrow("three observations");
  expect(readShadowSnapshot({ evaluated: [], observations: four.slice(0, 3), gap: [], counts: counts(3) }).observations).toHaveLength(3);
  expect(() => readShadowSnapshot({ evaluated: [], observations: [], gap: [gap(), gap()], counts: counts(0, 2) })).toThrow("duplicate gap key");
});

test("observations and gaps have separate hundred-row bounds and an aggregate 256 KiB ceiling", () => {
  const observations = Array.from({ length: 100 }, (_, index) => ({ ...observation(), task: index + 1 })), gaps = Array.from({ length: 100 }, (_, index) => ({ ...gap(), task: index + 1 }));
  expect(readShadowSnapshot({ evaluated: [], observations, gap: gaps, counts: counts(100, 100) }).gap).toHaveLength(100);
  expect(() => readShadowSnapshot({ evaluated: [], observations: [...observations, { ...observation(), task: 101 }], gap: [], counts: counts(100, 0) })).toThrow("at most 100");
  expect(() => readShadowSnapshot({ evaluated: [], observations: [], gap: [...gaps, { ...gap(), task: 101 }], counts: counts(0, 100) })).toThrow("at most 100");
  const large = observations.slice(0, 33).map(value => ({ ...value, refs: Array(8).fill("deliverable:" + "x".repeat(1012)) }));
  expect(() => readShadowSnapshot({ evaluated: [], observations: large, gap: [], counts: counts(33) })).toThrow("256 KiB");
  expect(() => readShadowSnapshot({ ...snapshot(), notes: "synthetic-private-note" })).toThrow("unknown or non-data fields");
});

test("file reader is bounded, no-follow and strict about UTF-8/JSON while changing no source bytes", () => {
  const root = tempDir(), file = join(root, "snapshot.json"), raw = JSON.stringify(snapshot());
  writeAtomic(file, raw + " ".repeat(SUPERVISION_RECORD_BYTES - Buffer.byteLength(raw)), SUPERVISION_RECORD_BYTES);
  const before = readBytesBounded(file, SUPERVISION_RECORD_BYTES);
  expect(readShadowSnapshotFile(file)).toEqual(snapshot()); expect(readBytesBounded(file, SUPERVISION_RECORD_BYTES)).toEqual(before);
  const linked = join(root, "linked.json"); symlinkSync(file, linked); expect(() => readShadowSnapshotFile(linked)).toThrow("without a final symlink");
  writeFileSync(file, raw + " ".repeat(SUPERVISION_RECORD_BYTES)); expect(() => readShadowSnapshotFile(file)).toThrow("256 KiB");
  writeFileSync(file, Buffer.from([255])); expect(() => readShadowSnapshotFile(file)).toThrow("UTF-8 JSON");
  writeAtomic(file, "not JSON", SUPERVISION_RECORD_BYTES); expect(() => readShadowSnapshotFile(file)).toThrow("UTF-8 JSON");
});


test("initial counts are empty and closed readers reject hidden/accessor/symbol fields before reading values", () => {
  const initial = { evaluations: 0, observations: 0, deduped: 0, suppressed: 0, gap: 0, evaluatedSuppressed: 0, workerTurns: 0 as const, actionWrites: 0 as const, notifications: 0 as const };
  expect(readShadowCounts(initial)).toEqual(initial);
  for (const field of ["observations", "gap", "deduped", "suppressed", "evaluatedSuppressed"]) expect(() => readShadowCounts({ ...initial, [field]: 1 })).toThrow("zero evaluations");
  const hidden = snapshot(); Object.defineProperty(hidden, "private", { value: "synthetic private body", enumerable: false });
  expect(() => readShadowSnapshot(hidden)).toThrow("non-data fields");
  const symbol = snapshot(); Object.defineProperty(symbol, Symbol("private"), { value: "synthetic private body", enumerable: true });
  expect(() => readShadowSnapshot(symbol)).toThrow("non-data fields");
  let reads = 0; const accessor = observation(); Object.defineProperty(accessor, "trigger", { get() { reads++; return "failures:check:synthetic"; }, enumerable: true });
  expect(() => readSupervisionObservation(accessor)).toThrow("non-data fields"); expect(reads).toBe(0);
  const nonenumerable = counts(); Object.defineProperty(nonenumerable, "evaluations", { value: 1, enumerable: false });
  expect(() => readShadowCounts(nonenumerable)).toThrow("non-data fields");
});


test("closed arrays reject sparse, named, symbol and accessor indices without invoking getters", () => {
  let reads = 0;
  const observed = [observation()]; Object.defineProperty(observed, "0", { get() { reads++; return observation(); }, enumerable: true });
  expect(() => readShadowSnapshot({ ...snapshot(), observations: observed })).toThrow("index data fields"); expect(reads).toBe(0);
  const refs = ["history:1"]; Object.defineProperty(refs, "0", { get() { reads++; return "history:1"; }, enumerable: true });
  expect(() => readSupervisionObservation({ ...observation(), refs })).toThrow("index data fields"); expect(reads).toBe(0);
  const gaps = [gap()]; Object.defineProperty(gaps, "0", { get() { reads++; return gap(); }, enumerable: true });
  expect(() => readShadowSnapshot({ evaluated: [], observations: [], gap: gaps, counts: counts(0, 1) })).toThrow("index data fields"); expect(reads).toBe(0);
  const extra = [observation()]; Object.defineProperty(extra, "private", { value: "synthetic", enumerable: true });
  expect(() => readShadowSnapshot({ ...snapshot(), observations: extra })).toThrow("extra fields");
  const symbol = [gap()]; Object.defineProperty(symbol, Symbol("private"), { value: "synthetic", enumerable: true });
  expect(() => readShadowSnapshot({ evaluated: [], observations: [], gap: symbol, counts: counts(0, 1) })).toThrow("extra fields");
  expect(() => readSupervisionObservation({ ...observation(), refs: Array(1) })).toThrow("dense JSON data array");
});

test("the exported envelope requires explicit bounded evaluated coverage and its suppression counter", () => {
  const row = {rule: "repeated_failure", task: 1, revision: "1:none"};
  expect(readEvaluatedRevision(row)).toEqual(row);
  const evaluated = Array.from({length: MAX_SHADOW_EVALUATED}, (_, index) => ({...row, task: index + 1}));
  expect(readShadowSnapshot({...snapshot(), evaluated}).evaluated).toEqual(evaluated);
  expect(readShadowSnapshot({...snapshot(), evaluated: [], counts: {...counts(), evaluatedSuppressed: 9}}).counts.evaluatedSuppressed).toBe(9);
  expect(() => readShadowSnapshot({...snapshot(), evaluated: [...evaluated, {...row, task: 101}]})).toThrow("at most 100");
  expect(() => readShadowSnapshot({...snapshot(), evaluated: [row, {...row}]})).toThrow("duplicate evaluated revision key");
  const {evaluated: _evaluated, ...oldSnapshot} = snapshot();
  expect(() => readShadowSnapshot(oldSnapshot)).toThrow("missing, unknown or non-data fields");
  const {evaluatedSuppressed: _suppressed, ...oldCounts} = counts();
  expect(() => readShadowCounts(oldCounts)).toThrow("missing, unknown or non-data fields");
  for (const evaluatedSuppressed of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => readShadowCounts({...counts(), evaluatedSuppressed})).toThrow("nonnegative safe integer");
  }
  for (const value of [{...row, version: 1}, {...row, task: 0}, {...row, rule: "future"}, {...row, revision: ""}, {...row, revision: "bad\nrevision"}]) {
    expect(() => readEvaluatedRevision(value)).toThrow("execution supervision records:");
  }
  const initial = {...counts(0, 0), evaluations: 0, deduped: 0, suppressed: 0};
  expect(() => readShadowSnapshot({observations: [], gap: [], counts: initial, evaluated: [row]})).toThrow("zero evaluations");
});

test("evaluated metadata rejects getters, sparse arrays and proxies without invoking producer hooks", () => {
  let reads = 0;
  const row = {rule: "repeated_failure", task: 1, revision: "1:none"};
  Object.defineProperty(row, "revision", {enumerable: true, get() {reads++; return "1:none";}});
  expect(() => readEvaluatedRevision(row)).toThrow("non-data fields");
  const proxy = new Proxy(snapshot(), {getPrototypeOf() {reads++; return Object.prototype;}});
  expect(() => readShadowSnapshot(proxy)).toThrow("plain object");
  expect(() => readShadowSnapshot({...snapshot(), evaluated: Array(1)})).toThrow("dense JSON data array");
  const entries = [{rule: "repeated_failure", task: 1, revision: "1:none"}];
  Object.defineProperty(entries, "0", {enumerable: true, get() {reads++; return {};}});
  expect(() => readShadowSnapshot({...snapshot(), evaluated: entries})).toThrow("index data fields");
  expect(reads).toBe(0);
});
