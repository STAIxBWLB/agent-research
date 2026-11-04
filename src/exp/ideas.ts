import { boundedText, commit, onlyKeys, openStudy, plain, readLedger, requireExperiment, type Actor, type LedgerEvent } from "../study.ts";
import { listAttempts } from "./attempts.ts";

export const MAX_IDEAS = 1000, MAX_DECISION_ATTEMPTS = 200;
export interface IdeaInput { id: string; title: string; hypothesis: string; parent?: string; commit?: string }
export interface IdeaDecision { decision: "refine" | "pivot"; reason: string; attempts: string[]; commit?: string; cause?: string; retryWhen?: string }
export interface Idea { id: string; title: string; hypothesis: string; parent?: string; commits: string[]; state: "open" | "pivoted"; decisions: IdeaDecision[] }
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
function validateIdea(raw: unknown, strict: boolean): IdeaInput {
  if (!plain(raw)) bad("JSON object required");
  if (strict) onlyKeys(raw, ["id", "title", "hypothesis", "parent", "commit"], "idea");
  return { id: name(raw.id, "id"), title: boundedText(raw.title, "idea.title", 500), hypothesis: boundedText(raw.hypothesis, "idea.hypothesis", 4000),
    ...(raw.parent !== undefined ? { parent: name(raw.parent, "parent") } : {}), ...(raw.commit !== undefined ? { commit: commitId(raw.commit) } : {}) };
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
        ideas.set(input.id, { id: input.id, title: input.title, hypothesis: input.hypothesis, ...(input.parent !== undefined ? { parent: input.parent } : {}), commits: input.commit ? [input.commit] : [], state: "open", decisions: [] });
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
