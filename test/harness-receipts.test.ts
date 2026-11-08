import {expect, spyOn, test} from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
import {join} from "node:path";
import {parseVariantFixture, parseProbeFixture, compareProbeFixtures, realHubProbeUnavailable, HARNESS_FIXTURE_BYTES, type ProbeFixtureProjectionV1} from "../src/harness/receipts.ts";
import {hasHarnessCredential} from "../src/harness/privacy.ts";
import {readTextBounded} from "../src/study.ts";
const read = (name: string) => readTextBounded(join(import.meta.dir, "fixtures", "harness-rounds", `${name}.json`), HARNESS_FIXTURE_BYTES);
const variant = () => parseVariantFixture(read("variant"));
const baseline = () => parseProbeFixture(read("baseline"));
const candidate = () => parseProbeFixture(read("candidate"));

test("ares-owned fixture projections preserve declared unknown usage without producer assurance", () => {
  const a = baseline(), b = candidate(), v = variant();
  expect(parseVariantFixture(v)).toEqual(v); expect(parseProbeFixture(a)).toEqual(a);
  expect(v.evidence[0]).toMatchObject({v: 1, tool: "ares", kind: "attempt"});
  expect(a.usage).toBe("unknown"); expect(a.samplingControl).toBe("unknown");
  expect(compareProbeFixtures(a, b)).toEqual({compatible: true, matched: false, sourceStrength: "synthetic-fixture", endToEndEvaluation: "unavailable", reasons: [], confounders: ["synthetic-fixture", "producer-unavailable", "sampling-unknown"]});
  expect(parseProbeFixture({...b, state: "failed"})).toMatchObject({state: "failed", usage: "unknown"});
  expect(compareProbeFixtures(a, {...b, state: "failed"})).toMatchObject({compatible: true, matched: false, endToEndEvaluation: "unavailable"});
  for (const state of ["cancelled", "unknown", "unavailable"] as const) expect(parseProbeFixture({...b, state}).state).toBe(state);
});

test("every required task/context/model/config/budget comparison identity drift is incompatible", () => {
  const a = baseline(), b = candidate();
  const changed: Partial<ProbeFixtureProjectionV1>[] = [
    {experimentId: "synthetic-other-round"}, {taskId: "synthetic-other-task"}, {taskRevision: 2}, {taskInputHash: "7".repeat(64)}, {baselineHash: "7".repeat(64)}, {baselineContextHash: "7".repeat(64)}, {libraryHash: "7".repeat(64)}, {codeTreeHash: "7".repeat(64)}, {hostRuntimeHash: "7".repeat(64)}, {toolsetHash: "7".repeat(64)}, {requestedModel: "synthetic-other-model"}, {requestedConfigHash: "7".repeat(64)}, {servedModel: "synthetic-other-model"}, {servedConfigHash: "7".repeat(64)}, {budgetHash: "7".repeat(64)},
  ];
  for (const field of changed) {
    const result = compareProbeFixtures(a, {...b, ...field}); expect(result.compatible).toBe(false); expect(result.reasons).toContain(`${Object.keys(field)[0]}-mismatch`);
    expect(result.matched).toBe(false); expect(result.sourceStrength).toBe("synthetic-fixture"); expect(result.endToEndEvaluation).toBe("unavailable");
  }
  expect(compareProbeFixtures(a, {...b, id: "synthetic-different-id", arm: "synthetic-another-arm", guidanceHash: "7".repeat(64), outputManifestHash: null})).toMatchObject({compatible: true, matched: false});
});

test("equal served fallbacks or absent served metadata cannot masquerade as matched contexts", () => {
  for (const shared of [{servedModel: "synthetic-fallback"}, {servedConfigHash: "9".repeat(64)}, {servedModel: null}, {servedConfigHash: null}]) {
    const result = compareProbeFixtures({...baseline(), ...shared}, {...candidate(), ...shared});
    expect(result.compatible).toBe(false); expect(result.matched).toBe(false); expect(result.reasons.length).toBeGreaterThan(0);
    expect(result.confounders).toEqual(["synthetic-fixture", "producer-unavailable", "sampling-unknown"]);
  }
});

test("variant projection strictly bounds bytes, rationale and local typed evidence", () => {
  const value = variant();
  expect(parseVariantFixture({...value, baselineBytes: 0, candidateBytes: 8192, evidence: [], rationale: "x".repeat(2000)})).toMatchObject({baselineBytes: 0, candidateBytes: 8192});
  const invalid: unknown[] = [null, [], {...value, v: 2}, {...value, revision: 0}, {...value, revision: 1.5}, {...value, baselineBytes: -1}, {...value, candidateBytes: 8193}, {...value, candidateBytes: "100"}, {...value, rationale: "x".repeat(2001)}, {...value, baselineRoleHash: "A".repeat(64)}, {...value, candidateHash: "b".repeat(63)}, {...value, evidence: Array(17).fill(value.evidence[0])}, {...value, evidence: ["ares:synthetic/attempt:raw-string"]}, {...value, evidence: [{...value.evidence[0], tool: "agent-hub"}]}];
  for (const raw of invalid) expect(() => parseVariantFixture(raw)).toThrow("harness fixture");
  expect(() => parseVariantFixture("x".repeat(HARNESS_FIXTURE_BYTES + 1))).toThrow("bound");
  expect(() => parseVariantFixture("{")).toThrow("JSON");
});

test("probe projections reject unknown assurance/path/transcript/environment fields and raw secret claims", () => {
  const a = baseline(), v = variant();
  for (const key of ["path", "transcript", "env", "API_KEY", "secret", "matched", "hostObserved", "assurance", "improverContextHash", "streamBinding"]) {
    expect(() => parseProbeFixture({...a, [key]: "not permitted"})).toThrow("shape/version");
    expect(() => parseVariantFixture({...v, [key]: "not permitted"})).toThrow("shape/version");
  }
  for (const secret of ["API_KEY=synthetic-sensitive", "secret=synthetic-sensitive", "password:synthetic-sensitive", "sk-syntheticSensitiveToken"]) {
    expect(() => parseVariantFixture({...v, rationale: secret})).toThrow("rationale");
    expect(() => parseProbeFixture({...a, requestedModel: secret})).toThrow("requestedModel");
  }
  for (const model of ["https://synthetic.invalid/model", "file:///synthetic/private/model"]) expect(() => parseProbeFixture({...a, requestedModel: model})).toThrow("requestedModel");
  for (const raw of [{...a, v: 2}, {...a, taskRevision: 0}, {...a, state: "running"}, {...a, usage: 0}, {...a, usage: {tokens: 1}}, {...a, samplingControl: "host-verified"}, {...a, outputManifestHash: "invalid"}, {...a, servedConfigHash: "A".repeat(64)}]) expect(() => parseProbeFixture(raw)).toThrow("harness fixture");
  expect(() => parseProbeFixture(" ".repeat(HARNESS_FIXTURE_BYTES + 1))).toThrow("bound");
});

test("parsers and real-producer unavailable stub perform no implicit source/process/network reads", () => {
  const a = baseline(), b = candidate(), v = variant(), forbidden = (): never => {throw new Error("implicit fixture IO forbidden");};
  const preconnect = spyOn(globalThis.fetch, "preconnect").mockImplementation(forbidden), open = spyOn(fs, "openSync").mockImplementation(forbidden), spawn = spyOn(child, "spawn").mockImplementation(forbidden), sync = spyOn(child, "spawnSync").mockImplementation(forbidden), fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(forbidden, {preconnect}));
  try {
    expect(parseVariantFixture(v)).toEqual(v); expect(parseProbeFixture(a)).toEqual(a); expect(compareProbeFixtures(a, b).matched).toBe(false);
    const missing = realHubProbeUnavailable("synthetic-absent"), denied = realHubProbeUnavailable({id: "synthetic-denied", denied: true});
    expect(denied).toEqual(missing); expect(realHubProbeUnavailable()).toEqual(missing); expect(missing).toMatchObject({state: "unavailable", matched: false, endToEndEvaluation: "unavailable"});
    expect(JSON.stringify(missing)).not.toContain("synthetic-absent"); expect(JSON.stringify(denied)).not.toContain("synthetic-denied");
    expect(open).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(preconnect).not.toHaveBeenCalled();
  } finally {open.mockRestore(); spawn.mockRestore(); sync.mockRestore(); fetch.mockRestore(); preconnect.mockRestore();}
});

test("worker effective input identity is retained separately from editor library context", () => {
  const a = baseline(), b = candidate();
  expect(a.workerEffectiveInputHash).not.toBe(b.workerEffectiveInputHash);
  expect(compareProbeFixtures(a, b)).toMatchObject({compatible: true, matched: false});
  expect(compareProbeFixtures(a, {...a, id: "same-guidance-different-worker-input", workerEffectiveInputHash: "f".repeat(64)})).toMatchObject({compatible: false, reasons: ["workerEffectiveInputHash-mismatch"]});
});

test("credential-like bearer text in an otherwise permitted field is not imported", () => {
  expect(() => parseProbeFixture({...baseline(), requestedModel: "Bearer synthetic-secret-token"})).toThrow("fixture");
  expect(() => parseVariantFixture({...variant(), author: "Bearer synthetic-secret-token"})).toThrow("fixture");
});

test("round and fixture privacy use the union of the shared credential markers", () => {
  for (const value of ["API_KEY=synthetic", "secret=synthetic", "password=synthetic", "token=synthetic", "ACCESS_TOKEN=synthetic", "credential=synthetic", "Bearer abcdefgh", "sk-abcdefgh", "xsk-abcdefghijklmnop"]) {
    expect(hasHarnessCredential(value)).toBe(true);
    expect(() => parseVariantFixture({...variant(), author: value})).toThrow("fixture");
    expect(() => parseProbeFixture({...baseline(), requestedModel: value})).toThrow("fixture");
  }
  for (const value of ["credential review", "synthetic model", "token budget", "sk-short"]) expect(hasHarnessCredential(value)).toBe(false);
});
