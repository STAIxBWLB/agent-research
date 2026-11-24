import { calculate, inputs, type CommitResult } from "./investigate.ts";
import { foldIdeas, readCategories, type Expectation, type Idea } from "./ideas.ts";
import { observedMetric, sampleMean } from "./selection.ts";
import type { Attempt, AttemptStatus } from "./attempts.ts";

export const DEFAULT_WINDOW = 5, MAX_WINDOW = 1000;
export type Outcome = "hit" | "miss" | "unmeasured";
export interface ReportCommit { commit: string; delta: number | null; pairedSeeds: number; measured: boolean; eligible: boolean; reason: string }
export interface ReportPrediction { metric: string; expect: Expectation; minDelta?: number; delta: number | null; outcome?: Outcome }
export interface ReportIdea {
  id: string; category?: string; bundle: number; confounded: boolean; state: Idea["state"]; commits: ReportCommit[];
  attempts: Record<AttemptStatus, number>; timing: "prospective" | "post-hoc"; measuredCommit: string | null; primaryDelta: number | null;
  predictions: ReportPrediction[]; unpredictedRegressions: string[];
}
export interface ReportCategory { name: string; ideas: number; measured: number; hits: number; bestRecentDelta: number | null; noRecentGain: boolean }
export interface IdeaReport {
  v: 1; advisory: true; run: string; metric: { name: string; unit: string; direction: "max" | "min" }; baseline: string; minSeeds: number; minDelta: number;
  window: number; inputsSha256: string; ideas: ReportIdea[]; categories: ReportCategory[]; confounded: string[];
  search: { measured: number; bestDelta: number | null; stalled: boolean; untried: string[] };
}

function bad(reason: string): never { throw new Error(`idea report: ${reason}`); }
const best = (values: (number | null)[]) => values.reduce<number | null>((top, v) => v === null ? top : top === null || v > top ? v : top, null);

/** Direction-adjusted paired mean delta for any declared metric over the investigation's own pairs. */
function metricDelta(row: CommitResult, metric: { name: string; unit: string; direction: "max" | "min" }, byId: Map<string, Attempt>): number | null {
  if (!row.pairs.length) return null;
  const values: number[] = [], reference: number[] = [];
  for (const pair of row.pairs) {
    const a = byId.get(pair.attempt), b = byId.get(pair.baselineAttempt);
    const x = a && observedMetric(a, metric), y = b && observedMetric(b, metric);
    if (x === undefined || y === undefined) return null;
    values.push(x); reference.push(y);
  }
  const mean = sampleMean(values)!, ref = sampleMean(reference)!, delta = metric.direction === "max" ? mean - ref : ref - mean;
  return Number.isFinite(delta) ? delta : null;
}

/** Read-only, advisory fold over the ledger and the investigation pairing; it writes nothing and gates nothing. */
export function ideaReport(dirArg: string, options: { run?: string; window?: number } = {}): IdeaReport {
  const window = options.window ?? DEFAULT_WINDOW;
  if (!Number.isSafeInteger(window) || window < 1 || window > MAX_WINDOW) bad(`window: integer in 1..${MAX_WINDOW} required; pass --window N`);
  const input = inputs(dirArg), { rule, protocol, events, attempts, dir } = input;
  if (options.run !== undefined && options.run !== rule.run) bad(`run ${options.run} is not the selection run ${rule.run}; pass --run ${rule.run} or set a selection for that run`);
  const result = calculate(input), primary = result.metric, byId = new Map(attempts.map(a => [a.id, a]));
  const rows = new Map([result.baseline, ...result.candidates].map(row => [row.commit, row]));
  const baselineReady = result.baseline.eligible;
  const firstStart = new Map<string, number>(), added = new Map<string, number>();
  events.forEach((event, index) => {
    if (event.type === "attempt.started" && typeof event.data.commit === "string" && !firstStart.has(event.data.commit)) firstStart.set(event.data.commit, index);
    if (event.type === "idea.added" && event.data.idea && typeof (event.data.idea as { id?: unknown }).id === "string") added.set((event.data.idea as { id: string }).id, index);
  });
  const ideas = foldIdeas(events).map((idea): ReportIdea => {
    const commits = idea.commits.map((commit): ReportCommit => {
      const row = rows.get(commit), pairs = row?.pairs.length ?? 0, measured = !!row && commit !== rule.baseline.commit && baselineReady && pairs >= rule.minSeeds && row.delta !== null;
      return { commit, delta: row && commit !== rule.baseline.commit ? row.delta : null, pairedSeeds: pairs, measured, eligible: !!row?.eligible && commit !== rule.baseline.commit, reason: row ? row.reason : "no-attempts" };
    });
    const totals = { running: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0 };
    for (const commit of idea.commits) { const row = rows.get(commit); if (row) for (const status of Object.keys(totals) as AttemptStatus[]) totals[status] += row.attempts[status].length; }
    const starts = idea.commits.map(c => firstStart.get(c)).filter((i): i is number => i !== undefined);
    const timing = starts.length && Math.min(...starts) < added.get(idea.id)! ? "post-hoc" : "prospective";
    const latest = [...commits].reverse().find(c => c.measured), row = latest ? rows.get(latest.commit)! : undefined;
    const deltaFor = (name: string): number | null => {
      if (!row) return null;
      const metric = protocol.metrics.find(m => m.name === name);
      return !metric ? null : name === primary.name ? row.delta : metricDelta(row, metric, byId);
    };
    const predictions = (idea.predicts ?? []).map((p): ReportPrediction => {
      const delta = deltaFor(p.metric), threshold = p.metric === primary.name && p.expect === "no-change" ? rule.minDelta : p.minDelta ?? 0;
      const hit = delta === null ? undefined : p.expect === "improve" ? delta > 0 && delta >= threshold : p.expect === "regress" ? delta < 0 && -delta >= (p.minDelta ?? 0) : Math.abs(delta) < threshold;
      const outcome: Outcome | undefined = timing === "post-hoc" ? undefined : hit === undefined ? "unmeasured" : hit ? "hit" : "miss";
      return { metric: p.metric, expect: p.expect, ...(p.minDelta !== undefined ? { minDelta: p.minDelta } : {}), delta, ...(outcome ? { outcome } : {}) };
    });
    const regressAllowed = new Set((idea.predicts ?? []).filter(p => p.expect === "regress").map(p => p.metric));
    const unpredictedRegressions = row ? protocol.metrics.filter(m => !regressAllowed.has(m.name)).filter(m => { const d = deltaFor(m.name); return d !== null && d < 0; }).map(m => m.name) : [];
    const bundle = idea.bundle ?? 1;
    return { id: idea.id, ...(idea.category !== undefined ? { category: idea.category } : {}), bundle, confounded: bundle > 1, state: idea.state, commits, attempts: totals, timing,
      measuredCommit: latest?.commit ?? null, primaryDelta: row ? row.delta : null, predictions, unpredictedRegressions };
  });
  const clean = ideas.filter(i => !i.confounded), measured = clean.filter(i => i.measuredCommit !== null);
  const names = [...new Set(clean.flatMap(i => i.category === undefined ? [] : [i.category]))].sort();
  const categories = names.map((name): ReportCategory => {
    const members = clean.filter(i => i.category === name), done = members.filter(i => i.measuredCommit !== null);
    const recent = best(done.slice(-window).map(i => i.primaryDelta));
    return { name, ideas: members.length, measured: done.length, hits: members.reduce((n, i) => n + i.predictions.filter(p => p.outcome === "hit").length, 0),
      bestRecentDelta: recent, noRecentGain: done.length > 0 && recent !== null && recent <= 0 };
  });
  const eligibleDelta = (i: ReportIdea) => i.commits.find(c => c.commit === i.measuredCommit)?.eligible ? i.primaryDelta : null;
  const before = best(measured.slice(0, -window).map(eligibleDelta)), last = best(measured.slice(-window).map(eligibleDelta));
  const stalled = measured.length >= window && (last === null || last <= Math.max(before ?? 0, 0));
  const declared = readCategories(dir), tried = new Set(measured.map(i => i.category));
  return {
    v: 1, advisory: true, run: rule.run, metric: primary, baseline: rule.baseline.commit, minSeeds: rule.minSeeds, minDelta: rule.minDelta, window,
    inputsSha256: result.inputsSha256, ideas, categories, confounded: ideas.filter(i => i.confounded).map(i => i.id),
    search: { measured: measured.length, bestDelta: best(measured.map(eligibleDelta)), stalled, untried: (declared ?? []).filter(c => !tried.has(c)) },
  };
}
