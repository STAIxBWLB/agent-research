import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COST_FIELDS, DENOMINATORS, PREREGISTRATION, PROTOCOL_DOC, freezePreregistration, verifyPreregistration, validateCostRecord } from "../scripts/execution-eval.ts";
import { readTextBounded, sha256 } from "../src/study.ts";
import { tempDir } from "./helpers.ts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
function fixture() {
  const root = tempDir(), receipt = join(root, "frozen.json");
  const protocol = JSON.parse(readTextBounded(join(sourceRoot, PREREGISTRATION), 65_536));
  const corpus = JSON.parse(readTextBounded(join(sourceRoot, protocol.corpus), 65_536)) as { cases: { input: string; expected: string }[] };
  for (const name of [PREREGISTRATION, PROTOCOL_DOC, protocol.corpus, ...corpus.cases.flatMap(row => [row.input, row.expected])]) {
    const target = join(root, name); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readTextBounded(join(sourceRoot, name), 262_144));
  }
  return { root, receipt, protocol, corpus };
}
function saveProtocol(f: ReturnType<typeof fixture>) { writeFileSync(join(f.root, PREREGISTRATION), JSON.stringify(f.protocol, null, 2) + "\n"); }

test("first command freezes method/input/expected hashes; repeat freeze verifies without rewriting", () => {
  const f = fixture(), first = freezePreregistration(f.root, f.receipt), text = readFileSync(f.receipt, "utf8"), mtime = statSync(f.receipt).mtimeMs;
  expect(first.status).toBe("preregistered-not-measured");
  expect(Object.hasOwn(first.bindings, "codeSha256")).toBe(false);
  expect(Object.hasOwn(first, "codeFiles")).toBe(false);
  expect(first.inputFiles).toHaveLength(37); expect(first.expectedFiles).toHaveLength(36);
  expect(Object.values(first.bindings).every(hash => /^[a-f0-9]{64}$/.test(hash))).toBe(true);
  expect(verifyPreregistration(f.root, f.receipt)).toEqual(first);
  expect(freezePreregistration(f.root, f.receipt)).toEqual(first);
  expect(readFileSync(f.receipt, "utf8")).toBe(text); expect(statSync(f.receipt).mtimeMs).toBe(mtime);
  expect(statSync(f.receipt).mode & 0o777).toBe(0o600);
  expect(f.protocol.denominators).toEqual([...DENOMINATORS]);
});

test("a changed fixture byte refuses verify and repeat freeze without rewriting the receipt", () => {
  const f = fixture(); freezePreregistration(f.root, f.receipt);
  const text = readFileSync(f.receipt, "utf8"), file = join(f.root, f.corpus.cases[0]!.input);
  writeFileSync(file, readFileSync(file, "utf8") + "\n");
  expect(() => verifyPreregistration(f.root, f.receipt)).toThrow("inputSha256 changed since freeze");
  expect(() => freezePreregistration(f.root, f.receipt)).toThrow("inputSha256 changed since freeze");
  expect(readFileSync(f.receipt, "utf8")).toBe(text);
});

test("changed proposed thresholds and dropped denominators each refuse without rewriting", () => {
  for (const change of ["threshold", "denominator"] as const) {
    const f = fixture(); freezePreregistration(f.root, f.receipt); const before = readFileSync(f.receipt, "utf8");
    if (change === "threshold") f.protocol.thresholds.reuse.minMedianEligibleComputeReductionPct = 19;
    else f.protocol.denominators = f.protocol.denominators.filter((key: string) => key !== "unknown");
    saveProtocol(f);
    expect(() => verifyPreregistration(f.root, f.receipt)).toThrow(change === "threshold" ? "thresholdsSha256 changed" : "denominators changed or missing");
    expect(() => freezePreregistration(f.root, f.receipt)).toThrow("execution eval:");
    expect(readFileSync(f.receipt, "utf8")).toBe(before);
  }
});

test("expected truth, method changes and tampered receipt seals are separately refused", () => {
  for (const change of ["expected", "method", "receipt"] as const) {
    const f = fixture(); freezePreregistration(f.root, f.receipt);
    if (change === "expected") { const file = join(f.root, f.corpus.cases[0]!.expected); writeFileSync(file, readFileSync(file, "utf8") + "\n"); }
    else if (change === "method") { f.protocol.budgets.caseCpuSeconds = 59; saveProtocol(f); }
    else { const raw = JSON.parse(readFileSync(f.receipt, "utf8")); raw.receiptSha256 = "0".repeat(64); writeFileSync(f.receipt, JSON.stringify(raw)); }
    const before = readFileSync(f.receipt, "utf8");
    expect(() => verifyPreregistration(f.root, f.receipt)).toThrow(change === "expected" ? "expectedSha256 changed" : change === "method" ? "protocolSha256 changed" : "receipt content or seal changed");
    expect(readFileSync(f.receipt, "utf8")).toBe(before);
  }
});

test("missing truth, over-bound files and links refuse the first freeze without an output", () => {
  for (const change of ["truth", "bound", "link"] as const) {
    const f = fixture();
    if (change === "truth") { const row = f.corpus.cases.at(-1)!, file = join(f.root, row.expected), raw = JSON.parse(readFileSync(file, "utf8")); delete raw.trigger; writeFileSync(file, JSON.stringify(raw)); }
    else if (change === "bound") writeFileSync(join(f.root, f.corpus.cases[0]!.input), " ".repeat(16_385));
    else { const file = join(f.root, "linked.json"); writeFileSync(file, "{}"); symlinkSync(file, join(f.root, "receipt-link.json")); expect(() => freezePreregistration(f.root, join(f.root, "receipt-link.json"))).toThrow("frozen receipt"); continue; }
    expect(() => freezePreregistration(f.root, f.receipt)).toThrow("execution eval:");
    expect(existsSync(f.receipt)).toBe(false);
  }
});

test("unknown costs stay unknown, independent clocks and overhead categories stay separate", () => {
  const unknown = Object.fromEntries(COST_FIELDS.map(key => [key, "unknown"]));
  const result = validateCostRecord({ ...unknown, cpuSeconds: 2, wallElapsedMs: 1500, idleWallMs: 300, personMinutes: 1 });
  expect(result.providerTokens).toBe("unknown"); expect(result.verificationCpuSeconds).toBe("unknown");
  expect(result.retentionByteSeconds).toBe("unknown"); expect(result.materializationCpuSeconds).toBe("unknown");
  expect(result.failureWallMs).toBe("unknown"); expect(result.gpuDeviceSeconds).toBe("unknown");
  expect(result.cpuSeconds).toBe(2); expect(result.wallElapsedMs).toBe(1500); expect(result.personMinutes).toBe(1);
  expect(Object.hasOwn(result, "total")).toBe(false);
  for (const value of [null, -1, Infinity, NaN, "0"]) expect(() => validateCostRecord({ ...unknown, verificationCpuSeconds: value })).toThrow("measured units or unknown");
  const missing = { ...unknown }; delete missing.failureCpuSeconds;
  expect(() => validateCostRecord(missing)).toThrow("failureCpuSeconds");
  expect(() => validateCostRecord({ ...unknown, total: 42 })).toThrow("unknown field");
});

test("corpus wrappers and supervision labels stay outside candidate payloads; reuse seeds match method", () => {
  const f = fixture(), counts = { diagnose: 0, reuse: 0, supervision: 0 };
  for (const row of f.corpus.cases) {
    const input = JSON.parse(readTextBounded(join(f.root, row.input), 16_384));
    expect(Object.keys(input).sort()).toEqual(["id", "input", "scenario", "trial", "v"]);
    expect(Object.hasOwn(input.input, "scenario")).toBe(false);
    expect(Object.hasOwn(input.input, "trigger")).toBe(false);
    counts[input.trial as keyof typeof counts]++;
    if (input.trial === "reuse") expect(input.input.workload.seeds).toEqual(input.id.endsWith("first-variant") ? f.protocol.design.seedSets.firstVariant : f.protocol.design.seedSets.secondVariant);
  }
  expect(counts).toEqual(f.protocol.design.plannedCases);
  expect(Object.keys(f.protocol.costs.fields).sort()).toEqual([...COST_FIELDS].sort());
});

test("evolving source, bootstrap, harness and release versions do not invalidate fixed preregistration", () => {
  const f = fixture(), files = ["src/http.ts", "scripts/execution-eval.ts", "bin/ares.js", "package.json"];
  for (const name of files) { const file = join(f.root, name); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, "synthetic code at freeze\n"); }
  const receipt = freezePreregistration(f.root, f.receipt), before = readFileSync(f.receipt, "utf8");
  for (const name of files) writeFileSync(join(f.root, name), "changed code for a later arm or release\n");
  expect(verifyPreregistration(f.root, f.receipt)).toEqual(receipt);
  expect(freezePreregistration(f.root, f.receipt)).toEqual(receipt);
  expect(readFileSync(f.receipt, "utf8")).toBe(before);
});

test("every present reuse artifact is judgeable under its candidate-visible canonical digest rule", () => {
  const f = fixture(); let valid = 0, corrupt = 0;
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, part]) => `${JSON.stringify(key)}:${canonical(part)}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  for (const row of f.corpus.cases) {
    const input = JSON.parse(readTextBounded(join(f.root, row.input), 16_384));
    if (input.trial !== "reuse") continue;
    const artifact = input.input.source?.artifact;
    if (!artifact) continue;
    expect(artifact.digestRule).toBe("sha256(canonical JSON: recursively sorted object keys, preserved array order, UTF-8, no whitespace)");
    if (!artifact.present || artifact.payload === null || artifact.payload === undefined) continue;
    const calculated = sha256(canonical(artifact.payload));
    if (input.scenario === "corrupt-artifact") { expect(calculated).not.toBe(artifact.digest); corrupt++; }
    else { expect(calculated).toBe(artifact.digest); valid++; }
  }
  expect(valid).toBe(6); expect(corrupt).toBe(2);
});
