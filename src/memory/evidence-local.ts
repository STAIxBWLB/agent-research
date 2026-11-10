import {openStudy} from "../study.ts";
import {localEvidenceSnapshot, validateExecutionReference, type ExecutionReferenceV1, type ProvenanceNode} from "../provenance.ts";

export interface LocalEvidenceInspection {
  ref?: ExecutionReferenceV1;
  state: "available" | "missing" | "changed" | "unavailable" | "unsupported";
  digest: string | null;
  sourceVersion?: {reference: 1; native?: number; ledger?: 1};
  integrity: "record" | "receipt-only" | "unverified";
  outcome: {status: "succeeded" | "failed" | "cancelled" | "unknown" | "unfinished" | "qualified" | "not_qualified" | "winner" | "no-winner" | "closed" | "not-applicable" | "unverified"; success: boolean};
  metadata?: {family?: string; status?: string; winner?: boolean; qualification?: "qualified" | "not_qualified"};
  support: "reviewer-judgment";
}
const base = (state: LocalEvidenceInspection["state"], ref?: ExecutionReferenceV1, digest: string | null = null): LocalEvidenceInspection => ({...(ref ? {ref, sourceVersion: {reference: 1 as const}} : {}), state, digest, integrity: "unverified", outcome: {status: "unverified", success: false}, support: "reviewer-judgment"});
const digestOf = (node: ProvenanceNode) => node.ref.sha256 ?? node.proof.sourceBindingSha256 ?? node.proof.recordSha256 ?? node.proof.sha256;
const unsupported = (codes: string[]) => codes.some(code => code.startsWith("unsupported"));

/** Typed local addresses only. A readable record or recorded successful outcome never establishes claim support. */
export function inspectLocalEvidence(dir: string, raw: unknown, snapshot?: ReturnType<typeof localEvidenceSnapshot>): LocalEvidenceInspection {
  let ref: ExecutionReferenceV1;
  try {const parsed = validateExecutionReference(raw); if (parsed.tool !== "ares") return base("unsupported"); ref = parsed;} catch {return base("unsupported");}
  let study: ReturnType<typeof openStudy>["study"];
  try {study = snapshot?.study ?? openStudy(dir).study;}
  catch (error) {return base(error instanceof Error && /unsupported/.test(error.message) ? "unsupported" : "unavailable", ref);}
  if (ref.projectKey !== study.id) return base("unsupported", ref);
  const expected = ref.sha256;
  try {
    let matches: ProvenanceNode[], codes: string[], audit: {status: string};
    if (snapshot) {
      codes = snapshot.issues; audit = snapshot;
      if (snapshot.status === "changed") return base("changed", ref);
      if (unsupported(codes)) return base("unsupported", ref);
      if (snapshot.status === "capped") return base("unavailable", ref);
      matches = snapshot.nodes.filter(node => node.ref.projectKey === ref.projectKey && node.ref.kind === ref.kind && node.ref.id === ref.id && (ref.revision === undefined || ref.revision === node.ref.revision));
    } else {
      const shared = localEvidenceSnapshot(dir);
      return inspectLocalEvidence(dir, raw, shared);
    }
    if (matches.length > 1 && expected === undefined) {
      const families = new Set(matches.map(node => node.data?.family ?? node.ref.kind));
      if (families.size > 1 || matches.filter(node => node.state === "current").length !== 1) return base("unsupported", ref);
    }
    const node = matches.find(node => expected !== undefined && digestOf(node) === expected)
      ?? matches.find(node => node.state === "current") ?? matches[0];
    if (!node) return base(codes.length ? "unavailable" : "missing", ref);
    const digest = digestOf(node);
    if (expected !== undefined && expected !== digest || node.state === "corrupt") return base("changed", ref, digest);
    if (node.availability === "missing") return base("missing", ref, digest);
    if (node.state === "unavailable" || node.state === "declared-unresolved" || audit.status !== "ok") return base("unavailable", ref, digest);
    const result = base("available", ref, digest);
    if (ref.kind === "paper-evidence" && node.availability === "available") {
      const version = node.data?.nativeVersion;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return base("unavailable", ref, digest);
      result.sourceVersion!.native = version;
    }
    if (ref.kind === "harness-closure") result.sourceVersion = {reference: 1, native: 1, ledger: 1};
    if (node.state === "historical" || node.availability === "receipt-only") return result;
    if (node.availability === "not-read" || ref.kind === "artifact") {result.integrity = "receipt-only"; return result;}
    result.integrity = "record";
    if (node.proof.ledgerIndex !== undefined) result.sourceVersion!.ledger = 1;
    if (["attempt", "closed-result", "plan-revision"].includes(ref.kind)) result.sourceVersion!.native = 1;
    if (ref.kind === "study") result.sourceVersion!.native = study.v;
    const data = node.data ?? {}, metadata: NonNullable<LocalEvidenceInspection["metadata"]> = {};
    if (["investigate", "ablate", "final", "paper"].includes(String(data.family))) metadata.family = String(data.family);
    if (["succeeded", "failed", "cancelled", "unknown", "running", "qualified", "not_qualified", "open", "pivoted", "proposed", "accepted", "rejected", "withdrawn", "dispatched", "done", "uncertain"].includes(String(data.status))) metadata.status = String(data.status);
    if (data.family === "investigate" && typeof data.winner === "boolean") metadata.winner = data.winner;
    if (data.family === "final" && (data.status === "qualified" || data.status === "not_qualified")) metadata.qualification = data.status;
    if (Object.keys(metadata).length) result.metadata = metadata;
    if (ref.kind === "attempt") {
      const status = data.status;
      result.outcome = {status: status === "succeeded" || status === "failed" || status === "cancelled" ? status : status === "running" ? "unfinished" : "unknown", success: status === "succeeded"};
    } else if (data.family === "final") result.outcome = {status: data.status === "qualified" || data.status === "not_qualified" ? data.status : "unknown", success: data.status === "qualified"};
    else if (data.family === "investigate") result.outcome = {status: typeof data.winner === "boolean" ? data.winner ? "winner" : "no-winner" : "closed", success: false};
    else result.outcome = {status: ref.kind === "closed-result" || ref.kind === "paper-evidence" || ref.kind === "harness-closure" ? "closed" : "not-applicable", success: false};
    return result;
  } catch (cause) {return base(cause instanceof Error && cause.message.includes("unsupported") ? "unsupported" : "unavailable", ref);}
}
