import { existsSync } from "node:fs";
import { join } from "node:path";
import { commit, openStudy, plain, readLedger, readTextBounded, requireExperiment, sha256, type Actor } from "../study.ts";
import { listAttempts, type Attempt } from "./attempts.ts";
import { readFinalSeeds } from "./final.ts";
import { protocolHash, readProtocol, type ProtocolDefinition } from "./protocol.ts";
import { observedMetric, readSelection, type Selection } from "./selection.ts";

export interface CalibrationOptions { fromRun: string; nullCommit?: string; z?: number }
interface CalibrationReceipt {
  v: 1; method: "seed-sd" | "aa"; metric: string; commit: string; null?: string;
  seeds: number[]; attempts: string[]; n: number; sd: number; z: number;
  minSeeds: number; recommendedMinDelta: number;
}
const CALIBRATION_BYTES = 65_536;
const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;

function invalid(cause: string): never {
  throw new Error(`selection calibrate: ${cause}; inspect the selected run and retry ares selection calibrate <dir> --from-run RUN`);
}

function receiptPath(dir: string, run: string, hash?: string): string {
  return hash === undefined ? join(dir, "runs", run, "calibration.json")
    : join(dir, "runs", run, "calibrations", `${hash}.json`);
}

function sampleSd(values: number[]): number {
  const scale = Math.max(...values.map(Math.abs));
  if (scale === 0) return 0;
  const scaled = values.map(value => value / scale);
  const mean = scaled.reduce((sum, value) => sum + value, 0) / scaled.length;
  return Math.sqrt(scaled.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (scaled.length - 1)) * scale;
}

export function readBoundCalibration(dir: string, rule: Extract<Selection, { v: 2 }>, protocol: ProtocolDefinition) {
  const hash = rule.calibration?.sha256;
  if (!hash) return undefined;
  const event = readLedger(dir).findLast(entry => entry.type === "selection.calibrated" && entry.data.sha256 === hash);
  const run = event?.data.run;
  const fix = "run ares selection calibrate <dir> --from-run RUN and bind the resulting sha256 in ares selection";
  if (typeof run !== "string" || !RUN.test(run)) throw new Error(`selection.calibration.sha256: no recorded calibration for this digest; ${fix}`);
  if (event?.data.protocolHash !== protocolHash(protocol)) throw new Error(`selection.calibration: protocol differs from the recorded calibration; ${fix}`);
  let text: string, receipt: unknown;
  try {
    text = readTextBounded(receiptPath(dir, run, hash), CALIBRATION_BYTES);
    receipt = JSON.parse(text);
  } catch { throw new Error(`selection.calibration: recorded receipt is unreadable or invalid; restore the bounded receipt or ${fix}`); }
  if (sha256(text) !== hash || !plain(receipt) || receipt.v !== 1) throw new Error(`selection.calibration: receipt bytes do not match the recorded calibration; restore the original receipt or ${fix}`);
  if (receipt.metric !== rule.metric || receipt.commit !== rule.baseline.commit || receipt.minSeeds !== rule.minSeeds) throw new Error(`selection.calibration: the metric, baseline or minimum seed count differs from the recorded calibration; ${fix}`);
  const recommendation = receipt.recommendedMinDelta;
  if (typeof recommendation !== "number" || !Number.isFinite(recommendation) || recommendation < 0) throw new Error(`selection.calibration: recorded recommendation is invalid; ${fix}`);
  return { recommendedMinDelta: recommendation, minDelta: rule.minDelta, belowNoise: rule.minDelta < recommendation };
}

export function validateCalibrationOptions(options: CalibrationOptions) {
  const fromRun = options.fromRun, nullCommit = options.nullCommit?.toLowerCase(), z = options.z ?? 2;
  if (typeof fromRun !== "string" || !RUN.test(fromRun)) invalid("from-run must be a valid run name");
  if (nullCommit !== undefined && !COMMIT.test(nullCommit)) invalid("null commit must be a full 40-hex commit");
  if (typeof z !== "number" || !Number.isFinite(z) || z <= 0) invalid("z must be a finite positive number");
  return { fromRun, ...(nullCommit === undefined ? {} : { nullCommit }), z };
}

/** Caller holds the study lock. Only current-protocol, non-reserved earliest successes count. */
export function calibrateSelection(dirArg: string, options: CalibrationOptions, actor: Actor) {
  const { dir, study } = openStudy(dirArg);
  requireExperiment(study);
  const { fromRun: run, nullCommit: other, z } = validateCalibrationOptions(options);
  const protocol = readProtocol(dir), rule = protocol && readSelection(dir, protocol);
  if (!protocol || !rule) invalid("define a protocol and selection rule first");
  if (other === rule.baseline.commit) invalid("null commit must differ from the baseline commit");
  const hash = protocolHash(protocol), metric = protocol.metrics.find(entry => entry.name === rule.metric)!;
  const reserved = new Set(readFinalSeeds(dir, protocol)?.seeds), seeds = new Set(protocol.seeds);
  const attempts = listAttempts(dir, { run, status: "succeeded" }).attempts;
  const events = readLedger(dir);
  const byId = new Map(attempts.map(attempt => [attempt.id, attempt]));
  const started = new Set<string>();
  const baseline = new Map<number, Attempt>(), nullArm = new Map<number, Attempt>();
  for (const event of events) {
    const { id } = event.data;
    if (event.type !== "attempt.started" || typeof id !== "string") continue;
    const attempt = byId.get(id);
    if (!attempt || attempt.protocolHash !== hash || (attempt.commit !== rule.baseline.commit && attempt.commit !== other)
      || !seeds.has(attempt.seed) || reserved.has(attempt.seed)) continue;
    if (started.has(id) || attempt.studyId !== study.id || event.data.run !== run || event.data.commit !== attempt.commit || event.data.seed !== attempt.seed) invalid(`attempt ${id} has a duplicate or mismatched start receipt`);
    started.add(id);
    const arm = attempt.commit === rule.baseline.commit ? baseline : nullArm;
    if (!arm.has(attempt.seed)) arm.set(attempt.seed, attempt);
  }

  if (baseline.size < 3) invalid("at least three non-reserved baseline seeds are required");
  const pairedSeeds = [...baseline.keys()].filter(seed => other === undefined || nullArm.has(seed)).sort((a, b) => a - b);
  if (pairedSeeds.length < 3) invalid("at least three non-reserved paired A/A seeds are required");
  if (other !== undefined) {
    const trees = new Set([...baseline.values(), ...nullArm.values()].map(attempt => attempt.treeId));
    if (trees.size !== 1 || !COMMIT.test(trees.values().next().value ?? "")) invalid("A/A arms must have the same recorded task tree id");
  }
  const evidence: string[] = [];
  const measured = (attempt: Attempt) => {
    const value = observedMetric(attempt, metric);
    if (value === undefined) invalid(`attempt ${attempt.id} lacks the validated primary metric`);
    evidence.push(attempt.id);
    return value;
  };
  const scores = pairedSeeds.map(seed => {
    const value = measured(baseline.get(seed)!);
    return other === undefined ? value : measured(nullArm.get(seed)!) - value;
  });
  if (scores.some(score => !Number.isFinite(score))) invalid("paired deltas overflow; rescale the primary metric");
  const sd = sampleSd(scores), method = other === undefined ? "seed-sd" : "aa";
  const recommendedMinDelta = (sd / Math.sqrt(rule.minSeeds)) * (method === "seed-sd" ? Math.SQRT2 : 1) * z;
  if (!Number.isFinite(sd) || !Number.isFinite(recommendedMinDelta)) invalid("calibration overflows; rescale the metric or reduce z");
  const receipt: CalibrationReceipt = { v: 1, method, metric: rule.metric, commit: rule.baseline.commit, ...(other === undefined ? {} : { null: other }),
    seeds: pairedSeeds, attempts: evidence, n: pairedSeeds.length, sd, z, minSeeds: rule.minSeeds, recommendedMinDelta };
  const text = JSON.stringify(receipt, null, 2) + "\n", sha = sha256(text);
  const latest = receiptPath(dir, run), archived = receiptPath(dir, run, sha);
  const previous = existsSync(latest) ? readTextBounded(latest, CALIBRATION_BYTES) : undefined;
  const recorded = events.some(event => event.type === "selection.calibrated" && event.data.run === run && event.data.sha256 === sha && event.data.protocolHash === hash);
  if (existsSync(archived) && readTextBounded(archived, CALIBRATION_BYTES) !== text) invalid("immutable calibration receipt differs from its digest; restore the original receipt");
  if (previous !== text || !recorded || !existsSync(archived)) {
    commit(dir, [[latest, text, CALIBRATION_BYTES], [archived, text, CALIBRATION_BYTES]], [{ actor, type: "selection.calibrated", data: { run, sha256: sha, protocolHash: hash } }]);
  }
  return { ...receipt, sha256: sha, ...(method === "seed-sd" ? { assumption: "Assumes independent arms. This is conservative when pairing by seed removes shared variance." } : {}) };
}
