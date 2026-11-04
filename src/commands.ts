import { addAblation, showAblate, closeAblate } from "./exp/ablate.ts";
import { setFinalSeeds } from "./exp/final.ts";
import { addIdea, decideIdea } from "./exp/ideas.ts";
import { showInvestigation, closeInvestigation } from "./exp/investigate.ts";
import { setSelection } from "./exp/selection.ts";
import { createHubClient } from "./plan/hub.ts";
import { runPlan, type ControllerRuntime, type Observation, type StepNode } from "./plan/controller.ts";
import { resolveSnapshot } from "./exp/snapshot.ts";
import { spawnRunner } from "./exp/executor.ts";
import { foldPlan, readPlanState, planGateBinding, prepareControl, type ControlRequest, type ControlResult } from "./plan/state.ts";
import { setPlan } from "./plan/definition.ts";
export { manifest } from "./manifest.ts";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Http } from "./http.ts";
import { readScope, scopeHash, setScope } from "./scope.ts";
import { boundedText, commit, decideGate, gateState, GATES, initStudy, openStudy, readBytesBounded, readLedger, readTextBounded, requireGate, sha256, withLock, readPlanOwner, type Actor, type Binder, type GateName } from "./study.ts";
import { candidatesFile, includedHash, isVerified, loadCandidates, mergeCandidates, sameWork, verifySubject, type Candidate } from "./lit/candidates.ts";
import { searchSource, SOURCES, type SourceName } from "./lit/sources.ts";
import { verifyCandidates } from "./lit/verify.ts";
import { assignCitekeys, renderBib } from "./lit/bibtex.ts";
import { checkCitations } from "./lit/cite.ts";
import { cardPath, validateCard } from "./lit/cards.ts";
import { designBinding, protocolHash, readDesign, setProtocol } from "./exp/protocol.ts";
import { requireExperiment } from "./study.ts";
import { checkExecutor, setExecutor } from "./exp/executor.ts";
import { cancelAttempt, listAttempts, listAttemptSummaries, reconcileAttempts, runAttempt, showAttempt, type AttemptContext, type AttemptListOptions, type AttemptOptions } from "./exp/attempts.ts";
import { readAttemptLogs, type LogOptions } from "./exp/logs.ts";

export type ExperimentRuntime = Omit<AttemptContext, "actor">;
export interface Ctx extends ExperimentRuntime { actor: Actor; http: Http; signal?: AbortSignal }
const MAX_IDS = 200, DRAFT_BYTES = 2 * 1024 * 1024, BIB_BYTES = 16 * 1024 * 1024, CARD_BYTES = 65_536;

export function binder(dir: string): Binder {
  return gate => gate.startsWith("plan:") ? planGateBinding(readPlanState(dir, readLedger(dir)), gate) : gate === "scope" ? scopeHash(dir) : gate === "design" ? designBinding(dir) : includedHash(loadCandidates(dir));
}
function gateName(value: string): GateName {
  if (!GATES.includes(value as GateName) && !value.startsWith("plan:")) throw new Error(`unknown gate: ${value} (${GATES.join(", ")})`);
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
export const executorCheck = (dir: string, ctx: Ctx) => checkExecutor(dir, ctx.runner);
export const attemptRun = (dir: string, options: AttemptOptions, ctx: Ctx) => runAttempt(dir, options, ctx);
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
    gates: GATES.filter(g => g !== "design" || study.mode === "experiment").map(g => gateState(g, events, bind)),
    literature: {
      candidates: list.length, new: count("new"), included: included.length, excluded: count("excluded"),
      verified: included.filter(isVerified).length, unverified: included.filter(c => !isVerified(c)).length,
      cards: existsSync(cardsDir) ? readdirSync(cardsDir).filter(f => f.endsWith(".json")).length : 0,
    },
    bib: existsSync(bibPath) ? { path: bibPath, sha256: sha256(readBytesBounded(bibPath, BIB_BYTES)) } : null,
    events: events.length,
  };
}

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
  const gates: GateName[] = [...GATES.filter(g => g !== "design" || study.mode === "experiment"), ...(plan?.nodes.filter(n => n.kind === "gate").map(n => `plan:${n.id}` as GateName) ?? [])];
  return gates.map(g => gateState(g, events, bind));
}

export async function gateDecide(dirArg: string, gate: string, decision: "approve" | "reject", reason: string | undefined, ctx: Ctx) {
  const { dir, study } = openStudy(dirArg), name = gateName(gate), why = reason === undefined ? undefined : boundedText(reason, "--reason", 500);
  if (name === "design") requireExperiment(study);
  return withLock(dir, () => {
    if (name.startsWith("plan:") && !readPlanState(dir, readLedger(dir)).definition.nodes.some(n => n.id === name.slice(5) && n.kind === "gate")) throw new Error(`gate ${name}: no gate node ${name.slice(5)} in the plan; run ares gate list and select an existing gate`);
    return decideGate(dir, name, decision, ctx.actor, binder(dir), why);
  });
}

export async function search(dirArg: string, query: string, options: { source?: string; limit?: number; yearFrom?: number }, ctx: Ctx) {
  const { dir, study } = openStudy(dirArg), q = boundedText(query, "query", 500);
  const source = options.source ?? "all";
  if (source !== "all" && !SOURCES.includes(source as SourceName)) throw new Error("--source: openalex, s2, arxiv or all");
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit: 1..50");
  if (options.yearFrom !== undefined && (!Number.isSafeInteger(options.yearFrom) || options.yearFrom < 1000 || options.yearFrom > 2100)) throw new Error("--year-from: year 1000..2100");
  return withLock(dir, async () => {
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
  });
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

export async function screen(dirArg: string, values: string[], decision: "include" | "exclude", reason: string | undefined, ctx: Ctx) {
  const { dir, study } = openStudy(dirArg), wanted = ids(values), why = reason === undefined ? undefined : boundedText(reason, "--reason", 500);
  return withLock(dir, () => {
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
    const prepared = prepareControl(state, events, request, ctx.actor);
    if (!prepared.event) return { result: prepared.result };
    const node = state.nodes.find(n => n.id === request.node);
    const attempt = node?.attemptId ? listAttempts(dir).attempts.find(a => a.id === node.attemptId) : undefined;
    if (request.action === "cancel" && attempt) return { attemptId: attempt.id };
    // A missing record after a crash is uncertain, and explicit retry/cancel may release it.
    if ((request.action === "retry" || request.action === "skip") && attempt?.status === "running") throw new Error(`plan node ${node!.id}: attempt is still running; cancel it or run ares attempt reconcile before retry`);
    commit(dir, [], [prepared.event]);
    return { result: prepared.result };
  });
  if (prepared.result) return prepared.result;
  let result: ControlResult | undefined;
  await cancelAttempt(dir, prepared.attemptId!, "plan cancellation", ctx, () => {
    const events = readLedger(dir), state = readPlanState(dir, events);
    const prepared = prepareControl(state, events, request, ctx.actor);
    result = prepared.result;
    return prepared.event ? [prepared.event] : [];
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
      const design = readDesign(dir);
      if (!design) throw new Error("plan attempt: protocol missing; run ares protocol before resume");
      const options = attemptOptions(node, state.retryOf), snapshot = await resolveSnapshot(options.repo, options.commit, ctx.runner ?? spawnRunner);
      const { attemptId } = await import("./exp/attempts.ts");
      return { attemptId: attemptId(protocolHash(design.protocol), snapshot.commit, snapshot.treeId, options.seed ?? design.protocol.seeds[0]!, options.run ?? "main", options.retry) };
    },
    execute: async (node, state) => {
      if (node.command === "attempt.run") return observed(await runAttempt(dir, { ...attemptOptions(node, state.retryOf), expectedId: state.attemptId! }, ctx));
      let result: unknown, ok = true;
      switch (node.command) {
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
