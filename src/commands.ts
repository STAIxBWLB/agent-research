import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Http } from "./http.ts";
import { readScope, scopeHash, setScope } from "./scope.ts";
import { appendEvent, boundedText, decideGate, gateState, GATES, initStudy, openStudy, readBytesBounded, readLedger, readTextBounded, requireGate, sha256, withLock, writeAtomic, type Actor, type Binder, type GateName } from "./study.ts";
import { includedHash, isVerified, loadCandidates, mergeCandidates, sameWork, saveCandidates, verifySubject, type Candidate } from "./lit/candidates.ts";
import { searchSource, SOURCES, type SourceName } from "./lit/sources.ts";
import { verifyCandidates } from "./lit/verify.ts";
import { assignCitekeys, renderBib } from "./lit/bibtex.ts";
import { checkCitations } from "./lit/cite.ts";
import { cardPath, validateCard } from "./lit/cards.ts";

export interface Ctx { actor: Actor; http: Http; sleep?: (ms: number) => Promise<void> }
const MAX_IDS = 200, DRAFT_BYTES = 2 * 1024 * 1024, BIB_BYTES = 16 * 1024 * 1024, CARD_BYTES = 65_536;

export function binder(dir: string): Binder {
  return gate => (gate === "scope" ? scopeHash(dir) : includedHash(loadCandidates(dir)));
}
function gateName(value: string): GateName {
  if (!GATES.includes(value as GateName)) throw new Error(`unknown gate: ${value} (scope or screen)`);
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

export function status(dirArg: string) {
  const { dir, study } = openStudy(dirArg), events = readLedger(dir), list = loadCandidates(dir), bind = binder(dir);
  const cardsDir = join(dir, "literature", "cards"), bibPath = join(dir, "refs", "references.bib");
  const count = (s: Candidate["status"]) => list.filter(c => c.status === s).length;
  const included = list.filter(c => c.status === "included");
  return {
    study: dir, question: study.question, mode: study.mode, autonomy: study.autonomy,
    scope: { set: scopeHash(dir) !== undefined },
    gates: GATES.map(g => gateState(g, events, bind)),
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
  const { dir } = openStudy(dirArg), events = readLedger(dir), bind = binder(dir);
  return GATES.map(g => gateState(g, events, bind));
}

export async function gateDecide(dirArg: string, gate: string, decision: "approve" | "reject", reason: string | undefined, ctx: Ctx) {
  const { dir } = openStudy(dirArg), name = gateName(gate), why = reason === undefined ? undefined : boundedText(reason, "--reason", 500);
  return withLock(dir, () => decideGate(dir, name, decision, ctx.actor, binder(dir), why));
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
    const approve = requireGate(dir, study, "scope", binder(dir));
    const names = source === "all" ? SOURCES : [source as SourceName];
    const results = [];
    for (const name of names) results.push(await searchSource(ctx.http, name, q, { limit, ...(yearFrom !== undefined ? { yearFrom } : {}), ...(sc.yearTo !== undefined ? { yearTo: sc.yearTo } : {}) }));
    const list = loadCandidates(dir), counts = mergeCandidates(list, results.flatMap(r => r.records), sc.maxCandidates);
    saveCandidates(dir, list);
    const sources = results.map(r => ({ source: r.source, ok: r.ok, returned: r.records.length, ...(r.error ? { error: r.error } : {}) }));
    approve();
    appendEvent(dir, ctx.actor, "lit.search", { query: q, sources, ...counts });
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
    const approve = requireGate(dir, study, "scope", binder(dir));
    for (const id of wanted) {
      const c = find(all, id);
      c.status = status; c.decidedBy = ctx.actor; c.decidedAt = at;
      if (why) c.reason = why; else delete c.reason;
    }
    saveCandidates(dir, all);
    approve();
    appendEvent(dir, ctx.actor, "lit.screen", { ids: wanted, decision, ...(why ? { reason: why } : {}) });
    return { decision, ids: wanted, gate: gateState("screen", readLedger(dir), binder(dir)) };
  });
}

export async function card(dirArg: string, id: string, raw: unknown, ctx: Ctx) {
  const { dir, study } = openStudy(dirArg), value = validateCard(raw);
  return withLock(dir, () => {
    const c = find(loadCandidates(dir), id);
    if (c.status !== "included") throw new Error(`${id}: cards are recorded for included candidates only`);
    const approve = requireGate(dir, study, "scope", binder(dir));
    const path = cardPath(dir, id), text = JSON.stringify({ id, ...value }, null, 2) + "\n";
    writeAtomic(path, text, CARD_BYTES);
    approve();
    appendEvent(dir, ctx.actor, "lit.card", { id, sha256: sha256(text) });
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
    const approve = requireGate(dir, study, "scope", binder(dir));
    const batch = pending.slice(0, MAX_IDS);
    const results = await verifyCandidates(ctx.http, batch, ctx.sleep ? { sleep: ctx.sleep } : {});
    for (const c of batch) { const v = results.get(c.id); if (v) c.verify = v; }
    saveCandidates(dir, all);
    const tally = { checked: batch.length, verified: batch.filter(isVerified).length, notFound: batch.filter(c => c.verify?.exists === "no").length,
      unknown: batch.filter(c => c.verify?.exists === "unknown").length, mismatched: batch.filter(c => c.verify?.exists === "yes" && c.verify.match !== "yes").length,
      noIdentifier: batch.filter(c => c.verify?.syntax !== "ok").length, remaining: pending.length - batch.length,
      final: wanted ? 0 : all.filter(c => c.status === "included" && !isVerified(c) && !open(c)).length };
    approve();
    appendEvent(dir, ctx.actor, "lit.verify", tally);
    return { ...tally, results: batch.map(c => ({ id: c.id, ...c.verify })) };
  });
}

export async function bib(dirArg: string, ctx: Ctx) {
  const { dir, study } = openStudy(dirArg);
  return withLock(dir, () => {
    const approve = requireGate(dir, study, "screen", binder(dir));
    const all = loadCandidates(dir), eligible = all.filter(c => c.status === "included" && isVerified(c));
    const twins = sameWork(all).map(g => g.filter(id => all.find(c => c.id === id)!.status === "included")).filter(g => g.length > 1);
    if (twins.length) throw new Error(`included candidates that are the same work: ${twins.map(g => g.join(" = ")).join("; ")}; exclude all but one of each`);
    const assigned = assignCitekeys(all, eligible);
    if (assigned) saveCandidates(dir, all);
    const { text, entries } = renderBib(all), path = join(dir, "refs", "references.bib"), hash = sha256(text);
    writeAtomic(path, text, BIB_BYTES);
    approve();
    appendEvent(dir, ctx.actor, "lit.bib", { entries, sha256: hash });
    const left = all.filter(c => c.status === "included" && !isVerified(c)).map(c => ({ id: c.id, verify: c.verify ? `${c.verify.syntax}/${c.verify.exists}/${c.verify.match}` : "not checked" }));
    return { path, entries, sha256: hash, newKeys: assigned, notInBib: left };
  });
}

export function cite(dirArg: string, draft: string) {
  const { dir } = openStudy(dirArg), path = resolve(draft);
  return { draft: path, ...checkCitations(readTextBounded(path, DRAFT_BYTES), loadCandidates(dir)) };
}
