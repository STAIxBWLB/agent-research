import {expect, test} from "bun:test";
import {symlinkSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {baselineSlots} from "../scripts/execution-baseline.ts";
import {bindRunCode} from "../scripts/execution-code-binding.ts";
import {resolveDiagnosticFixture} from "../scripts/execution-diagnose.ts";
import {COST_FIELDS} from "../scripts/execution-eval.ts";
import {TREATMENT_AUTHORITY_DEVIATION, TREATMENT_RECEIPT_BYTES, treatmentSlots, treatmentDenominators, treatmentMatches, treatmentChildCpuSeconds, parseTreatmentCgroupCpu, validateTreatmentObservation, readTreatmentObservation, validateTreatmentTrialManifest, readTreatmentTrialManifest, readRegisteredTreatmentSchedule, serializeTreatmentBundle, diagnoseSetupCode, validateDiagnosticScaffolding, type DiagnoseSetupCode, type TreatmentObservation, type TreatmentTrialManifest} from "../scripts/execution-trials.ts";
import {readBytesBounded, readTextBounded, sha256, writeAtomic} from "../src/study.ts";
import {tempDir} from "./helpers.ts";

// Shape-only synthetic receipts; none of these tests calls the admitted runner or a child.
function observation(): TreatmentObservation {
  return {...treatmentSlots(0, [3, 11, 19], "reuse")[0]!, v: 1, authority: "harness-observed", trial: "reuse", caseId: "synthetic-case", caseIndex: 0, slot: 0,
    codeSha256: "a".repeat(64), methodSha256: "b".repeat(64), inputSha256: "c".repeat(64), expectedSha256: "d".repeat(64),
    status: "unknown", cause: "budget-stopped-not-started", matched: "unknown", result: null, integration: null, processWallMs: "unknown", humanTimeToFind: "unknown",
    costs: Object.fromEntries(COST_FIELDS.map(key => [key, "unknown"])) as TreatmentObservation["costs"], containerCpuSeconds: "unknown", artifact: null, logs: null};
}
function manifest() {
  const codeFiles = [{path: "scripts/synthetic.ts", sha256: "a".repeat(64), bytes: 1}];
  const rows = Array.from({length: 12}, (_, index) => treatmentSlots(index, [3, 11, 19], "reuse")).flat().map(slot => ({arm: slot.arm, status: "unknown" as const}));
  return {...TREATMENT_AUTHORITY_DEVIATION, v: 1, kind: "synthetic-paired-treatment-observations", authority: "harness-observed", trial: "reuse", state: "incomplete", failure: null,
    startedAt: "2026-11-10T00:00:00.000Z", endedAt: "2026-11-10T00:01:00.000Z",
    bindings: {registration: "a".repeat(64), supervision: "b".repeat(64), reuseR2: "c".repeat(64), reuseSetup: "d".repeat(64)},
    methodSha256: "b".repeat(64), inputSha256: "c".repeat(64), expectedSha256: "d".repeat(64),
    code: {commit: "a".repeat(40), tree: "b".repeat(40), codeSha256: sha256(JSON.stringify(codeFiles)), files: codeFiles},
    environment: {os: "linux", osRelease: "synthetic", arch: "x64", bun: "1.3.10", cpuModelsSha256: "a".repeat(64), logicalCpus: 2, cpuLimit: 2, memoryLimitBytes: 256 * 1024 * 1024, pidsLimit: 32, containerIdentitySha256: "b".repeat(64), imageDigest: "sha256:" + "c".repeat(64), imageDigestSource: "admission-controller-pinned-image-id", sequentialChildren: 1},
    schedule: {cases: 12, repetitions: 3, conditions: ["cold", "warm"], arms: ["fresh", "eligible-reuse"], observations: 144, sha256: "e".repeat(64)},
    denominators: treatmentDenominators(rows), costs: observation().costs, admission: {parentCpuSeconds: 1, wallMs: 2, codeMaterializationBytes: 1, tmpfs: {kind: "controller-tmpfs-cap", bytes: 16 * 1024 * 1024}},
    accounting: {cpuScope: "synthetic scope", components: "subsets, never summed again", transferBytes: 65536, retainedBytes: 65537, unpublishedSlots: 144, containerCpuSeconds: "unknown", containerCpuScope: "admitted-container-cgroup"},
    files: [] as {path: string; sha256: string; bytes: number}[], limitations: ["synthetic validator fixture only, no measurements"]};
}
function scaffolding(binding: DiagnoseSetupCode, skipped = false) {
  return {v: 1, kind: "synthetic-native-scaffolding", authority: "harness-observed", source: "visible-facts-only", independentPhysicalAttestation: false,
    state: skipped ? "skipped" : "materialized", reason: skipped ? "no-visible-producer" : null, ...binding,
    setup: {wallMs: 2, parentCpuSeconds: 0.1, subprocessCpuSeconds: "unknown"}, current: {wallMs: 3, parentCpuSeconds: 0.2, subprocessCpuSeconds: "unknown"},
    clockScope: "child-parent-process-only", components: "setup and current are subsets, never added again"};
}

test("paired slots preserve original corpus parity, seed order and cold/warm labels for all144 slots", () => {
  for (const trial of ["diagnose", "reuse"] as const) {
    const all = [];
    for (let index = 5; index < 17; index++) {
      const slots = treatmentSlots(index, [4, 12, 20], trial), baseline = baselineSlots(index, [4, 12, 20]);
      expect(slots).toHaveLength(12);
      for (const [pair, original] of baseline.entries()) {
        const actual = slots.slice(pair * 2, pair * 2 + 2);
        expect(actual.map(slot => slot.executedSlot)).toEqual([0, 1]);
        expect(actual.map(slot => [slot.seed, slot.condition, slot.repetition])).toEqual(Array(2).fill([original.seed, original.condition, original.repetition]));
        expect(actual[original.executedSlot]!.arm).toBe(trial === "reuse" ? "fresh" : "current-workflow");
      }
      all.push(...slots);
    }
    expect(all).toHaveLength(144);
    expect(new Set(all.map(slot => slot.arm)).size).toBe(2);
  }
  expect(() => treatmentSlots(0, [1, 2], "reuse")).toThrow("three declared seeds");
});

test("failed, cancelled, unknown and excluded slots stay in each full denominator", () => {
  const statuses = ["succeeded", "failed", "cancelled", "unknown", "excluded"] as const;
  const rows = ["fresh", "eligible-reuse"].flatMap(arm => statuses.map(status => ({arm: arm as "fresh" | "eligible-reuse", status})));
  const result = treatmentDenominators(rows);
  expect(result.full).toBe(10); expect(result.unknown).toBe(2); expect(result.failed).toBe(2);
  expect(result.arms.fresh).toEqual({full: 5, succeeded: 1, failed: 1, cancelled: 1, unknown: 1, excluded: 1});
  expect(treatmentChildCpuSeconds(undefined)).toBe("unknown");
  for (const total of [-1, NaN, Infinity]) expect(treatmentChildCpuSeconds({cpuTime: {total}})).toBe("unknown");
  expect(treatmentChildCpuSeconds({cpuTime: {total: 0}})).toBe(0);
  expect(treatmentChildCpuSeconds({cpuTime: {total: 1500000}})).toBe(1.5);
  expect(treatmentChildCpuSeconds({cpuTime: {total: 1500000n}})).toBe(1.5);
  expect(treatmentChildCpuSeconds({cpuTime: {total: 0n}})).toBe(0);
  expect(treatmentChildCpuSeconds({cpuTime: {total: -1n}})).toBe("unknown");
  expect(treatmentChildCpuSeconds({cpuTime: {total: BigInt(Number.MAX_SAFE_INTEGER) + 1n}})).toBe("unknown");
  expect(parseTreatmentCgroupCpu("usage_usec 1500000\nuser_usec 1000000\nsystem_usec 500000\n")).toBe(1.5);
  for (const text of ["", "usage_usec -1", "usage_usec 1.5", "usage_usec 1\nusage_usec 2", "x".repeat(4097)]) expect(() => parseTreatmentCgroupCpu(text)).toThrow("execution treatment trials:");
});

test("truth matching is evaluator-only and compares complete seeded outputs or diagnostic projection", () => {
  const expected = {freshExecution: {outputs: [{seed: 3, prepare: 6, transform: 12, evaluate: 24}]}};
  expect(treatmentMatches("reuse", expected, 3, expected.freshExecution.outputs[0])).toBe(true);
  expect(treatmentMatches("reuse", expected, 3, {...expected.freshExecution.outputs[0], evaluate: 25})).toBe(false);
  expect(() => treatmentMatches("reuse", expected, 4, {})).toThrow("unique sealed");
  const diagnostic = {provenance: {attemptId: "synthetic", head: "a".repeat(40)}, nextAction: "inspect"};
  expect(treatmentMatches("diagnose", {...diagnostic, evaluatorOnly: "not projected"}, 3, diagnostic)).toBe(true);
  expect(treatmentMatches("diagnose", diagnostic, 3, {...diagnostic, nextAction: "retry"})).toBe(false);
});

test("bounded slot receipts preserve unknown units, integration phase scopes and source bytes", () => {
  const row = observation(); row.integration = {instrumentation: {total: {wallMs: 2, parentCpuSeconds: 1, subprocessCpuSeconds: "unknown"}}, sourceRecordUnchanged: true};
  expect(validateTreatmentObservation(row)).toEqual(row);
  expect(row.costs.cpuSeconds).toBe("unknown");
  const dir = tempDir(), file = join(dir, "slot.json"); writeAtomic(file, JSON.stringify(row), TREATMENT_RECEIPT_BYTES);
  const before = readBytesBounded(file, TREATMENT_RECEIPT_BYTES);
  expect(readTreatmentObservation(file)).toEqual(row); expect(readBytesBounded(file, TREATMENT_RECEIPT_BYTES)).toEqual(before);
  const linked = join(dir, "linked.json"); symlinkSync(file, linked);
  expect(() => readTreatmentObservation(linked)).toThrow("linked");
  for (const value of [{...row, seed: 0.5}, {...row, slotOrder: ["fresh", "fresh"]}, {...row, integration: {path: "/private/synthetic"}}, {...row, privateBody: "private"}, {...row, result: "x".repeat(TREATMENT_RECEIPT_BYTES)}]) expect(() => validateTreatmentObservation(value)).toThrow("execution treatment trials:");
});

test("incomplete manifests retain the full144 denominator and bound code, admission and schedule", () => {
  const raw = manifest(); expect(validateTreatmentTrialManifest(raw)).toEqual(raw as unknown as TreatmentTrialManifest);
  expect(raw.denominators.full).toBe(144); expect(raw.denominators.arms.fresh!.full).toBe(72);
  for (const change of [
    (value: ReturnType<typeof manifest>) => {value.state = "complete";},
    (value: ReturnType<typeof manifest>) => {value.denominators.unknown--;},
    (value: ReturnType<typeof manifest>) => {value.environment.pidsLimit = 33;},
    (value: ReturnType<typeof manifest>) => {value.schedule.observations = 143;},
    (value: ReturnType<typeof manifest>) => {value.code.codeSha256 = "0".repeat(64);},
    (value: ReturnType<typeof manifest>) => {value.accounting.unpublishedSlots = 143;},
  ]) {const value = manifest(); change(value); expect(() => validateTreatmentTrialManifest(value)).toThrow("execution treatment trials:");}
});

test("inert receipt validators never execute accessors, proxy traps or serializers", () => {
  let calls = 0;
  const getter = observation(); Object.defineProperty(getter, "result", {enumerable: true, get() {calls++; return {};}});
  const proxy = new Proxy(observation(), {getPrototypeOf() {calls++; return Object.prototype;}});
  const serializer = {...observation(), toJSON() {calls++; return {};}};
  for (const raw of [getter, proxy, serializer]) expect(() => validateTreatmentObservation(raw)).toThrow("execution treatment trials:");
  expect(calls).toBe(0);
});

test("bundle bounds include JSON escaping, prefix and newline without starting a trial", () => {
  expect(JSON.parse(serializeTreatmentBundle({"manifest.json": "{}"}))).toEqual({v: 1, files: {"manifest.json": "{}"}});
  expect(() => serializeTreatmentBundle({"manifest.json": "{}", "../private.json": "{}"})).toThrow("filename");
  const huge: Record<string, string> = {"manifest.json": "{}"};
  for (let index = 0; index < 130; index++) huge[`slot-${String(index).padStart(3, "0")}.json`] = '"'.repeat(65000);
  expect(() => serializeTreatmentBundle(huge)).toThrow("escaped bundle");
});

test("rehashed slot identity forgeries fail against the frozen144-slot schedule without running an arm", () => {
  const root = fileURLToPath(new URL("..", import.meta.url)), registered = readRegisteredTreatmentSchedule(root, "reuse"), code = bindRunCode(root);
  const dir = tempDir(), raw = manifest();
  Object.assign(raw, {bindings: registered.bindings, methodSha256: registered.methodSha256, inputSha256: registered.inputSha256, expectedSha256: registered.expectedSha256, code});
  raw.schedule.sha256 = registered.sha256; raw.accounting.unpublishedSlots = 143;
  const first = registered.slots[0]!, original: TreatmentObservation = {...observation(), ...first, codeSha256: code.codeSha256, methodSha256: registered.methodSha256};
  const publish = (row: TreatmentObservation) => {
    const text = JSON.stringify(row) + "\n";
    writeAtomic(join(dir, "slot-000.json"), text, TREATMENT_RECEIPT_BYTES);
    raw.files = [{path: "slot-000.json", sha256: sha256(text), bytes: Buffer.byteLength(text)}];
    writeAtomic(join(dir, "manifest.json"), JSON.stringify(raw) + "\n", TREATMENT_RECEIPT_BYTES);
  };
  publish(original);
  expect(readTreatmentTrialManifest(dir, root).denominators.full).toBe(144);
  for (const change of [
    (row: TreatmentObservation) => {row.seed++;},
    (row: TreatmentObservation) => {row.caseId = registered.slots[12]!.caseId;},
    (row: TreatmentObservation) => {row.caseIndex++;},
    (row: TreatmentObservation) => {row.repetition = 1;},
    (row: TreatmentObservation) => {row.condition = "warm";},
    (row: TreatmentObservation) => {row.slotOrder.reverse(); row.arm = row.slotOrder[row.executedSlot]!;},
    (row: TreatmentObservation) => {row.inputSha256 = "0".repeat(64);},
    (row: TreatmentObservation) => {row.expectedSha256 = "0".repeat(64);},
  ]) {
    const row = structuredClone(original); change(row); publish(row);
    // Both row and file metadata have been rehashed; only the independent frozen schedule detects it.
    expect(() => readTreatmentTrialManifest(dir, root)).toThrow("slot identity differs from the frozen");
  }
  publish({...original, status: "failed", matched: true, result: {seed: -2147483648, prepare: 42, transform: 42, evaluate: 42}});
  expect(() => readTreatmentTrialManifest(dir, root)).toThrow("matched flag differs from sealed evaluator truth");
  publish(original); raw.schedule.sha256 = "0".repeat(64);
  writeAtomic(join(dir, "manifest.json"), JSON.stringify(raw), TREATMENT_RECEIPT_BYTES);
  expect(() => readTreatmentTrialManifest(dir, root)).toThrow("frozen registered schedule");
});

test("Diagnose alone requires setup code bindings and keeps scaffolding phase clocks separate", () => {
  const binding = {helperSha256: "a".repeat(64), fixtureFactorySha256: "b".repeat(64)};
  const row: TreatmentObservation = {...observation(), ...treatmentSlots(0, [3, 11, 19], "diagnose")[0]!, trial: "diagnose", diagnoseSetupCode: binding, result: {}, integration: {scaffolding: scaffolding(binding)}};
  row.costs.cpuSeconds = 5;
  expect(validateTreatmentObservation(row).costs.cpuSeconds).toBe(5);
  const {diagnoseSetupCode: _binding, ...missingBinding} = row;
  expect(() => validateTreatmentObservation(missingBinding)).toThrow("receipt fields");
  expect(validateTreatmentObservation(observation()).trial).toBe("reuse");
  expect(() => validateTreatmentObservation({...row, integration: {scaffolding: {...scaffolding(binding), helperSha256: "c".repeat(64)}}})).toThrow("scaffolding hashes differ");
  expect(() => validateDiagnosticScaffolding({...scaffolding(binding), current: {wallMs: 1, parentCpuSeconds: -1, subprocessCpuSeconds: "unknown"}}, binding)).toThrow("phase clock");
  expect(() => validateDiagnosticScaffolding({...scaffolding(binding), independentPhysicalAttestation: true}, binding)).toThrow("authority or clock scope");
  expect(() => validateDiagnosticScaffolding(scaffolding(binding), binding, {})).toThrow("skip state");
  expect(() => validateDiagnosticScaffolding(scaffolding(binding, true), binding, {})).not.toThrow();
});

test("rehashed Diagnose helper forgery fails against the measured historical code inventory", () => {
  const root = fileURLToPath(new URL("..", import.meta.url)), registered = readRegisteredTreatmentSchedule(root, "diagnose"), code = bindRunCode(root), binding = diagnoseSetupCode(code);
  const dir = tempDir(), raw = manifest();
  Object.assign(raw, {trial: "diagnose", bindings: registered.bindings, methodSha256: registered.methodSha256, inputSha256: registered.inputSha256, expectedSha256: registered.expectedSha256, code});
  raw.schedule.arms = ["current-workflow", "H1-A1-C1-lineage-view"]; raw.schedule.sha256 = registered.sha256;
  raw.denominators = treatmentDenominators(registered.slots.map(slot => ({arm: slot.arm, status: "unknown" as const}))); raw.accounting.unpublishedSlots = 143;
  const first = registered.slots[0]!, input = JSON.parse(readTextBounded(join(root, `test/fixtures/execution-eval/${first.caseId}.input.json`), 16384)).input;
  const skipped = resolveDiagnosticFixture(input).provenance.attemptId === null;
  const row: TreatmentObservation = {...observation(), ...first, trial: "diagnose", codeSha256: code.codeSha256, methodSha256: registered.methodSha256,
    diagnoseSetupCode: binding, result: {}, integration: {scaffolding: scaffolding(binding, skipped)}};
  const publish = () => {const text = JSON.stringify(row) + "\n"; writeAtomic(join(dir, "slot-000.json"), text, TREATMENT_RECEIPT_BYTES); raw.files = [{path: "slot-000.json", sha256: sha256(text), bytes: Buffer.byteLength(text)}]; writeAtomic(join(dir, "manifest.json"), JSON.stringify(raw), TREATMENT_RECEIPT_BYTES);};
  publish(); expect(readTreatmentTrialManifest(dir, root).trial).toBe("diagnose");
  row.diagnoseSetupCode = {...binding, helperSha256: "0".repeat(64)};
  row.integration = {scaffolding: scaffolding(row.diagnoseSetupCode, skipped)};
  publish();
  expect(() => readTreatmentTrialManifest(dir, root)).toThrow("diagnostic setup code binding differs from measured helper inventory");
});
