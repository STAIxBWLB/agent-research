import {assertWritable, boundedText, onlyKeys, plain} from "../study.ts";
import {SKILL_BYTES, SKILL_EVIDENCE} from "./skills.ts";
import {skillEvidenceReference, type EvidenceInspection, type SkillEvidenceReference} from "./evidence.ts";
import {supportsScreenedAmem} from "./amem-show.ts";

export interface SkillProposalV2 {
  name: string; summary: string; steps: string[]; evidence: SkillEvidenceReference[];
  applicability?: string; limitations: string[]; counterevidence: SkillEvidenceReference[]; inspections: EvidenceInspection[];
}
const STATES = ["available", "missing", "changed", "unavailable", "unsupported"];
const OUTCOMES = ["succeeded", "failed", "cancelled", "unknown", "unfinished", "qualified", "not_qualified", "winner", "no-winner", "closed", "not-applicable", "unverified"];
function bad(): never {throw new Error("skill v2: invalid or over-bound proposal/inspection; restore the versioned proposal or revise its bounded references and inspection metadata, then retry");}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!plain(value)) bad(); try {onlyKeys(value, fields, "skill v2");} catch {bad();} return value;
}
function text(value: unknown, bound: number): string {
  try {const result = boundedText(value, "skill v2 text", bound); if (result.includes("\0") || Buffer.byteLength(result) > bound) bad(); return result;} catch {return bad();}
}
function ref(value: unknown, studyId?: string): SkillEvidenceReference {return skillEvidenceReference(value, studyId) ?? bad();}
function refs(value: unknown, required: boolean, studyId?: string): SkillEvidenceReference[] {
  if (!Array.isArray(value) || value.length > SKILL_EVIDENCE || required && !value.length) bad(); return value.map(value => ref(value, studyId));
}
function inspection(value: unknown, studyId?: string): EvidenceInspection {
  const row = object(value, ["ref", "state", "digest", "integrity", "outcome", "support", "sourceVersion", "observedAt", "metadata"]), reference = ref(row.ref, studyId);
  if (!STATES.includes(row.state as string) || row.digest !== null && (typeof row.digest !== "string" || !/^[a-f0-9]{64}$/.test(row.digest)) || !["record", "receipt-only", "unverified", "screened"].includes(row.integrity as string) || row.support !== "reviewer-judgment") bad();
  const outcome = object(row.outcome, ["status", "success"]);
  if (!OUTCOMES.includes(outcome.status as string) || typeof outcome.success !== "boolean") bad();
  if (outcome.success && (row.state !== "available" || row.integrity !== "record" || !["succeeded", "qualified"].includes(outcome.status as string))) bad();
  if (row.state === "available" && (row.digest === null || reference.tool === "ares" && reference.sha256 !== undefined && reference.sha256 !== row.digest)) bad();
  if (reference.tool === "ares" && row.integrity === "screened" || reference.tool === "amem" && row.integrity === "record") bad();
  if (reference.tool === "amem" && ["missing", "unavailable", "unsupported"].includes(row.state as string) && row.digest !== null) bad();
  const result = {ref: reference, state: row.state, digest: row.digest, integrity: row.integrity, outcome: {status: outcome.status, success: outcome.success}, support: "reviewer-judgment"} as EvidenceInspection;
  if (row.sourceVersion !== undefined) {
    const version = object(row.sourceVersion, ["reference", "native", "ledger", "amem"]);
    if (version.reference !== 1 || version.native !== undefined && (!Number.isSafeInteger(version.native) || Number(version.native) < 1 || Number(version.native) > 1_000_000) || version.ledger !== undefined && version.ledger !== 1 || version.amem !== undefined && (typeof version.amem !== "string" || version.amem.length > 64)) bad();
    result.sourceVersion = {reference: 1, ...(version.native !== undefined ? {native: version.native as number} : {}), ...(version.ledger === 1 ? {ledger: 1 as const} : {}), ...(version.amem !== undefined ? {amem: version.amem as string} : {})};
  }
  if (row.observedAt !== undefined) {if (typeof row.observedAt !== "string" || row.observedAt.length > 64 || !Number.isFinite(Date.parse(row.observedAt))) bad(); result.observedAt = row.observedAt;}
  if (row.state === "available" && (!result.sourceVersion || reference.tool === "amem" && (row.integrity !== "screened" || !supportsScreenedAmem(result.sourceVersion.amem) || !result.observedAt))) bad();
  if (row.metadata !== undefined) {
    const data = object(row.metadata, ["family", "status", "winner", "qualification", "kind"]);
    if (data.family !== undefined && !["investigate", "ablate", "final", "paper"].includes(data.family as string) || data.status !== undefined && !["succeeded", "failed", "cancelled", "unknown", "running", "qualified", "not_qualified", "open", "pivoted", "proposed", "accepted", "rejected", "withdrawn", "dispatched", "done", "uncertain"].includes(data.status as string) || data.winner !== undefined && typeof data.winner !== "boolean" || data.qualification !== undefined && !["qualified", "not_qualified"].includes(data.qualification as string) || data.kind !== undefined && !["fail", "finding", "decision", "contract", "other"].includes(data.kind as string)) bad();
    result.metadata = {...(data.family !== undefined ? {family: data.family as string} : {}), ...(data.status !== undefined ? {status: data.status as string} : {}), ...(data.winner !== undefined ? {winner: data.winner as boolean} : {}), ...(data.qualification !== undefined ? {qualification: data.qualification as "qualified" | "not_qualified"} : {}), ...(data.kind !== undefined ? {kind: data.kind as string} : {})};
  }
  return result;
}
export function validateSkillProposalV2(raw: unknown, studyId?: string): SkillProposalV2 {
  const row = object(raw, ["name", "summary", "steps", "evidence", "applicability", "limitations", "counterevidence", "inspections"]);
  if (typeof row.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.name) || !Array.isArray(row.steps) || !row.steps.length || row.steps.length > 64 || !Array.isArray(row.inspections) || row.inspections.length > SKILL_EVIDENCE) bad();
  const limitations = row.limitations === undefined ? [] : row.limitations; if (!Array.isArray(limitations) || limitations.length > 16) bad();
  const proposal: SkillProposalV2 = {name: row.name, summary: text(row.summary, 4000), steps: row.steps.map(value => text(value, 1000)), evidence: refs(row.evidence, true, studyId), ...(row.applicability !== undefined ? {applicability: text(row.applicability, 2000)} : {}), limitations: limitations.map(value => text(value, 1000)), counterevidence: refs(row.counterevidence === undefined ? [] : row.counterevidence, false, studyId), inspections: row.inspections.map(value => inspection(value, studyId))};
  const expected = new Set([...proposal.evidence, ...proposal.counterevidence].map(value => JSON.stringify(value))), observed = proposal.inspections.map(value => JSON.stringify(value.ref));
  if (expected.size > SKILL_EVIDENCE || observed.length !== expected.size || new Set(observed).size !== observed.length || observed.some(value => !expected.has(value))) bad();
  assertWritable(skillMarkdownV2(proposal), SKILL_BYTES, "skill v2 proposal"); return proposal;
}
export function skillMarkdownV2(proposal: SkillProposalV2): string {
  const list = (values: string[]) => values.map(value => `- ${value.replaceAll("\n", "\n  ")}`).join("\n");
  return `---\nskillProposal: 2\nname: ${proposal.name}\n---\n\n# ${proposal.name}\n\n${proposal.summary}\n\n## Steps\n\n${list(proposal.steps)}\n\n## Evidence\n\n${list(proposal.evidence.map(value => JSON.stringify(value)))}\n\n## Applicability\n\n${proposal.applicability ?? "not recorded"}\n\n## Limitations\n\n${list(proposal.limitations)}\n\n## Counterevidence\n\n${list(proposal.counterevidence.map(value => JSON.stringify(value)))}\n\n## Inspection receipts\n\n\`\`\`json\n${JSON.stringify(proposal.inspections, null, 2)}\n\`\`\`\n`;
}
