import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { readTextBounded, sha256, writeAtomic } from "../src/study.ts";
import { baselineSlots, baselineDenominators, runBaseline, emitBaseline, RESULT_AUTHORITY_DEVIATION, BASELINE_BUNDLE_BYTES, BASELINE_BUNDLE_PREFIX } from "../scripts/execution-baseline.ts";
import { freezePreregistration, PREREGISTRATION, PROTOCOL_DOC, validateCostRecord } from "../scripts/execution-eval.ts";
import { tempDir } from "./helpers.ts";
import { freshValues } from "../scripts/execution-workload.ts";
const root = fileURLToPath(new URL("..", import.meta.url));

test("fresh synthetic workload agrees with sealed values without consuming cached artifacts", () => {
  const corpus = JSON.parse(readTextBounded(join(root, "test/fixtures/execution-eval/corpus.json"), 65_536));
  let cases = 0, runs = 0;
  for (const row of corpus.cases) {
    if (row.trial !== "reuse") continue;
    const input = JSON.parse(readTextBounded(join(root, row.input), 16_384)).input;
    const expected = JSON.parse(readTextBounded(join(root, row.expected), 16_384));
    // Source cache is irrelevant to the baseline, including corrupt/pruned/interrupted cases.
    delete input.source;
    for (const output of expected.freshExecution.outputs) { expect(freshValues(input, output.seed)).toEqual(output); runs++; }
    cases++;
  }
  expect(cases).toBe(12); expect(runs).toBe(36);
});

test("fresh workload refuses undeclared seeds and unsupported stage operations", () => {
  const corpus = JSON.parse(readTextBounded(join(root, "test/fixtures/execution-eval/corpus.json"), 65_536)), row = corpus.cases.find((value: { trial: string }) => value.trial === "reuse");
  const input = JSON.parse(readTextBounded(join(root, row.input), 16_384)).input;
  expect(() => freshValues(input, 999)).toThrow("seed is not declared");
  input.workload.stages[1].operation = "execute-arbitrary-command";
  expect(() => freshValues(input, input.workload.seeds[0])).toThrow("stage definition is unsupported");
});


test("baseline slots preserve paired AB/BA positions and leave treatment slots empty", () => {
  let first = 0, second = 0;
  for (let index = 0; index < 12; index++) {
    const slots = baselineSlots(index, [3, 11, 19]); expect(slots).toHaveLength(6);
    for (const slot of slots) {
      expect(slot.slotOrder.filter(value => value === "baseline")).toHaveLength(1);
      expect(slot.slotOrder.filter(value => value === null)).toHaveLength(1);
      expect(slot.slotOrder[slot.executedSlot]).toBe("baseline");
      expect(slot.executedSlot).toBe((index + slot.repetition) % 2);
      if (slot.executedSlot === 0) first++; else second++;
    }
    expect(slots.map(slot => [slot.seed, slot.condition])).toEqual([[3, "cold"], [3, "warm"], [11, "cold"], [11, "warm"], [19, "cold"], [19, "warm"]]);
  }
  expect(first).toBe(36); expect(second).toBe(36);
});

test("every observation denominator survives failures, cancellation, uncertainty and exclusions", () => {
  const statuses = ["succeeded", "failed", "cancelled", "unknown", "excluded"] as const;
  const counted = baselineDenominators(statuses.map(status => ({ trial: "reuse", status })));
  expect(counted.reuse).toEqual({ full: 5, succeeded: 1, failed: 1, cancelled: 1, unknown: 1, excluded: 1 });
  expect(counted.diagnose).toEqual({ full: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0, excluded: 0 });
});

test("baseline admission refuses preregistration drift before any code binding or workload effect", () => {
  const temp = tempDir(), protocol = JSON.parse(readTextBounded(join(root, PREREGISTRATION), 65_536)), corpus = JSON.parse(readTextBounded(join(root, protocol.corpus), 65_536));
  for (const file of [PREREGISTRATION, PROTOCOL_DOC, protocol.corpus, ...corpus.cases.flatMap((row: { input: string; expected: string }) => [row.input, row.expected])]) {
    const target = join(temp, file), bound = file.startsWith("test/fixtures/execution-eval/") && file !== protocol.corpus ? 16_384 : 65_536; mkdirSync(dirname(target), { recursive: true }); writeAtomic(target, readTextBounded(join(root, file), bound), bound);
  }
  const receipt = join(temp, "docs/verification/execution-eval-frozen.json"); freezePreregistration(temp, receipt);
  const fixture = join(temp, corpus.cases[0].input); writeFileSync(fixture, readTextBounded(fixture, 16_384) + "\n");
  expect(() => runBaseline(temp, join(tempDir(), "unwritten"), "sha256:" + "a".repeat(64))).toThrow("inputSha256 changed since freeze");
});

test("committed harness observations retain exact hashes, all rows, empty treatment slots and unknown costs", () => {
  const directory = join(root, "docs/verification/execution-eval-baseline/baseline-3f8f373"), manifestText = readTextBounded(join(directory, "manifest.json"), 65_536), manifest = JSON.parse(manifestText);
  const summary = JSON.parse(readTextBounded(join(directory, "summary.json"), 65_536));
  expect(summary.sourceManifest.sha256).toBe(sha256(manifestText));
  for (const receipt of [manifest, summary]) { expect(receipt.resultAuthorityLinks).toEqual([]); expect(receipt.resultAuthorityLinksReason).toBe("synthetic corpus, no ares study; harness-observed only"); expect(receipt.resultAuthorityDecision).toEqual(RESULT_AUTHORITY_DEVIATION.resultAuthorityDecision); expect(receipt.metadataClarification.measurementRepeated).toBe(false); }
  expect(sha256(JSON.stringify(manifest.code.files))).toBe(manifest.code.codeSha256);
  expect(manifest.code.files.some((file: { path: string }) => file.path === "bin/ares.js")).toBe(true);
  expect(manifest.code.files.some((file: { path: string }) => file.path === "scripts/execution-baseline.ts")).toBe(true);
  expect(manifest.registrationReceiptSha256).toBe("72f36f856c2559bf7a626689bca3825ae3cfe49f27c9d8abf544f24bd2778e20");
  const rows = manifest.files.flatMap((file: { path: string; sha256: string; bytes: number }) => {
    const text = readTextBounded(join(directory, file.path), 65_536); expect(sha256(text)).toBe(file.sha256); expect(Buffer.byteLength(text)).toBe(file.bytes);
    const receipt = JSON.parse(text); expect(receipt.authority).toBe("harness-observed"); expect(receipt.codeSha256).toBe(manifest.code.codeSha256); expect(receipt.methodSha256).toBe(manifest.methodSha256);
    expect(receipt.resultAuthorityLinks).toEqual([]); expect(receipt.resultAuthorityLinksReason).toBe(RESULT_AUTHORITY_DEVIATION.resultAuthorityLinksReason); expect(receipt.resultAuthorityDecision.issue).toBe(63); expect(receipt.resultAuthorityDecision.date).toBe("2026-11-08");
    expect(sha256(JSON.stringify(receipt.observations))).toBe(receipt.metadataClarification.observationsSha256); expect(receipt.metadataClarification.measurementRepeated).toBe(false);
    return receipt.observations;
  });
  expect(rows).toHaveLength(144); expect(baselineDenominators(rows)).toEqual(manifest.denominators);
  for (const row of rows) {
    expect(row.authority).toBe("harness-observed"); expect(row.slotOrder[row.executedSlot]).toBe("baseline"); expect(row.slotOrder.filter((value: unknown) => value === null)).toHaveLength(1);
    expect(row.humanTimeToFind).toBe("unknown"); expect(row.costs.personMinutes).toBe("unknown"); expect(row.costs.providerTokens).toBe("unknown");
    expect(row.trial === "diagnose" || row.trial === "reuse").toBe(true); expect(validateCostRecord(row.costs)).toEqual(row.costs);
  }
  expect(manifest.environment.cpuLimit).toBe(2); expect(manifest.environment.pidsLimit).toBe(32); expect(manifest.environment.memoryLimitBytes).toBe(256 * 1024 * 1024);
  expect(manifest.schedule.treatmentObservations).toBe(0); expect(manifest.schedule.supervision).toBe("preregistered-only");
});

test("baseline bundle publication refuses changed receipt content", () => {
  const directory = join(root, "docs/verification/execution-eval-baseline/baseline-3f8f373"), temporary = tempDir(), manifest = JSON.parse(readTextBounded(join(directory, "manifest.json"), 65_536));
  for (const name of ["manifest.json", ...manifest.files.map((file: { path: string }) => file.path)]) writeAtomic(join(temporary, name), readTextBounded(join(directory, name), 65_536), 65_536);
  expect(Object.keys(JSON.parse(emitBaseline(temporary)).files)).toHaveLength(25);
  const target = join(temporary, manifest.files[0].path); writeAtomic(target, readTextBounded(target, 65_536) + "\n", 65_536);
  expect(() => emitBaseline(temporary)).toThrow("baseline receipt hash changed");
});


test("baseline CLI refuses missing/relative output and nontrailing flags before effects", () => {
  for (const args of [["--emit"], ["relative/dir"], ["relative/dir", "--emit"], []]) {
    const cwd = tempDir();
    const child = Bun.spawnSync([process.execPath, join(root, "scripts/execution-eval.ts"), "baseline", ...args], { cwd, env: { HOME: cwd, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 3000, maxBuffer: 65_536 });
    expect(child.exitCode).not.toBe(0); expect(child.stderr.toString()).toContain("absolute output operand");
    expect(child.stdout.length).toBe(0); expect(existsSync(join(cwd, "--emit"))).toBe(false); expect(existsSync(join(cwd, "relative"))).toBe(false);
  }
});

test("baseline CLI allows only one optional trailing emit flag", () => {
  for (const extra of [["--unknown"], ["--emit", "--emit"]]) {
    const cwd = tempDir(), output = join(cwd, "outside");
    const child = Bun.spawnSync([process.execPath, join(root, "scripts/execution-eval.ts"), "baseline", output, ...extra], { cwd, env: { HOME: cwd, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe", timeout: 3000, maxBuffer: 65_536 });
    expect(child.exitCode).not.toBe(0); expect(child.stderr.toString()).toContain("optional --emit"); expect(existsSync(output)).toBe(false);
  }
});

test("baseline emit bounds serialized bytes including prefix, escaping and newline", () => {
  const directory = tempDir(), files: Record<string, string> = {}, entries: { path: string; sha256: string; bytes: number }[] = [];
  for (let index = 0; index < 20; index++) {
    const name = `case-${index}.json`, text = JSON.stringify({ padding: '"'.repeat(30_000) }) + "\n";
    writeAtomic(join(directory, name), text, 65_536); files[name] = text; entries.push({ path: name, sha256: sha256(text), bytes: Buffer.byteLength(text) });
  }
  const manifest = JSON.stringify({ v: 1, files: entries }) + "\n"; writeAtomic(join(directory, "manifest.json"), manifest, 65_536); files["manifest.json"] = manifest;
  const rawBytes = Object.values(files).reduce((total, text) => total + Buffer.byteLength(text), 0);
  expect(rawBytes).toBeLessThan(BASELINE_BUNDLE_BYTES);
  expect(Buffer.byteLength(BASELINE_BUNDLE_PREFIX + JSON.stringify({ v: 1, files }) + "\n")).toBeGreaterThan(BASELINE_BUNDLE_BYTES);
  expect(() => emitBaseline(directory)).toThrow("serialized baseline bundle exceeds 2 MiB including prefix and newline");
  expect(readTextBounded(join(directory, "manifest.json"), 65_536)).toBe(manifest);
});
