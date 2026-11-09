import {inspectSkillEvidenceSet, compareSkillInspections, evidenceFingerprint, requireSkillEvidence, unsupportedSourceGuidance, type SkillCheckOptions} from "./skill-check.ts";
import type {EvidenceInspection} from "./evidence.ts";
import {canonical} from "../plan/state.ts";
import {skillMarkdownV2, validateSkillProposalV2, validateSkillInputV2, validateSkillInspections, type SkillProposalV2} from "./skill-format.ts";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, boundedText, commit, onlyKeys, openStudy, plain, readLedger, readTextBounded, sha256, assertStudyReadLock, type Actor, type LedgerEvent } from "../study.ts";

export const SKILL_PROPOSAL_VERSION = 2, SKILL_PROPOSALS = 100, SKILL_BYTES = 16 * 1024, SKILL_EVIDENCE = 64;
export interface SkillProposal { name: string; summary: string; steps: string[]; evidence: string[] }
export type SkillDecision = "accept" | "reject" | "withdraw";
interface SkillRecordState {
  state: "proposed" | "accepted" | "rejected" | "withdrawn"; sha256: string; actor: Actor; at: string;
  decision?: { action: SkillDecision; reason: string; pr?: string; actor: Actor; at: string; evidenceFingerprint?: string; inspections?: EvidenceInspection[]; localGeneration?: string | null };
}
export type SkillRecord = SkillRecordState & (SkillProposal & {skillProposal: 1; evidenceStatus: "legacy-unresolved"} | SkillProposalV2 & {skillProposal: 2; evidenceStatus: "inspection-required"});

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
  if (raw.evidence.length < 1 || raw.evidence.length > SKILL_EVIDENCE) bad("evidence requires 1..64 refs; supply at least one recorded amem id or ares: reference");
  if (raw.steps.length > SKILL_BYTES) bad("proposal arrays exceed the 16 KiB format ceiling; shorten steps or evidence");
  const proposal: SkillProposal = { name: nameOf(raw.name), summary: text(raw.summary, "summary"), steps: raw.steps.map(value => text(value, "step")), evidence: raw.evidence.map(value => text(value, "evidence")) };
  if (proposal.evidence.some(value => !/^[a-f0-9]{32}$/.test(value) && !/^ares:[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value))) bad("evidence must contain 32-hex amem ids or ares:<study-id>/... refs");
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
function version(event: LedgerEvent): 1 | 2 {
  if (event.data.skillProposal !== 1 && event.data.skillProposal !== 2) throw new Error("skill proposal: unsupported version; use an ares version supporting this journal and keep its files unchanged");
  return event.data.skillProposal;
}
export function foldSkills(events: LedgerEvent[]): SkillRecord[] {
  const rows = new Map<string, SkillRecord>();
  for (const event of events) {
    if (event.type === "skill.proposed") {
      const v = version(event), proposal = v === 1 ? validateSkillProposal(event.data.proposal, false) : validateSkillProposalV2(event.data.proposal), hash = sha256(v === 1 ? markdown(proposal as SkillProposal) : skillMarkdownV2(proposal as SkillProposalV2));
      if (event.data.sha256 !== hash || rows.has(proposal.name) || rows.size >= SKILL_PROPOSALS) bad("journal has a mismatched hash, duplicate name or more than 100 proposals");
      rows.set(proposal.name, { ...proposal, skillProposal: v, evidenceStatus: v === 1 ? "legacy-unresolved" : "inspection-required", state: "proposed", sha256: hash, actor: event.actor, at: event.at } as SkillRecord);
    } else if (event.type === "skill.decided") {
      const v = version(event), name = nameOf(event.data.name), row = rows.get(name), action = decisionOf(event.data.decision);
      if (!row || row.state !== "proposed" || row.skillProposal !== v) bad("decision references a missing, mismatched-version or already decided proposal");
      const reason = text(event.data.reason, "reason"), pr = prOf(event.data.pr, action);
      if (v === 2 && action === "accept" && (typeof event.data.evidenceFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(event.data.evidenceFingerprint))) bad("v2 acceptance lacks its evidence fingerprint; restore the original decision event");
      let observed: EvidenceInspection[] | undefined, localGeneration: string | null | undefined;
      if (row.skillProposal === 2 && action === "accept") {
        observed = validateSkillInspections(event.data.inspections, [...row.evidence, ...row.counterevidence]);
        localGeneration = event.data.localGeneration as string | null;
        const hasLocal = observed.some(inspection => inspection.ref?.tool === "ares");
        if (hasLocal ? typeof localGeneration !== "string" || localGeneration.length !== 64 || !/^[a-f0-9]{64}$/.test(localGeneration) : localGeneration !== null) bad("v2 acceptance localGeneration must be a 64-hex digest exactly when inspections include ares refs, otherwise null; restore its original receipt");
        if (compareSkillInspections(row.inspections, observed).length || event.data.evidenceFingerprint !== evidenceFingerprint(row.sha256, observed, localGeneration)) bad("v2 acceptance has mismatched evidence inspection/fingerprint; restore its original receipt");
      }
      row.state = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "withdrawn";
      row.decision = { action, reason, ...(pr === undefined ? {} : { pr }), actor: event.actor, at: event.at, ...(v === 2 && action === "accept" ? {evidenceFingerprint: event.data.evidenceFingerprint as string, inspections: observed!, localGeneration: localGeneration!} : {}) };
    }
  }
  return [...rows.values()];
}
function file(dir: string, name: string): string { return join(dir, "proposals", "skills", `${name}.md`); }
/** Read only tracked proposals; every file is regular/bounded and bound to its original event. */
function readSkills(dirArg: string) {
  const { dir } = openStudy(dirArg), events = readLedger(dir), rows = foldSkills(events);
  for (const parent of [join(dir, "proposals"), join(dir, "proposals", "skills")]) {const stat = lstatSync(parent, {throwIfNoEntry: false}); if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) bad("proposal directory is linked or not regular; restore the committed study tree");}
  for (const row of rows) {
    let content: string;
    try { content = readTextBounded(file(dir, row.name), SKILL_BYTES, {noFollow: true}); } catch { bad("proposal file missing, unreadable or larger than 16 KiB; restore its committed Markdown"); }
    if (!content.startsWith(`---\nskillProposal: ${row.skillProposal}\n`)) throw new Error("skill proposal file: unsupported version; use an ares version supporting this file and keep it unchanged");
    if (sha256(content) !== row.sha256) bad("proposal file differs from its receipt; restore the original Markdown");
  }
  return { dir, events, rows };
}
export function listSkills(dir: string): SkillRecord[] { return readSkills(dir).rows; }
/** Caller holds the study lock. One bounded file and one event share the existing commit preflight. */
export async function proposeSkill(dirArg: string, raw: unknown, actor: Actor, options: SkillCheckOptions = {}): Promise<SkillRecord> {
  const {dir, study} = openStudy(dirArg), input = validateSkillInputV2(raw, study.id), current = readSkills(dir);
  if (current.rows.length >= SKILL_PROPOSALS) bad("100-proposal limit reached; start a new study for further proposals");
  if (current.rows.some(row => row.name === input.name) || lstatSync(file(dir, input.name), {throwIfNoEntry: false})) bad("name or proposal file already exists; choose a new name without replacing prior work");
  const refs = [...new Map([...input.evidence, ...input.counterevidence].map(ref => [canonical(ref), ref])).values()];
  const checked = await inspectSkillEvidenceSet(dir, refs, options);
  if (canonical(readSkills(dir).rows) !== canonical(current.rows)) requireSkillEvidence("proposal journal changed during inspection", "propose");
  if (!checked.recheck()) requireSkillEvidence(checked.localFailure === "unsupported" ? "unsupported ares source record version" : "local source changed or aggregate source budget exhausted during proposal inspection", "propose", checked.inspections);
  const proposal = validateSkillProposalV2({...input, inspections: checked.inspections}, study.id);
  const content = skillMarkdownV2(proposal), hash = sha256(content);
  const added = commit(dir, [[file(dir, proposal.name), content, SKILL_BYTES]], [{actor, type: "skill.proposed", data: {skillProposal: 2, proposal, sha256: hash}}]);
  return foldSkills([...current.events, ...added]).find(row => row.name === proposal.name)!;
}
export async function checkSkill(dir: string, name: string, options: SkillCheckOptions = {}) {
  const target = nameOf(name); let row: SkillRecord | undefined;
  try {row = readSkills(dir).rows.find(row => row.name === target);}
  catch (cause) {return {name: target, state: cause instanceof Error && cause.message.includes("unsupported") ? "unsupported" : "unavailable", inspections: [], acceptReady: false, support: "reviewer-judgment", nextStep: cause instanceof Error && cause.message.includes("unsupported") ? "use a compatible ares version or restore the local record, keeping bytes unchanged; run ares skill check again" : "Restore the versioned study/proposal and its receipts, then run ares skill check again; keep unsupported versions unchanged"};}
  if (!row) return {name: target, state: "missing", inspections: [], acceptReady: false, support: "reviewer-judgment", nextStep: "Select a recorded name with ares skill list or create a new proposal"};
  if (row.skillProposal === 1) return {name: row.name, proposalSha256: row.sha256, skillProposal: 1, state: "unsupported", legacyUnresolved: true, inspections: [], acceptReady: false, support: "reviewer-judgment", nextStep: row.state === "proposed" ? "Legacy bytes/decisions are preserved; create a new v2 proposal for evidence-backed checks" : "Decision is final; create a revised v2 proposal for new evidence. Legacy bytes and the recorded decision remain unchanged"};
  const refs = [...new Map([...row.evidence, ...row.counterevidence].map(ref => [canonical(ref), ref])).values()], checked = await inspectSkillEvidenceSet(dir, refs, options), reasons = compareSkillInspections(row.inspections, checked.inspections);
  try {if (canonical(readSkills(dir).rows.find(current => current.name === row.name)) !== canonical(row)) reasons.push("proposal-changed");} catch {reasons.push("proposal-changed");}
  if (!checked.recheck()) reasons.push(checked.localFailure ?? "local-source-changed-or-budget-exhausted");
  const sourceGuidance = unsupportedSourceGuidance(checked.inspections);
  const sourcesReady = reasons.length === 0, ready = sourcesReady && row.state === "proposed", state = sourcesReady ? "available" : checked.remainingMs <= 0 ? "unavailable" : reasons.some(reason => reason.includes("changed")) ? "changed" : reasons.includes("unsupported") ? "unsupported" : reasons.includes("missing") ? "missing" : "unavailable";
  return {name: row.name, proposalSha256: row.sha256, skillProposal: 2, state, inspections: checked.inspections, acceptReady: ready, support: "reviewer-judgment", evidenceFingerprint: evidenceFingerprint(row.sha256, checked.inspections, checked.localGeneration), localGeneration: checked.localGeneration, responseBytes: checked.bytes, reasons, nextStep: row.state !== "proposed" ? `Decision is final; create a revised proposal for new evidence${sourceGuidance ? `; ${sourceGuidance}` : ""}` : ready ? "Source integrity is not support: a reviewer decides using the supplied PR reference" : state === "unsupported" ? `${sourceGuidance || "use a supporting source reader"}; create a revised proposal with current evidence/counterevidence and honest limitations` : "Create a revised proposal with current evidence/counterevidence and honest limitations"};
}
/** Caller holds the owned study lock. Final decisions never open, inspect or merge a PR. */
export async function decideSkill(dirArg: string, name: string, decision: string, reason: string, pr: string | undefined, actor: Actor, options: SkillCheckOptions = {}): Promise<SkillRecord> {
  const target = nameOf(name), action = decisionOf(decision), why = text(reason, "reason"), reference = prOf(pr, action), {dir, events, rows} = readSkills(dirArg);
  const row = rows.find(row => row.name === target);
  if (!row || row.state !== "proposed") bad("proposal is missing or already decided; decisions including withdrawal are final");
  let evidence: {evidenceFingerprint: string; inspections: EvidenceInspection[]; localGeneration: string | null} | undefined;
  if (row.skillProposal === 2 && action === "accept") {
    if (!options.lock) requireSkillEvidence("v2 acceptance requires an owned study transaction"); assertStudyReadLock(dir, options.lock);
    const checked = await inspectSkillEvidenceSet(dir, [...new Map([...row.evidence, ...row.counterevidence].map(ref => [canonical(ref), ref])).values()], options), reasons = compareSkillInspections(row.inspections, checked.inspections);
    if (reasons.length) requireSkillEvidence(`required evidence or counterevidence is changed/unavailable (${[...new Set(reasons)].join(", ")})`, "accept", checked.inspections);
    if (canonical(readSkills(dir).rows) !== canonical(rows) || !checked.recheck()) requireSkillEvidence("local source/proposal changed or aggregate source budget exhausted before decision");
    assertStudyReadLock(dir, options.lock);
    evidence = {evidenceFingerprint: evidenceFingerprint(row.sha256, checked.inspections, checked.localGeneration), inspections: checked.inspections, localGeneration: checked.localGeneration};
  }
  const pending = {actor, type: "skill.decided", data: {skillProposal: row.skillProposal, name: target, decision: action, reason: why, ...(reference === undefined ? {} : {pr: reference}), ...evidence}};
  foldSkills([...events, {v: 1, at: new Date().toISOString(), ...pending}]);
  const added = commit(dir, [], [pending]);
  return foldSkills([...events, ...added]).find(row => row.name === target)!;
}
