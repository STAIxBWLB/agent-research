import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { readTextBounded } from "../src/study.ts";
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
