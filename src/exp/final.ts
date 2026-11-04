import { existsSync } from "node:fs";
import { join } from "node:path";
import { commit, onlyKeys, openStudy, plain, readTextBounded, requireExperiment, sha256, assertWritable, gateState, readLedger, requireGate, type Actor } from "../study.ts";
import { readDesign, readProtocol, type Protocol } from "./protocol.ts";
import { listAttempts, type Attempt, type AttemptStatus } from "./attempts.ts";
import { ablateResultPath, ABLATE_BYTES, foldAblations, readClosedAblate } from "./ablate.ts";
import { INVESTIGATE_BYTES, investigateResultPath, metricValue, pairSamples, readClosedInvestigation, type PairedSamples, type Sample } from "./investigate.ts";
import { readSelection } from "./selection.ts";

export interface FinalSeeds { v: 1; seeds: number[] }
export const FINAL_SEEDS_BYTES = 65_536;
const compatible = "use an ares version that supports this final-seeds file, keeping design/final.json unchanged";
export function finalSeedsPath(dir: string): string { return join(dir, "design", "final.json"); }
export function validateFinalSeeds(raw: unknown, protocol: Protocol): FinalSeeds {
  try {
    if (!plain(raw)) throw new Error("final seeds: JSON object required");
    if (raw.v !== 1) throw new Error(`final seeds.v: unsupported version; ${compatible}`);
    onlyKeys(raw, ["v", "seeds"], "final seeds");
    const max = Math.floor(protocol.seeds.length / 2);
    if (!max) throw new Error("final seeds: protocol needs at least two declared seeds to reserve at most half");
    if (!Array.isArray(raw.seeds) || !raw.seeds.length || raw.seeds.length > max) throw new Error(`final seeds.seeds: nonempty list of at most ${max} seeds required (half the declared protocol seeds)`);
    if (raw.seeds.some(s => !Number.isSafeInteger(s) || !protocol.seeds.includes(s as number))) throw new Error("final seeds.seeds: undeclared seed; use only declared integer protocol seeds");
    if (new Set(raw.seeds).size !== raw.seeds.length) throw new Error("final seeds.seeds: duplicate seed; name each reserved seed once");
    return { v: 1, seeds: [...raw.seeds] as number[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "final seeds: invalid input";
    throw new Error(message.includes(compatible) ? message : `${message}; correct the file or protocol and run ares final seeds <dir> --file PATH again`);
  }
}
function record(dir: string, protocol: Protocol): { value: FinalSeeds; text: string } | undefined {
  const file = finalSeedsPath(dir);
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readTextBounded(file, FINAL_SEEDS_BYTES); }
  catch { throw new Error(`design/final.json: unreadable, non-regular, invalid UTF-8 or larger than ${FINAL_SEEDS_BYTES} bytes; restore a valid regular final-seeds file within this bound`); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("design/final.json: invalid JSON; restore the last valid final-seeds file before continuing"); }
  return { value: validateFinalSeeds(raw, protocol), text };
}
export function readFinalSeeds(dir: string, protocol: Protocol): FinalSeeds | undefined { return record(dir, protocol)?.value; }
export function finalSeedsHash(dir: string, protocol: Protocol): string | undefined {
  const value = record(dir, protocol); return value === undefined ? undefined : sha256(value.text);
}
/** Caller holds the study lock; identical bytes never move the reservation event boundary. */
export function setFinalSeeds(dir: string, raw: unknown, protocol: Protocol, actor: Actor, readUsedSeeds: () => ReadonlySet<number>) {
  requireExperiment(openStudy(dir).study);
  const final = validateFinalSeeds(raw, protocol), previous = record(dir, protocol), text = JSON.stringify(final, null, 2) + "\n", hash = sha256(text), changed = previous?.text !== text;
  if (changed) {
    const used = readUsedSeeds();
    const seen = final.seeds.find(seed => used.has(seed));
    if (seen !== undefined) throw new Error(`final seeds: seed ${seen} was already used by an existing attempt; choose an unused declared seed`);
    commit(dir, [[finalSeedsPath(dir), text, FINAL_SEEDS_BYTES]], [{ actor, type: "final.seeds.set", data: { sha256: hash, seeds: final.seeds } }]);
  }
  return { final, sha256: hash, changed };
}


export const FINAL_RESULT_BYTES = 1_048_576;
function finalError(reason: string): never { throw new Error(`final: ${reason}; inspect ares gate list and close the current investigate/ablate inputs before retrying final`); }
function resultBytes(file: string, bound: number, phase: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readTextBounded(file, bound); } catch { finalError(`${phase} result is unreadable, invalid UTF-8 or oversized; restore its last valid bounded file`); }
  let raw: unknown; try { raw = JSON.parse(text); } catch { finalError(`${phase} result JSON is malformed; restore its last valid file`); }
  if (!plain(raw) || raw.v !== 1) throw new Error(`${phase} result: unsupported version; use an ares version that supports it, keeping the original file unchanged`);
  return text;
}
/** Content changes reopen approval even before the changed result has been reclosed. */
export function finalGateBinding(dir: string): string | undefined {
  const { study } = openStudy(dir); if (study.mode !== "experiment") return undefined;
  const protocol = readProtocol(dir); if (!protocol || !readFinalSeeds(dir, protocol)) return undefined;
  const rule = readSelection(dir, protocol); if (!rule) return undefined;
  const investigate = resultBytes(investigateResultPath(dir, rule.run), INVESTIGATE_BYTES, "investigate");
  if (investigate === undefined) return undefined;
  const raw = JSON.parse(investigate) as Record<string, unknown>;
  if (!plain(raw.winner) || typeof raw.winner.commit !== "string" || !/^[a-f0-9]{40}$/.test(raw.winner.commit)) return undefined;
  const ablate = resultBytes(ablateResultPath(dir), ABLATE_BYTES, "ablate");
  if (foldAblations(readLedger(dir)).length && ablate === undefined) return undefined;
  const design = readDesign(dir); if (!design) return undefined;
  return sha256(JSON.stringify([sha256(investigate), ablate === undefined ? null : sha256(ablate), design.binding]));
}
export function requireFinalInputs(dirArg: string) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  const design = readDesign(dir); if (!design) finalError("protocol missing; set an experiment protocol first");
  const final = readFinalSeeds(dir, design.protocol); if (!final) finalError("reserved seeds missing; run ares final seeds --file PATH first");
  const rule = readSelection(dir, design.protocol); if (!rule) finalError("selection missing; run ares selection --file PATH first");
  const investigate = readClosedInvestigation(dir); if (!investigate.result.winner) finalError("investigation has no winner");
  const required = foldAblations(readLedger(dir)).length > 0;
  const ablate = required || existsSync(ablateResultPath(dir)) ? readClosedAblate(dir) : undefined;
  const binding = finalGateBinding(dir); if (!binding) finalError("closed upstream results are incomplete");
  return { dir, study, design, final, rule, investigate, ablate, binding, winner: investigate.result.winner.commit, baseline: rule.baseline.commit };
}
/** Called under the study lock before snapshot resolution and again before record creation. */
export function authorizeFinalAttempt(dir: string, commit: string, seed: number): { binding: string; auto: boolean } {
  const input = requireFinalInputs(dir);
  if (!input.final.seeds.includes(seed)) finalError(`seed ${seed} is not reserved; choose a seed from design/final.json`);
  if (typeof commit !== "string" || !/^[a-fA-F0-9]{40}$/.test(commit)) finalError("commit must be a full 40-hex SHA; choose the winner or baseline frozen commit");
  const normalized = commit.toLowerCase();
  if (normalized !== input.winner && normalized !== input.baseline) finalError("commit is neither the investigate winner nor selection baseline; choose one of those frozen commits");
  const approvals = requireGate(dir, input.study, "final", () => input.binding);
  return { binding: input.binding, auto: approvals.length > 0 };
}
interface FinalAttempt { id: string; commit: string; seed: number; status: AttemptStatus; decisive: boolean; reason?: string; retryOf?: string }
export interface FinalResult {
  v: 1; status: "qualified" | "not_qualified"; reason?: string; winner: string; baseline: string; seeds: number[];
  pairs: PairedSamples["pairs"]; mean: number | null; baselineMean: number | null; delta: number | null;
  decisive: FinalAttempt[]; attempts: FinalAttempt[]; investigateSha256: string; ablateSha256?: string; sealBinding: string; inputsSha256: string;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function finalResultPath(dir: string): string { return join(dir, "runs", "final", "final.json"); }
/** Earliest start decides even on failure; newer retries never replace its outcome. */
export function closeFinal(dirArg: string, actor: Actor): FinalResult {
  const input = requireFinalInputs(dirArg), file = finalResultPath(input.dir), old = resultBytes(file, FINAL_RESULT_BYTES, "final");
  const attempts = listAttempts(input.dir, { run: "final" }).attempts;
  if (attempts.some(a => a.status === "running")) throw new Error("final close: a final attempt is running; run ares attempt reconcile before closing");
  const events = readLedger(input.dir), starts = new Map<string, { index: number; data: Record<string, unknown> }>();
  events.forEach((e, index) => { if (e.type === "attempt.started" && typeof e.data.id === "string") { if (starts.has(e.data.id)) finalError(`duplicate start receipt for ${e.data.id}; restore the valid ledger`); starts.set(e.data.id, { index, data: e.data }); } });
  const ordered = [...attempts].sort((a, b) => (starts.get(a.id)?.index ?? -1) - (starts.get(b.id)?.index ?? -1) || a.id.localeCompare(b.id));
  const chosen = new Map<string, Attempt>(), rows: FinalAttempt[] = [];
  for (const a of ordered) {
    if (a.studyId !== input.study.id || typeof a.commit !== "string" || !/^[a-f0-9]{40}$/.test(a.commit) || !Number.isSafeInteger(a.seed)) finalError(`attempt ${a.id} has invalid study/commit/seed metadata`);
    const required = [input.winner, input.baseline].includes(a.commit) && input.final.seeds.includes(a.seed), start = starts.get(a.id);
    if (required && (!start || start.data.run !== "final" || start.data.commit !== a.commit || start.data.seed !== a.seed)) finalError(`attempt ${a.id} has no matching start receipt; restore its ledger evidence`);
    const key = `${a.commit}:${a.seed}`, decisive = required && !chosen.has(key);
    if (decisive) chosen.set(key, a);
    rows.push({ id: a.id, commit: a.commit, seed: a.seed, status: a.status, decisive, ...(!required ? { reason: "outside-final-pairs" } : !decisive ? { reason: "later-attempt" } : {}), ...(a.retryOf ? { retryOf: a.retryOf } : {}) });
  }
  for (const commit of [input.winner, input.baseline]) for (const seed of input.final.seeds) if (!chosen.has(`${commit}:${seed}`)) finalError(`missing decisive attempt for commit ${commit} seed ${seed}; finish every reserved winner/baseline pair`);
  const decisive = rows.filter(a => a.decisive), firstFailure = decisive.find(a => a.status !== "succeeded");
  let reason: string | undefined = firstFailure?.status;
  const selected = [...chosen.values()];
  if (!reason && selected.some(a => a.sealBinding !== input.design.binding || a.finalBinding !== input.binding || a.protocolHash !== input.investigate.result.protocolHash)) reason = "input-changed";
  const samples = (commit: string): Sample[] => input.final.seeds.flatMap(seed => {
    const a = chosen.get(`${commit}:${seed}`)!;
    if (a.status !== "succeeded" || a.sealBinding !== input.design.binding || a.finalBinding !== input.binding || a.protocolHash !== input.investigate.result.protocolHash) return [];
    return [{ seed, attempt: a.id, value: metricValue(a, input.investigate.result.metric) }];
  });
  const paired = pairSamples(samples(input.winner), samples(input.baseline), input.investigate.result.metric.direction, input.winner);
  if (!reason) {
    const gate = gateState("final", events, () => input.binding);
    if (gate.state !== "approved") finalError("gate is not approved for the current inputs; run ares gate approve <dir> final");
    if (paired.delta === null || paired.delta <= 0 || paired.delta < input.rule.minDelta) reason = "below-margin";
  }
  const result: FinalResult = { v: 1, status: reason ? "not_qualified" : "qualified", ...(reason ? { reason } : {}), winner: input.winner, baseline: input.baseline, seeds: input.final.seeds, pairs: paired.pairs, mean: paired.mean, baselineMean: paired.referenceMean, delta: paired.delta, decisive, attempts: rows, investigateSha256: input.investigate.sha256, ...(input.ablate ? { ablateSha256: input.ablate.sha256 } : {}), sealBinding: input.design.binding,
    inputsSha256: sha256(canonical({ binding: input.binding, attempts: ordered.map(a => ({ record: sha256(canonical(a)), start: starts.get(a.id)?.index ?? null })) })) };
  const text = JSON.stringify(result, null, 2) + "\n"; assertWritable(text, FINAL_RESULT_BYTES, "final result; archive the study and start a new bounded run");
  if (old !== text) commit(input.dir, [[file, text, FINAL_RESULT_BYTES]], [{ actor, type: "final.closed", data: { sha256: sha256(text), status: result.status, investigateSha256: result.investigateSha256 } }]);
  return result;
}
