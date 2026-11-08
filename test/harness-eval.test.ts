import {expect, spyOn, test} from "bun:test";
import {dirname, join} from "node:path";
import * as fs from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {freezeHarnessPreregistration, verifyHarnessPreregistration, buildRoleInputs, makeRoleValidationContext, librarySnapshot, validateRolePayload, validateRoundInputs, requireFixturePolicy, requireResumeBinding, runHarnessFaults, runHarnessControls, verifyControlReceipt, liveArms, ROLES, CONDITIONS, HARNESS_PROTOCOL, HARNESS_FROZEN, HARNESS_METHOD, type HarnessCase} from "../scripts/harness-eval.ts";
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
      const task = cases.find(row => row.id === id)!, library = librarySnapshot(cases, order, id, protocol.corpus.learningSourceIds), inputs = buildRoleInputs(task, "contrastive-prior", library, makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, "contrastive-prior"));
      validateRoundInputs(inputs, makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, "contrastive-prior")); const hash = inputs.worker.librarySha256 as string;
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
      const inputs = buildRoleInputs(task, condition, library, makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, condition));
      for (const role of ROLES) {
        const view = canonical(inputs[role]); expect(view).not.toContain("evaluatorKey"); expect(view).not.toContain("rubric"); expect(view).not.toContain("selectedSlot"); expect(view).not.toContain("test/fixtures/");
        for (const row of index.cases) expect(view).not.toContain(read(sourceRoot, row.expected, 16_384).evaluatorKey);
        for (const future of order.taskIds.slice(order.taskIds.indexOf(task.id) + 1)) expect(view).not.toContain(future);
        expect(() => validateRolePayload(role, {...inputs[role], rubric: "private"}, makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, condition))).toThrow();
        expect(() => validateRolePayload(role, {...inputs[role], data: {nested: {futureTaskData: "private"}}}, makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, condition))).toThrow();
      }
      expect(canonical(inputs.selector)).not.toContain(condition);
    }
  }
});

test("library mutation, unregistered source replacement and revoked policy invalidate rather than refresh", () => {
  const {protocol, cases} = corpus(), order = protocol.orders[0], task = cases.at(-1)!, library = librarySnapshot(cases, order, task.id, protocol.corpus.learningSourceIds), inputs = buildRoleInputs(task, "contrastive-prior", library, makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, "contrastive-prior"));
  expect(() => buildRoleInputs(task, "contrastive-prior", [...library, {sourceTaskId: "future", text: "future", sha256: "a".repeat(64)}], makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, "contrastive-prior"))).toThrow("unregistered");
  const altered = structuredClone(inputs); (altered.composer.library as unknown[]).pop(); expect(() => validateRoundInputs(altered, makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, "contrastive-prior"))).toThrow();
  expect(() => librarySnapshot(cases, order, task.id, protocol.corpus.learningSourceIds, [library[0]!.sourceTaskId])).toThrow("condition invalidated");
  expect(() => requireFixturePolicy("revoked")).toThrow("no replacement"); expect(() => requireFixturePolicy("denied")).toThrow();
});

test("fault suite is deterministic, all live arms unavailable, and unknown costs remain unknown", () => {
  const faults = runHarnessFaults(sourceRoot); expect(faults).toHaveLength(21); expect(faults.every(row => ["blocked", "insufficient-evidence"].includes(row.outcome))).toBe(true); expect(runHarnessFaults(sourceRoot)).toEqual(faults);
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
  try {expect(runHarnessFaults(sourceRoot)).toHaveLength(21); expect(liveArms().every(arm => arm.status === "unavailable")).toBe(true); for (const spy of [preconnect, fetch, spawn, spawnSync]) expect(spy).not.toHaveBeenCalled();}
  finally {fetch.mockRestore(); preconnect.mockRestore(); spawn.mockRestore(); spawnSync.mockRestore();}
});

test("all five deterministic conditions prepare the declared blinded opportunity controls", () => {
  const {protocol, cases} = corpus(), order = protocol.orders[0], task = cases[2]!, library = librarySnapshot(cases, order, task.id, protocol.corpus.learningSourceIds);
  for (const condition of CONDITIONS) {
    const inputs = buildRoleInputs(task, condition, library, makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, condition)), candidates = inputs.selector.candidates as {id: string; output: string}[];
    expect(candidates).toHaveLength(condition === "repeated-base" ? 7 : condition.startsWith("contrastive-") ? 2 : 1);
    expect(canonical(inputs.selector)).not.toContain("selectedSlot"); expect(canonical(inputs.selector)).not.toContain(condition);
    const plan = protocol.conditions.find((row: {id: string}) => row.id === condition); expect(Object.values(plan.stageCalls).reduce((sum: number, value) => sum + Number(value), 0)).toBeLessThanOrEqual(8);
  }
});

function committedCliFixture() {
  const f = fixture(), home = join(f.root, "isolated-home"); fs.mkdirSync(home);
  const env = {PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0"};
  const git = (root: string, ...args: string[]) => {
    const value = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Synthetic Fixture", "-c", "user.email=fixture@example.invalid", ...args], {cwd: root, env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000});
    if (value.error || value.status !== 0) throw new Error("synthetic Git fixture setup failed"); return value.stdout;
  };
  const paths = git(sourceRoot, "ls-files", "-z", "--", "bin/ares.js", "package.json", "bun.lock", "src", "scripts").split("\0").filter(Boolean); let total = 0;
  expect(paths.length).toBeLessThanOrEqual(256);
  for (const path of paths) {const value = readTextBounded(join(sourceRoot, path), 1024 * 1024, {noFollow: true}); total += Buffer.byteLength(value); expect(total).toBeLessThanOrEqual(16 * 1024 * 1024); fs.mkdirSync(dirname(join(f.root, path)), {recursive: true}); writeAtomic(join(f.root, path), value, 1024 * 1024, fs.statSync(join(sourceRoot, path)).mode & 0o777);}
  freezeHarnessPreregistration(f.root, join(f.root, HARNESS_FROZEN)); git(f.root, "init", "--quiet"); git(f.root, "add", "--all"); git(f.root, "commit", "--quiet", "-m", "Synthetic code binding fixture");
  const cli = (...args: string[]) => {const value = spawnSync(process.execPath, [join(f.root, "scripts/harness-eval.ts"), ...args], {cwd: f.root, env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10000}); if (value.error) throw value.error; return value;};
  return {...f, cli, git: (...args: string[]) => git(f.root, ...args)};
}

test("temporary committed CLI controls have complete independent end-to-end costs and refuse forged history", () => {
  const f = committedCliFixture(), output = join(f.root, "controls.json"), first = f.cli("controls", output); expect(first.status).toBe(0);
  const receipt = read(f.root, "controls.json", 8 * 1024 * 1024), before = readTextBounded(output, 8 * 1024 * 1024), {receiptSha256, ...body} = receipt;
  expect(receiptSha256).toBe(sha256(canonical(body))); expect(receipt.preregistrationSha256).toBe(verifyHarnessPreregistration(f.root, join(f.root, HARNESS_FROZEN)).receiptSha256);
  expect(receipt.kind).toBe("guidance-fixture-observations"); expect(receipt.evidence).toBe("prerecorded-fixture-only"); expect(receipt.rows).toHaveLength(180); expect(receipt.live).toHaveLength(5); expect(receipt.faults).toHaveLength(21); expect(receipt.resultAuthorityLinks).toEqual([]); expect(receipt.conclusion).toBe("insufficient-evidence");
  const whole = validateCostRecord(receipt.endToEndCosts); expect(whole.wallElapsedMs).toBe("unknown"); expect(whole.cpuSeconds).toBe("unknown"); expect(whole.providerRequests).toBe(0);
  for (const row of receipt.rows) {
    expect(Object.keys(row.costStages)).toEqual(Object.keys(f.protocol.conditions[0].stageCalls));
    for (const profile of Object.values(row.costStages)) {const cost = validateCostRecord(receipt.costProfiles[profile as string]); expect(cost.providerRequests).toBe(0); expect(cost.providerTokens).toBe("unknown"); expect(cost.wallElapsedMs).toBe("unknown"); expect(cost.personMinutes).toBe("unknown");}
    const end = validateCostRecord(row.endToEndCosts); expect(end.wallElapsedMs).toBe("unknown"); expect(end.cpuSeconds).toBe("unknown"); expect(end.personMinutes).toBe("unknown");
    expect(new Set(Object.values(row.preparedRoleLibrarySha256)).size).toBe(1); expect(receipt.conditionProfiles[row.conditionProfile].ceiling.calls).toBe(8);
  }
  expect(receipt.denominators.fixture.executed).toBe(180); expect(receipt.denominators.fixture["judge-unavailable"]).toBe(180); expect(receipt.denominators.live.executed).toBe(0); expect(receipt.denominators.live.unavailable).toBe(180);
  for (const task of f.cases.filter(row => row.split === "heldout")) expect(before).not.toContain(task.control.reflection.text);
  for (const row of receipt.rows.filter((row: {split: string}) => row.split === "heldout")) {
    const task = f.cases.find(task => task.id === row.taskId)!; expect(row.deferredReflection).toEqual({sha256: sha256(task.control.reflection.text), bytes: Buffer.byteLength(task.control.reflection.text), status: "deferred-until-all-heldout-outputs-and-judgments-frozen"});
  }
  expect(f.cli("controls", output).status).toBe(0); expect(readTextBounded(output, 8 * 1024 * 1024)).toBe(before);
  const compact = JSON.stringify(receipt);
  expect(compact).not.toBe(before); writeAtomic(output, compact, 8 * 1024 * 1024);
  expect(f.cli("controls", output).status).toBe(0); expect(readTextBounded(output, 8 * 1024 * 1024)).toBe(compact);
  for (const field of ["commit", "tree"]) {
    const forged = structuredClone(receipt); forged.code[field] = (field === "commit" ? "f" : "e").repeat(40); const {receiptSha256: _old, ...changed} = forged; forged.receiptSha256 = sha256(canonical(changed));
    const file = join(f.root, `forged-${field}.json`); writeAtomic(file, JSON.stringify(forged), 8 * 1024 * 1024);
    const result = f.cli("controls", file); expect(result.status).toBe(1); expect(result.stderr).toContain("execution code binding"); expect(result.stderr).toContain("restore the original run receipt");
  }
});

test("nested role DTOs reject held-out/future libraries, mismatched text hashes and method-labelled candidates", () => {
  const {protocol, cases} = corpus(), order = protocol.orders[0], task = cases.at(-1)!, context = makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, "contrastive-prior"), library = librarySnapshot(cases, order, task.id, protocol.corpus.learningSourceIds), valid = buildRoleInputs(task, "contrastive-prior", library, context);
  const libraryPayload = (role: typeof ROLES[number], entries: unknown[]) => ({...valid[role], library: entries, librarySha256: sha256(canonical(entries))});
  const heldout = cases.find(row => row.id === "transfer-weighted")!, held = {sourceTaskId: heldout.id, text: heldout.control.reflection.text, sha256: sha256(heldout.control.reflection.text)};
  expect(order.taskIds.indexOf(heldout.id)).toBeLessThan(order.taskIds.indexOf(task.id));
  for (const role of ROLES) {
    expect(() => validateRolePayload(role, libraryPayload(role, [held]), context)).toThrow("past learning experience");
    expect(() => validateRolePayload(role, libraryPayload(role, [{...library[0]!, sha256: "0".repeat(64)}]), context)).toThrow("text hash mismatch");
    const changedText = "Synthetic substituted guidance"; expect(() => validateRolePayload(role, libraryPayload(role, [{...library[0]!, text: changedText, sha256: sha256(changedText)}]), context)).toThrow("source content changed");
    expect(() => validateRolePayload(role, libraryPayload(role, [{...library[0]!, origin: "contrastive-prior"}]), context)).toThrow("unknown field");
    expect(() => validateRolePayload(role, libraryPayload(role, [library[0], library[0]]), context)).toThrow("unique past");
    expect(() => validateRolePayload(role, valid[role], context)).not.toThrow();
  }
  const early = cases.find(row => row.id === order.taskIds[0])!, later = cases.find(row => row.id === order.taskIds[1])!, earlyContext = makeRoleValidationContext(cases, order, early.id, protocol.corpus.learningSourceIds, "contrastive-prior"), empty = librarySnapshot(cases, order, early.id, protocol.corpus.learningSourceIds), prepared = buildRoleInputs(early, "contrastive-prior", empty, earlyContext), future = {sourceTaskId: later.id, text: later.control.reflection.text, sha256: sha256(later.control.reflection.text)};
  expect(() => validateRolePayload("worker", {...prepared.worker, library: [future], librarySha256: sha256(canonical([future]))}, earlyContext)).toThrow("past learning experience");
  for (const role of ["proposer", "composer", "selector"] as const) {
    const key = role === "selector" ? "candidates" : "outputs";
    expect(() => validateRolePayload(role, {...valid[role], [key]: [{id: "contrastive-prior", output: "Synthetic output"}]}, context)).toThrow("opaque unique blinded id");
    expect(() => validateRolePayload(role, {...valid[role], [key]: [{id: "0123456789abcdef", output: "Synthetic output", origin: "contrastive-prior"}]}, context)).toThrow("unknown field");
    expect(() => validateRolePayload(role, {...valid[role], [key]: [{id: "0123456789abcdef", output: {text: "Synthetic output"}}]}, context)).toThrow("bounded text");
  }
  expect(() => validateRolePayload("worker", {...valid.worker, guidance: {method: "contrastive-prior"}}, context)).toThrow();
  expect(() => validateRolePayload("composer", {...valid.composer, proposal: {text: "proposal"}}, context)).toThrow();
  expect(() => validateRolePayload("reflector", {...valid.reflector, selectedOutput: {text: "private"}}, context)).toThrow();
});

test("a committed executable-mode change refuses control receipt resume without changing codeSha256 format", async () => {
  const f = committedCliFixture(), output = join(f.root, "mode-controls.json"), bootstrap = join(f.root, "bin/ares.js");
  fs.chmodSync(bootstrap, 0o755); f.git("add", "--", "bin/ares.js"); if (!f.git("status", "--porcelain").trim()) expect(f.git("ls-tree", "HEAD", "bin/ares.js")).toContain("100755"); else f.git("commit", "--quiet", "-m", "Synthetic executable fixture");
  expect(f.cli("controls", output).status).toBe(0); const before = readTextBounded(output, 8 * 1024 * 1024), receipt = JSON.parse(before);
  fs.chmodSync(bootstrap, 0o644); f.git("add", "--", "bin/ares.js"); f.git("commit", "--quiet", "-m", "Synthetic mode-only change");
  const {bindRunCode} = await import("../scripts/execution-code-binding.ts"); expect(bindRunCode(f.root).codeSha256).toBe(receipt.code.codeSha256);
  const result = f.cli("controls", output); expect(result.status).toBe(1); expect(result.stderr).toContain("stored/current source mode mismatch"); expect(result.stderr).toContain("restore the original run receipt"); expect(readTextBounded(output, 8 * 1024 * 1024)).toBe(before);
});

test("CLI receipt read failures name the cause and a recovery step without raw fs errors", () => {
  const f = committedCliFixture(), missing = join(f.root, "missing-receipt.json"), directory = join(f.root, "directory-receipt"); fs.mkdirSync(directory);
  for (const file of [missing, directory]) {
    const result = f.cli("verify", file); expect(result.status).toBe(1); expect(result.stderr).toContain("frozen receipt"); expect(result.stderr).toContain("restore the registered receipt bytes or re-register"); expect(result.stderr).not.toContain("ENOENT"); expect(result.stderr).not.toContain("EISDIR");
  }
  const control = f.cli("controls", directory); expect(control.status).toBe(1); expect(control.stderr).toContain("control receipt"); expect(control.stderr).toContain("restore the registered control receipt bytes"); expect(control.stderr).not.toContain("EISDIR");
  expect(() => verifyControlReceipt(f.root, missing)).toThrow("control receipt");
});

test("checked-in evidence stays bound to its historical main code and registration", () => {
  const receipt = read(sourceRoot, "docs/verification/harness-eval-controls.json", 8 * 1024 * 1024), raw = JSON.stringify(receipt), {receiptSha256, ...body} = receipt, home = tempDir();
  expect(receiptSha256).toBe(sha256(canonical(body))); expect(receipt.code.commit).toBe("f9f2934fa37d9fee7d55858d8b725fdb4a0638d9");
  const env = {PATH: "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C"};
  const git = (args: string[], maxBuffer = 1024 * 1024, input?: string) => {
    const result = spawnSync("git", ["--no-pager", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "core.attributesFile=/dev/null", "-c", "protocol.allow=never", ...args], {cwd: sourceRoot, env, timeout: 5000, maxBuffer, ...(input === undefined ? {} : {input})});
    if (result.error || result.status !== 0 || result.stdout.length > maxBuffer) throw new Error("historical evidence Git read failed"); return result.stdout;
  };
  const commit = receipt.code.commit as string, frozenPath = "docs/verification/harness-eval-frozen.json", protocolPath = "docs/verification/harness-eval-preregistration.json";
  expect(git(["rev-parse", "--verify", `${commit}^{commit}`]).toString().trim()).toBe(commit); expect(git(["rev-parse", "--verify", `${commit}^{tree}`]).toString().trim()).toBe(receipt.code.tree); git(["merge-base", "--is-ancestor", commit, "HEAD"]);
  const seal = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(git(["show", `${commit}:${frozenPath}`], 65_536))), {receiptSha256: sealSha, ...sealBody} = seal;
  expect(sealSha).toBe(sha256(canonical(sealBody))); expect(sealSha).toBe(receipt.preregistrationSha256); expect(receipt.bindings).toEqual(seal.bindings);
  const tree = new Map<string, {mode: string; oid: string}>();
  for (const entry of git(["ls-tree", "-r", "-z", commit]).toString("utf8").split("\0").filter(Boolean)) {const match = /^([0-7]{6}) blob ([a-f0-9]{40,64})\t(.+)$/.exec(entry); if (match) tree.set(match[3]!, {mode: match[1]!, oid: match[2]!});}
  const roots = ["bin/ares.js", "package.json", "bun.lock", "scripts", "src"], sourceNames = [...tree.keys()].filter(name => roots.some(root => name === root || name.startsWith(root + "/"))).sort();
  expect(receipt.code.files.map((file: {path: string}) => file.path)).toEqual(sourceNames); expect(receipt.code.codeSha256).toBe(sha256(JSON.stringify(receipt.code.files))); expect(tree.get("bin/ares.js")?.mode).toBe("100755");
  const files = [...receipt.code.files, ...seal.files] as {path: string; sha256: string; bytes: number}[]; expect(files.length).toBeLessThanOrEqual(416);
  const batch = git(["cat-file", "--batch"], 17 * 1024 * 1024 + 416 * 160, files.map(file => {const entry = tree.get(file.path); expect(entry).toBeDefined(); expect(["100644", "100755"]).toContain(entry!.mode); return entry!.oid;}).join("\n") + "\n"), contents = new Map<string, Buffer>(); let offset = 0;
  for (const file of files) {
    const end = batch.indexOf(10, offset); expect(end).toBeGreaterThanOrEqual(offset); const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(batch.subarray(offset, end).toString("ascii")); expect(match).not.toBeNull();
    const bytes = Number(match![2]), start = end + 1, content = batch.subarray(start, start + bytes); expect(match![1]).toBe(tree.get(file.path)!.oid); expect(bytes).toBe(file.bytes); expect(content.length).toBe(bytes); expect(sha256(content)).toBe(file.sha256); expect(batch[start + bytes]).toBe(10); contents.set(file.path, content); offset = start + bytes + 1;
  }
  expect(offset).toBe(batch.length);
  const json = (path: string) => JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(contents.get(path)!)), protocol = json(protocolPath), index = json(protocol.corpus.index), fields = Object.keys(protocol.costs.fields).sort();
  const cost = (value: Record<string, unknown>) => {expect(Object.keys(value).sort()).toEqual(fields); for (const field of fields) expect(value[field]).toBe(field === "providerRequests" ? 0 : "unknown");};
  expect(receipt.rows).toHaveLength(180); expect(receipt.conclusion).toBe("insufficient-evidence"); expect(receipt.resultAuthorityLinks).toEqual([]); expect(receipt.live.map((arm: {condition: string}) => arm.condition)).toEqual(protocol.conditions.map((row: {id: string}) => row.id)); expect(receipt.live.every((arm: {status: string}) => arm.status === "unavailable")).toBe(true); cost(receipt.endToEndCosts);
  const tuples = new Set<string>();
  for (const row of receipt.rows) {
    const order = protocol.orders.find((value: {id: string}) => value.id === row.order), task = index.cases.find((value: {id: string}) => value.id === row.taskId), plan = protocol.conditions.find((value: {id: string}) => value.id === row.condition); expect(order).toBeDefined(); expect(task).toBeDefined(); expect(plan).toBeDefined();
    const tuple = `${row.order}:${row.condition}:${row.taskId}`; expect(tuples.has(tuple)).toBe(false); tuples.add(tuple); expect(row.inputSha256).toBe(sha256(contents.get(task.input)!)); expect(row.streamSha256).toBe(sha256(canonical(order))); expect(row.judge).toBe("unavailable"); expect(row.quality).toBe("unknown");
    const past = order.taskIds.slice(0, order.taskIds.indexOf(row.taskId)).filter((id: string) => protocol.corpus.learningSourceIds.includes(id)), admitted = ["retrieval-only", "contrastive-prior"].includes(row.condition) ? past.map((id: string) => {const source = index.cases.find((entry: {id: string}) => entry.id === id), text = json(source.control).reflection.text; return {sourceTaskId: id, text, sha256: sha256(text)};}) : [];
    expect(row.library).toEqual(admitted); expect(row.librarySha256).toBe(sha256(canonical(admitted))); for (const role of Object.keys(protocol.authority.roleDtoAllowlist)) {expect(row.preparedRoleLibrarySha256[role]).toBe(row.librarySha256); expect(row.preparedRoleInputSha256[role]).toMatch(/^[a-f0-9]{64}$/);}
    expect(Object.keys(row.costStages)).toEqual(protocol.costs.stages); for (const profile of Object.values(row.costStages)) cost(receipt.costProfiles[profile as string]); cost(row.endToEndCosts);
    expect(receipt.conditionProfiles[row.conditionProfile].stageCalls).toEqual(plan.stageCalls); expect(receipt.conditionProfiles[row.conditionProfile].ceiling).toEqual(protocol.budgets);
    if (task.split === "heldout") {const reflection = json(task.control).reflection.text; expect(raw).not.toContain(reflection); expect(row.deferredReflection).toEqual({sha256: sha256(reflection), bytes: Buffer.byteLength(reflection), status: "deferred-until-all-heldout-outputs-and-judgments-frozen"});} else expect(row.deferredReflection).toBeNull();
  }
  expect(tuples.size).toBe(180); expect(receipt.faults).toHaveLength(json(index.faults).cases.length); expect(receipt.faults.every((fault: {outcome: string}) => ["blocked", "insufficient-evidence"].includes(fault.outcome))).toBe(true);
  for (const counts of Object.values(receipt.denominators)) expect(Object.keys(counts as object)).toEqual(protocol.denominators);
  expect(receipt.denominators.fixture).toMatchObject({planned: 180, executed: 180, "judge-unavailable": 180, succeeded: 0}); expect(receipt.denominators.live).toMatchObject({planned: 180, executed: 0, unavailable: 180}); expect(receipt.denominators.faults).toMatchObject({planned: 18, executed: 18, denied: 16, "judge-unavailable": 1, unknown: 1});
});

for (const condition of ["retrieval-only", "contrastive-prior"] as const) for (const mutation of ["empty", "subset", "reordered"] as const) test(`registered ${condition} snapshot refuses consistent ${mutation} replacements`, () => {
  const {protocol, cases} = corpus();
  for (const order of protocol.orders) {
    const task = cases.at(-1)!, context = makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, condition), library = librarySnapshot(cases, order, task.id, protocol.corpus.learningSourceIds);
    expect(library.length).toBeGreaterThan(1);
    const inputs = buildRoleInputs(task, condition, library, context), changed = structuredClone(inputs);
    const replacement = mutation === "empty" ? [] : mutation === "subset" ? library.slice(1) : [...library].reverse();
    for (const role of ROLES) {changed[role].library = replacement; changed[role].librarySha256 = sha256(canonical(replacement));}
    expect(new Set(ROLES.map(role => canonical(changed[role].library))).size).toBe(1);
    expect(new Set(ROLES.map(role => changed[role].librarySha256)).size).toBe(1);
    for (const role of ROLES) expect(() => validateRolePayload(role, changed[role], context)).toThrow("registered snapshot");
    expect(() => validateRoundInputs(changed, context)).toThrow("registered snapshot");
  }
});
test("snapshot binding is canonical and condition-specific without exposing condition labels", () => {
  const {protocol, cases} = corpus(), order = protocol.orders[0], task = cases.at(-1)!, library = librarySnapshot(cases, order, task.id, protocol.corpus.learningSourceIds);
  for (const condition of CONDITIONS) {
    const context = makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, condition), inputs = buildRoleInputs(task, condition, library, context);
    for (const role of ROLES) {
      const entries = inputs[role].library as {sourceTaskId: string; text: string; sha256: string}[];
      const reorderedKeys = entries.map(entry => ({sha256: entry.sha256, text: entry.text, sourceTaskId: entry.sourceTaskId}));
      validateRolePayload(role, {...inputs[role], library: reorderedKeys, librarySha256: sha256(canonical(reorderedKeys))}, context);
      expect(canonical(inputs[role])).not.toContain(condition);
    }
  }
  const context = makeRoleValidationContext(cases, order, task.id, protocol.corpus.learningSourceIds, "contrastive-prior");
  expect(() => buildRoleInputs(task, "frozen-base", library, context)).toThrow("condition");
  const faults = runHarnessFaults(sourceRoot).filter(row => row.kind.startsWith("registered-library-"));
  expect(faults.map(row => row.kind)).toEqual(["registered-library-empty", "registered-library-subset", "registered-library-reordered"]);
  expect(faults.every(row => row.outcome === "blocked" && row.cause === "registered-snapshot-refusal")).toBe(true);
});
