import {expect, spyOn, test} from "bun:test";
import {dirname, join} from "node:path";
import * as fs from "node:fs";
import {fileURLToPath} from "node:url";
import {freezeHarnessPreregistration, verifyHarnessPreregistration, buildRoleInputs, librarySnapshot, validateRolePayload, validateRoundInputs, requireFixturePolicy, requireResumeBinding, runHarnessFaults, runHarnessControls, liveArms, ROLES, CONDITIONS, HARNESS_PROTOCOL, HARNESS_FROZEN, HARNESS_METHOD, type HarnessCase} from "../scripts/harness-eval.ts";
import {COST_FIELDS, validateCostRecord, canonical} from "../scripts/execution-eval.ts";
import {readTextBounded, writeAtomic, sha256} from "../src/study.ts";
import {tempDir} from "./helpers.ts";
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const read = (root: string, file: string, bound = 65_536) => JSON.parse(readTextBounded(join(root, file), bound));
function corpus(root = sourceRoot) {
  const protocol = read(root, HARNESS_PROTOCOL), index = read(root, protocol.corpus.index);
  const cases: HarnessCase[] = index.cases.map((row: {id: string; family: string; split: "learning" | "heldout"; input: string; control: string}) => ({id: row.id, family: row.family, split: row.split, input: read(root, row.input, 16_384), control: read(root, row.control, 16_384), inputSha256: sha256(readTextBounded(join(root, row.input), 16_384))}));
  return {protocol, index, cases};
}
function fixture() {
  const root = tempDir(), seal = read(sourceRoot, HARNESS_FROZEN);
  for (const {path} of seal.files) {fs.mkdirSync(dirname(join(root, path)), {recursive: true}); writeAtomic(join(root, path), readTextBounded(join(sourceRoot, path), 65_536), 65_536);}
  const receipt = join(root, "frozen.json"); return {root, receipt, ...corpus(root)};
}

test("issue68 freezes independently, verifies idempotently and leaves code outside the seal", () => {
  const f = fixture(), frozen = freezeHarnessPreregistration(f.root, f.receipt), before = readTextBounded(f.receipt, 65_536);
  expect(freezeHarnessPreregistration(f.root, f.receipt)).toEqual(frozen); expect(verifyHarnessPreregistration(f.root, f.receipt)).toEqual(frozen);
  fs.mkdirSync(join(f.root, "src")); writeAtomic(join(f.root, "src/future.ts"), "// Changed treatment source is bound by run receipts only\n", 65_536);
  expect(verifyHarnessPreregistration(f.root, f.receipt)).toEqual(frozen); expect(readTextBounded(f.receipt, 65_536)).toBe(before); expect(fs.statSync(f.receipt).mode & 0o777).toBe(0o600);
});

for (const kind of ["input", "expected", "threshold", "denominator", "order", "learning-source", "control", "method"] as const) test(`verify refuses changed ${kind} without rewriting the seal`, () => {
  const f = fixture(); freezeHarnessPreregistration(f.root, f.receipt); const before = readTextBounded(f.receipt, 65_536);
  if (["input", "expected", "control"].includes(kind)) {const file = f.index.cases[0][kind]; writeAtomic(join(f.root, file), readTextBounded(join(f.root, file), 16_384) + "\n", 16_384);}
  else if (kind === "method") writeAtomic(join(f.root, HARNESS_METHOD), readTextBounded(join(f.root, HARNESS_METHOD), 65_536) + "\n", 65_536);
  else {const p = f.protocol; if (kind === "threshold") p.thresholds.guidance.minValidOutcomeGainPercentagePoints = 4; else if (kind === "denominator") p.denominators.pop(); else if (kind === "order") p.orders[0].taskIds.reverse(); else p.corpus.learningSourceIds.pop(); writeAtomic(join(f.root, HARNESS_PROTOCOL), JSON.stringify(p), 65_536);}
  expect(() => verifyHarnessPreregistration(f.root, f.receipt)).toThrow("harness eval"); expect(readTextBounded(f.receipt, 65_536)).toBe(before);
});

test("the frozen split/order, five budgets and prospective thresholds match the issue contract", () => {
  const f = corpus(), seal = verifyHarnessPreregistration(sourceRoot);
  expect(f.cases).toHaveLength(12); expect(new Set(f.cases.map(row => row.family)).size).toBeGreaterThanOrEqual(2); expect(f.protocol.orders).toHaveLength(3); expect(f.protocol.conditions.map((row: {id: string}) => row.id)).toEqual([...CONDITIONS]);
  expect(f.protocol.denominators).toEqual(["planned", "executed", "succeeded", "failed", "cancelled", "denied", "judge-unavailable", "unknown", "excluded", "unavailable"]);
  for (const order of f.protocol.orders) {expect(order.taskIds).toHaveLength(12); expect(order.taskIds.slice(0, 8).every((id: string) => f.protocol.corpus.learningSourceIds.includes(id))).toBe(true); expect(order.taskIds.slice(8).every((id: string) => f.protocol.corpus.heldoutIds.includes(id))).toBe(true);}
  expect(seal.bindings.orderedStreamSha256).toHaveLength(64); expect(seal.bindings).not.toHaveProperty("codeSha256"); expect(f.protocol.thresholds.status).toBe("proposed-not-measured");
});

test("each round has one immutable past-only library, and held-out reflections never feed held-out successors", () => {
  const {protocol, cases} = corpus();
  for (const order of protocol.orders) {
    let heldoutHash: string | undefined;
    for (const id of order.taskIds) {
      const task = cases.find(row => row.id === id)!, library = librarySnapshot(cases, order, id, protocol.corpus.learningSourceIds), inputs = buildRoleInputs(task, "contrastive-prior", library);
      validateRoundInputs(inputs); const hash = inputs.worker.librarySha256 as string;
      for (const entry of library) {expect(protocol.corpus.learningSourceIds).toContain(entry.sourceTaskId); expect(order.taskIds.indexOf(entry.sourceTaskId)).toBeLessThan(order.taskIds.indexOf(id)); expect(entry.sourceTaskId).not.toBe(id);}
      expect(new Set(ROLES.map(role => canonical(inputs[role].library))).size).toBe(1);
      if (task.split === "heldout") {if (heldoutHash) expect(hash).toBe(heldoutHash); heldoutHash = hash; expect(library).toHaveLength(8); expect(library.some(entry => protocol.corpus.heldoutIds.includes(entry.sourceTaskId))).toBe(false);}
      expect(Object.isFrozen(library)).toBe(true);
    }
  }
});

test("private evaluator keys, rubrics, control paths and future-task ids never enter any role DTO", () => {
  const {protocol, index, cases} = corpus(), order = protocol.orders[0];
  for (const task of cases) {
    const library = librarySnapshot(cases, order, task.id, protocol.corpus.learningSourceIds);
    for (const condition of CONDITIONS) {
      const inputs = buildRoleInputs(task, condition, library);
      for (const role of ROLES) {
        const view = canonical(inputs[role]); expect(view).not.toContain("evaluatorKey"); expect(view).not.toContain("rubric"); expect(view).not.toContain("selectedSlot"); expect(view).not.toContain("test/fixtures/");
        for (const row of index.cases) expect(view).not.toContain(read(sourceRoot, row.expected, 16_384).evaluatorKey);
        for (const future of order.taskIds.slice(order.taskIds.indexOf(task.id) + 1)) expect(view).not.toContain(future);
        expect(() => validateRolePayload(role, {...inputs[role], rubric: "private"})).toThrow();
        expect(() => validateRolePayload(role, {...inputs[role], data: {nested: {futureTaskData: "private"}}})).toThrow();
      }
      expect(canonical(inputs.selector)).not.toContain(condition);
    }
  }
});

test("library mutation, unregistered source replacement and revoked policy invalidate rather than refresh", () => {
  const {protocol, cases} = corpus(), order = protocol.orders[0], task = cases.at(-1)!, library = librarySnapshot(cases, order, task.id, protocol.corpus.learningSourceIds), inputs = buildRoleInputs(task, "contrastive-prior", library);
  expect(() => buildRoleInputs(task, "contrastive-prior", [...library, {sourceTaskId: "future", text: "future", sha256: "a".repeat(64)}])).toThrow("unregistered");
  const altered = structuredClone(inputs); (altered.composer.library as unknown[]).pop(); expect(() => validateRoundInputs(altered)).toThrow();
  expect(() => librarySnapshot(cases, order, task.id, protocol.corpus.learningSourceIds, [library[0]!.sourceTaskId])).toThrow("condition invalidated");
  expect(() => requireFixturePolicy("revoked")).toThrow("no replacement"); expect(() => requireFixturePolicy("denied")).toThrow();
});

test("fault suite is deterministic, all live arms unavailable, and unknown costs remain unknown", () => {
  const faults = runHarnessFaults(sourceRoot); expect(faults).toHaveLength(14); expect(faults.every(row => ["blocked", "insufficient-evidence"].includes(row.outcome))).toBe(true); expect(runHarnessFaults(sourceRoot)).toEqual(faults);
  expect(liveArms()).toHaveLength(5); expect(liveArms().every(arm => arm.status === "unavailable")).toBe(true);
  const costs = Object.fromEntries(COST_FIELDS.map(field => [field, "unknown"])); expect(validateCostRecord(costs).providerTokens).toBe("unknown"); expect(validateCostRecord(costs).personMinutes).toBe("unknown");
});

test("resume refuses changed input before code admission or outward effects", () => {
  const f = fixture(); const expectedFile = join(f.root, HARNESS_FROZEN); freezeHarnessPreregistration(f.root, expectedFile); const file = f.index.cases[0].input; writeAtomic(join(f.root, file), readTextBounded(join(f.root, file), 16_384) + "\n", 16_384);
  const output = join(f.root, "existing.json"); writeAtomic(output, "{}", 65_536); expect(() => runHarnessControls(f.root, output)).toThrow("changed since freeze"); expect(readTextBounded(output, 65_536)).toBe("{}");
  expect(() => requireResumeBinding("a".repeat(64), "b".repeat(64))).toThrow("resume input hash changed");
});

test("fixture faults and role preparation call no provider/model/network boundary", () => {
  const forbidden = (): never => {throw new Error("no live boundary in fixture controls");};
  const preconnect = spyOn(globalThis.fetch, "preconnect").mockImplementation(forbidden), fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(forbidden, {preconnect})), spawn = spyOn(Bun, "spawn").mockImplementation(forbidden), spawnSync = spyOn(Bun, "spawnSync").mockImplementation(forbidden);
  try {expect(runHarnessFaults(sourceRoot)).toHaveLength(14); expect(liveArms().every(arm => arm.status === "unavailable")).toBe(true); for (const spy of [preconnect, fetch, spawn, spawnSync]) expect(spy).not.toHaveBeenCalled();}
  finally {fetch.mockRestore(); preconnect.mockRestore(); spawn.mockRestore(); spawnSync.mockRestore();}
});

test("all five deterministic conditions prepare the declared blinded opportunity controls", () => {
  const {protocol, cases} = corpus(), task = cases[2]!, library = librarySnapshot(cases, protocol.orders[0], task.id, protocol.corpus.learningSourceIds);
  for (const condition of CONDITIONS) {
    const inputs = buildRoleInputs(task, condition, library), candidates = inputs.selector.candidates as {id: string; output: string}[];
    expect(candidates).toHaveLength(condition === "repeated-base" ? 7 : condition.startsWith("contrastive-") ? 2 : 1);
    expect(canonical(inputs.selector)).not.toContain("selectedSlot"); expect(canonical(inputs.selector)).not.toContain(condition);
    const plan = protocol.conditions.find((row: {id: string}) => row.id === condition); expect(Object.values(plan.stageCalls).reduce((sum: number, value) => sum + Number(value), 0)).toBeLessThanOrEqual(8);
  }
});

test("committed fixture receipt preserves all streams, fault outcomes and unknown costs without result authority", () => {
  const receipt = read(sourceRoot, "docs/verification/harness-eval-controls.json", 8 * 1024 * 1024), {receiptSha256, ...body} = receipt;
  expect(receiptSha256).toBe(sha256(canonical(body))); expect(receipt.preregistrationSha256).toBe(verifyHarnessPreregistration(sourceRoot).receiptSha256);
  expect(receipt.kind).toBe("guidance-fixture-observations"); expect(receipt.evidence).toBe("prerecorded-fixture-only"); expect(receipt.rows).toHaveLength(180); expect(receipt.live).toHaveLength(5); expect(receipt.faults).toHaveLength(14); expect(receipt.resultAuthorityLinks).toEqual([]); expect(receipt.conclusion).toBe("insufficient-evidence");
  expect(receipt.code.codeSha256).toBe(sha256(JSON.stringify(receipt.code.files)));
  for (const path of ["bin/ares.js", "scripts/harness-eval.ts", "scripts/execution-eval.ts", "package.json", "bun.lock"]) expect(receipt.code.files.some((file: {path: string}) => file.path === path)).toBe(true);
  const {protocol} = corpus();
  for (const row of receipt.rows) {
    expect(Object.keys(row.costStages)).toEqual(Object.keys(protocol.conditions[0].stageCalls));
    for (const profile of Object.values(row.costStages)) {const cost = validateCostRecord(receipt.costProfiles[profile as string]); expect(cost.providerRequests).toBe(0); expect(cost.providerTokens).toBe("unknown"); expect(cost.wallElapsedMs).toBe("unknown"); expect(cost.personMinutes).toBe("unknown");}
    expect(row.judge).toBe("unavailable"); expect(row.quality).toBe("unknown"); expect(new Set(Object.values(row.preparedRoleLibrarySha256)).size).toBe(1);
  }
  expect(receipt.denominators.fixture.executed).toBe(180); expect(receipt.denominators.fixture["judge-unavailable"]).toBe(180); expect(receipt.denominators.live.executed).toBe(0); expect(receipt.denominators.live.unavailable).toBe(180); expect(receipt.denominators.faults.executed).toBe(14);
});
