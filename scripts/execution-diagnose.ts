import { resolve } from "node:path";
import { plain, readTextBounded, writeAtomic } from "../src/study.ts";

export const DIAGNOSTIC_BYTES = 16 * 1024;
export interface DiagnosticObservation {
  provenance: { attemptId: string | null; head: string | null; selectedHead: string | null; status: string; completeness: string };
  nextAction: string;
  retryOf?: string;
  independentSamples?: number;
}
const text = (value: unknown): string | undefined => typeof value === "string" && value.length > 0 && value.length <= 256 ? value : undefined;
const head = (value: unknown): string | null => typeof value === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : null;
const statuses = ["succeeded", "running", "failed", "cancelled", "unknown"];
/** Automated source-resolution for synthetic candidate-visible facts, not a product lineage reader or usability measurement. */
export function resolveDiagnosticFixture(input: unknown): DiagnosticObservation {
  const value = plain(input) ? input : {}, selectedHead = plain(value.study) ? head(value.study.selectedHead) : null;
  const unknown = (completeness = "unknown", nextAction = "inspect-visible-source-records"): DiagnosticObservation => ({ provenance: { attemptId: null, head: null, selectedHead, status: "unknown", completeness }, nextAction });
  const source = plain(value.source) ? value.source : undefined;
  if (source?.visibility === "withheld") return unknown("privacy-gap", "request-safe-provenance-summary");
  if (source && typeof source.bytes === "string") {
    if (Buffer.byteLength(source.bytes) > DIAGNOSTIC_BYTES) return unknown("unreadable-source", "restore-valid-source-record");
    let raw: unknown;
    try { raw = JSON.parse(source.bytes); } catch { return unknown("unreadable-source", "restore-valid-source-record"); }
    if (!plain(raw)) return unknown("unreadable-source", "restore-valid-source-record");
    if (raw.v !== 1) return unknown("unsupported-source-version", "use-compatible-source-reader");
    // A valid but unrecognized source record does not establish a producer relationship.
  }
  const artifact = plain(value.artifact) ? value.artifact : undefined;
  const attempts = Array.isArray(value.attempts) && value.attempts.length <= 128 ? value.attempts.filter(plain) : [];
  const producer = text(artifact?.producerAttemptId), matches = producer ? attempts.filter(attempt => attempt.id === producer) : [];
  if (matches.length !== 1) return unknown();
  const attempt = matches[0]!, attemptId = text(attempt.id), commit = head(attempt.commit), status = text(attempt.status);
  if (!attemptId || !commit || !status || !statuses.includes(status)) return unknown();
  if (artifact?.commit !== undefined && artifact.commit !== commit) return unknown("conflicting-source", "reconcile-visible-source-records");
  const observed = (completeness: string, nextAction: string): DiagnosticObservation => ({ provenance: { attemptId, head: commit, selectedHead, status, completeness }, nextAction });
  const missingArtifact = () => observed("artifact-missing", artifact?.retention === "pruned" ? "reexecute-from-frozen-inputs" : "restore-or-reexecute-artifact");
  const delivery = plain(value.delivery) ? value.delivery : undefined;
  const parentId = text(attempt.parentAttemptId);
  if (parentId) {
    const parents = attempts.filter(parent => parent.id === parentId);
    const events = Array.isArray(value.events) && value.events.length <= 128 ? value.events.filter(plain) : [];
    const linked = events.some(event => event.type === "retry.requested" && event.childAttemptId === attemptId && event.sourceAttemptId === parentId);
    if (parents.length !== 1 || !linked || parents[0]!.commit !== commit || !Number.isSafeInteger(attempt.seed) || parents[0]!.seed !== attempt.seed) return unknown("conflicting-source", "reconcile-visible-source-records");
    const retry = (observation: DiagnosticObservation) => ({ ...observation, retryOf: parentId, independentSamples: 1 });
    if (status === "running") return retry(observed("pending", "await-retry-result"));
    if (status === "failed" || status === "cancelled") return retry(observed("terminal-failure", `inspect-${status}-retry`));
    if (status === "unknown") return retry(observed("delivery-unresolved", "reconcile-dispatch-before-retry"));
    if (artifact?.present === false) return retry(missingArtifact());
    return retry(observed(artifact?.present === true ? "complete" : "artifact-unavailable", artifact?.present === true ? "use-terminal-retry-result" : "inspect-visible-source-records"));
  }
  // Retry identity must be validated before lost acknowledgement can describe the child.
  if (status === "unknown" && delivery?.acknowledged === false && delivery.effectObserved == null) return observed("delivery-unresolved", "reconcile-dispatch-before-retry");
  if (status === "succeeded" && artifact?.present === false) return missingArtifact();
  if (status === "succeeded" && artifact?.present === true) return observed("complete", selectedHead && commit !== selectedHead ? "run-fresh-selected-head" : "inspect-terminal-result");
  return observed("pending", status === "running" ? "await-attempt-result" : "inspect-visible-source-records");
}

if (import.meta.main) {
  try {
    const [inputFile, outputFile, ...extra] = process.argv.slice(2);
    if (!inputFile || !outputFile || extra.length) throw new Error("usage");
    const content = readTextBounded(resolve(inputFile), DIAGNOSTIC_BYTES, { noFollow: true });
    const observation = resolveDiagnosticFixture(JSON.parse(content));
    writeAtomic(resolve(outputFile), JSON.stringify({ v: 1, kind: "automated-source-resolution", authority: "harness-observed", ...observation }, null, 2) + "\n", DIAGNOSTIC_BYTES, 0o600);
  } catch {
    console.error("execution diagnose: malformed, unreadable or over-bound input/output; use bun scripts/execution-diagnose.ts INPUT OUTPUT with bounded UTF-8 JSON and an owned writable output directory");
    process.exitCode = 1;
  }
}
