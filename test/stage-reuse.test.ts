import { expect, test } from "bun:test";
import { validateStageProtocol, stageProtocolHash } from "../src/exp/stages.ts";
import { stageReuseEligibility, stageReuseKey, validateReuseContract, type StageReuseContract, type StageReuseKeyInput, type StageReuseEligibilityInput, type StageReuseReason } from "../src/exp/reuse.ts";
import { metricProtocol } from "./metric-fixtures.ts";

function contract(): StageReuseContract {
  return { v: 1, kind: "pure-artifact", inputs: "declared-only", externalState: "none", writableState: "fresh-output-only", modelOutputs: "forbidden", determinism: "byte-exact", toolchain: { description: "Synthetic deterministic byte transformer, documented fixtures", documentationSha256: "d".repeat(64) } };
}
function protocol() {
  const base = metricProtocol(), execution = { ...base.candidate, seed: true, code: "snapshot", reuse: contract() };
  return validateStageProtocol({ ...base, v: 2, seeds: [1, 2], candidate: { stages: [
    { ...execution, name: "prepare", needs: [], inputs: { data: { task: "data.txt" } }, outputs: { rows: "rows.txt" } },
    { ...execution, name: "train", needs: ["prepare"], inputs: { rows: { stage: "prepare", output: "rows" } }, outputs: { model: "model.bin" } },
  ] } });
}
function input(): StageReuseKeyInput {
  return { protocol: protocol(), stage: { kind: "candidate", name: "prepare" }, phase: "investigate", mode: "eligible", studyId: "synthetic-study", populationSha256: "f".repeat(64),
    codeTree: "a".repeat(40), codeSnapshotSha256: "b".repeat(64), inputHashes: { data: "c".repeat(64) }, seed: 1,
    runtime: { semantics: "ares-stage-v2/1", producerVersion: "synthetic-1" }, platform: { os: "linux", arch: "x64", abi: "synthetic-libc-1" } };
}
function eligibility(value: StageReuseKeyInput) { return { protocol: value.protocol, stage: value.stage, phase: value.phase, mode: value.mode, forceFresh: value.forceFresh }; }

test("reuse declaration is closed, versioned and cannot claim model caching, hidden state or review authority", () => {
  expect(validateReuseContract(contract())).toEqual(contract());
  for (const raw of [
    { ...contract(), v: 2 }, { ...contract(), kind: "model-output" }, { ...contract(), inputs: "implicit" },
    { ...contract(), externalState: "host" }, { ...contract(), writableState: "shared-host" },
    { ...contract(), modelOutputs: "allowed" }, { ...contract(), determinism: "statistical" },
    { ...contract(), reviewed: true }, { ...contract(), toolchain: {} },
    { ...contract(), toolchain: { description: "synthetic", documentationSha256: "z".repeat(64) } },
    { ...contract(), toolchain: { ...contract().toolchain, description: "x".repeat(1025) } },
    { ...contract(), toolchain: { ...contract().toolchain, description: "가".repeat(342) } },
  ]) expect(() => validateReuseContract(raw)).toThrow();
});

test("default, forced, non-investigate, evaluator, legacy and undeclared cases remain fresh", () => {
  const base = input(), e = eligibility(base);
  expect(stageReuseEligibility(e)).toEqual({ v: 1, kind: "declaration-only", eligible: true, reason: "declared-pure-artifact" });
  const checks: { value: StageReuseEligibilityInput; reason: StageReuseReason }[] = [
    { value: { ...e, mode: undefined }, reason: "mode-off" }, { value: { ...e, mode: "off" as const }, reason: "mode-off" },
    { value: { ...e, forceFresh: true }, reason: "force-fresh" },
    ...["evaluate", "ablate", "final", "posthoc", "main", "unknown"].map(phase => ({ value: { ...e, phase }, reason: "phase-fresh" as const })),
    { value: { ...e, stage: { kind: "evaluator" as const } }, reason: "evaluator-fresh" },
    { value: { ...e, protocol: metricProtocol() }, reason: "legacy-fresh" },
  ];
  for (const { value, reason } of checks) {
    expect(stageReuseEligibility(value)).toEqual({ v: 1, kind: "declaration-only", eligible: false, reason });
    expect(() => stageReuseKey({ ...base, ...value })).toThrow(reason);
  }
  const p = protocol(); delete p.candidate.stages[0]!.reuse;
  expect(stageReuseEligibility({ ...e, protocol: p }).reason).toBe("undeclared-contract");
  p.candidate.stages[0]!.reuse = contract(); p.candidate.stages[0]!.outputs = {}; p.candidate.stages.pop();
  expect(stageReuseEligibility({ ...e, protocol: p }).reason).toBe("no-artifact-outputs");
});

test("every keyed execution, code, input, contract, runtime and platform identity deterministically invalidates", () => {
  const base = input(), original = stageReuseKey(base);
  expect(stageReuseKey(structuredClone(base))).toBe(original);
  const changes: ((value: StageReuseKeyInput) => void)[] = [
    value => { value.studyId = "other-study"; }, value => { value.populationSha256 = "e".repeat(64); }, value => { value.codeTree = "e".repeat(40); }, value => { value.codeSnapshotSha256 = "e".repeat(64); },
    value => { value.inputHashes.data = "e".repeat(64); }, value => { value.seed = 2; },
    value => { value.runtime.semantics = "ares-stage-v2/2"; }, value => { value.runtime.producerVersion = "synthetic-2"; },
    value => { value.platform.os = "darwin"; }, value => { value.platform.arch = "arm64"; }, value => { value.platform.abi = "synthetic-libc-2"; },
    value => { if (value.protocol.v === 2) value.protocol.candidate.stages[0]!.image = `synthetic@sha256:${"e".repeat(64)}`; },
    value => { if (value.protocol.v === 2) value.protocol.candidate.stages[0]!.command = ["run", "changed argument"]; },
    value => { if (value.protocol.v === 2) value.protocol.candidate.stages[0]!.env = { MODE: "different" }; },
    value => { if (value.protocol.v === 2) value.protocol.candidate.stages[0]!.seed = false; },
    value => { if (value.protocol.v === 2) value.protocol.candidate.stages[0]!.inputs.data = { task: "other.txt" }; },
    value => { if (value.protocol.v === 2) value.protocol.candidate.stages[0]!.outputs.rows = "other.txt"; },
    value => { if (value.protocol.v === 2) value.protocol.candidate.stages[0]!.reuse!.toolchain.documentationSha256 = "e".repeat(64); },
    value => { if (value.protocol.v === 2) value.protocol.candidate.stages[0]!.reuse!.toolchain.description = "Different documented transformer"; },
    value => { value.protocol.method = "different comparison population"; },
    value => { value.protocol.evaluator.image = `synthetic@sha256:${"e".repeat(64)}`; },
    value => { value.protocol.evaluator.command = ["different evaluator"]; },
    value => { value.protocol.metrics[0]!.unit = "different-unit"; }, value => { value.protocol.metrics[0]!.direction = "min"; },
    value => { value.protocol.seeds.push(3); }, value => { value.protocol.limits.cpus = 2; },
  ];
  for (const change of changes) { const next = structuredClone(base); change(next); expect(stageReuseKey(next)).not.toBe(original); }
  const train = input(); train.stage = { kind: "candidate", name: "train" }; train.inputHashes = { rows: "c".repeat(64) };
  const ordered = stageReuseKey(train); if (train.protocol.v === 2) train.protocol.candidate.stages[1]!.needs = [];
  expect(stageReuseKey(train)).not.toBe(ordered);
});

test("budget changes and unrelated downstream stage edits preserve an upstream key; object order is canonical", () => {
  const base = input(), original = stageReuseKey(base), budget = structuredClone(base), downstream = structuredClone(base);
  budget.protocol.budget.maxAttempts++; expect(stageReuseKey(budget)).toBe(original);
  if (downstream.protocol.v === 2) downstream.protocol.candidate.stages[1]!.command = ["different downstream implementation"];
  expect(stageReuseKey(downstream)).toBe(original);
  if (base.protocol.v === 2) base.protocol.candidate.stages[0]!.env = { B: "b", A: "a" };
  const unordered = structuredClone(base); if (unordered.protocol.v === 2) unordered.protocol.candidate.stages[0]!.env = { A: "a", B: "b" };
  expect(stageReuseKey(unordered)).toBe(stageReuseKey(base));
  if (unordered.protocol.v === 2) unordered.protocol.candidate.stages[0]!.command.push(" spaced argv ");
  expect(stageReuseKey(unordered)).not.toBe(stageReuseKey(base));
});

test("keys refuse missing/extra input identities, undefined ABI/version/seed and forged eligibility fields", () => {
  const base = input();
  for (const patch of [
    { inputHashes: {} }, { inputHashes: { data: "not-a-digest" } }, { inputHashes: { data: "c".repeat(64), extra: "c".repeat(64) } },
    { populationSha256: "short" }, { codeTree: "short" }, { codeSnapshotSha256: "short" }, { seed: 3 }, { studyId: "../outside" },
    { runtime: { semantics: "", producerVersion: "v1" } }, { platform: { os: "linux", arch: "x64", abi: "" } },
    { approved: true }, { mode: "automatic" }, { forceFresh: "yes" },
  ]) expect(() => stageReuseKey({ ...base, ...patch } as StageReuseKeyInput)).toThrow();
  expect(() => stageReuseEligibility({ ...eligibility(base), approved: true } as ReturnType<typeof eligibility>)).toThrow("unknown");
});

test("optional contract is preserved in v2 identity and absent declarations stay absent", () => {
  const p = protocol(), withContract = stageProtocolHash(p);
  delete p.candidate.stages[0]!.reuse;
  const withoutContract = stageProtocolHash(p);
  expect(withoutContract).not.toBe(withContract);
  expect(Object.hasOwn(validateStageProtocol(p).candidate.stages[0]!, "reuse")).toBe(false);
  p.candidate.stages[0]!.reuse = contract(); expect(stageProtocolHash(p)).toBe(withContract);
});
