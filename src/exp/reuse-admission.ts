import { posix } from "node:path";
import { canonical } from "./protocol.ts";
import { plain } from "../study.ts";
import { stageReuseEligibility, stageReuseKey } from "./reuse.ts";
import { reuseSourceFacts, type StageReuseSourceFacts } from "./reuse-runtime.ts";
import { retainedOperation, type RetainedRef, type RetainedManifest } from "./retention.ts";
import { stageRetainedIdentity, type StageReuseReceipt } from "./pipeline.ts";
import { ARTIFACT_BYTES, ARTIFACT_FILES } from "./artifacts.ts";
import { OUTPUT_METADATA_BYTES } from "./metrics.ts";
import { spawnRunner } from "./executor.ts";
import type { Attempt, AttemptContext, AttemptStage, Evaluation } from "./attempts.ts";

export type ReuseDecision = { outcome: "fresh"; reason: string; key?: string; context?: StageReuseSourceFacts; verificationMs: number; materializationMs: number }
  | { outcome: "reused"; reason: "verified-hit"; key: string; context: StageReuseSourceFacts; verificationMs: number; materializationMs: number; source: RetainedRef; record: AttemptStage; receipt: StageReuseReceipt; outputs: Evaluation["outputs"]; manifestBytes: number };
function validManifest(attempt: Attempt, key: string, ref: RetainedRef, manifest: RetainedManifest): boolean {
  const stage = attempt.pipeline!.definition.candidate.stages[attempt.pipeline!.index]!;
  if (!plain(ref) || !/^[a-f0-9]{16}$/.test(ref.attemptId) || ref.attemptId === attempt.id || ref.stage !== stage.name || !/^[a-f0-9]{64}$/.test(ref.sha256) || !plain(manifest) || manifest.v !== 1 || manifest.studyId !== attempt.studyId || manifest.attemptId !== ref.attemptId || manifest.stage !== stage.name || manifest.reuseKey !== key || canonical(manifest.identity) !== canonical(stageRetainedIdentity(attempt)) || canonical(manifest.outputs) !== canonical(stage.outputs) || !Array.isArray(manifest.files) || manifest.files.length > ARTIFACT_FILES || Buffer.byteLength(JSON.stringify(manifest)) > OUTPUT_METADATA_BYTES) return false;
  const paths = new Set<string>(); let bytes = 0;
  for (const file of manifest.files) {
    if (!plain(file) || typeof file.path !== "string" || !file.path || Buffer.byteLength(file.path) > 4096 || file.path.startsWith("/") || file.path.includes("\\") || /\p{Cc}/u.test(file.path) || file.path.split("/").some(part => !part || part === "." || part === "..") || paths.has(file.path) || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return false;
    paths.add(file.path); bytes += file.bytes;
    if (bytes > ARTIFACT_BYTES) return false;
  }
  return true;
}
/** Caller holds the current stage ownership/policy fence; native lookup verifies and pins before returning. */
export async function prepareStageReuse(dir: string, attempt: Attempt, ctx: AttemptContext, sourceAttempt: (id: string) => Attempt): Promise<ReuseDecision> {
  let context: StageReuseSourceFacts | undefined;
  const started = performance.now(), pipeline = attempt.pipeline!, stage = pipeline.definition.candidate.stages[pipeline.index]!;
  const fresh = (reason: string, key?: string): ReuseDecision => ({ outcome: "fresh", reason, ...(key ? { key, ...(context ? { context } : {}) } : {}), verificationMs: performance.now() - started, materializationMs: 0 });
  if (!attempt.reuse || attempt.reuse.mode === "off") return fresh(attempt.reuse?.forceFresh ? "force-fresh" : "mode-off");
  if (["ablate", "final", "posthoc"].includes(attempt.run)) return fresh("phase-fresh");
  const eligibility = stageReuseEligibility({ protocol: pipeline.definition, stage: { kind: "candidate", name: stage.name }, phase: "investigate", mode: "eligible" });
  if (!eligibility.eligible) return fresh(eligibility.reason);
  const facts = await reuseSourceFacts(dir, attempt, ctx);
  if ("reason" in facts) return fresh(facts.reason);
  context = facts;
  const key = stageReuseKey({ protocol: pipeline.definition, stage: { kind: "candidate", name: stage.name }, phase: "investigate", mode: "eligible", studyId: attempt.studyId,
    codeTree: attempt.treeId, codeSnapshotSha256: pipeline.codeSnapshotHash!, inputHashes: pipeline.inputHashes, seed: attempt.seed, ...facts });
  if (attempt.reuse.forceFresh) return fresh("force-fresh", key);
  const result = await retainedOperation(attempt.executor, { op: "lookup", studyId: attempt.studyId, attemptId: attempt.id, stage: stage.name, key, expected: stageRetainedIdentity(attempt), outputs: stage.outputs }, ctx.runner ?? spawnRunner);
  if (result.hit !== true) return fresh(["missing", "pruned", "corrupt", "unsupported", "ineligible-source", "scan-cap"].includes(String(result.reason)) ? result.reason! : "unsupported", key);
  if (!result.ref || !result.manifest || !Number.isSafeInteger(result.manifestBytes) || result.manifestBytes! < 0 || result.manifestBytes! > OUTPUT_METADATA_BYTES || !validManifest(attempt, key, result.ref, result.manifest) || result.manifestBytes! < Buffer.byteLength(JSON.stringify(result.manifest))) return fresh("invalid-hit", key);
  let original: Attempt, record: AttemptStage | undefined;
  try {
    original = sourceAttempt(result.ref.attemptId);
    if (original.status === "running" || original.studyId !== attempt.studyId || !original.pipeline || original.treeId !== attempt.treeId || original.seed !== attempt.seed || original.pipeline.codeSnapshotHash !== pipeline.codeSnapshotHash || original.reuse?.stages[stage.name]?.outcome !== "fresh" || original.reuse.stages[stage.name]?.key !== key || canonical(original.executor) !== canonical(attempt.executor) || !original.sealing.candidateHasNoEvaluator || canonical(original.reuse?.stages[stage.name]?.context) !== canonical(facts)) return fresh("ineligible-source", key);
    const completed = original.pipeline.completed.find(parent => parent.name === stage.name && canonical(parent.ref) === canonical(result.ref) && !parent.reuse);
    record = completed?.record;
    if (!record && original.stage === "candidate" && original.pipeline.definition.candidate.stages[original.pipeline.index]?.name === stage.name) record = original.stages.candidate;
    const sourceDefinition = original.pipeline.definition.candidate.stages.find(value => value.name === stage.name);
    if (!record || record.exitCode !== 0 || record.containerId !== result.manifest.observed.containerId || record.network !== "none" || record.user !== attempt.stages.candidate?.user || record.image !== stage.image || canonical(record.argv) !== canonical(stage.command) || canonical(record.limits) !== canonical(attempt.protocol.limits) || canonical(sourceDefinition) !== canonical(stage)) return fresh("ineligible-source", key);
    const outputRoot = posix.join(original.executor.workdir, original.studyId, original.id, "stages", stage.name, "output");
    if (!Array.isArray(record.evidence?.outputs) || result.manifest.files.some(file => !record!.evidence!.outputs.some(observed => observed.path === posix.join(outputRoot, file.path) && observed.sha256 === file.sha256 && observed.bytes === file.bytes))) return fresh("invalid-hit", key);
  } catch { return fresh("source-unavailable", key); }
  const duration = Date.parse(record.endedAt ?? "") - Date.parse(record.startedAt);
  const wallSeconds = Number.isFinite(duration) && duration >= 0 ? duration / 1000 : "unknown";
  const gpuHours = wallSeconds !== "unknown" && Number.isFinite(record.limits.gpus) ? wallSeconds * record.limits.gpus / 3600 : "unknown";
  const verificationMs = performance.now() - started;
  const receipt: StageReuseReceipt = { v: 1, key, context: facts, source: result.ref, original: { wallSeconds, gpuHours, cpuSeconds: "unknown" }, verificationMs, materializationMs: 0 };
  return { outcome: "reused", reason: "verified-hit", key, context: facts, verificationMs, materializationMs: 0, source: result.ref, record, receipt,
    manifestBytes: result.manifestBytes!, outputs: result.manifest.files.map(file => ({ ...file, path: posix.join(attempt.executor.workdir, attempt.studyId, ".retained", "objects", result.ref!.attemptId, stage.name, "data", file.path) })) };
}
