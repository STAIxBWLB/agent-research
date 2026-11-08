import {plain, openStudy} from "../study.ts";
import {PROVENANCE_KINDS, validateExecutionReference, type ExecutionReferenceV1} from "../provenance.ts";
import {inspectLocalEvidence, type LocalEvidenceInspection} from "./evidence-local.ts";
import {readScreenedAmem} from "./amem-show.ts";
import type {ProcessRunner} from "../exp/executor.ts";

export interface AmemEvidenceReference {v: 1; tool: "amem"; id: string}
export type SkillEvidenceReference = ExecutionReferenceV1 | AmemEvidenceReference;
export interface EvidenceInspection extends Omit<LocalEvidenceInspection, "ref" | "sourceVersion" | "integrity" | "metadata"> {
  ref?: SkillEvidenceReference;
  sourceVersion?: {reference: 1; native?: number; ledger?: 1; amem?: string};
  integrity: LocalEvidenceInspection["integrity"] | "screened";
  metadata?: LocalEvidenceInspection["metadata"] & {kind?: string};
  observedAt?: string;
}
/** Compatibility strings are addresses only, never file paths or resolver instructions. */
export function skillEvidenceReference(raw: unknown, studyId?: string): SkillEvidenceReference | undefined {
  if (typeof raw === "string") {
    if (/^[a-f0-9]{32}$/.test(raw)) return {v: 1, tool: "amem", id: raw};
    const match = /^ares:([^/]+)\/([^:]+):(.+)$/.exec(raw);
    if (!match || !(PROVENANCE_KINDS as readonly string[]).includes(match[2]!)) return undefined;
    raw = {v: 1, tool: "ares", projectKey: match[1], kind: match[2], id: match[3]};
  }
  if (plain(raw) && raw.v === 1 && raw.tool === "amem" && Object.keys(raw).every(key => ["v", "tool", "id"].includes(key)) && typeof raw.id === "string" && /^[a-f0-9]{32}$/.test(raw.id)) return {v: 1, tool: "amem", id: raw.id};
  try {const ref = validateExecutionReference(raw); return studyId === undefined || ref.projectKey === studyId ? ref : undefined;}
  catch {return undefined;}
}
const refused = (state: EvidenceInspection["state"], ref?: SkillEvidenceReference): EvidenceInspection => ({...(ref ? {ref} : {}), state, digest: null, integrity: "unverified", outcome: {status: "unverified", success: false}, support: "reviewer-judgment"});
/** One bounded source inspection; multi-source decision budgets and atomic acceptance belong to T2. */
export async function inspectSkillEvidence(dir: string, raw: unknown, options: {runner?: ProcessRunner; env?: NodeJS.ProcessEnv; now?: () => number} = {}): Promise<EvidenceInspection> {
  let studyId: string, projectDir: string;
  try {const opened = openStudy(dir); studyId = opened.study.id; projectDir = opened.dir;} catch (error) {return refused(error instanceof Error && /unsupported/.test(error.message) ? "unsupported" : "unavailable");}
  const ref = skillEvidenceReference(raw, studyId);
  if (!ref) return refused("unsupported");
  if (ref.tool === "ares") return inspectLocalEvidence(projectDir, ref);
  const result = await readScreenedAmem(projectDir, ref.id, options);
  if (result.state !== "available" && result.state !== "changed") return {...refused(result.state, ref), observedAt: result.observedAt};
  return {ref, state: result.state, digest: result.digest, integrity: result.state === "available" ? "screened" : "unverified", outcome: {status: "not-applicable", success: false}, support: "reviewer-judgment", sourceVersion: {reference: 1, ...(result.sourceVersion ? {amem: result.sourceVersion} : {})}, observedAt: result.observedAt, ...(result.kind ? {metadata: {kind: result.kind}} : {})};
}
