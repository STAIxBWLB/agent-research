import * as lineage from "../src/provenance.ts";
import type { ExecutionReferenceV1, LineageComparison, ProvenancePage } from "../src/provenance.ts";
import { sha256, plain } from "../src/study.ts";
import { canonical } from "../src/exp/protocol.ts";
import { resolveDiagnosticFixture, type DiagnosticObservation } from "./execution-diagnose.ts";

export const LINEAGE_TREATMENT_BYTES = 65_536;
export type DiagnosticLineageReason = "matched-producer-metadata" | "no-visible-producer" | "unsupported-producer-reference" | "missing-study-identity" | "native-read-unavailable" | "lineage-capped" | "lineage-unavailable" | "comparison-unavailable" | "source-changed" | "producer-missing" | "producer-conflict" | "retry-conflict" | "artifact-reference-conflict" | "lineage-view-over-bound";
export interface DiagnosticLineageTreatment {
  v: 1;
  kind: "fixture-integration-only";
  arm: "diagnose-lineage";
  authority: "harness-observed";
  diagnostic: DiagnosticObservation;
  integration: {
    state: "matched" | "unavailable" | "conflicting" | "skipped";
    reason: DiagnosticLineageReason;
    producer: ExecutionReferenceV1 | null;
    evidenceSha256: string | null;
    producerView: {lineage: ProvenancePage; comparison: LineageComparison} | null;
  };
  humanTimeToFind: "unknown";
  costs: "unknown";
  resultAuthority: {selection: false; final: false; adoption: false};
  limitations: string[];
}
/** Read-only fixture adapter. studyDir is the explicit caller binding, never a candidate payload locator. */
export function diagnoseTreatment(studyDir: string, input: unknown): DiagnosticLineageTreatment {
  const baseline = resolveDiagnosticFixture(input), value = plain(input) ? input : {};
  const unknown = (completeness: "lineage-unavailable" | "lineage-conflicting"): DiagnosticObservation => ({provenance: {attemptId: null, head: null, selectedHead: baseline.provenance.selectedHead, status: "unknown", completeness}, nextAction: completeness === "lineage-conflicting" ? "reconcile-visible-source-records" : "inspect-bounded-lineage-source"});
  const result = (state: DiagnosticLineageTreatment["integration"]["state"], reason: DiagnosticLineageReason, diagnostic: DiagnosticObservation, producer: ExecutionReferenceV1 | null = null, producerView: DiagnosticLineageTreatment["integration"]["producerView"] = null): DiagnosticLineageTreatment => {
    if (producerView !== null && Buffer.byteLength(JSON.stringify(producerView)) > LINEAGE_TREATMENT_BYTES - 4096) { state = "unavailable"; reason = "lineage-view-over-bound"; diagnostic = unknown("lineage-unavailable"); producerView = null; }
    return {v: 1, kind: "fixture-integration-only", arm: "diagnose-lineage", authority: "harness-observed", diagnostic,
      integration: {state, reason, producer, evidenceSha256: producerView === null ? null : sha256(canonical(producerView)), producerView},
      humanTimeToFind: "unknown", costs: "unknown", resultAuthority: {selection: false, final: false, adoption: false},
      limitations: ["Native product views establish recorded producer metadata only; artifact bodies are never read", "Artifact presence, delivery symptoms and selected-head context remain candidate-visible facts, not newly verified native observations", "Fixture scaffolding and recorded timestamps are not treatment trial measurements or usability timing"]};
  };
  const artifact = plain(value.artifact) ? value.artifact : undefined;
  // Preserve deliberate privacy/corrupt-source uncertainty; do not attempt to resolve hidden references.
  if (baseline.provenance.attemptId === null || artifact?.producerAttemptId == null) return result("skipped", "no-visible-producer", baseline);
  const producerId = artifact.producerAttemptId;
  if (typeof producerId !== "string" || !/^[a-f0-9]{16}$/.test(producerId) || producerId !== baseline.provenance.attemptId) return result("unavailable", "unsupported-producer-reference", unknown("lineage-unavailable"));
  const study = plain(value.study) ? value.study : undefined;
  if (typeof study?.id !== "string" || !study.id || Buffer.byteLength(study.id) > 256 || /\p{Cc}/u.test(study.id)) return result("unavailable", "missing-study-identity", unknown("lineage-unavailable"));
  const producer: ExecutionReferenceV1 = {v: 1, tool: "ares", projectKey: study.id, kind: "attempt", id: producerId};
  let page: ProvenancePage, comparison: LineageComparison;
  try {
    page = lineage.readProvenance(studyDir, {root: producer});
    if (page.status === "capped" || page.truncated || page.nextCursor !== undefined) return result("unavailable", "lineage-capped", unknown("lineage-unavailable"), producer);
    if (page.status !== "ok") return result("unavailable", "lineage-unavailable", unknown("lineage-unavailable"), producer);
    comparison = lineage.compareLineage(studyDir, {attempts: [producerId]});
  } catch { return result("unavailable", "native-read-unavailable", unknown("lineage-unavailable"), producer); }
  const producerView = {lineage: page, comparison};
  const row = comparison.rows[0];
  if (comparison.status !== "ok" || comparison.rows.length !== 1 || !row || row.state !== "available") return result("unavailable", "comparison-unavailable", unknown("lineage-unavailable"), producer, producerView);
  if (page.sourceSha256 === null || page.sourceSha256 !== comparison.sourceSha256 || page.ledgerPosition !== comparison.ledgerPosition) return result("unavailable", "source-changed", unknown("lineage-unavailable"), producer, producerView);
  const node = page.nodes.find(node => node.ref.kind === "attempt" && node.ref.id === producerId && node.ref.projectKey === producer.projectKey), native = row.attempts[0];
  if (!node || node.state !== "current" || node.availability !== "available" || !native || native.id !== producerId || row.attempts.length !== 1) return result("unavailable", "producer-missing", unknown("lineage-unavailable"), producer, producerView);
  const visibleAttempts = Array.isArray(value.attempts) ? value.attempts.filter(plain) : [], visible = visibleAttempts.find(attempt => attempt.id === producerId);
  if (native.code.commit !== baseline.provenance.head || native.status !== baseline.provenance.status || node.data?.status !== baseline.provenance.status || visible?.seed !== undefined && native.seed !== visible.seed) return result("conflicting", "producer-conflict", unknown("lineage-conflicting"), producer, producerView);
  const expectedParent = baseline.retryOf ?? null;
  if (native.retryOf !== expectedParent || expectedParent !== null && (!native.retryAncestry.includes(expectedParent) || !page.edges.some(edge => edge.from.kind === "attempt" && edge.from.id === producerId && edge.to.kind === "attempt" && edge.to.id === expectedParent && edge.relation === "retryOf"))) return result("conflicting", "retry-conflict", unknown("lineage-conflicting"), producer, producerView);
  if (artifact?.digest !== undefined && (typeof artifact.digest !== "string" || !/^[a-f0-9]{64}$/.test(artifact.digest) || !native.artifactDigests.includes(artifact.digest) || !page.edges.some(edge => edge.from.kind === "attempt" && edge.from.id === producerId && edge.to.kind === "artifact" && edge.to.id === artifact.digest && ["produced", "reused-artifact"].includes(edge.relation)))) return result("conflicting", "artifact-reference-conflict", unknown("lineage-conflicting"), producer, producerView);
  const matched = result("matched", "matched-producer-metadata", baseline, producer, producerView);
  if (Buffer.byteLength(JSON.stringify(matched)) > LINEAGE_TREATMENT_BYTES) return result("unavailable", "lineage-view-over-bound", unknown("lineage-unavailable"), producer);
  return matched;
}
