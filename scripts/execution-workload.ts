import { readTextBounded, plain, writeAtomic } from "../src/study.ts";

export interface FreshValues { seed: number; prepare: number; transform: number; evaluate: number }
function fail(cause: string): never { throw new Error(`execution baseline: ${cause}; restore the frozen candidate payload and declared seed before a fresh baseline run`); }
function integer(value: unknown): value is number { return Number.isSafeInteger(value) && Math.abs(value as number) <= 1_000_000; }
export interface NumericWorkload { values: number[]; seeds: number[]; multiplier: number; offset: number; evaluateOperation: "square-plus-seed" | "square-plus-two-seeds" }
export function numericWorkload(raw: unknown, seed: number): NumericWorkload {
  if (!plain(raw) || !plain(raw.workload)) fail("workload payload is missing");
  const workload = raw.workload;
  if (!Array.isArray(workload.values) || !workload.values.length || workload.values.length > 64 || !workload.values.every(integer)) fail("workload values exceed the bounded integer contract");
  if (!integer(seed) || !Array.isArray(workload.seeds) || workload.seeds.length > 16 || !workload.seeds.includes(seed)) fail("seed is not declared in the frozen workload");
  if (!Array.isArray(workload.stages) || workload.stages.length !== 3) fail("three ordered workload stages are required");
  const [prepareStage, transformStage, evaluateStage] = workload.stages;
  if (!plain(prepareStage) || prepareStage.id !== "prepare" || prepareStage.operation !== "sum-input-plus-seed" || !plain(transformStage) || transformStage.id !== "transform" || transformStage.operation !== "multiply-plus-offset" || !integer(transformStage.multiplier) || !integer(transformStage.offset) || !plain(evaluateStage) || evaluateStage.id !== "evaluate" || !["square-plus-seed", "square-plus-two-seeds"].includes(String(evaluateStage.operation))) fail("workload stage definition is unsupported");
  return { values: [...workload.values], seeds: [...workload.seeds] as number[], multiplier: transformStage.multiplier, offset: transformStage.offset, evaluateOperation: evaluateStage.operation as NumericWorkload["evaluateOperation"] };
}
function safe(value: number): number { if (!Number.isSafeInteger(value)) fail("workload arithmetic exceeds safe integer bounds"); return value; }
export function prepareValue(values: unknown, seed: number): number {
  if (!Array.isArray(values) || !values.length || values.length > 64 || !values.every(integer) || !integer(seed)) fail("workload values exceed the bounded integer contract");
  return safe(values.reduce((sum: number, value: number) => sum + value, seed));
}
export function transformValue(value: number, multiplier: number, offset: number): number {
  if (!Number.isSafeInteger(value) || !integer(multiplier) || !integer(offset)) fail("workload transform parameters are invalid");
  return safe(value * multiplier + offset);
}
export function evaluateValue(value: number, seed: number, operation: string): number {
  if (!Number.isSafeInteger(value) || !integer(seed) || !["square-plus-seed", "square-plus-two-seeds"].includes(operation)) fail("workload evaluator parameters are invalid");
  return safe(value * value + seed * (operation === "square-plus-two-seeds" ? 2 : 1));
}
/** The fixed synthetic integer workload, not a reuse engine or a scientific result authority. */
export function freshValues(raw: unknown, seed: number): FreshValues {
  const workload = numericWorkload(raw, seed), prepare = prepareValue(workload.values, seed);
  const transform = transformValue(prepare, workload.multiplier, workload.offset), evaluate = evaluateValue(transform, seed, workload.evaluateOperation);
  return { seed, prepare, transform, evaluate };
}
if (import.meta.main) {
  try {
    const [input, output, rawSeed, ...extra] = process.argv.slice(2);
    if (!input || !output || !rawSeed || extra.length || !/^-?\d{1,7}$/.test(rawSeed)) fail("usage is execution-workload.ts INPUT OUTPUT SEED");
    const payload: unknown = JSON.parse(readTextBounded(input, 16_384, { noFollow: true }));
    writeAtomic(output, JSON.stringify(freshValues(payload, Number(rawSeed))) + "\n", 16_384, 0o600);
  } catch (error) { console.error(error instanceof Error ? error.message : "execution baseline: fresh workload failed; inspect the synthetic input before retry"); process.exitCode = 1; }
}
