import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { readTextBounded } from "../src/study.ts";
import { baselineSlots, baselineDenominators, runBaseline } from "../scripts/execution-baseline.ts";
import { freezePreregistration, PREREGISTRATION, PROTOCOL_DOC } from "../scripts/execution-eval.ts";
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
    const target = join(temp, file); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(join(root, file)));
  }
  const receipt = join(temp, "docs/verification/execution-eval-frozen.json"); freezePreregistration(temp, receipt);
  const fixture = join(temp, corpus.cases[0].input); writeFileSync(fixture, readTextBounded(fixture, 16_384) + "\n");
  expect(() => runBaseline(temp, join(tempDir(), "unwritten"), "sha256:" + "a".repeat(64))).toThrow("inputSha256 changed since freeze");
});
