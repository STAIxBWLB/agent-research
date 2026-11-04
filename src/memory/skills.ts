import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, boundedText, commit, onlyKeys, openStudy, plain, readLedger, readTextBounded, sha256, type Actor, type LedgerEvent } from "../study.ts";

export const SKILL_PROPOSAL_VERSION = 1, SKILL_PROPOSALS = 100, SKILL_BYTES = 16 * 1024;
export interface SkillProposal { name: string; summary: string; steps: string[]; evidence: string[] }
export type SkillDecision = "accept" | "reject" | "withdraw";
export interface SkillRecord extends SkillProposal {
  skillProposal: 1; state: "proposed" | "accepted" | "rejected" | "withdrawn"; sha256: string; actor: Actor; at: string;
  decision?: { action: SkillDecision; reason: string; pr?: string; actor: Actor; at: string };
}
function bad(message: string): never { throw new Error(`skill: ${message}; inspect ares skill list, correct the input or restore the last valid proposal and retry`); }
function nameOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) bad("name must follow the run-name rule (1..64 letters, digits, underscores or hyphens)");
  return value;
}
function text(value: unknown, field: string): string {
  let result: string;
  try { result = boundedText(value, `skill ${field}`, SKILL_BYTES); } catch { bad(`${field} must be nonblank text within 16 KiB`); }
  if (result.includes("\0") || Buffer.byteLength(result) > SKILL_BYTES) bad(`${field} contains NUL or exceeds 16 KiB`);
  return result;
}
function markdown(proposal: SkillProposal): string {
  const list = (values: string[]) => values.map(value => `- ${value.replaceAll("\n", "\n  ")}`).join("\n");
  return `---\nskillProposal: 1\nname: ${proposal.name}\n---\n\n# ${proposal.name}\n\n${proposal.summary}\n\n## Steps\n\n${list(proposal.steps)}\n\n## Evidence\n\n${list(proposal.evidence)}\n`;
}
/** Strict for new input, additive-field tolerant when replaying existing v1 records. */
export function validateSkillProposal(raw: unknown, strict = true): SkillProposal {
  if (!plain(raw)) bad("proposal object required");
  if (strict) { try { onlyKeys(raw, ["name", "summary", "steps", "evidence"], "skill proposal"); } catch { bad("unknown proposal field; use only name, summary, steps and evidence"); } }
  if (!Array.isArray(raw.steps) || !raw.steps.length || !Array.isArray(raw.evidence)) bad("steps must be a nonempty array and evidence an array");
  if (raw.steps.length > SKILL_BYTES || raw.evidence.length > SKILL_BYTES) bad("proposal arrays exceed the 16 KiB format ceiling; shorten steps or evidence");
  const proposal: SkillProposal = { name: nameOf(raw.name), summary: text(raw.summary, "summary"), steps: raw.steps.map(value => text(value, "step")), evidence: raw.evidence.map(value => text(value, "evidence")) };
  if (proposal.evidence.some(value => !/^(?:mem:)?[a-f0-9]{32}$/.test(value) && !/^ares:[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value))) bad("evidence must contain amem ids or nonempty ares: refs");
  try { assertWritable(markdown(proposal), SKILL_BYTES, "skill proposal"); } catch { bad("proposal Markdown exceeds 16 KiB; shorten summary, steps or evidence"); }
  return proposal;
}
function decisionOf(value: unknown): SkillDecision {
  if (value !== "accept" && value !== "reject" && value !== "withdraw") bad("decision must be accept, reject or withdraw");
  return value;
}
function prOf(value: unknown, action: SkillDecision): string | undefined {
  if (value === undefined) { if (action === "accept") bad("accept requires --pr URL for the reviewed PR"); return undefined; }
  const result = text(value, "PR URL");
  try { const url = new URL(result); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) bad("PR must be an HTTP(S) URL without credentials"); }
  catch { bad("PR must be an HTTP(S) URL without credentials"); }
  return result;
}
function version(event: LedgerEvent): void {
  if (event.data.skillProposal !== 1) throw new Error("skill proposal: unsupported version; use an ares version supporting this journal and keep its files unchanged");
}
export function foldSkills(events: LedgerEvent[]): SkillRecord[] {
  const rows = new Map<string, SkillRecord>();
  for (const event of events) {
    if (event.type === "skill.proposed") {
      version(event); const proposal = validateSkillProposal(event.data.proposal, false), hash = sha256(markdown(proposal));
      if (event.data.sha256 !== hash || rows.has(proposal.name) || rows.size >= SKILL_PROPOSALS) bad("journal has a mismatched hash, duplicate name or more than 100 proposals");
      rows.set(proposal.name, { ...proposal, skillProposal: 1, state: "proposed", sha256: hash, actor: event.actor, at: event.at });
    } else if (event.type === "skill.decided") {
      version(event); const name = nameOf(event.data.name), row = rows.get(name), action = decisionOf(event.data.decision);
      if (!row || row.state !== "proposed") bad("decision references a missing or already decided proposal");
      const reason = text(event.data.reason, "reason"), pr = prOf(event.data.pr, action);
      row.state = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "withdrawn";
      row.decision = { action, reason, ...(pr === undefined ? {} : { pr }), actor: event.actor, at: event.at };
    }
  }
  return [...rows.values()];
}
function file(dir: string, name: string): string { return join(dir, "proposals", "skills", `${name}.md`); }
/** Read only tracked proposals; every file is regular/bounded and bound to its original event. */
function readSkills(dirArg: string) {
  const { dir } = openStudy(dirArg), events = readLedger(dir), rows = foldSkills(events);
  for (const row of rows) {
    let content: string;
    try { content = readTextBounded(file(dir, row.name), SKILL_BYTES); } catch { bad("proposal file missing, unreadable or larger than 16 KiB; restore its committed Markdown"); }
    if (!content.startsWith("---\nskillProposal: 1\n")) throw new Error("skill proposal file: unsupported version; use an ares version supporting this file and keep it unchanged");
    if (sha256(content) !== row.sha256) bad("proposal file differs from its receipt; restore the original Markdown");
  }
  return { dir, events, rows };
}
export function listSkills(dir: string): SkillRecord[] { return readSkills(dir).rows; }
/** Caller holds the study lock. One bounded file and one event share the existing commit preflight. */
export function proposeSkill(dirArg: string, raw: unknown, actor: Actor): SkillRecord {
  const proposal = validateSkillProposal(raw), { dir, events, rows } = readSkills(dirArg);
  if (rows.length >= SKILL_PROPOSALS) bad("100-proposal limit reached; start a new study for further proposals");
  if (rows.some(row => row.name === proposal.name) || existsSync(file(dir, proposal.name))) bad("name or proposal file already exists; choose a new name without replacing prior work");
  const content = markdown(proposal), hash = sha256(content);
  const added = commit(dir, [[file(dir, proposal.name), content, SKILL_BYTES]], [{ actor, type: "skill.proposed", data: { skillProposal: 1, proposal, sha256: hash } }]);
  return foldSkills([...events, ...added]).find(row => row.name === proposal.name)!;
}
/** Final actor-recorded decisions never open, inspect or merge a PR. */
export function decideSkill(dirArg: string, name: string, decision: string, reason: string, pr: string | undefined, actor: Actor): SkillRecord {
  const target = nameOf(name), action = decisionOf(decision), why = text(reason, "reason"), reference = prOf(pr, action), { dir, events, rows } = readSkills(dirArg);
  const row = rows.find(row => row.name === target);
  if (!row || row.state !== "proposed") bad("proposal is missing or already decided; decisions including withdrawal are final");
  const added = commit(dir, [], [{ actor, type: "skill.decided", data: { skillProposal: 1, name: target, decision: action, reason: why, ...(reference === undefined ? {} : { pr: reference }) } }]);
  return foldSkills([...events, ...added]).find(row => row.name === target)!;
}
