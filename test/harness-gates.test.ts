import {expect, test} from "bun:test";
import {existsSync} from "node:fs";
import {join} from "node:path";
import {HARNESS_GATE_ID_BYTES, isHarnessGate, initStudy, openStudy, gateState, decideGate, requireGate, readLedger, readBytesBounded, commit, withLock, type GateName, type Binder} from "../src/study.ts";
import {tempDir} from "./helpers.ts";

const person = {kind: "person" as const, id: "synthetic-owner"}, agent = {kind: "agent" as const, id: "synthetic-worker"}, gate = "harness:round-X_9" as const;
function fixture(mode = "experiment", autonomy = "gates") {
  const dir = tempDir(), study = initStudy(dir, {question: "Synthetic harness gate", mode, autonomy}, person);
  let current: string | undefined;
  const binder: Binder = name => name === gate ? current : undefined;
  return {dir, study, binder, set: (value: string | undefined) => {current = value;}, bytes: () => readBytesBounded(join(dir, "ledger.jsonl"), 1024 * 1024)};
}

test("harness gate ids follow the bounded ASCII run-name rule", () => {
  expect(HARNESS_GATE_ID_BYTES).toBe(64);
  for (const name of ["harness:a", gate, "harness:9" + "_".repeat(63)]) expect(isHarnessGate(name)).toBe(true);
  for (const name of [null, 1, "scope", "plan:round", "harness:", "harness:_bad", "harness:-bad", "harness:has.dot", "harness:has/slash", "harness:has:colon", "harness:has space", "harness:a\n", "harness:한", "harness:a\0", "harness:" + "a".repeat(65)]) expect(isHarnessGate(name)).toBe(false);
});

test("none, pending, actor approval and stale hashes use ordinary gate state semantics", () => {
  const f = fixture(), before = f.bytes();
  expect(gateState(gate, readLedger(f.dir), f.binder)).toMatchObject({state: "none"});
  expect(() => decideGate(f.dir, gate, "approve", person, f.binder)).toThrow("nothing to decide yet");
  expect(() => requireGate(f.dir, f.study, gate, f.binder)).toThrow("no current round binding"); expect(f.bytes()).toEqual(before);
  f.set("a".repeat(64)); expect(gateState(gate, readLedger(f.dir), f.binder).state).toBe("pending");
  expect(() => requireGate(f.dir, f.study, gate, f.binder)).toThrow(`ares gate approve <dir> ${gate}`);
  const approved = decideGate(f.dir, gate, "approve", agent, f.binder);
  expect(approved).toMatchObject({state: "approved", current: "a".repeat(64), decided: {actor: agent, binding: "a".repeat(64)}});
  expect(requireGate(f.dir, f.study, gate, f.binder)).toEqual([]);
  f.set("b".repeat(64)); const changed = gateState(gate, readLedger(f.dir), f.binder);
  expect(changed).toMatchObject({state: "pending", current: "b".repeat(64), decided: {binding: "a".repeat(64)}});
  expect(() => requireGate(f.dir, f.study, gate, f.binder)).toThrow("is pending");
});

test("rejection needs a reason and records the approving actor without a person-only guard", () => {
  const f = fixture(); f.set("a".repeat(64)); const before = f.bytes();
  expect(() => decideGate(f.dir, gate, "reject", agent, f.binder)).toThrow("a rejection needs --reason"); expect(f.bytes()).toEqual(before);
  expect(decideGate(f.dir, gate, "reject", agent, f.binder, "Synthetic refusal")).toMatchObject({state: "rejected", decided: {actor: agent, decision: "reject", reason: "Synthetic refusal"}});
  expect(() => requireGate(f.dir, f.study, gate, f.binder)).toThrow("Synthetic refusal");
  expect(decideGate(f.dir, gate, "approve", person, f.binder)).toMatchObject({state: "approved", decided: {actor: person}});
});

test("auto approvals are returned only and join a successful command's one commit", async () => {
  const f = fixture("experiment", "auto"); f.set("a".repeat(64)); const before = f.bytes();
  const approvals = requireGate(f.dir, f.study, gate, f.binder);
  expect(approvals).toEqual([{actor: {kind: "auto"}, type: "gate.approve", data: {gate, binding: "a".repeat(64)}}]);
  expect(f.bytes()).toEqual(before); expect(gateState(gate, readLedger(f.dir), f.binder).state).toBe("pending");
  await expect(withLock(f.dir, () => {
    const pending = requireGate(f.dir, f.study, gate, f.binder);
    commit(f.dir, [[join(f.dir, "synthetic-unwritten.json"), "too long", 1]], [...pending, {actor: person, type: "synthetic.harness-command", data: {}}]);
  })).rejects.toThrow("exceed");
  expect(f.bytes()).toEqual(before); expect(existsSync(join(f.dir, "synthetic-unwritten.json"))).toBe(false);
  await withLock(f.dir, () => commit(f.dir, [], [...requireGate(f.dir, f.study, gate, f.binder), {actor: person, type: "synthetic.harness-command", data: {}}]));
  expect(readLedger(f.dir).slice(-2).map(event => event.type)).toEqual(["gate.approve", "synthetic.harness-command"]);
  expect(gateState(gate, readLedger(f.dir), f.binder)).toMatchObject({state: "approved", decided: {actor: {kind: "auto"}}});
  for (const path of ["design", "task", "runs", "executor.json"]) expect(existsSync(join(f.dir, path))).toBe(false);
});

test("harness gates use the study default without phase inference", () => {
  const f = fixture(); f.set("a".repeat(64));
  const gated = {...f.study, autonomy: {default: "gates" as const, phases: {design: "auto" as const}}};
  expect(() => requireGate(f.dir, gated, gate, f.binder, "design")).toThrow("is pending");
  const automatic = {...f.study, autonomy: {default: "auto" as const, phases: {design: "gates" as const}}};
  expect(requireGate(f.dir, automatic, gate, f.binder, "design")).toHaveLength(1);
  for (const mode of ["copilot", "step"] as const) expect(() => requireGate(f.dir, {...f.study, autonomy: mode}, gate, f.binder)).toThrow("is pending");
  expect(readLedger(f.dir).some(event => event.type === "gate.approve")).toBe(false);
});

test("survey and malformed namespace ids refuse before binders or writes", () => {
  const survey = fixture("survey", "auto"), before = survey.bytes(); let calls = 0;
  const binder: Binder = () => {calls++; return "a".repeat(64);};
  expect(() => decideGate(survey.dir, gate, "approve", person, binder)).toThrow("experiment");
  expect(() => requireGate(survey.dir, openStudy(survey.dir).study, gate, binder)).toThrow("experiment");
  expect(calls).toBe(0); expect(survey.bytes()).toEqual(before);
  const f = fixture("experiment", "auto"), original = f.bytes();
  for (const invalid of ["harness:", "harness:_bad", "harness:../round", "harness:a\n", "harness:한", "harness:" + "x".repeat(65)] as GateName[]) {
    expect(() => decideGate(f.dir, invalid, "approve", person, binder)).toThrow("harness gate: invalid round id");
    expect(() => requireGate(f.dir, f.study, invalid, binder)).toThrow("harness gate: invalid round id");
  }
  expect(calls).toBe(0); expect(f.bytes()).toEqual(original);
});


test("unknown well-formed harness gates name the show/set and gate-list recovery steps", () => {
  const f = fixture(), before = f.bytes();
  for (const decision of ["approve", "reject"] as const) {
    expect(() => decideGate(f.dir, gate, decision, person, f.binder, "Synthetic rejection")).toThrow("run ares harness show / ares harness set");
    expect(() => decideGate(f.dir, gate, decision, person, f.binder, "Synthetic rejection")).toThrow("then run ares gate list");
  }
  expect(f.bytes()).toEqual(before);
});
