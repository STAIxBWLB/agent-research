import { requireCopilotAccept } from "../copilot.ts";
import { readFinalSeeds, finalSeedsHash } from "./final.ts";
import { foldIdeas } from "./ideas.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, commit, openStudy, plain, readLedger, readTextBounded, requireExperiment, sha256, type Actor, type LedgerEvent } from "../study.ts";
import { listAttempts, type Attempt, type AttemptStatus } from "./attempts.ts";
import { protocolHash, readProtocol } from "./protocol.ts";
import { readSelection, selectionHash } from "./selection.ts";

export const INVESTIGATE_BYTES = 1_048_576;
export type NoWinner = "no-baseline" | "baseline-seeds" | "no-candidate" | "below-margin" | "tie";
type Exclusion = "other-protocol" | "before-selection" | "missing-start-event" | "undeclared-seed" | "later-success" | "reserved-seed";
export interface Sample { seed: number; attempt: string; value: number }
export interface CommitResult {
  commit: string; idea?: string; attempts: Record<AttemptStatus, string[]>; perSeed: Sample[];
  pairedSeeds: number[]; pairs: { seed: number; attempt: string; baselineAttempt: string; value: number; baselineValue: number }[];
  mean: number | null; baselineMean: number | null; delta: number | null; eligible: boolean; reason: string;
}
export interface InvestigateResult {
  v: 1; run: string; ruleSha256: string; protocolHash: string; inputsSha256: string;
  metric: { name: string; unit: string; direction: "max" | "min" };
  baseline: CommitResult; candidates: CommitResult[];
  totals: { attempts: number; byStatus: Record<AttemptStatus, number>; countedSuccesses: number; excluded: number };
  excluded: { id: string; commit: string; seed: number; status: AttemptStatus; reasons: Exclusion[] }[];
  winner: { commit: string; idea?: string; attempts: string[]; mean: number; delta: number } | null; reason?: NoWinner;
}
const recover = "; inspect ares attempt show and restore the last valid study inputs before ares investigate show";
function bad(reason: string): never { throw new Error(`investigate: ${reason}${recover}`); }
function canonical(raw: unknown): string {
  if (Array.isArray(raw)) return `[${raw.map(canonical).join(",")}]`;
  if (plain(raw)) return `{${Object.keys(raw).sort().map(k => `${JSON.stringify(k)}:${canonical(raw[k])}`).join(",")}}`;
  return JSON.stringify(raw) ?? "null";
}
function mean(values: number[]): number | null {
  if (!values.length) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (Number.isFinite(total)) return total / values.length;
  const scale = Math.max(...values.map(Math.abs));
  if (!scale) return 0;
  // Normalize before summing so finite evaluator values never overflow their mean.
  return Math.max(-1, Math.min(1, values.reduce((sum, v) => sum + v / scale / values.length, 0))) * scale;
}
export function metricValue(attempt: Attempt, metric: InvestigateResult["metric"]): number {
  if (!Array.isArray(attempt.metrics)) bad(`attempt ${attempt.id}: primary metrics missing`);
  const values = attempt.metrics.filter(m => m?.name === metric.name);
  const value = values[0];
  if (values.length !== 1 || !value || value.unit !== metric.unit || value.provenance !== "ares-observed" || typeof value.value !== "number" || !Number.isFinite(value.value)) bad(`attempt ${attempt.id}: primary metric missing, duplicate, non-finite or unvalidated`);
  return value.value;
}
export interface PairedSamples {
  pairedSeeds: number[]; pairs: { seed: number; attempt: string; referenceAttempt: string; value: number; referenceValue: number }[];
  mean: number | null; referenceMean: number | null; delta: number | null;
}
/** Descriptive shared-seed comparison; callers decide eligibility and never infer significance. */
export function pairSamples(samples: Sample[], reference: Sample[], direction: "max" | "min", commit: string): PairedSamples {
  const pairs = [...samples].sort((a, b) => a.seed - b.seed).flatMap(sample => {
    const base = reference.find(b => b.seed === sample.seed);
    return base ? [{ seed: sample.seed, attempt: sample.attempt, referenceAttempt: base.attempt, value: sample.value, referenceValue: base.value }] : [];
  });
  const candidateMean = mean(pairs.map(p => p.value)), referenceMean = mean(pairs.map(p => p.referenceValue));
  const delta = candidateMean === null || referenceMean === null ? null : direction === "max" ? candidateMean - referenceMean : referenceMean - candidateMean;
  if (delta !== null && !Number.isFinite(delta)) bad(`commit ${commit}: primary metric delta overflows; rescale the metric's unit in a new protocol and rerun attempts`);
  return { pairedSeeds: pairs.map(p => p.seed), pairs, mean: candidateMean, referenceMean, delta };
}
function empty(commit: string): CommitResult {
  return { commit, attempts: { running: [], succeeded: [], failed: [], cancelled: [], unknown: [] }, perSeed: [], pairedSeeds: [], pairs: [], mean: null, baselineMean: null, delta: null, eligible: false, reason: "no-counted-success" };
}
function inputs(dirArg: string) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  const protocol = readProtocol(dir);
  if (!protocol) throw new Error("investigate: protocol missing; run ares protocol before selecting an investigation rule");
  const rule = readSelection(dir, protocol), ruleSha = selectionHash(dir, protocol);
  if (!rule || !ruleSha) throw new Error("investigate: selection missing; run ares selection <dir> --file PATH before investigating");
  const events = readLedger(dir), cutoff = events.findLastIndex(e => e.type === "selection.set");
  if (cutoff < 0 || events[cutoff]!.data.sha256 !== ruleSha || events[cutoff]!.data.run !== rule.run) throw new Error("investigate: selection bytes have no current selection.set receipt; run ares selection <dir> --file PATH to record the rule before new attempts");
  const hash = protocolHash(protocol), metric = protocol.metrics.find(m => m.name === rule.metric)!;
  const attempts = listAttempts(dir, { run: rule.run }).attempts;
  for (const attempt of attempts) {
    if (attempt.studyId !== study.id || typeof attempt.commit !== "string" || !/^[a-f0-9]{40}$/.test(attempt.commit) || !Number.isSafeInteger(attempt.seed)) bad(`attempt ${attempt.id}: invalid study, commit or seed identity`);
  }
  const reserved = readFinalSeeds(dir, protocol)?.seeds ?? [], reservedSha = finalSeedsHash(dir, protocol);
  return { dir, protocol, rule, ruleSha, events, cutoff, hash, metric, attempts, reserved, reservedSha };
}
function calculate(input: ReturnType<typeof inputs>): InvestigateResult {
  const { rule, ruleSha, events, cutoff, hash, metric, attempts, protocol, reserved, reservedSha } = input;
  const ideas = foldIdeas(events), owners = new Map<string, string>();
  // The journal enforces exactly one idea owner for any associated commit.
  for (const idea of ideas) for (const commit of idea.commits) owners.set(commit, idea.id);
  const starts = new Map<string, { index: number; event: LedgerEvent }>();
  events.forEach((event, index) => {
    if (event.type !== "attempt.started" || typeof event.data.id !== "string") return;
    if (starts.has(event.data.id)) bad(`attempt ${event.data.id}: duplicate attempt.started receipt`);
    starts.set(event.data.id, { index, event });
  });
  const ordered = [...attempts].sort((a, b) => (starts.get(a.id)?.index ?? -1) - (starts.get(b.id)?.index ?? -1) || a.id.localeCompare(b.id));
  const byStatus = { running: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0 };
  const rows = new Map<string, CommitResult>([[rule.baseline.commit, empty(rule.baseline.commit)]]);
  const excluded: InvestigateResult["excluded"] = [];
  for (const attempt of ordered) {
    const row = rows.get(attempt.commit) ?? empty(attempt.commit); rows.set(row.commit, row);
    byStatus[attempt.status]++; row.attempts[attempt.status].push(attempt.id);
    const reasons: Exclusion[] = [], start = starts.get(attempt.id);
    if (attempt.protocolHash !== hash) reasons.push("other-protocol");
    if (!start) reasons.push("missing-start-event");
    else {
      if (start.event.data.run !== attempt.run || start.event.data.commit !== attempt.commit || start.event.data.seed !== attempt.seed) bad(`attempt ${attempt.id}: start receipt identity disagrees with its record`);
      if (start.index <= cutoff) reasons.push("before-selection");
    }
    if (!protocol.seeds.includes(attempt.seed)) reasons.push("undeclared-seed");
    if (reserved.includes(attempt.seed)) reasons.push("reserved-seed");
    if (!reasons.length && attempt.status === "succeeded") {
      if (row.perSeed.some(s => s.seed === attempt.seed)) reasons.push("later-success");
      else row.perSeed.push({ seed: attempt.seed, attempt: attempt.id, value: metricValue(attempt, metric) });
    }
    if (reasons.length) excluded.push({ id: attempt.id, commit: attempt.commit, seed: attempt.seed, status: attempt.status, reasons });
  }
  for (const row of rows.values()) { const idea = owners.get(row.commit); if (idea !== undefined) row.idea = idea; }
  const baseline = rows.get(rule.baseline.commit)!;
  for (const row of rows.values()) row.perSeed.sort((a, b) => a.seed - b.seed);
  baseline.mean = mean(baseline.perSeed.map(s => s.value)); baseline.baselineMean = baseline.mean;
  baseline.pairedSeeds = baseline.perSeed.map(s => s.seed); baseline.delta = baseline.mean === null ? null : 0;
  baseline.eligible = baseline.perSeed.length >= rule.minSeeds;
  baseline.reason = !baseline.perSeed.length ? "no-baseline" : baseline.eligible ? "baseline" : "baseline-seeds";
  const candidates = [...rows.values()].filter(row => row !== baseline).sort((a, b) => a.commit.localeCompare(b.commit));
  for (const row of candidates) {
    const paired = pairSamples(row.perSeed, baseline.perSeed, metric.direction, row.commit);
    row.pairedSeeds = paired.pairedSeeds; row.mean = paired.mean; row.baselineMean = paired.referenceMean; row.delta = paired.delta;
    row.pairs = paired.pairs.map(p => ({ seed: p.seed, attempt: p.attempt, baselineAttempt: p.referenceAttempt, value: p.value, baselineValue: p.referenceValue }));
    row.reason = !baseline.perSeed.length ? "no-baseline" : !baseline.eligible ? "baseline-seeds" : !row.perSeed.length ? "no-counted-success" : row.pairs.length < rule.minSeeds ? "candidate-seeds" : row.delta! <= 0 || row.delta! < rule.minDelta ? "below-margin" : "eligible";
    row.eligible = row.reason === "eligible";
  }
  const eligible = candidates.filter(row => row.eligible).sort((a, b) => b.delta! - a.delta!);
  let winner: InvestigateResult["winner"] = null, reason: NoWinner | undefined;
  if (!baseline.perSeed.length) reason = "no-baseline";
  else if (!baseline.eligible) reason = "baseline-seeds";
  else if (!candidates.some(row => row.pairedSeeds.length >= rule.minSeeds)) reason = "no-candidate";
  else if (!eligible.length) reason = "below-margin";
  else if (eligible.length > 1 && eligible[0]!.delta === eligible[1]!.delta) reason = "tie";
  else { const row = eligible[0]!; winner = { commit: row.commit, ...(row.idea !== undefined ? { idea: row.idea } : {}), attempts: row.pairs.map(p => p.attempt), mean: row.mean!, delta: row.delta! }; }
  const result: InvestigateResult = {
    v: 1, run: rule.run, ruleSha256: ruleSha, protocolHash: hash,
    inputsSha256: sha256(canonical({ ruleSha, protocolHash: hash, ...(reservedSha !== undefined ? { finalSeedsSha256: reservedSha } : {}), cutoff, ideas: sha256(canonical(ideas)), attempts: ordered.map(a => ({ record: sha256(canonical(a)), start: starts.get(a.id)?.index ?? null })) })),
    metric, baseline, candidates, totals: { attempts: attempts.length, byStatus, countedSuccesses: [...rows.values()].reduce((n, r) => n + r.perSeed.length, 0), excluded: excluded.length }, excluded,
    winner, ...(reason ? { reason } : {}),
  };
  assertWritable(JSON.stringify(result, null, 2) + "\n", INVESTIGATE_BYTES, "investigate result; archive this study and use a new bounded run");
  return result;
}
export function investigateResultPath(dir: string, run: string): string { return join(dir, "runs", run, "investigate.json"); }
function previousResult(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readTextBounded(file, INVESTIGATE_BYTES); }
  catch { throw new Error(`investigate result: unreadable, non-regular, invalid UTF-8 or larger than ${INVESTIGATE_BYTES} bytes; restore the last valid regular result within that bound before show or close`); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("investigate result: invalid JSON; restore the last valid investigate.json before show or close"); }
  if (!plain(value) || value.v !== 1) throw new Error("investigate result: unsupported version; use an ares version that supports this result, keeping investigate.json unchanged");
  return text;
}
export function showInvestigation(dirArg: string): InvestigateResult {
  const input = inputs(dirArg); previousResult(investigateResultPath(input.dir, input.rule.run)); return calculate(input);
}
/** Caller holds the study lock; every refusal precedes the single file/event commit. */
export function closeInvestigation(dirArg: string, actor: Actor): InvestigateResult {
  const input = inputs(dirArg);
  requireCopilotAccept(input.dir, "hypotheses");
  const file = investigateResultPath(input.dir, input.rule.run), previous = previousResult(file);
  if (input.attempts.some(a => a.status === "running")) throw new Error("investigate close: an attempt in the selected run is running; run ares attempt reconcile before closing");
  const result = calculate(input), text = JSON.stringify(result, null, 2) + "\n";
  if (previous !== text) commit(input.dir, [[file, text, INVESTIGATE_BYTES]], [{ actor, type: "investigate.closed", data: { run: input.rule.run, sha256: sha256(text), ruleSha256: input.ruleSha, winner: result.winner?.commit ?? null } }]);
  return result;
}


/** Read only a current, committed investigation result, never a hand-edited or stale winner. */
export function readClosedInvestigation(dirArg: string): { result: InvestigateResult; sha256: string } {
  const input = inputs(dirArg);
  requireCopilotAccept(input.dir, "hypotheses");
  const text = previousResult(investigateResultPath(input.dir, input.rule.run));
  if (text === undefined) throw new Error("investigate result: not closed; run ares investigate close before the next phase");
  const hash = sha256(text), receipt = input.events.findLast(e => e.type === "investigate.closed" && e.data.run === input.rule.run);
  if (!receipt || receipt.data.sha256 !== hash) throw new Error("investigate result: bytes do not match the latest close receipt; run ares investigate close to restore the committed result");
  const result = calculate(input);
  if (text !== JSON.stringify(result, null, 2) + "\n") throw new Error("investigate result: stale inputs; run ares investigate close again before the next phase");
  return { result, sha256: hash };
}
