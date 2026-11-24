import { boundedText, commit, onlyKeys, openStudy, plain, readLedger, readTextBounded, requireExperiment, sha256, type Actor, type LedgerEvent } from "../study.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listAttempts } from "./attempts.ts";
import { readProtocol } from "./protocol.ts";
import { readSelection } from "./selection.ts";

export const MAX_IDEAS = 1000, MAX_DECISION_ATTEMPTS = 200;
export const MAX_PREDICTIONS = 4, MAX_BUNDLE = 16, MAX_CATEGORIES = 32, CATEGORIES_BYTES = 8192;
export type Expectation = "improve" | "no-change" | "regress";
export interface Prediction { metric: string; expect: Expectation; minDelta?: number }
export interface IdeaPlanning { category?: string; bundle?: number; predicts?: Prediction[] }
export interface IdeaInput extends IdeaPlanning { id: string; title: string; hypothesis: string; parent?: string; commit?: string }
export interface IdeaDecision { decision: "refine" | "pivot"; reason: string; attempts: string[]; commit?: string; cause?: string; retryWhen?: string }
export interface Idea extends IdeaPlanning { id: string; title: string; hypothesis: string; parent?: string; commits: string[]; state: "open" | "pivoted"; decisions: IdeaDecision[] }
const recovery = "; correct the idea input and retry ares idea add or ares idea decide";
function bad(reason: string): never { throw new Error(`idea: ${reason}${recovery}`); }
function name(raw: unknown, field: string): string {
  if (typeof raw !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw)) bad(`${field}: use 1..64 letters, digits, underscores or hyphens, starting with a letter or digit`);
  return raw;
}
function commitId(raw: unknown): string {
  if (typeof raw !== "string" || !/^[a-fA-F0-9]{40}$/.test(raw)) bad("commit: full 40-hex SHA required");
  return raw.toLowerCase();
}
function prediction(raw: unknown, strict: boolean): Prediction {
  if (!plain(raw)) bad("predicts: objects with metric and expect required");
  if (strict) onlyKeys(raw, ["metric", "expect", "minDelta"], "idea prediction");
  const metric = boundedText(raw.metric, "idea prediction metric", 128);
  if (raw.expect !== "improve" && raw.expect !== "no-change" && raw.expect !== "regress") bad("predicts.expect: use improve, no-change or regress");
  if (raw.minDelta !== undefined && (typeof raw.minDelta !== "number" || !Number.isFinite(raw.minDelta) || raw.minDelta < 0)) bad("predicts.minDelta: finite number >= 0 required in the metric's unit");
  return { metric, expect: raw.expect, ...(raw.minDelta !== undefined ? { minDelta: raw.minDelta as number } : {}) };
}
/** Optional planning fields; absent fields are omitted so older ideas fold to identical objects. */
function planning(raw: Record<string, unknown>, strict: boolean): IdeaPlanning {
  const out: IdeaPlanning = {};
  if (raw.category !== undefined) out.category = name(raw.category, "category");
  if (raw.bundle !== undefined) {
    if (!Number.isSafeInteger(raw.bundle) || (raw.bundle as number) < 1 || (raw.bundle as number) > MAX_BUNDLE) bad(`bundle: integer in 1..${MAX_BUNDLE} required (independent changes in the commit)`);
    out.bundle = raw.bundle as number;
  }
  if (raw.predicts !== undefined) {
    if (!Array.isArray(raw.predicts) || !raw.predicts.length || raw.predicts.length > MAX_PREDICTIONS) bad(`predicts: 1..${MAX_PREDICTIONS} predictions required`);
    const predicts = raw.predicts.map(p => prediction(p, strict));
    if (new Set(predicts.map(p => p.metric)).size !== predicts.length) bad("predicts: one prediction per metric");
    out.predicts = predicts;
  }
  return out;
}
function validateIdea(raw: unknown, strict: boolean): IdeaInput {
  if (!plain(raw)) bad("JSON object required");
  if (strict) onlyKeys(raw, ["id", "title", "hypothesis", "parent", "commit", "category", "bundle", "predicts"], "idea");
  return { id: name(raw.id, "id"), title: boundedText(raw.title, "idea.title", 500), hypothesis: boundedText(raw.hypothesis, "idea.hypothesis", 4000),
    ...(raw.parent !== undefined ? { parent: name(raw.parent, "parent") } : {}), ...(raw.commit !== undefined ? { commit: commitId(raw.commit) } : {}), ...planning(raw, strict) };
}
export function categoriesPath(dir: string): string { return join(dir, "design", "idea-categories.json"); }
function validateCategories(raw: unknown): { v: 1; categories: string[] } {
  if (!plain(raw)) bad("categories: JSON object {v:1,categories:[...]} required");
  onlyKeys(raw, ["v", "categories"], "idea categories");
  if (raw.v !== 1) bad("categories.v: 1 required");
  if (!Array.isArray(raw.categories) || !raw.categories.length || raw.categories.length > MAX_CATEGORIES) bad(`categories: 1..${MAX_CATEGORIES} names required`);
  const categories = raw.categories.map(c => name(c, "category"));
  if (new Set(categories).size !== categories.length) bad("categories: duplicate name; list each category once");
  return { v: 1, categories };
}
/** The study-local vocabulary, or undefined when none is declared. It is a planning aid outside the design seal. */
export function readCategories(dir: string): string[] | undefined {
  const file = categoriesPath(dir);
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readTextBounded(file, CATEGORIES_BYTES); }
  catch { bad(`design/idea-categories.json: unreadable, non-regular, invalid UTF-8 or larger than ${CATEGORIES_BYTES} bytes; restore a valid file within that bound`); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { bad("design/idea-categories.json: invalid JSON; restore the last valid vocabulary"); }
  return validateCategories(raw).categories;
}
/** Caller holds the study lock; identical bytes record nothing. */
export function setCategories(dir: string, raw: unknown, actor: Actor): { categories: string[]; sha256: string; changed: boolean } {
  return safe(() => {
    requireExperiment(openStudy(dir).study);
    const value = validateCategories(raw), text = JSON.stringify(value, null, 2) + "\n", hash = sha256(text), file = categoriesPath(dir);
    let previous: string | undefined;
    // A valid new vocabulary may replace an unreadable or invalid one.
    if (existsSync(file)) { try { previous = readTextBounded(file, CATEGORIES_BYTES); } catch { previous = undefined; } }
    const changed = previous !== text;
    if (changed) commit(dir, [[file, text, CATEGORIES_BYTES]], [{ actor, type: "idea.categories.set", data: { sha256: hash, count: value.categories.length } }]);
    return { categories: value.categories, sha256: hash, changed };
  });
}
function checkPlanning(dir: string, input: IdeaInput): void {
  if (input.category !== undefined) {
    const declared = readCategories(dir);
    if (declared && !declared.includes(input.category)) bad(`category ${input.category} is not declared; use one of ${declared.join(", ")}`);
  }
  if (input.predicts) {
    const protocol = readProtocol(dir);
    if (!protocol) bad("predicts: protocol missing; run ares protocol before predicting metrics, or omit predicts");
    const names = protocol.metrics.map(m => m.name);
    for (const p of input.predicts) if (!names.includes(p.metric)) bad(`predicts.metric ${p.metric} is not declared; use one of ${names.join(", ")}`);
    // Only the primary metric has a selection margin; elsewhere no-change needs its own tolerance or it can never hit.
    const primary = readSelection(dir, protocol)?.metric;
    for (const p of input.predicts) if (p.expect === "no-change" && p.minDelta === undefined && p.metric !== primary) bad(`predicts ${p.metric}: no-change on a non-primary metric needs minDelta; add minDelta in that metric's unit`);
  }
}
function pivotContext(raw: Record<string, unknown>, strict: boolean): Pick<IdeaDecision, "cause" | "retryWhen"> {
  if (strict && raw.decision !== "pivot" && (raw.cause !== undefined || raw.retryWhen !== undefined)) bad("cause and retryWhen are pivot-only; omit --cause and --retry-when for refine");
  const extra: { cause?: string; retryWhen?: string } = {};
  for (const field of ["cause", "retryWhen"] as const) if (raw[field] !== undefined && raw.decision === "pivot") {
    const value = boundedText(raw[field], `idea ${field}`, 2000);
    if (Buffer.byteLength(value) > 2000) bad(`${field}: at most 2000 bytes required`);
    extra[field] = value;
  }
  return extra;
}
function validateDecision(raw: unknown, strict: boolean): IdeaDecision {
  if (!plain(raw)) bad("decision object required");
  if (strict) onlyKeys(raw, ["decision", "reason", "attempts", "commit", "cause", "retryWhen"], "idea decision");
  if (raw.decision !== "refine" && raw.decision !== "pivot") bad("decision: use refine or pivot");
  // Reject new pivot commit options; keep older ledger entries readable on replay.
  if (strict && raw.decision === "pivot" && raw.commit !== undefined) bad("pivot does not take --commit; omit --commit, or use refine to attach a commit");
  const extra = pivotContext(raw, strict);
  const reason = boundedText(raw.reason, "idea reason", 2000);
  if (Buffer.byteLength(reason) > 2000) bad("reason: at most 2000 bytes required");
  if (raw.attempts !== undefined && (!Array.isArray(raw.attempts) || raw.attempts.length > MAX_DECISION_ATTEMPTS || raw.attempts.some(a => typeof a !== "string" || !/^[a-f0-9]{16}$/.test(a)))) bad(`attempts: name at most ${MAX_DECISION_ATTEMPTS} 16-hex attempt ids from ares attempt list`);
  if (raw.decision === "refine" && raw.commit === undefined) bad("refine requires --commit with a full frozen SHA");
  return { decision: raw.decision, reason, ...extra, attempts: [...new Set((raw.attempts as string[] | undefined) ?? [])], ...(raw.commit !== undefined ? { commit: commitId(raw.commit) } : {}) };
}
function claim(ideas: Iterable<Idea>, id: string, frozen?: string): void {
  if (!frozen) return;
  for (const other of ideas) if (other.id !== id && other.commits.includes(frozen)) bad(`commit already belongs to idea ${other.id}; choose another commit or refine that idea`);
}
function evidenceRequired(target: Idea, input: IdeaDecision): void {
  if (target.commits.length && !input.attempts.length) bad(`idea ${target.id} has commits; pass --attempts with terminal evidence from those commits`);
  if (!target.commits.length && input.attempts.length) bad(`idea ${target.id} has no commit; omit --attempts when attaching its first commit or dropping it before testing`);
}
function safe<T>(fn: () => T): T {
  try { return fn(); } catch (error) { const message = error instanceof Error ? error.message : "idea: invalid input"; throw new Error(message.includes(recovery) ? message : message + recovery); }
}
/** Replay the journal only; unknown event kinds and additive event fields are preserved in the ledger. */
export function foldIdeas(events: LedgerEvent[]): Idea[] {
  return safe(() => {
    const ideas = new Map<string, Idea>();
    for (const event of events) {
      if (event.type === "idea.added") {
        const input = validateIdea(event.data.idea, false);
        if (ideas.has(input.id)) bad(`duplicate id ${input.id}; choose a new idea id`);
        if (ideas.size >= MAX_IDEAS) bad(`limit ${MAX_IDEAS} reached; start a new study for more ideas`);
        if (input.parent !== undefined && !ideas.has(input.parent)) bad(`parent ${input.parent} does not exist; add its parent idea first`);
        claim(ideas.values(), input.id, input.commit);
        const { category, bundle, predicts } = input;
        ideas.set(input.id, { id: input.id, title: input.title, hypothesis: input.hypothesis, ...(input.parent !== undefined ? { parent: input.parent } : {}), commits: input.commit ? [input.commit] : [], state: "open", decisions: [],
          ...(category !== undefined ? { category } : {}), ...(bundle !== undefined ? { bundle } : {}), ...(predicts !== undefined ? { predicts } : {}) });
      } else if (event.type === "idea.decided") {
        const id = name(event.data.id, "id"), input = validateDecision(event.data, false), target = ideas.get(id);
        if (!target) bad(`unknown id ${id}; add the idea before deciding`);
        if (target.state === "pivoted") bad(`idea ${id} is pivoted; add a new child idea instead of deciding it again`);
        evidenceRequired(target, input);
        if (input.decision === "refine") claim(ideas.values(), id, input.commit);
        if (input.decision === "refine" && !target.commits.includes(input.commit!)) target.commits.push(input.commit!);
        if (input.decision === "pivot") target.state = "pivoted";
        target.decisions.push(input);
      }
    }
    return [...ideas.values()];
  });
}
/** Caller holds the study lock; the journal is the only write. */
export function addIdea(dir: string, raw: unknown, actor: Actor): Idea {
  return safe(() => {
    requireExperiment(openStudy(dir).study);
    const input = validateIdea(raw, true), events = readLedger(dir), ideas = foldIdeas(events);
    if (ideas.some(i => i.id === input.id)) bad(`duplicate id ${input.id}; choose a new idea id`);
    if (ideas.length >= MAX_IDEAS) bad(`limit ${MAX_IDEAS} reached; start a new study for more ideas`);
    if (input.parent !== undefined && !ideas.some(i => i.id === input.parent)) bad(`parent ${input.parent} does not exist; add its parent idea first`);
    claim(ideas, input.id, input.commit);
    checkPlanning(dir, input);
    const added = commit(dir, [], [{ actor, type: "idea.added", data: { idea: input } }]);
    return foldIdeas([...events, ...added]).find(i => i.id === input.id)!;
  });
}
/** Validate all evidence before committing the decision; a failed decision never changes the journal. */
export function decideIdea(dir: string, idArg: string, raw: unknown, actor: Actor): Idea {
  return safe(() => {
    const { study } = openStudy(dir); requireExperiment(study);
    const id = name(idArg, "id"), input = validateDecision(raw, true), events = readLedger(dir), ideas = foldIdeas(events), target = ideas.find(i => i.id === id);
    if (!target) bad(`unknown id ${id}; add the idea before deciding`);
    if (target.state === "pivoted") bad(`idea ${id} is pivoted; add a new child idea instead of deciding it again`);
    evidenceRequired(target, input);
    if (input.decision === "refine") claim(ideas, id, input.commit);
    const attempts = new Map((input.attempts.length ? listAttempts(dir).attempts : []).map(a => [a.id, a]));
    for (const wanted of input.attempts) {
      const attempt = attempts.get(wanted);
      if (!attempt) bad(`attempt ${wanted} does not exist; choose an id from ares attempt list`);
      if (attempt.studyId !== study.id) bad(`attempt ${wanted} belongs to another study; choose this study's attempt`);
      if (attempt.status === "running") bad(`attempt ${wanted} is running; run ares attempt reconcile before deciding`);
      if (!target.commits.includes(attempt.commit)) bad(`attempt ${wanted} belongs to a foreign commit; cite only this idea's existing commits`);
    }
    const added = commit(dir, [], [{ actor, type: "idea.decided", data: { id, ...input } }]);
    return foldIdeas([...events, ...added]).find(i => i.id === id)!;
  });
}
