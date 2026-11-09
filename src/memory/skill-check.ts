import {openStudy, sha256, assertStudyReadLock, type StudyReadLock} from "../study.ts";
import {canonical} from "../plan/state.ts";
import {localEvidenceSnapshot} from "../provenance.ts";
import {inspectLocalEvidence} from "./evidence-local.ts";
import {readScreenedAmem} from "./amem-show.ts";
import {skillEvidenceReference, type SkillEvidenceReference, type EvidenceInspection} from "./evidence.ts";
import {sourceBudget, SOURCE_BYTES, type SourceBudget} from "./source-budget.ts";
import type {ProcessRunner} from "../exp/executor.ts";

export interface SkillCheckOptions {runner?: ProcessRunner; env?: NodeJS.ProcessEnv; now?: () => number; lock?: StudyReadLock; budget?: SourceBudget}
const unavailable = (ref: SkillEvidenceReference): EvidenceInspection => ({ref, state: "unavailable", digest: null, integrity: "unverified", outcome: {status: "unverified", success: false}, support: "reviewer-judgment"});
export function semanticInspection(value: EvidenceInspection) {const {observedAt: _time, ...content} = value; return content;}
export const evidenceFingerprint = (proposalSha256: string, inspections: EvidenceInspection[], localGeneration: string | null) => sha256(canonical({proposalSha256, inspections, localGeneration}));
/** One captured local producer view and one aggregate 25s/256KiB response budget across all exact-id reads. */
export async function inspectSkillEvidenceSet(dirArg: string, raw: readonly SkillEvidenceReference[], options: SkillCheckOptions = {}) {
  const {dir, study} = openStudy(dirArg), budget = options.budget ?? sourceBudget(options.now), refs: SkillEvidenceReference[] = [];
  if (!Array.isArray(raw) || raw.length > 64) throw new Error("skill check: evidence bound exceeded; create a revised proposal with at most 64 sources and honest limitations");
  const unique = new Set<string>();
  for (const value of raw) {const ref = skillEvidenceReference(value, study.id); if (!ref) throw new Error("skill check: unsupported or wrong-study reference; create a revised proposal with current-study typed refs and honest limitations"); const key = canonical(ref); if (!unique.has(key)) {unique.add(key); refs.push(ref);}}
  let local: ReturnType<typeof localEvidenceSnapshot> | undefined, localFailure: "unsupported" | "unavailable" | undefined;
  if (refs.some(ref => ref.tool === "ares")) {
    try {local = localEvidenceSnapshot(dir, options.lock); if (!budget.consume(local.bytes)) {local = undefined; localFailure = "unavailable";}}
    catch (cause) {localFailure = cause instanceof Error && cause.message.includes("unsupported") ? "unsupported" : "unavailable";}
  }
  const inspections: EvidenceInspection[] = [];
  for (const ref of refs) {
    if (budget.remainingMs() <= 0 || budget.remainingBytes <= 0) {inspections.push(unavailable(ref)); continue;}
    if (ref.tool === "ares") {inspections.push(local ? inspectLocalEvidence(dir, ref, local) : {...unavailable(ref), state: localFailure ?? "unavailable"}); continue;}
    const result = await readScreenedAmem(dir, ref.id, {...options, budget});
    inspections.push(result.state === "available" || result.state === "changed" ? {ref, state: result.state, digest: result.digest, integrity: result.state === "available" ? "screened" : "unverified", outcome: {status: "not-applicable", success: false}, support: "reviewer-judgment", sourceVersion: {reference: 1, ...(result.sourceVersion ? {amem: result.sourceVersion} : {})}, observedAt: result.observedAt, ...(result.kind ? {metadata: {kind: result.kind}} : {})} : {...unavailable(ref), state: result.state, observedAt: result.observedAt});
  }
  const recheck = () => {
    if (budget.remainingMs() <= 0) return false;
    try {if (options.lock) assertStudyReadLock(dir, options.lock); if (canonical(openStudy(dir).study) !== canonical(study) || (local ? !local.recheck() : refs.some(ref => ref.tool === "ares"))) return false;} catch {return false;}
    return budget.remainingMs() > 0;
  };
  if (!recheck()) for (let i = 0; i < inspections.length; i++) {
    const row = inspections[i]!, expired = budget.remainingMs() <= 0;
    if (row.ref?.tool === "ares" && local || expired) inspections[i] = {...row, state: expired ? "unavailable" : "changed", digest: expired ? null : row.digest, integrity: "unverified", outcome: {status: "unverified", success: false}};
  }
  return {inspections, localFailure, localGeneration: local?.sourceSha256 ?? null, bytes: SOURCE_BYTES - budget.remainingBytes, remainingMs: budget.remainingMs(), recheck};
}
export function compareSkillInspections(pinned: EvidenceInspection[], current: EvidenceInspection[]) {
  const expected = new Map(pinned.map(row => [canonical(row.ref), row]));
  const reasons: string[] = [];
  for (const row of current) {const before = expected.get(canonical(row.ref)); if (!before || row.state !== "available" || before.state !== "available" || canonical(semanticInspection(row)) !== canonical(semanticInspection(before))) reasons.push(row.state === "available" ? "changed-source" : row.state);}
  if (expected.size !== current.length) reasons.push("source-set-changed"); return reasons;
}
export function unsupportedSourceGuidance(inspections: readonly EvidenceInspection[]): string {
  const tools = new Set(inspections.filter(row => row.state === "unsupported").map(row => row.ref?.tool));
  return [tools.has("ares") ? "use a compatible ares version or restore the local record, keeping bytes unchanged" : "", tools.has("amem") ? "use amem >=0.22.1 with screened exact-id amem_show" : ""].filter(Boolean).join("; ");
}
export function requireSkillEvidence(why: string, operation: "accept" | "propose" = "accept", inspections: readonly EvidenceInspection[] = []): never {
  const next = operation === "propose" ? "retry ares skill propose after restoring source access/budget, or revise the proposal input with honest limitations" : "create a revised proposal with current evidence/counterevidence and honest limitations, then run ares skill check before deciding", source = unsupportedSourceGuidance(inspections);
  throw new Error(`skill ${operation}: ${why}; ${next}${source ? `; ${source}` : ""}`);
}
