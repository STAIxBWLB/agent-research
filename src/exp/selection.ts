import { existsSync } from "node:fs";
import { join } from "node:path";
import { boundedText, commit, onlyKeys, openStudy, plain, readTextBounded, requireExperiment, sha256, type Actor } from "../study.ts";
import type { ProtocolDefinition as Protocol } from "./protocol.ts";
import type { Attempt } from "./attempts.ts";
import { readBoundCalibration } from "./calibrate.ts";

interface SelectionFields { run: string; metric: string; baseline: { commit: string }; minSeeds: number; minDelta: number }
interface Guard { metric: string; maxRegression: number }
interface CostRule { metric: string; free: number; perUnit: number }
export type Selection = SelectionFields & (
  { v: 1 } | { v: 2; guards?: Guard[]; cost?: CostRule; calibration?: { sha256: string } }
);
const V1_FIELDS = ["v", "run", "metric", "baseline", "minSeeds", "minDelta"];
const V2_FIELDS = [...V1_FIELDS, "guards", "cost", "calibration"];

function nonnegative(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field}: finite number >= 0 required`);
  return value;
}

function v2Fields(raw: Record<string, unknown>, protocol: Protocol, primary: string) {
  const fields: Pick<Extract<Selection, { v: 2 }>, "guards" | "cost" | "calibration"> = {};
  if (Object.hasOwn(raw, "guards")) {
    if (!Array.isArray(raw.guards) || raw.guards.length > 8) throw new Error("selection.guards: array of at most eight guards required");
    const seen = new Set<string>([primary]);
    fields.guards = raw.guards.map(guard => {
      if (!plain(guard)) throw new Error("selection.guards: each guard must be an object");
      onlyKeys(guard, ["metric", "maxRegression"], "selection.guard");
      const metric = boundedText(guard.metric, "selection.guard.metric", 128);
      if (seen.has(metric) || !protocol.metrics.some(m => m.name === metric)) throw new Error("selection.guard.metric: select a distinct declared metric other than the primary");
      seen.add(metric);
      return { metric, maxRegression: nonnegative(guard.maxRegression, "selection.guard.maxRegression") };
    });
  }
  if (Object.hasOwn(raw, "cost")) {
    if (!plain(raw.cost)) throw new Error("selection.cost: object required");
    onlyKeys(raw.cost, ["metric", "free", "perUnit"], "selection.cost");
    const metric = boundedText(raw.cost.metric, "selection.cost.metric", 128);
    if (!protocol.metrics.some(m => m.name === metric && m.direction === "min")) throw new Error("selection.cost.metric: select a declared min metric");
    fields.cost = { metric, free: nonnegative(raw.cost.free, "selection.cost.free"), perUnit: nonnegative(raw.cost.perUnit, "selection.cost.perUnit") };
  }
  if (Object.hasOwn(raw, "calibration")) {
    if (!plain(raw.calibration)) throw new Error("selection.calibration: object required");
    onlyKeys(raw.calibration, ["sha256"], "selection.calibration");
    if (typeof raw.calibration.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.calibration.sha256)) throw new Error("selection.calibration.sha256: lowercase SHA-256 required");
    fields.calibration = { sha256: raw.calibration.sha256 };
  }
  return fields;
}
export const SELECTION_BYTES = 65_536;
const compatible = "use an ares version that supports this selection, keeping design/selection.json unchanged";
export function selectionPath(dir: string): string { return join(dir, "design", "selection.json"); }
export function validateSelection(raw: unknown, protocol: Protocol): Selection {
  try {
    if (!plain(raw)) throw new Error("selection: JSON object required");
    if (raw.v !== 1 && raw.v !== 2) throw new Error(`selection.v: unsupported version; ${compatible}`);
    onlyKeys(raw, raw.v === 1 ? V1_FIELDS : V2_FIELDS, "selection");
    if (typeof raw.run !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.run)) throw new Error("selection.run: use 1..64 letters, digits, underscores or hyphens, starting with a letter or digit");
    if (["ablate", "final", "posthoc"].includes(raw.run)) throw new Error(`selection.run: ${raw.run} is a reserved phase run; choose another run such as investigate`);
    const metric = boundedText(raw.metric, "selection.metric", 128);
    if (!protocol.metrics.some(m => m.name === metric)) throw new Error("selection.metric: undeclared; choose a metric from design/protocol.json");
    if (!plain(raw.baseline)) throw new Error("selection.baseline: object with commit required");
    onlyKeys(raw.baseline, ["commit"], "selection.baseline");
    if (typeof raw.baseline.commit !== "string" || !/^[a-fA-F0-9]{40}$/.test(raw.baseline.commit)) throw new Error("selection.baseline.commit: full 40-hex commit required");
    if (!Number.isSafeInteger(raw.minSeeds) || (raw.minSeeds as number) < 1 || (raw.minSeeds as number) > protocol.seeds.length) throw new Error(`selection.minSeeds: integer in 1..${protocol.seeds.length} required (declared protocol seed count)`);
    if (typeof raw.minDelta !== "number" || !Number.isFinite(raw.minDelta) || raw.minDelta < 0) throw new Error("selection.minDelta: finite number >= 0 required in the metric's unit");
    const fields = { run: raw.run, metric, baseline: { commit: raw.baseline.commit.toLowerCase() }, minSeeds: raw.minSeeds as number, minDelta: raw.minDelta };
    return raw.v === 1 ? { v: 1, ...fields } : { v: 2, ...fields, ...v2Fields(raw, protocol, metric) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "selection: invalid rule";
    throw new Error(message.includes(compatible) ? message : `${message}; correct the rule and run ares selection <dir> --file PATH again`);
  }
}
function record(dir: string, protocol: Protocol): { selection: Selection; text: string } | undefined {
  const file = selectionPath(dir);
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readTextBounded(file, SELECTION_BYTES); }
  catch { throw new Error(`design/selection.json: unreadable, non-regular, invalid UTF-8 or larger than ${SELECTION_BYTES} bytes; restore a readable regular UTF-8 rule within that limit before ares selection`); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("design/selection.json: invalid JSON; restore its last valid rule before running ares selection"); }
  return { selection: validateSelection(raw, protocol), text };
}
export function readSelection(dir: string, protocol: Protocol): Selection | undefined { return record(dir, protocol)?.selection; }
/** The design seal binds original file bytes, including formatting, just like the protocol. */
export function selectionHash(dir: string, protocol: Protocol): string | undefined {
  const value = record(dir, protocol);
  return value === undefined ? undefined : sha256(value.text);
}
/** Caller holds the study lock. Identical bytes do not move the investigation cutoff. */
export function setSelection(dir: string, raw: unknown, protocol: Protocol, actor: Actor) {
  requireExperiment(openStudy(dir).study);
  const selection = validateSelection(raw, protocol), previous = record(dir, protocol);
  if (selection.v === 2 && selection.calibration) readBoundCalibration(dir, selection, protocol);
  const text = JSON.stringify(selection, null, 2) + "\n", hash = sha256(text), changed = previous?.text !== text;
  if (changed) commit(dir, [[selectionPath(dir), text, SELECTION_BYTES]], [{ actor, type: "selection.set", data: { sha256: hash, run: selection.run, metric: selection.metric } }]);
  return { selection, sha256: hash, changed };
}

export function observedMetric(attempt: Attempt, metric: Protocol["metrics"][number]): number | undefined {
  const values = Array.isArray(attempt.metrics) ? attempt.metrics.filter(m => m?.name === metric.name) : [];
  const measurement = values[0];
  return values.length === 1 && measurement?.unit === metric.unit && measurement.provenance === "ares-observed"
    && typeof measurement.value === "number" && Number.isFinite(measurement.value) ? measurement.value : undefined;
}

export function sampleMean(values: number[]): number | null {
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (Number.isFinite(total)) return total / values.length;
  const scale = Math.max(...values.map(Math.abs));
  if (!scale) return 0;
  return Math.max(-1, Math.min(1, values.reduce((sum, value) => sum + value / scale / values.length, 0))) * scale;
}

export interface SelectionPair { attempt: Attempt; baseline: Attempt }
export interface ConstraintResult {
  guardDeltas?: Record<string, number | null>;
  cost?: { growth: number; allowedGrowth: number };
  reason?: string;
}

/** Both phases apply the same independent rules to their actual paired attempts. */
export function evaluateSelectionConstraints(
  rule: Selection, protocol: Protocol, pairs: readonly SelectionPair[], delta: number,
): ConstraintResult {
  if (rule.v === 1 || !pairs.length) return {};
  const result: ConstraintResult = {};
  const values = (name: string) => {
    const metric = protocol.metrics.find(entry => entry.name === name)!;
    const candidate = pairs.map(pair => observedMetric(pair.attempt, metric));
    const baseline = pairs.map(pair => observedMetric(pair.baseline, metric));
    return { metric, candidate, baseline };
  };
  const complete = (sample: (number | undefined)[]): sample is number[] => sample.every(value => value !== undefined);
  for (const guard of rule.guards ?? []) {
    const { metric, candidate, baseline } = values(guard.metric);
    const measured = complete(candidate) && complete(baseline);
    const difference = measured ? sampleMean(candidate)! - sampleMean(baseline)! : null;
    const adjusted = difference === null ? null : metric.direction === "max" ? difference : -difference;
    if (adjusted !== null && !Number.isFinite(adjusted)) throw new Error(`selection guard ${guard.metric}: delta overflows; rescale the metric in a new protocol and rerun attempts`);
    (result.guardDeltas ??= Object.create(null) as Record<string, number | null>)[guard.metric] = adjusted;
    if (adjusted === null) result.reason ??= `guard-missing:${guard.metric}`;
    else if (adjusted < -guard.maxRegression) result.reason ??= `guard:${guard.metric}`;
  }
  if (rule.cost) {
    const { candidate, baseline } = values(rule.cost.metric);
    const base = complete(baseline) ? sampleMean(baseline) : null;
    if (base !== null && base <= 0) throw new Error(`selection cost ${rule.cost.metric}: baseline mean must be positive; correct the cost metric and rerun the baseline attempts`);
    if (base === null || !complete(candidate)) { result.reason ??= "cost-missing"; return result; }
    const average = sampleMean(candidate)!;
    const growth = (average - base) / base, allowedGrowth = rule.cost.free + rule.cost.perUnit * delta;
    if (!Number.isFinite(growth) || !Number.isFinite(allowedGrowth)) throw new Error(`selection cost ${rule.cost.metric}: cost rule overflows; rescale the metrics or revise the rule and rerun investigation`);
    result.cost = { growth, allowedGrowth };
    if (growth > 0 && growth > allowedGrowth) result.reason ??= "cost-rule";
  }
  return result;
}
