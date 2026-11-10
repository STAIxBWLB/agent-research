import { expect, test } from "bun:test";
import { existsSync, mkdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, filePath, FROZEN_RECEIPT, PREREGISTRATION, freezePreregistration, verifyPreregistration } from "../scripts/execution-eval.ts";
import { AMENDMENT_CORPUS, AMENDMENT_PROTOCOL, AMENDMENT_RECEIPT, freezeSupervisionAmendment, loadSupervisionAmendmentCases, parseSupervisionIntentLabel, verifySupervisionAmendment } from "../scripts/execution-supervision-amendment.ts";
import { readBytesBounded, readTextBounded, sha256 } from "../src/study.ts";
import { tempDir } from "./helpers.ts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
interface CorpusRow {id: string; scenario: string; input: string; expected: string}
function fixture() {
  const root = tempDir(), parent = verifyPreregistration(sourceRoot, join(sourceRoot, FROZEN_RECEIPT));
  const corpus = JSON.parse(readTextBounded(filePath(sourceRoot, AMENDMENT_CORPUS), 65_536, {noFollow: true})) as {v: number; cases: CorpusRow[]};
  const names = [...new Set([FROZEN_RECEIPT, ...parent.methodFiles.map(row => row.path), ...parent.inputFiles.map(row => row.path), ...parent.expectedFiles.map(row => row.path), AMENDMENT_PROTOCOL, AMENDMENT_CORPUS, ...corpus.cases.flatMap(row => [row.input, row.expected])])];
  let total = 0;
  for (const name of names) {
    const bytes = readBytesBounded(filePath(sourceRoot, name), 65_536, {noFollow: true});
    total += bytes.length; if (total > 3 * 1024 * 1024) throw new Error("synthetic test fixture copy exceeds 3 MiB");
    const target = join(root, name); mkdirSync(dirname(target), {recursive: true}); writeFileSync(target, bytes);
  }
  const beforeV1 = [...parent.methodFiles, ...parent.inputFiles, ...parent.expectedFiles].map(row => [row.path, sha256(readBytesBounded(filePath(root, row.path), 65_536, {noFollow: true}))]);
  return {root, corpus, parent, beforeV1, receipt: join(root, AMENDMENT_RECEIPT)};
}
function read(root: string, name: string) { return readTextBounded(filePath(root, name), 65_536, {noFollow: true}); }
function edit(root: string, name: string, mutate: (raw: any) => void) {
  const raw = JSON.parse(read(root, name)); mutate(raw); writeFileSync(join(root, name), JSON.stringify(raw, null, 2) + "\n");
}

test("amendment freezes once with raw parent, inherited method and exact ordered v2 source hashes", () => {
  const f = fixture(), parentBytes = read(f.root, FROZEN_RECEIPT), first = freezeSupervisionAmendment(f.root);
  const receiptBytes = read(f.root, AMENDMENT_RECEIPT), modified = statSync(f.receipt).mtimeMs;
  expect(first).toMatchObject({v: 1, status: "preregistered-amendment-not-measured", amends: {path: FROZEN_RECEIPT, sha256: sha256(parentBytes), receiptSha256: f.parent.receiptSha256}});
  expect(first.bindings.thresholdsSha256).toBe(f.parent.bindings.thresholdsSha256);
  expect(first.bindings.denominatorsSha256).toBe(f.parent.bindings.denominatorsSha256);
  expect(first.bindings.protocolSha256).toBe(sha256(read(f.root, AMENDMENT_PROTOCOL)));
  expect(Object.values(first.bindings).every(value => /^[a-f0-9]{64}$/.test(value))).toBe(true);
  expect(Object.hasOwn(first.bindings, "codeSha256")).toBe(false);
  expect(Object.hasOwn(first, "observations")).toBe(false);
  const expectedPaths = [AMENDMENT_CORPUS, ...f.corpus.cases.flatMap(row => [row.input, row.expected])];
  expect(first.files.filter(row => row.path.startsWith("test/fixtures/execution-eval-supervision-v2/")).map(row => row.path)).toEqual(expectedPaths);
  for (const row of first.files) {
    const bytes = readBytesBounded(filePath(f.root, row.path), 65_536, {noFollow: true});
    expect(row).toEqual({path: row.path, sha256: sha256(bytes), bytes: bytes.length});
  }
  expect(verifySupervisionAmendment(f.root)).toEqual(first);
  expect(freezeSupervisionAmendment(f.root)).toEqual(first);
  expect(read(f.root, AMENDMENT_RECEIPT)).toBe(receiptBytes);
  expect(statSync(f.receipt).mtimeMs).toBe(modified); expect(statSync(f.receipt).mode & 0o777).toBe(0o600);
  expect(read(f.root, FROZEN_RECEIPT)).toBe(parentBytes);
  expect(f.beforeV1.map(([name]) => [name, sha256(readBytesBounded(filePath(f.root, name!), 65_536, {noFollow: true}))])).toEqual(f.beforeV1);
});

test("loader requires the amendment and keeps evaluator labels separate from candidate payloads", () => {
  const f = fixture();
  expect(() => loadSupervisionAmendmentCases(f.root)).toThrow("amendment receipt");
  const frozen = freezeSupervisionAmendment(f.root), loaded = loadSupervisionAmendmentCases(f.root);
  expect(loaded.receipt).toEqual(frozen); expect(loaded.cases).toHaveLength(12);
  for (const group of ["ordinary-progress", "true-trigger", "misleading-symptom"]) expect(loaded.cases.filter(row => row.scenario === group)).toHaveLength(4);
  expect(loaded.cases.map(row => row.id)).toEqual(f.corpus.cases.map(row => row.id));
  for (const [index, row] of loaded.cases.entries()) {
    const source = f.corpus.cases[index]!;
    expect(Object.keys(row.payload).sort()).toEqual(["facts", "request"]);
    expect(Object.hasOwn(row.payload, "expected")).toBe(false); expect(Object.hasOwn(row.payload, "trigger")).toBe(false);
    expect(row.inputSha256).toBe(sha256(read(f.root, source.input)));
    expect(row.expectedSha256).toBe(sha256(read(f.root, source.expected)));
    expect(row.expected.id).toBe(row.id); expect(row.expected.scenario).toBe(row.scenario);
  }
});

test("label, amendment method, parent raw bytes and inherited method changes refuse without overwriting", () => {
  for (const mutation of ["label", "input-bytes", "protocol", "parent", "method"] as const) {
    const f = fixture(); freezeSupervisionAmendment(f.root); const before = read(f.root, AMENDMENT_RECEIPT);
    if (mutation === "label") edit(f.root, f.corpus.cases[0]!.expected, raw => { raw.reason = "revised-intent"; });
    else if (mutation === "input-bytes") writeFileSync(join(f.root, f.corpus.cases[0]!.input), read(f.root, f.corpus.cases[0]!.input) + "\n");
    else if (mutation === "protocol") writeFileSync(join(f.root, AMENDMENT_PROTOCOL), read(f.root, AMENDMENT_PROTOCOL) + "\nRevised integration method.\n");
    else if (mutation === "parent") writeFileSync(join(f.root, FROZEN_RECEIPT), read(f.root, FROZEN_RECEIPT) + "\n");
    else edit(f.root, PREREGISTRATION, raw => { raw.budgets.caseCpuSeconds = 59; });
    expect(() => verifySupervisionAmendment(f.root)).toThrow();
    expect(() => freezeSupervisionAmendment(f.root)).toThrow();
    expect(read(f.root, AMENDMENT_RECEIPT)).toBe(before);
  }
});

test("future receipt versions and changed seal bytes are preserved and refused", () => {
  for (const mutation of ["version", "seal"] as const) {
    const f = fixture(); freezeSupervisionAmendment(f.root);
    edit(f.root, AMENDMENT_RECEIPT, raw => { if (mutation === "version") raw.v = 2; else raw.receiptSha256 = "0".repeat(64); });
    const original = read(f.root, AMENDMENT_RECEIPT);
    expect(() => verifySupervisionAmendment(f.root)).toThrow(mutation === "version" ? "version is unsupported" : "content or seal changed");
    expect(() => freezeSupervisionAmendment(f.root)).toThrow();
    expect(read(f.root, AMENDMENT_RECEIPT)).toBe(original);
  }
});

test("first amendment freeze rejects parent byte drift and an otherwise valid re-frozen v1 method", () => {
  for (const mutation of ["parent-whitespace", "re-frozen-method", "parent-version"] as const) {
    const f = fixture();
    if (mutation === "parent-whitespace") writeFileSync(join(f.root, FROZEN_RECEIPT), read(f.root, FROZEN_RECEIPT) + "\n");
    else if (mutation === "parent-version") edit(f.root, FROZEN_RECEIPT, raw => { raw.v = 2; });
    else {
      edit(f.root, PREREGISTRATION, raw => { raw.budgets.caseCpuSeconds = 59; });
      unlinkSync(join(f.root, FROZEN_RECEIPT));
      freezePreregistration(f.root, join(f.root, FROZEN_RECEIPT));
      expect(verifyPreregistration(f.root, join(f.root, FROZEN_RECEIPT)).receiptSha256).not.toBe(f.parent.receiptSha256);
    }
    const parentAfter = read(f.root, FROZEN_RECEIPT);
    expect(() => freezeSupervisionAmendment(f.root)).toThrow();
    expect(existsSync(f.receipt)).toBe(false); expect(read(f.root, FROZEN_RECEIPT)).toBe(parentAfter);
  }
});

test("closed wrapper versions, identities, pair paths and the four-per-scenario denominator refuse before freeze", () => {
  for (const mutation of ["version", "corpus-version", "input-field", "label-id", "pair", "duplicate", "scenario", "facts", "bound"] as const) {
    const f = fixture(), row = f.corpus.cases[0]!;
    if (mutation === "version") edit(f.root, row.input, raw => { raw.v = 2; });
    else if (mutation === "corpus-version") edit(f.root, AMENDMENT_CORPUS, raw => { raw.v = 2; });
    else if (mutation === "input-field") edit(f.root, row.input, raw => { raw.input.expected = true; });
    else if (mutation === "label-id") edit(f.root, row.expected, raw => { raw.id = "another-case"; });
    else if (mutation === "pair") edit(f.root, AMENDMENT_CORPUS, raw => { raw.cases[0].input = "test/fixtures/execution-eval/other.input.json"; });
    else if (mutation === "duplicate") edit(f.root, AMENDMENT_CORPUS, raw => { raw.cases[1] = raw.cases[0]; });
    else if (mutation === "scenario") {
      edit(f.root, AMENDMENT_CORPUS, raw => { raw.cases[0].scenario = "true-trigger"; });
      edit(f.root, row.input, raw => { raw.scenario = "true-trigger"; });
      edit(f.root, row.expected, raw => { raw.scenario = "true-trigger"; });
    }
    else if (mutation === "facts") edit(f.root, row.input, raw => { raw.input.facts = {tasks: "not-admitted-facts"}; });
    else writeFileSync(join(f.root, row.input), " ".repeat(16_385));
    expect(() => freezeSupervisionAmendment(f.root)).toThrow(); expect(existsSync(f.receipt)).toBe(false);
  }
});

test("physical source files, parent directories and receipts refuse links including dangling ones", () => {
  for (const mutation of ["input", "source-parent", "receipt", "dangling-receipt", "receipt-parent"] as const) {
    const f = fixture();
    if (mutation === "source-parent") {
      const directory = join(f.root, "test/fixtures/execution-eval-supervision-v2"), moved = join(f.root, "moved-v2");
      renameSync(directory, moved); symlinkSync(moved, directory);
    } else if (mutation === "receipt-parent") {
      const directory = join(f.root, "docs/verification"), moved = join(f.root, "moved-verification");
      renameSync(directory, moved); symlinkSync(moved, directory);
    } else if (mutation === "input") {
      const file = join(f.root, f.corpus.cases[0]!.input), moved = join(f.root, "input-copy.json");
      renameSync(file, moved); symlinkSync(moved, file);
    } else {
      if (mutation === "receipt") { const target = join(f.root, "other-receipt.json"); writeFileSync(target, "{}"); symlinkSync(target, f.receipt); }
      else symlinkSync(join(f.root, "absent-receipt.json"), f.receipt);
    }
    expect(() => freezeSupervisionAmendment(f.root)).toThrow();
    if (mutation === "receipt" || mutation === "dangling-receipt") unlinkSync(f.receipt);
    expect(existsSync(f.receipt)).toBe(false);
  }
});

test("intent parser validates the complete evaluator-only label without scoring rule behavior", () => {
  const valid = {v: 1, id: "synthetic-case", trial: "supervision", scenario: "true-trigger", trigger: true, task: 7, nextAction: "recheck", reason: "synthetic-intent", mustNot: ["perform-unapproved-task-action"]};
  expect(parseSupervisionIntentLabel(valid) as unknown).toEqual(valid);
  const clean = { ...valid, trigger: false, nextAction: "none" }; expect(parseSupervisionIntentLabel(clean) as unknown).toEqual(clean);
  const invalid = [ {...valid, v: 2}, {...valid, trial: "diagnose"}, {...valid, nextAction: "none"}, {...valid, trigger: false}, {...valid, task: 0}, {...valid, task: 1.5}, {...valid, reason: "not a code"}, {...valid, mustNot: ["x".repeat(257)]}, {...valid, mustNot: Array(33).fill("bounded")}, {...valid, unknown: "refuse"} ];
  for (const row of invalid) expect(() => parseSupervisionIntentLabel(row)).toThrow("execution supervision amendment:");
  let invoked = false;
  const accessor = {...valid}; Object.defineProperty(accessor, "reason", {get: () => { invoked = true; return "hidden"; }, enumerable: true});
  const proxy = new Proxy(valid, {ownKeys: () => { invoked = true; return []; }});
  const sparse = new Array(1);
  for (const row of [accessor, proxy, {...valid, mustNot: sparse}, {...valid, toJSON: () => { invoked = true; return valid; }}]) expect(() => parseSupervisionIntentLabel(row)).toThrow();
  expect(invoked).toBe(false);
  expect(canonical(valid)).toBe(canonical(parseSupervisionIntentLabel(valid)));
});


test("intent action refuses object coercion without invoking its hooks", () => {
  let invoked = false;
  const raw = {v: 1, id: "synthetic-case", trial: "supervision", scenario: "true-trigger", trigger: true, task: 7,
    nextAction: {toString() {invoked = true; return "recheck";}}, reason: "synthetic-intent", mustNot: []};
  expect(() => parseSupervisionIntentLabel(raw)).toThrow("expected action"); expect(invoked).toBe(false);
});
