import {expect, test} from "bun:test";
import {readdirSync} from "node:fs";
import {join} from "node:path";
import {readTextBounded} from "../src/study.ts";
import {currentSupervisionRevision, SUPERVISION_FACTS_BYTES, validateSupervisionFacts} from "../scripts/execution-supervision-facts.ts";

const facts = () => ({tasks: [{id: 1, state: "in_progress", history: [{at: 1.5, event: "accepted", by: "peer-a"}]}]});

test("all twelve approved v2 corpus inputs satisfy the structural facts contract", () => {
  const dir = join(import.meta.dir, "fixtures", "execution-eval-supervision-v2");
  const files = readdirSync(dir).filter(name => name.endsWith(".input.json")).sort();
  expect(files.length).toBe(12);
  for (const file of files) {
    const envelope = JSON.parse(readTextBounded(join(dir, file), SUPERVISION_FACTS_BYTES)) as {input: {facts: unknown}};
    const before = JSON.stringify(envelope.input.facts);
    expect(validateSupervisionFacts(envelope.input.facts)).toEqual(envelope.input.facts);
    expect(JSON.stringify(envelope.input.facts)).toBe(before);
  }
});

test("history preserves fractional times, ordering and more than the producer's read prefix", () => {
  const input = facts(); input.tasks[0]!.history = Array.from({length: 66}, (_, index) => ({at: index + 0.5, event: "bookkeeping", by: "hub"}));
  const result = validateSupervisionFacts(input);
  expect(result.tasks[0]!.history).toEqual(input.tasks[0]!.history);
  expect(result.tasks[0]!.history).not.toBe(input.tasks[0]!.history);
  expect(currentSupervisionRevision(result.tasks[0]!)).toEqual({revision: "0:none", from: 0, accepted: -1});
});

test("revision identity follows episodes and plan boundaries, never bookkeeping or elapsed time", () => {
  const task = {history: [
    {at: 1, event: "accepted"},
    {at: 2, event: "check failed"},
    {at: 3, event: "plan changed", planRevision: {revision: 3, fingerprint: "synthetic-plan"}},
    {at: 9999999.5, event: "bookkeeping"},
  ]};
  expect(currentSupervisionRevision(task)).toEqual({revision: "1:3", from: 3, accepted: 0});
  for (const event of ["reassigned", "escalated", "reopened"]) {
    expect(currentSupervisionRevision({history: [...task.history, {at: 5, event}]})).toEqual({revision: "2:3", from: 5, accepted: -1});
  }
  expect(currentSupervisionRevision({history: [...task.history, {at: 5, event: "accepted"}]})).toEqual({revision: "2:3", from: 5, accepted: 4});
});

test("deliverables are closed bounded opaque metadata with source true-or-absent markers", () => {
  const record = {id: "d-123456789abc", path: "synthetic/artifact.json", format: "json", version: "1", sha256: "a".repeat(64), bytes: 2, private: true};
  const input = {tasks: [{id: 1, state: "in_review", history: [{at: 0, event: "done", noWrites: true, evidenceOnly: true, deliverables: [record]}]}], deliverables: [{task: 1, checked: false, changed: [record.id], missing: []}], overlaps: [{task: 1, other: 2}]};
  // Unmeasured changed ids and absent overlap sides are admissible facts, not evaluated conditions.
  expect(validateSupervisionFacts(input)).toEqual(input);
  const {path: _path, ...privateRecord} = record;
  expect(validateSupervisionFacts({...input, tasks: [{...input.tasks[0]!, history: [{at: 0, event: "done", deliverables: [privateRecord]}]}]}).tasks[0]!.history[0]!.deliverables![0]!.path).toBeUndefined();
});

test("rejects unknown fields, malformed leaves and aggregate consumer limits", () => {
  for (const raw of [
    {...facts(), privateBody: "sensitive-text"},
    {tasks: [{...facts().tasks[0]!, state: "future-state"}]},
    {tasks: [{...facts().tasks[0]!, id: 0}]},
    {tasks: [{...facts().tasks[0]!, history: [{at: Infinity, event: "accepted"}]}]},
    {tasks: [{...facts().tasks[0]!, history: [{at: 1, event: "line\nbreak"}]}]},
    {tasks: [{...facts().tasks[0]!, history: [{at: 1, event: "done", noWrites: false}]}]},
    {tasks: [{...facts().tasks[0]!, history: [{at: 1, event: "changed", planRevision: {revision: 0, fingerprint: "plan"}}]}]},
    {tasks: Array.from({length: 101}, () => facts().tasks[0]!)},
    {tasks: [{...facts().tasks[0]!, history: Array.from({length: 4097}, () => ({at: 0, event: "x"}))}]},
    {tasks: [{...facts().tasks[0]!, history: Array.from({length: 300}, () => ({at: 0, event: "x".repeat(1024)}))}]},
    {...facts(), deliverables: [{task: 1, checked: true, changed: Array(17).fill("ref")}]},
    {...facts(), overlaps: Array.from({length: 201}, () => ({task: 1, other: 2}))},
  ]) expect(() => validateSupervisionFacts(raw)).toThrow("restore complete bounded facts");
});

test("inert validation never executes getters, proxy traps, iterators or serializers", () => {
  let calls = 0;
  const accessor = facts(); Object.defineProperty(accessor.tasks[0]!, "history", {enumerable: true, get() {calls++; return [];}});
  const proxy = new Proxy(facts(), {ownKeys() {calls++; return [];}});
  const serializer = {...facts(), toJSON() {calls++; return {};}};
  const sparse = facts(); delete sparse.tasks[0];
  const indexed = facts(); Object.defineProperty(indexed.tasks, "0", {enumerable: true, get() {calls++; return {};}});
  const symbol = facts(); Object.defineProperty(symbol, Symbol("hidden"), {value: 1, enumerable: true});
  const hidden = facts(); Object.defineProperty(hidden, "hidden", {value: 1});
  for (const raw of [accessor, proxy, serializer, sparse, indexed, symbol, hidden]) expect(() => validateSupervisionFacts(raw)).toThrow("restore complete bounded facts");
  expect(calls).toBe(0);
  try {validateSupervisionFacts({...facts(), "sensitive-key": "sensitive-value"});}
  catch (error) {expect(String(error)).not.toContain("sensitive");}
});
