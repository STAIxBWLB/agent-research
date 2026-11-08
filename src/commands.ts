import {harnessBinding, readHarnessRounds, setHarnessRound, showHarness, importHarnessFixture} from "./harness/rounds.ts";
import { readProvenance, compareLineage, type ProvenanceOptions, type ProvenancePage, type LineageComparison } from "./provenance.ts";
import { validateAutonomyMode, validatePhase, PHASES, ACCEPT_ARTIFACTS, resolveAutonomy, type AcceptArtifact, type Autonomy } from "./autonomy.ts";
import { copilotBinding, requireCopilotAccept } from "./copilot.ts";
import { homedir } from "node:os";
import { addStudy, removeStudy, readRegistry } from "./console/registry.ts";
import { readWatchSnapshot, setWatch, runWatch, showWatch, recordWatchFailure, watchFailureClass, type WatchSnapshot } from "./lit/watch.ts";
import { runSetup, type SetupMode } from "./setup.ts";
import { proposeSkill, decideSkill, listSkills } from "./memory/skills.ts";
import { rankLessons, type LessonRankOptions } from "./memory/lessons.ts";
import { createAmemClient } from "./memory/amem.ts";
import { previewArchive, exportArchive, type ArchivePreview, type ArchiveResult } from "./memory/archive.ts";
import { addReview, resolveReview, reviewReadiness, reviewBinding, requireReviewReady } from "./paper/review.ts";
import { buildPaper } from "./paper/build.ts";
import { checkPaper } from "./paper/check.ts";
import { addAblation, showAblate, closeAblate } from "./exp/ablate.ts";
import { setFinalSeeds, finalGateBinding, requireFinalInputs, closeFinal, showPosthoc } from "./exp/final.ts";
import { addIdea, decideIdea } from "./exp/ideas.ts";
import { showInvestigation, closeInvestigation } from "./exp/investigate.ts";
import { setSelection } from "./exp/selection.ts";
import { createHubClient } from "./plan/hub.ts";
import { runPlan, type ControllerRuntime, type Observation, type StepNode } from "./plan/controller.ts";
import { resolveSnapshot } from "./exp/snapshot.ts";
import { GpuAdmissionDeferred, spawnRunner } from "./exp/executor.ts";
import { foldPlan, readPlanState, planGateBinding, prepareControl, type ControlRequest, type ControlResult } from "./plan/state.ts";
import { setPlan } from "./plan/definition.ts";
export { manifest } from "./manifest.ts";
import { exportBundle } from "./study-export.ts";
import { existsSync, readdirSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Http } from "./http.ts";
import { readScope, scopeHash, setScope } from "./scope.ts";
import { boundedText, commit, decideGate, gateState, GATES, initStudy, openStudy, readBytesBounded, readLedger, readTextBounded, requireGate, isHarnessGate, sha256, withLock, readPlanOwner, type Actor, type Binder, type GateName, type Study, STUDY_BYTES } from "./study.ts";
import { candidatesFile, includedHash, isVerified, loadCandidates, mergeCandidates, sameWork, verifySubject, type Candidate } from "./lit/candidates.ts";
import { searchSource, SOURCES, type SourceName } from "./lit/sources.ts";
import { verifyCandidates } from "./lit/verify.ts";
import { assignCitekeys, renderBib } from "./lit/bibtex.ts";
import { checkCitations } from "./lit/cite.ts";
import { cardPath, validateCard } from "./lit/cards.ts";
import { designBinding, protocolHash, readDesign, setProtocol } from "./exp/protocol.ts";
import { requireExperiment } from "./study.ts";
import { checkExecutor, setExecutor, readExecutor, hashExecutorInput, type InputManifest } from "./exp/executor.ts";
import { cancelAttempt, listAttempts, listAttemptSummaries, reconcileAttempts, runAttempt, showAttempt, type AttemptContext, type AttemptListOptions, type AttemptOptions } from "./exp/attempts.ts";
import { readAttemptLogs, type LogOptions } from "./exp/logs.ts";

export type ExperimentRuntime = Omit<AttemptContext, "actor">;
export interface Ctx extends ExperimentRuntime { actor: Actor; http: Http; signal?: AbortSignal }
const MAX_IDS = 200, DRAFT_BYTES = 2 * 1024 * 1024, BIB_BYTES = 16 * 1024 * 1024, CARD_BYTES = 65_536;

export function binder(dir: string): Binder {
  return gate => isHarnessGate(gate) ? harnessBinding(dir, gate.slice(8)) : gate.startsWith("accept:") ? copilotBinding(dir, gate.slice(7) as AcceptArtifact) : gate === "review" ? reviewBinding(dir) : gate === "final" ? finalGateBinding(dir) : gate.startsWith("plan:") ? planGateBinding(readPlanState(dir, readLedger(dir)), gate) : gate === "scope" ? scopeHash(dir) : gate === "design" ? designBinding(dir) : includedHash(loadCandidates(dir));
}
function gateName(value: string): GateName {
  if (!GATES.includes(value as GateName) && !ACCEPT_ARTIFACTS.some(artifact => value === `accept:${artifact}`) && !value.startsWith("plan:") && !isHarnessGate(value)) throw new Error("unknown gate: unsupported name; run ares gate list <dir> and choose a listed gate before approval or rejection");
  return value as GateName;
}
function ids(values: string[]): string[] {
  if (!values.length) throw new Error("at least one candidate id required");
  if (values.length > MAX_IDS) throw new Error(`at most ${MAX_IDS} ids per call`);
  return [...new Set(values.map(v => boundedText(v, "id", 300)))];
}
function find(list: Candidate[], id: string): Candidate {
  const c = list.find(x => x.id === id);
  if (!c) throw new Error(`unknown candidate: ${id}`);
  return c;
}

export function init(dir: string, options: { question: string; mode?: string; autonomy?: string }, ctx: Pick<Ctx, "actor">) {
  const study = initStudy(dir, options, ctx.actor);
  return { created: resolve(dir), study };
}

export function autonomyShow(dirArg: string) {
  const { study } = openStudy(dirArg), policy = study.autonomy;
  const effective = Object.fromEntries(PHASES.map(phase => [phase, typeof policy === "string" ? policy : policy.phases[phase] ?? policy.default]));
  return { autonomy: policy, effective };
}
export async function autonomySet(dirArg: string, rawMode: string, rawPhase: string | undefined, ctx: Pick<Ctx, "actor">) {
  const mode = validateAutonomyMode(rawMode), phase = rawPhase === undefined ? undefined : validatePhase(rawPhase);
  const { dir } = openStudy(dirArg);
  return withLock(dir, () => {
    const { study } = openStudy(dir), from = study.autonomy;
    const to: Autonomy = phase !== undefined ? { default: typeof from === "string" ? from : from.default, phases: { ...(typeof from === "string" ? {} : from.phases), [phase]: mode } }
      : typeof from === "string" ? mode : { default: mode, phases: { ...from.phases } };
    const v = study.v === 2 || typeof to !== "string" || to === "copilot" || to === "step" ? 2 : 1;
    commit(dir, [[join(dir, "study.json"), JSON.stringify({ ...study, v, autonomy: to }, null, 2) + "\n", STUDY_BYTES]], [{ actor: ctx.actor, type: "autonomy.set", data: { from, to, phase: phase ?? null } }]);
    return autonomyShow(dir);
  });
}

export async function protocol(dirArg: string, raw: unknown, ctx: Ctx) {
  const { dir } = openStudy(dirArg);
  return withLock(dir, () => {
    const value = setProtocol(dir, raw, ctx.actor);
    return { protocol: value, protocolHash: protocolHash(value), gate: gateState("design", readLedger(dir), binder(dir)) };
  });
}
export async function executorSet(dirArg: string, raw: unknown, ctx: Ctx) {
  const { dir } = openStudy(dirArg);
  return withLock(dir, () => setExecutor(dir, raw, ctx.actor));
}
/** Read only configured executor-host inputs; no paths or bodies are recorded in the study. */
export async function executorInputsHash(dirArg: string, path: string, ctx: Ctx): Promise<InputManifest> {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  const executor = readExecutor(dir);
  if (!executor) throw new Error("executor: not configured; run ares executor set <dir> --kind local|ssh [--host ALIAS] --workdir PATH");
  return hashExecutorInput(executor, path, ctx.runner);
}
export const executorCheck = (dir: string, ctx: Ctx) => checkExecutor(dir, ctx.runner);
export const harnessSet = (dir: string, raw: unknown, ctx: Ctx) => withLock(dir, () => setHarnessRound(dir, raw, ctx.actor));
export const harnessShow = (dir: string, round?: string) => showHarness(dir, round);
export const harnessImport = (dir: string, round: string, raw: unknown, ctx: Ctx) => withLock(dir, () => importHarnessFixture(dir, round, raw, ctx.actor));
export async function attemptRun(dir: string, options: AttemptOptions, ctx: Ctx) {
  try { return await runAttempt(dir, options, ctx); }
  catch (error) { if (error instanceof GpuAdmissionDeferred) return error.result; throw error; }
}
export const attemptList = (dir: string, options: AttemptListOptions = {}) => listAttemptSummaries(dir, options);
export const attemptShow = (dir: string, id: string) => showAttempt(dir, id);
export const attemptCancel = (dir: string, id: string, reason: string | undefined, ctx: Ctx) => cancelAttempt(dir, id, reason, ctx);
export const attemptReconcile = (dir: string, ctx: Ctx) => reconcileAttempts(dir, ctx);
export const attemptLogs = (dir: string, id: string, options: LogOptions, ctx: Ctx) => readAttemptLogs(dir, id, options, ctx.runner);

export function status(dirArg: string) {
  const { dir, study } = openStudy(dirArg), events = readLedger(dir), list = loadCandidates(dir), bind = binder(dir);
  const cardsDir = join(dir, "literature", "cards"), bibPath = join(dir, "refs", "references.bib");
  const count = (s: Candidate["status"]) => list.filter(c => c.status === s).length;
  const included = list.filter(c => c.status === "included");
  return {
    study: dir, question: study.question, mode: study.mode, autonomy: study.autonomy,
    scope: { set: scopeHash(dir) !== undefined },
    gates: GATES.filter(g => (g !== "design" && g !== "final") || study.mode === "experiment").map(g => gateState(g, events, bind)),
    literature: {
      candidates: list.length, new: count("new"), included: included.length, excluded: count("excluded"),
      verified: included.filter(isVerified).length, unverified: included.filter(c => !isVerified(c)).length,
      cards: existsSync(cardsDir) ? readdirSync(cardsDir).filter(f => f.endsWith(".json")).length : 0,
    },
    bib: existsSync(bibPath) ? { path: bibPath, sha256: sha256(readBytesBounded(bibPath, BIB_BYTES)) } : null,
    events: events.length,
  };
}

export const studyExport = (dir: string, options: { bundle: string; list?: boolean }) => exportBundle(dir, options);

export async function scope(dirArg: string, raw: unknown, ctx: Ctx) {
  const { dir } = openStudy(dirArg);
  return withLock(dir, () => {
    const result = setScope(dir, raw, ctx.actor);
    return { ...result, gate: gateState("scope", readLedger(dir), binder(dir)) };
  });
}

export function gateList(dirArg: string) {
  const { dir, study } = openStudy(dirArg), events = readLedger(dir), bind = binder(dir);
  const plan = foldPlan(events);
  const accepts = ACCEPT_ARTIFACTS.filter(artifact => resolveAutonomy(study.autonomy, `accept:${artifact}`) === "copilot").map(artifact => `accept:${artifact}` as GateName);
  const gates: GateName[] = [...accepts, ...GATES.filter(g => (g !== "design" && g !== "final") || study.mode === "experiment"), ...(plan?.nodes.filter(n => n.kind === "gate").map(n => `plan:${n.id}` as GateName) ?? []), ...(study.mode === "experiment" ? readHarnessRounds(dir).map(round => `harness:${round.id}` as GateName) : [])];
  return gates.map(g => gateState(g, events, bind));
}

export async function gateDecide(dirArg: string, gate: string, decision: "approve" | "reject", reason: string | undefined, ctx: Ctx, guard?: () => void) {
  const { dir, study } = openStudy(dirArg), name = gateName(gate), why = reason === undefined ? undefined : boundedText(reason, "--reason", 500);
  if (name === "design" || name === "final" || isHarnessGate(name)) requireExperiment(study);
  return withLock(dir, () => {
    guard?.();
    if (name === "final") requireFinalInputs(dir);
    if (name === "review" && decision === "approve") requireReviewReady(dir);
    if (name.startsWith("plan:") && !readPlanState(dir, readLedger(dir)).definition.nodes.some(n => n.id === name.slice(5) && n.kind === "gate")) throw new Error(`gate ${name}: no gate node ${name.slice(5)} in the plan; run ares gate list and select an existing gate`);
    return decideGate(dir, name, decision, ctx.actor, binder(dir), why);
  });
}

export async function search(dirArg: string, query: string, options: { source?: string; limit?: number; yearFrom?: number }, ctx: Ctx) {
  const { dir } = openStudy(dirArg); return withLock(dir, () => searchLocked(dir, query, options, ctx));
}
async function searchLocked(dirArg: string, query: string, options: { source?: string; limit?: number; yearFrom?: number }, ctx: Ctx) {
  const { dir, study } = openStudy(dirArg), q = boundedText(query, "query", 500);
  const source = options.source ?? "all";
  if (source !== "all" && !SOURCES.includes(source as SourceName)) throw new Error("--source: openalex, s2, arxiv or all");
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit: 1..50");
  if (options.yearFrom !== undefined && (!Number.isSafeInteger(options.yearFrom) || options.yearFrom < 1000 || options.yearFrom > 2100)) throw new Error("--year-from: year 1000..2100");
  const sc = readScope(dir);
  if (!sc) throw new Error("gate scope: no scope yet (run ares scope)");
  const yearFrom = options.yearFrom ?? sc.yearFrom;
  if (yearFrom !== undefined && sc.yearTo !== undefined && yearFrom > sc.yearTo) throw new Error(`--year-from: after the scope's yearTo ${sc.yearTo}`);
  const approval = requireGate(dir, study, "scope", binder(dir));
  const names = source === "all" ? SOURCES : [source as SourceName];
  const results = [];
  for (const name of names) results.push(await searchSource(ctx.http, name, q, { limit, ...(yearFrom !== undefined ? { yearFrom } : {}), ...(sc.yearTo !== undefined ? { yearTo: sc.yearTo } : {}) }));
  const list = loadCandidates(dir), counts = mergeCandidates(list, results.flatMap(r => r.records), sc.maxCandidates);
  const sources = results.map(r => ({ source: r.source, ok: r.ok, returned: r.records.length, ...(r.error ? { error: r.error } : {}) }));
  // A search where every source failed is recorded but is not a success, so it approves nothing.
  const answered = sources.some(r => r.ok);
  commit(dir, [candidatesFile(dir, list)], [...(answered ? approval : []), { actor: ctx.actor, type: "lit.search", data: { query: q, sources, ...counts } }]);
  return { query: q, sources, ...counts, candidates: list.length };

}

export function list(dirArg: string, options: { status?: string; limit?: number }) {
  const { dir } = openStudy(dirArg), limit = options.limit ?? 50;
  if (options.status !== undefined && !["new", "included", "excluded"].includes(options.status)) throw new Error("--status: new, included or excluded");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("--limit: 1..500");
  const all = loadCandidates(dir).filter(c => !options.status || c.status === options.status);
  return {
    total: all.length,
    candidates: all.slice(0, limit).map(c => ({
      id: c.id, title: c.title, authors: c.authors.slice(0, 5), year: c.year, venue: c.venue, sources: c.sources, status: c.status,
      ...(c.reason ? { reason: c.reason } : {}), ...(c.citekey ? { citekey: c.citekey } : {}), ...(c.duplicates?.length ? { duplicates: c.duplicates } : {}),
      verified: isVerified(c), ...(c.verify ? { verify: { syntax: c.verify.syntax, exists: c.verify.exists, match: c.verify.match } } : {}),
      ...(c.abstract ? { abstract: c.abstract.slice(0, 600) } : {}),
    })),
  };
}

export async function screen(dirArg: string, values: string[], decision: "include" | "exclude", reason: string | undefined, ctx: Ctx, guard?: () => void) {
  const { dir, study } = openStudy(dirArg), wanted = ids(values), why = reason === undefined ? undefined : boundedText(reason, "--reason", 500);
  return withLock(dir, () => {
    guard?.();
    const all = loadCandidates(dir), at = new Date().toISOString(), status = decision === "include" ? "included" : "excluded";
    for (const id of wanted) find(all, id);
    const approval = requireGate(dir, study, "scope", binder(dir));
    for (const id of wanted) {
      const c = find(all, id);
      c.status = status; c.decidedBy = ctx.actor; c.decidedAt = at;
      if (why) c.reason = why; else delete c.reason;
    }
    commit(dir, [candidatesFile(dir, all)], [...approval, { actor: ctx.actor, type: "lit.screen", data: { ids: wanted, decision, ...(why ? { reason: why } : {}) } }]);
    return { decision, ids: wanted, gate: gateState("screen", readLedger(dir), binder(dir)) };
  });
}

export async function card(dirArg: string, id: string, raw: unknown, ctx: Ctx) {
  const { dir, study } = openStudy(dirArg), value = validateCard(raw);
  return withLock(dir, () => {
    const c = find(loadCandidates(dir), id);
    if (c.status !== "included") throw new Error(`${id}: cards are recorded for included candidates only`);
    const approval = requireGate(dir, study, "scope", binder(dir));
    const path = cardPath(dir, id), text = JSON.stringify({ id, ...value }, null, 2) + "\n";
    commit(dir, [[path, text, CARD_BYTES]], [...approval, { actor: ctx.actor, type: "lit.card", data: { id, sha256: sha256(text) } }]);
    return { id, path };
  });
}

/**
 * Without ids: included candidates never checked, checked against other identifiers, or left unknown, up to 200.
 * Final results (no identifier, not found, title or year mismatch) are skipped so the batch always advances;
 * re-check one by naming its id.
 */
export async function verify(dirArg: string, values: string[], ctx: Ctx) {
  const { dir, study } = openStudy(dirArg), wanted = values.length ? ids(values) : undefined;
  return withLock(dir, async () => {
    const all = loadCandidates(dir);
    const open = (c: Candidate) => !c.verify || c.verify.subject !== verifySubject(c) || (c.verify.syntax === "ok" && c.verify.exists === "unknown");
    const pending = wanted ? wanted.map(id => find(all, id)) : all.filter(c => c.status === "included" && !isVerified(c) && open(c));
    const approval = requireGate(dir, study, "scope", binder(dir));
    const batch = pending.slice(0, MAX_IDS);
    const results = await verifyCandidates(ctx.http, batch, ctx.sleep ? { sleep: ctx.sleep } : {});
    for (const c of batch) { const v = results.get(c.id); if (v) c.verify = v; }
    const tally = { checked: batch.length, verified: batch.filter(isVerified).length, notFound: batch.filter(c => c.verify?.exists === "no").length,
      unknown: batch.filter(c => c.verify?.exists === "unknown").length, mismatched: batch.filter(c => c.verify?.exists === "yes" && c.verify.match !== "yes").length,
      noIdentifier: batch.filter(c => c.verify?.syntax !== "ok").length, remaining: pending.length - batch.length,
      final: wanted ? 0 : all.filter(c => c.status === "included" && !isVerified(c) && !open(c)).length };
    commit(dir, [candidatesFile(dir, all)], [...approval, { actor: ctx.actor, type: "lit.verify", data: tally }]);
    return { ...tally, results: batch.map(c => ({ id: c.id, ...c.verify })) };
  });
}

export async function bib(dirArg: string, ctx: Ctx) {
  const { dir, study } = openStudy(dirArg);
  return withLock(dir, () => {
    const approval = requireGate(dir, study, "screen", binder(dir));
    const all = loadCandidates(dir), eligible = all.filter(c => c.status === "included" && isVerified(c));
    const twins = sameWork(all).map(g => g.filter(id => all.find(c => c.id === id)!.status === "included")).filter(g => g.length > 1);
    if (twins.length) throw new Error(`included candidates that are the same work: ${twins.map(g => g.join(" = ")).join("; ")}; exclude all but one of each`);
    const assigned = assignCitekeys(all, eligible);
    const { text, entries } = renderBib(all), path = join(dir, "refs", "references.bib"), hash = sha256(text);
    commit(dir, [...(assigned ? [candidatesFile(dir, all)] : []), [path, text, BIB_BYTES]], [...approval, { actor: ctx.actor, type: "lit.bib", data: { entries, sha256: hash } }]);
    const left = all.filter(c => c.status === "included" && !isVerified(c)).map(c => ({ id: c.id, verify: c.verify ? `${c.verify.syntax}/${c.verify.exists}/${c.verify.match}` : "not checked" }));
    return { path, entries, sha256: hash, newKeys: assigned, notInBib: left };
  });
}

export function cite(dirArg: string, draft: string) {
  const { dir } = openStudy(dirArg), path = resolve(draft);
  return { draft: path, ...checkCitations(readTextBounded(path, DRAFT_BYTES), loadCandidates(dir)) };
}

export async function planSet(dirArg: string, raw: unknown, ctx: Pick<Ctx, "actor">) {
  const { dir } = openStudy(dirArg);
  return withLock(dir, () => setPlan(dir, raw, ctx.actor));
}
export function planShow(dirArg: string) {
  const { dir } = openStudy(dirArg);
  let controller: ReturnType<typeof readPlanOwner> | "none" | { error: string };
  try { controller = readPlanOwner(dir) ?? "none"; }
  catch { controller = { error: "controller owner unreadable; inspect .ares.plan.lock before ares run" }; }
  return { ...readPlanState(dir, readLedger(dir)), controller };
}

export async function planControl(dirArg: string, request: ControlRequest, ctx: Ctx): Promise<ControlResult> {
  const { dir } = openStudy(dirArg);
  const prepared = await withLock(dir, () => {
    const events = readLedger(dir), state = readPlanState(dir, events);
    const prepared = prepareControl(state, events, request, ctx.actor, openStudy(dir).study.autonomy);
    if (!prepared.event) return { result: prepared.result };
    const node = state.nodes.find(n => n.id === request.node);
    const attempt = node?.attemptId ? listAttempts(dir).attempts.find(a => a.id === node.attemptId) : undefined;
    if (request.action === "cancel" && attempt) return { attemptId: attempt.id, dispatchId: node?.dispatchId };
    // A missing record after a crash is uncertain, and explicit retry/cancel may release it.
    if ((request.action === "retry" || request.action === "skip") && attempt?.status === "running") throw new Error(`plan node ${node!.id}: attempt is still running; cancel it or run ares attempt reconcile before retry`);
    commit(dir, [], [prepared.event, ...(prepared.pause ? [prepared.pause] : [])]);
    return { result: prepared.result };
  });
  if (prepared.result) return prepared.result;
  let result: ControlResult | undefined;
  await cancelAttempt(dir, prepared.attemptId!, "plan cancellation", ctx, () => {
    const events = readLedger(dir), state = readPlanState(dir, events);
    // An identical cancel may have committed while this request waited for the attempt control lock.
    const current = prepareControl(state, events, request, ctx.actor, openStudy(dir).study.autonomy);
    if (!current.event) { result = current.result; return []; }
    if (state.nodes.find(node => node.id === request.node)?.dispatchId !== prepared.dispatchId) throw new Error("plan cancel: dispatch changed while cancelling the attempt; inspect ares plan show and retry with a new command-id");
    result = current.result;
    return current.event ? [current.event, ...(current.pause ? [current.pause] : [])] : [];
  });
  return result!;
}


function stepText(node: StepNode, key: string): string {
  return boundedText(node.args[key], `plan step ${node.id}.${key}`, 4096);
}
function stepNumber(node: StepNode, key: string): number | undefined {
  const value = node.args[key];
  if (value === undefined) return undefined;
  if ((typeof value !== "string" && typeof value !== "number") || !/^-?\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error(`plan step ${node.id}.${key}: integer required; correct the argument with ares plan set`);
  return Number(value);
}
export async function planRun(dirArg: string, options: { parallel?: number }, ctx: Ctx) {
  const { dir } = openStudy(dirArg);
  const attemptOptions = (node: StepNode, retryOf?: string) => {
    const parent = retryOf ?? (node.args.retry !== undefined ? stepText(node, "retry") : undefined);
    const retry = parent && listAttempts(dir).attempts.some(a => a.id === parent) ? parent : undefined;
    return {
      repo: resolve(dir, stepText(node, "repo")), commit: stepText(node, "commit"),
      ...(stepNumber(node, "seed") !== undefined ? { seed: stepNumber(node, "seed")! } : {}),
      ...(node.args.run !== undefined ? { run: stepText(node, "run") } : {}),
      ...(node.args.label !== undefined ? { label: stepText(node, "label") } : {}),
      ...(retry ? { retry } : {}), detach: true,
    };
  };
  const observed = (attempt: ReturnType<typeof showAttempt>): Observation => ({
    progress: sha256(JSON.stringify(attempt)),
    status: attempt.status === "running" ? "dispatched" : attempt.status === "succeeded" ? "done" : attempt.status === "unknown" ? "uncertain" : attempt.status,
    ...(attempt.status === "succeeded" ? { output: { attemptId: attempt.id, sha256: sha256(JSON.stringify(attempt)) } } : {}),
    ...(attempt.status !== "running" && attempt.status !== "succeeded" ? { reason: `attempt ${attempt.status}; inspect ares attempt show before retrying this node` } : {}),
  });
  const runtime: ControllerRuntime = {
    hub: createHubClient(dir, ctx.runner),
    actor: ctx.actor, ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    prepare: async (node, state) => {
      if (node.command !== "attempt.run") return {};
      requireCopilotAccept(dir, "hypotheses");
      const design = readDesign(dir);
      if (!design) throw new Error("plan attempt: protocol missing; run ares protocol before resume");
      const options = attemptOptions(node, state.retryOf), snapshot = await resolveSnapshot(options.repo, options.commit, ctx.runner ?? spawnRunner);
      const { attemptId } = await import("./exp/attempts.ts");
      return { attemptId: attemptId(protocolHash(design.protocol), snapshot.commit, snapshot.treeId, options.seed ?? design.protocol.seeds[0]!, options.run ?? "main", options.retry) };
    },
    execute: async (node, state) => {
      if (node.command === "attempt.run") {
        try { return observed(await runAttempt(dir, { ...attemptOptions(node, state.retryOf), expectedId: state.attemptId! }, ctx)); }
        catch (error) {
          if (error instanceof GpuAdmissionDeferred) return { status: "failed", reason: `deferred:${error.result.reason}; ${error.result.message}; run ares plan control <dir> retry ${node.id} --command-id ID --expected-revision N` };
          throw error;
        }
      }
      let result: unknown, ok = true;
      switch (node.command) {
        case "watch.run": {
          const result = await watchRun(dir, ctx);
          return result.ok ? { status: "done", output: { added: result.added } } : { status: "failed", reason: "watch: every source failed; inspect ares watch show and retry the plan node" };
        }
        case "lit.search": {
          const value = await search(dir, stepText(node, "query"), { ...(node.args.source !== undefined ? { source: stepText(node, "source") } : {}), ...(stepNumber(node, "limit") !== undefined ? { limit: stepNumber(node, "limit")! } : {}), ...(stepNumber(node, "year-from") !== undefined ? { yearFrom: stepNumber(node, "year-from")! } : {}) }, ctx);
          ok = value.sources.some(s => s.ok); result = value; break;
        }
        case "lit.verify": result = await verify(dir, (node.args.ids as string[] | undefined) ?? [], ctx); break;
        case "lit.bib": result = await bib(dir, ctx); break;
        case "investigate.close": {
          const result = await investigateClose(dir, ctx);
          return { status: "done", output: { sha256: sha256(JSON.stringify(result, null, 2) + "\n"), winner: result.winner } };
        }
        case "ablate.close": {
          const result = await ablateClose(dir, ctx);
          return { status: "done", output: { sha256: sha256(JSON.stringify(result, null, 2) + "\n"), status: "closed" } };
        }
        case "final.close": {
          const result = await finalClose(dir, ctx);
          return { status: "done", output: { sha256: sha256(JSON.stringify(result, null, 2) + "\n"), status: result.status } };
        }
        case "paper.build": {
          const result = await paperBuild(dir, ctx);
          return { status: "done", output: { sha256: result.evidenceSha256 } };
        }
        case "cite.check": { const value = cite(dir, resolve(dir, stepText(node, "draft"))); result = value; ok = value.ok; break; }
      }
      return { status: ok ? "done" : "failed", ...(ok ? { output: { sha256: sha256(JSON.stringify(result)) } } : { reason: "step reported failure; inspect its command result and inputs before retry" }) };
    },
    reconcile: async (_node, state) => {
      if (!state.attemptId || !listAttempts(dir).attempts.some(a => a.id === state.attemptId)) return { status: "uncertain", reason: "expected attempt record missing; explicitly retry or skip this node" };
      const before = showAttempt(dir, state.attemptId);
      if (before.status === "running") await reconcileAttempts(dir, ctx);
      return observed(showAttempt(dir, state.attemptId));
    },
  };
  return runPlan(dir, options, runtime);
}


export async function selection(dirArg: string, raw: unknown, ctx: Pick<Ctx, "actor">) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  return withLock(dir, () => {
    const design = readDesign(dir);
    if (!design) throw new Error("selection: protocol missing; run ares protocol <dir> --file PATH before setting a selection");
    const result = setSelection(dir, raw, design.protocol, ctx.actor);
    return { ...result, gate: gateState("design", readLedger(dir), binder(dir)) };
  });
}


export const investigateShow = (dir: string) => showInvestigation(dir);
export async function investigateClose(dirArg: string, ctx: Pick<Ctx, "actor">) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  return withLock(dir, () => closeInvestigation(dir, ctx.actor));
}


export async function ideaAdd(dirArg: string, raw: unknown, ctx: Pick<Ctx, "actor">) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  return withLock(dir, () => addIdea(dir, raw, ctx.actor));
}
export async function ideaDecide(dirArg: string, id: string, raw: unknown, ctx: Pick<Ctx, "actor">) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  return withLock(dir, () => decideIdea(dir, id, raw, ctx.actor));
}


export async function finalSeeds(dirArg: string, raw: unknown, ctx: Pick<Ctx, "actor">) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  return withLock(dir, () => {
    const design = readDesign(dir);
    if (!design) throw new Error("final seeds: protocol missing; run ares protocol <dir> --file PATH first");
    const result = setFinalSeeds(dir, raw, design.protocol, ctx.actor, () => {
      const attempts = listAttempts(dir).attempts;
      if (attempts.some(attempt => !Number.isSafeInteger(attempt.seed))) throw new Error("final seeds: attempt seed metadata is malformed; restore valid attempt records before reserving seeds");
      return new Set(attempts.map(attempt => attempt.seed));
    });
    return { ...result, gate: gateState("design", readLedger(dir), binder(dir)) };
  });
}


export async function ablateAdd(dirArg: string, raw: unknown, ctx: Pick<Ctx, "actor">) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  return withLock(dir, () => addAblation(dir, raw, ctx.actor));
}
export const ablateShow = (dir: string) => showAblate(dir);
export async function ablateClose(dirArg: string, ctx: Pick<Ctx, "actor">) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  return withLock(dir, () => closeAblate(dir, ctx.actor));
}


export async function finalClose(dirArg: string, ctx: Pick<Ctx, "actor">) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  return withLock(dir, () => closeFinal(dir, ctx.actor));
}

export const posthocShow = (dir: string) => showPosthoc(dir);

export const paperCheck = (dir: string) => checkPaper(dir);

export async function paperBuild(dirArg: string, ctx: Pick<Ctx, "actor">) {
  const { dir } = openStudy(dirArg); return withLock(dir, () => buildPaper(dir, ctx.actor));
}

export async function reviewAdd(dirArg: string, raw: unknown, ctx: Pick<Ctx, "actor">) {
  const { dir } = openStudy(dirArg); return withLock(dir, () => addReview(dir, raw, ctx.actor));
}
export async function reviewResolve(dirArg: string, target: string, reason: string, ctx: Pick<Ctx, "actor">) {
  const { dir } = openStudy(dirArg); return withLock(dir, () => resolveReview(dir, target, reason, ctx.actor));
}
export const reviewShow = (dir: string) => reviewReadiness(dir);

/** Preview is read-only; confirmed outward writes and receipts share the study lock. */
export async function archive(dirArg: string, options: { confirm?: string }, ctx: Pick<Ctx, "actor" | "runner">, env: NodeJS.ProcessEnv = process.env, guard?: () => void): Promise<ArchivePreview | ArchiveResult> {
  const { dir } = openStudy(dirArg);
  if (options.confirm === undefined) return previewArchive(dir);
  return withLock(dir, () => { guard?.(); return exportArchive(dir, options.confirm!, ctx.actor, ctx.runner, env); });
}

/** The study cwd binds amem's project; search and optional intent brief never write study files. */
export async function lessons(dirArg: string, options: LessonRankOptions & { for?: string }, ctx: Pick<Ctx, "runner" | "now"> = {}, env: NodeJS.ProcessEnv = process.env) {
  const { dir, study } = openStudy(dirArg), now = ctx.now?.() ?? Date.now();
  rankLessons([], now, options);
  if (options.for !== undefined && (!options.for.trim() || options.for.includes("\0") || options.for.length > 1000)) throw new Error("lessons intent: blank, NUL or over 1000 characters; pass --for with nonblank intent text within that bound");
  const client = createAmemClient(dir, ctx.runner, env), hits = await client.search(options.for ?? study.question);
  const ranked = rankLessons(hits, now, options);
  const brief = options.for === undefined ? undefined : await client.brief(options.for, 2048);
  return { lessons: ranked, ...(brief === undefined ? {} : { brief }) };
}

export async function skillPropose(dirArg: string, raw: unknown, ctx: Pick<Ctx, "actor">) {
  const { dir } = openStudy(dirArg); return withLock(dir, () => proposeSkill(dir, raw, ctx.actor));
}
export async function skillDecide(dirArg: string, name: string, decision: string, reason: string, pr: string | undefined, ctx: Pick<Ctx, "actor">, guard?: () => void) {
  const { dir } = openStudy(dirArg); return withLock(dir, () => { guard?.(); return decideSkill(dir, name, decision, reason, pr, ctx.actor); });
}
export const skillList = (dir: string) => listSkills(dir);

export const setup = (target: string, mode: SetupMode, env: NodeJS.ProcessEnv, options: { cwd?: string; root?: string } = {}) => runSetup(target, mode, { ...options, env });

export async function watchSet(dirArg: string, raw: unknown, ctx: Pick<Ctx, "actor">) {
  const { dir } = openStudy(dirArg); return withLock(dir, () => setWatch(dir, raw, ctx.actor));
}
function watchPreflight(dir: string, study: Study): WatchSnapshot {
  const snapshot = readWatchSnapshot(dir), scope = readScope(dir);
  if (!snapshot) throw new Error("watch: no config; run ares watch set <dir> --file PATH before watch run");
  if (!scope) throw new Error("gate scope: no scope yet; run ares scope before watch run");
  requireGate(dir, study, "scope", binder(dir));
  for (const query of snapshot.config.queries) if ((query.yearFrom ?? scope.yearFrom ?? 1000) > (scope.yearTo ?? 2100)) throw new Error(`watch query ${query.id}: yearFrom exceeds scope yearTo; correct that query or the scope before running`);
  return snapshot;
}
function watchRunLocked(dir: string, snapshot: WatchSnapshot, ctx: Ctx) {
  return runWatch(dir, snapshot, ctx.actor, query => {
    // Refresh the held lock between bounded searches, with no recurring timer.
    const time = new Date(); utimesSync(join(dir, ".ares.lock"), time, time);
    return searchLocked(dir, query.query, query, ctx);
  });
}
export async function watchRun(dirArg: string, ctx: Ctx) {
  const { dir, study } = openStudy(dirArg);
  return withLock(dir, () => watchRunLocked(dir, watchPreflight(dir, study), ctx));
}
export interface WatchStarted { started: true; configSha256: string }
/** Acknowledge only validated admission; the finite pass keeps the same lock until its receipt is written. */
export function watchRunDetached(dirArg: string, ctx: Ctx, track?: (completion: Promise<void>, terminate: () => void) => void): Promise<WatchStarted> {
  const { dir, study } = openStudy(dirArg);
  let accept!: (value: WatchStarted) => void, reject!: (cause: unknown) => void, started = false;
  let terminate = () => {};
  const admission = new Promise<WatchStarted>((resolve, refuse) => { accept = resolve; reject = refuse; });
  const completion = withLock(dir, async () => {
    const snapshot = watchPreflight(dir, study);
    let settled = false;
    terminate = () => {
      if (settled) return; settled = true;
      recordWatchFailure(dir, snapshot, ctx.actor, "terminated");
      console.error("ares watch: terminated; inspect ares watch show and lit list before retrying");
    };
    started = true; accept({ started: true, configSha256: snapshot.sha256 });
    try { await watchRunLocked(dir, snapshot, ctx); settled = true; }
    catch (cause) {
      if (settled) return; settled = true;
      const kind = watchFailureClass(cause);
      recordWatchFailure(dir, snapshot, ctx.actor, kind);
      console.error(`ares watch: background pass failed (${kind}); inspect ares watch show and lit list before retrying`);
    }
  }).then(() => {}, cause => {
    if (!started) reject(cause);
    else console.error(`ares watch: failure receipt could not be written (${watchFailureClass(cause)}); restore study storage, inspect ares watch show and lit list, then retry`);
  });
  track?.(completion, () => terminate());
  return admission;
}
export const watchShow = (dir: string) => ({ ...showWatch(dir), newCandidates: list(dir, { status: "new", limit: 500 }) });

function consoleHome(env: NodeJS.ProcessEnv): string {
  return env.AGENTHUB_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".agenthub");
}
export const consoleAdd = (dir: string, env: NodeJS.ProcessEnv) => addStudy(consoleHome(env), dir);
export const consoleRemove = (dir: string, env: NodeJS.ProcessEnv) => removeStudy(consoleHome(env), dir);
export const consoleList = (env: NodeJS.ProcessEnv) => readRegistry(consoleHome(env));

/** Local source-derived reads; comparison adds no verdict, winner or result authority. */
export function lineageShow(dir: string, options: ProvenanceOptions = {}): ProvenancePage {
  return readProvenance(dir, options);
}
export function lineageCompare(dir: string, options: Parameters<typeof compareLineage>[1] = {}): LineageComparison {
  return compareLineage(dir, options);
}
