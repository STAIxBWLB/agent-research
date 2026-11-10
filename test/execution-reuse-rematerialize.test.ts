import { expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, filePath, FROZEN_RECEIPT, verifyPreregistration } from "../scripts/execution-eval.ts";
import { checkRematerializedReuseAdmission } from "../scripts/execution-reuse.ts";
import { REMATERIALIZATION_PROTOCOL, REMATERIALIZATION_RECEIPT, SETUP_CODE_FILES, rematerializeFrozenReuseSetup, rematerializeReuseCase, reuseSetupDigest, sealReuseRematerialization, verifyReuseRematerializationSeal } from "../scripts/execution-reuse-rematerialize.ts";
import { freshValues } from "../scripts/execution-workload.ts";
import { AMENDMENT_RECEIPT as SUPERVISION_RECEIPT } from "../scripts/execution-supervision-amendment.ts";
import { readBytesBounded, readTextBounded, sha256 } from "../src/study.ts";
import { tempDir } from "./helpers.ts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const PARENT_RECEIPT = "72f36f856c2559bf7a626689bca3825ae3cfe49f27c9d8abf544f24bd2778e20";
const SUPERVISION_RECEIPT_SHA256 = "5fd3cc18a888bd9a11f06db2996a9cff284aae3ff52b3c47eb0609d16a4200cf";
type StageName = "prepare" | "transform" | "evaluate";
const ALL_STAGES: StageName[] = ["prepare", "transform", "evaluate"];
/** Which stages the reuse path must admit, written from the declared stage edits, never read from a label file. */
const ADMITTED: Record<string, StageName[]> = {
  "reuse-local-stage-edit-first-variant": ["prepare"],
  "reuse-local-stage-edit-second-variant": ["prepare", "transform"],
  "reuse-global-code-change-first-variant": [],
  "reuse-global-code-change-second-variant": [],
};
const REFUSED: [string, string][] = [
  ["reuse-no-hit-first-variant", "no-frozen-source"], ["reuse-no-hit-second-variant", "no-frozen-source"],
  ["reuse-corrupt-artifact-first-variant", "source-corrupt"], ["reuse-corrupt-artifact-second-variant", "source-corrupt"],
  ["reuse-pruned-artifact-first-variant", "source-not-retained"], ["reuse-pruned-artifact-second-variant", "source-not-retained"],
  ["reuse-interrupted-source-first-variant", "source-not-succeeded"], ["reuse-interrupted-source-second-variant", "source-not-succeeded"],
];
const casePath = (id: string) => `test/fixtures/execution-eval/${id}.input.json`;
function fixture() {
  const root = tempDir(), parent = verifyPreregistration(sourceRoot, join(sourceRoot, FROZEN_RECEIPT));
  const names = [...new Set([FROZEN_RECEIPT, SUPERVISION_RECEIPT, ...parent.methodFiles.map(row => row.path), ...parent.inputFiles.map(row => row.path), ...parent.expectedFiles.map(row => row.path), REMATERIALIZATION_PROTOCOL, ...SETUP_CODE_FILES])];
  let total = 0;
  for (const name of names) {
    const bytes = readBytesBounded(filePath(sourceRoot, name), 65_536, {noFollow: true});
    total += bytes.length; if (total > 3 * 1024 * 1024) throw new Error("synthetic test fixture copy exceeds 3 MiB");
    const target = join(root, name); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes);
  }
  const bytes = (name: string) => sha256(readBytesBounded(filePath(root, name), 65_536, {noFollow: true}));
  const before = {parent: bytes(FROZEN_RECEIPT), supervision: bytes(SUPERVISION_RECEIPT), expected: parent.expectedFiles.map(row => [row.path, bytes(row.path)])};
  return {root, parent, before, receipt: join(root, REMATERIALIZATION_RECEIPT)};
}
/** Reads one frozen case wrapper, never its expected label file. */
function wrapper(root: string, id: string) { return JSON.parse(readTextBounded(join(root, casePath(id)), 16_384)); }
function read(root: string, name: string) { return readTextBounded(filePath(root, name), 65_536, {noFollow: true}); }
function edit(root: string, name: string, mutate: (raw: any) => void) {
  const raw = JSON.parse(read(root, name)); mutate(raw); writeFileSync(join(root, name), JSON.stringify(raw, null, 2) + "\n");
}

test("the same frozen workload always rebuilds the same bytes, and the seal binds no label file", () => {
  const f = fixture(), first = rematerializeFrozenReuseSetup(f.root), second = rematerializeFrozenReuseSetup(f.root);
  expect(first.identity).toEqual(second.identity);
  expect(first.setupSha256).toBe(second.setupSha256); expect(first.setupSha256).toBe(reuseSetupDigest(first));
  expect(first.identity.amends).toEqual({path: FROZEN_RECEIPT, sha256: f.before.parent, receiptSha256: f.parent.receiptSha256});
  expect(first.identity.amends.receiptSha256).toBe(PARENT_RECEIPT);
  expect(first.identity.bindings.thresholdsSha256).toBe(f.parent.bindings.thresholdsSha256);
  expect(first.identity.bindings.denominatorsSha256).toBe(f.parent.bindings.denominatorsSha256);
  expect(Object.values(first.identity.bindings).every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  expect(first.identity.files.some(row => row.path.endsWith(".expected.json"))).toBe(false);
  expect(first.identity.files.map(row => row.path)).toContain(REMATERIALIZATION_PROTOCOL);
  for (const name of SETUP_CODE_FILES) expect(first.identity.files.find(row => row.path === name)?.sha256).toBe(sha256(readBytesBounded(filePath(f.root, name), 65_536, {noFollow: true})));
  // One declared workload appears in several cases; identical declarations must rebuild identical stage bytes.
  const groups = new Map<string, string[]>();
  for (const row of first.identity.cases) if (row.workloadSha256) groups.set(row.workloadSha256, [...(groups.get(row.workloadSha256) ?? []), row.stageSha256!]);
  expect(groups.size).toBe(2);
  for (const digests of groups.values()) expect(new Set(digests).size).toBe(1);
  const rebuilt = first.identity.cases.filter(row => row.state === "rematerialized");
  expect(rebuilt.map(row => row.caseId)).toEqual(Object.keys(ADMITTED));
  for (const row of rebuilt) {
    const declared = wrapper(f.root, row.caseId).input.source.workload;
    expect(row.stages).toHaveLength(3 * declared.seeds.length);
    for (const stage of row.stages) {
      expect(stage.value).toBe(freshValues({workload: declared}, stage.seed)[stage.stage]);
      expect(stage.sha256).toBe(sha256(JSON.stringify(stage.value) + "\n"));
      expect(stage.bytes).toBe(Buffer.byteLength(JSON.stringify(stage.value) + "\n"));
    }
    expect(row.hitCapableStages).toEqual(ADMITTED[row.caseId]!);
  }
  expect(first.identity.cases.filter(row => row.state === "refused").map(row => [row.caseId, row.reason])).toEqual(REFUSED.map(([id, reason]) => [id, reason]));
  expect(first.identity.cases.filter(row => row.state === "refused").every(row => !row.stages.length && !row.hitCapableStages.length)).toBe(true);
  expect(Object.entries(first.setupCosts).filter(([, value]) => value !== "unknown").map(([key]) => key).sort()).toEqual(["materializationCpuSeconds", "materializationWallMs"]);
});

test("a changed workload, protocol or setup code gives a new identity instead of a silently reused one", () => {
  const f = fixture(), sealed = rematerializeFrozenReuseSetup(f.root).setupSha256, base = wrapper(f.root, "reuse-local-stage-edit-first-variant");
  expect(rematerializeReuseCase(structuredClone(base)).workloadSha256).toBe(rematerializeReuseCase(base).workloadSha256);
  const values = structuredClone(base); values.input.source.workload.values = [2, 5, 9];
  const moved = rematerializeReuseCase(values);
  expect(moved.workloadSha256).not.toBe(rematerializeReuseCase(base).workloadSha256);
  expect(moved.stageSha256).not.toBe(rematerializeReuseCase(base).stageSha256);
  // A declaration-only edit changes the rebuilt bytes but cannot make a downstream stage match an upstream miss.
  const operation = structuredClone(base); operation.input.source.workload.stages[2].operation = "square-plus-two-seeds";
  expect(rematerializeReuseCase(operation).stageSha256).not.toBe(rematerializeReuseCase(base).stageSha256);
  expect(rematerializeReuseCase(operation).hitCapableStages).toEqual(["prepare"]);
  const upstream = structuredClone(base); upstream.input.workload.values = [2, 5, 9];
  expect(rematerializeReuseCase(upstream).hitCapableStages).toEqual([]);
  const code = structuredClone(base); code.input.currentContext.globalCodeDigest = "1".repeat(64);
  expect(rematerializeReuseCase(code).hitCapableStages).toEqual([]);
  for (const target of [REMATERIALIZATION_PROTOCOL, ...SETUP_CODE_FILES]) {
    const g = fixture();
    expect(sealReuseRematerialization(g.root).state).toBe("verified");
    writeFileSync(join(g.root, target), read(g.root, target) + "\n");
    expect(verifyReuseRematerializationSeal(g.root).state).toBe("changed");
    expect(rematerializeFrozenReuseSetup(g.root).setupSha256).not.toBe(sealed);
  }
});

test("rebuilds the frozen sources and the reuse path admits exactly the stages each declared edit allows", async () => {
  const f = fixture();
  for (const [id, admitted] of Object.entries(ADMITTED)) {
    const input = wrapper(f.root, id).input, seed = input.workload.seeds[0] as number;
    const result = await checkRematerializedReuseAdmission({...input, id}, seed);
    expect(result.kind).toBe("rematerialized-reuse-admission-check"); expect(result.sourcePopulation).toBe("fixture-rematerialized");
    expect(result.caseId).toBe(id); expect(result.sourceAttemptId).not.toBe(result.currentAttemptId);
    expect(result.hits.map(row => row.stage)).toEqual(admitted);
    expect(result.freshStages).toEqual(ALL_STAGES.filter(stage => !admitted.includes(stage)));
    expect(result.hits.every(row => /^[a-f0-9]{64}$/.test(row.key) && row.source.attemptId === result.sourceAttemptId)).toBe(true);
    expect(result.misses.every(row => row.reason !== "verified-hit")).toBe(true);
    expect(result.sourceObserved).toEqual(freshValues({workload: input.source.workload}, seed));
    expect(result.currentObserved).toEqual(result.expected);
    expect(result.expected).toEqual(freshValues(input, seed));
    const codeChanged = input.currentContext.globalCodeDigest !== input.source.globalCodeDigest;
    const stagesEdited = canonical(input.workload) !== canonical(input.source.workload);
    expect(result.changedKeys).toEqual([...(codeChanged ? ["code-tree"] : []), ...(stagesEdited ? ["candidate-stage-edit"] : [])]);
    expect(result.counts).toEqual({reusedStages: admitted.length, currentExecutedStages: 1 + ALL_STAGES.length - admitted.length});
    expect(result.executed).toEqual([...ALL_STAGES, "verify", ...ALL_STAGES.filter(stage => !admitted.includes(stage)), "verify"]);
    expect(result.sourceRecordUnchanged).toBe(true); expect(result.evaluatorFresh).toBe(true);
    expect(Object.values(result.costs).every(value => value === "unknown")).toBe(true);
    expect(result.candidateEvidenceSha256).toMatch(/^[a-f0-9]{64}$/);
  }
}, 180_000);

test("the seal freezes once, verifies, and refuses tampered bytes without overwriting them", () => {
  const f = fixture(), first = sealReuseRematerialization(f.root), bytes = read(f.root, REMATERIALIZATION_RECEIPT), modified = statSync(f.receipt).mtimeMs;
  expect(first.state).toBe("verified");
  expect(verifyReuseRematerializationSeal(f.root)).toEqual(first);
  expect(sealReuseRematerialization(f.root)).toEqual(first);
  expect(read(f.root, REMATERIALIZATION_RECEIPT)).toBe(bytes);
  expect(statSync(f.receipt).mtimeMs).toBe(modified); expect(statSync(f.receipt).mode & 0o777).toBe(0o600);
  expect(JSON.parse(bytes)).toMatchObject({identity: {v: 1, status: "preregistered-rematerialization-not-measured"}, setupSha256: first.receipt!.setupSha256});
  const missing = fixture();
  expect(verifyReuseRematerializationSeal(missing.root)).toEqual({state: "missing", receipt: null});
  expect(existsSync(missing.receipt)).toBe(false);
  for (const mutation of ["seal", "case-stage", "hit-capable", "costs", "version", "identity", "input-bytes", "label-bytes"] as const) {
    const g = fixture(), before = sealReuseRematerialization(g.root);
    const original = read(g.root, REMATERIALIZATION_RECEIPT);
    if (mutation === "input-bytes") writeFileSync(join(g.root, casePath("reuse-no-hit-first-variant")), read(g.root, casePath("reuse-no-hit-first-variant")) + "\n");
    else if (mutation === "label-bytes") writeFileSync(join(g.root, casePath("reuse-no-hit-first-variant").replace(".input.", ".expected.")), `${read(g.root, casePath("reuse-no-hit-first-variant").replace(".input.", ".expected."))}\n`);
    else edit(g.root, REMATERIALIZATION_RECEIPT, raw => {
      if (mutation === "seal") raw.setupSha256 = "0".repeat(64);
      else if (mutation === "case-stage") raw.identity.cases[0].stages[0].sha256 = "0".repeat(64);
      else if (mutation === "hit-capable") raw.identity.cases[0].hitCapableStages = [];
      else if (mutation === "costs") raw.setupCosts.materializationCpuSeconds = -1;
      else if (mutation === "version") raw.identity.v = 2;
      else raw.identity.cases.pop();
    });
    const tampered = mutation.includes("bytes") ? original : read(g.root, REMATERIALIZATION_RECEIPT);
    expect(verifyReuseRematerializationSeal(g.root).state).toBe("changed");
    expect(sealReuseRematerialization(g.root).state).toBe("changed");
    expect(read(g.root, REMATERIALIZATION_RECEIPT)).toBe(tampered);
    if (!mutation.includes("bytes")) expect(before.receipt!.setupSha256).toBe(first.receipt!.setupSha256);
  }
});

test("receipt links and linked parents are refused, and v1, supervision v2 and every label stay byte-identical", () => {
  const f = fixture(), target = join(f.root, "other-receipt.json");
  writeFileSync(target, "{}"); symlinkSync(target, f.receipt);
  expect(() => sealReuseRematerialization(f.root)).toThrow("physical regular file");
  expect(() => verifyReuseRematerializationSeal(f.root)).toThrow("physical regular file");
  unlinkSync(f.receipt);
  symlinkSync(join(f.root, "absent-receipt.json"), f.receipt);
  expect(() => verifyReuseRematerializationSeal(f.root)).toThrow("physical regular file");
  unlinkSync(f.receipt);
  const directory = join(f.root, "docs/verification"), moved = join(f.root, "moved-verification");
  renameSync(directory, moved); symlinkSync(moved, directory);
  expect(() => sealReuseRematerialization(f.root)).toThrow("physical directory");
  unlinkSync(directory); renameSync(moved, directory);
  expect(sealReuseRematerialization(f.root).state).toBe("verified");
  const bytes = (name: string) => sha256(readBytesBounded(filePath(f.root, name), 65_536, {noFollow: true}));
  expect(bytes(FROZEN_RECEIPT)).toBe(f.before.parent);
  expect(bytes(SUPERVISION_RECEIPT)).toBe(f.before.supervision);
  expect(verifyPreregistration(f.root, join(f.root, FROZEN_RECEIPT)).receiptSha256).toBe(PARENT_RECEIPT);
  expect(JSON.parse(read(f.root, SUPERVISION_RECEIPT)).receiptSha256).toBe(SUPERVISION_RECEIPT_SHA256);
  expect(f.before.expected.map(([name]) => [name, bytes(name!)])).toEqual(f.before.expected);
});
