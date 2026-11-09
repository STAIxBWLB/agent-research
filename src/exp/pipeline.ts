import type { StageReuseSourceFacts } from "./reuse-runtime.ts";
import { posix } from "node:path";
import { canonical, type Protocol, type ProtocolDefinition } from "./protocol.ts";
import { sha256 } from "../study.ts";
import { type ProtocolV2 } from "./stages.ts";
import { retainedOperation, type RetainedRef, type RetainedInput } from "./retention.ts";
import type { Attempt, AttemptContext, AttemptStage } from "./attempts.ts";
import { spawnRunner, type ContainerPaths } from "./executor.ts";
import { EvidenceError, OUTPUT_METADATA_BYTES } from "./metrics.ts";
import { version } from "../../package.json";

export interface StageReuseReceipt {
  v: 1; key: string; source: RetainedRef; context?: StageReuseSourceFacts;
  original: { wallSeconds: number | "unknown"; gpuHours: number | "unknown"; cpuSeconds: "unknown" };
  verificationMs: number; materializationMs: number; failureMs?: number;
}
export interface AttemptReuseState {
  mode: "off" | "eligible"; forceFresh: boolean;
  stages: Record<string, { outcome: "fresh" | "reused"; reason: string; key?: string; source?: RetainedRef; context?: StageReuseSourceFacts; verificationMs: number; materializationMs: number }>;
  verificationMs: number; materializationMs: number; failureMs?: number;
}
export interface PipelineState {
  definition: ProtocolV2;
  index: number;
  preflightRevision?: number;
  completed: { name: string; record: AttemptStage; ref: RetainedRef; reuse?: StageReuseReceipt }[];
  inputHashes: Record<string, string>;
  taskTreeHash: string;
  codeSnapshotHash?: string;
  sidecarBytes?: number;
  reusedSidecarBytes?: number;
  materializationMs?: Record<string, number>;
}
/** Execution projection is transient; v2 identity always binds the original definition. */
export function executionView(definition: ProtocolDefinition, index = 0): Protocol {
  if (definition.v === 1) return definition;
  const stage = definition.candidate.stages[index];
  if (!stage) throw new Error("pipeline: missing stage; restore the frozen attempt definition");
  const { candidate: _candidate, v: _v, ...common } = definition;
  return { ...common, v: 1, candidate: { image: stage.image, command: stage.command, ...(stage.env ? { env: stage.env } : {}) } };
}
export function pipelineRoot(attempt: Attempt): string { return posix.join(attempt.executor.workdir, attempt.studyId, attempt.id); }
export function pipelinePaths(attempt: Attempt): ContainerPaths {
  const root = pipelineRoot(attempt), stage = attempt.pipeline!.definition.candidate.stages[attempt.pipeline!.index]!;
  return { snapshot: posix.join(root, "snapshot"), output: attempt.stage === "evaluator" ? posix.join(root, "candidate") : posix.join(root, "stages", stage.name, "output"), evaluator: posix.join(root, "task", "evaluator"), result: posix.join(root, "result") };
}
export function pipelineInputRoot(attempt: Attempt): string | undefined {
  if (!attempt.pipeline || attempt.stage === "evaluator") return undefined;
  return posix.join(pipelineRoot(attempt), "stages", attempt.pipeline.definition.candidate.stages[attempt.pipeline.index]!.name, "inputs");
}
/** Verify retained parents and materialize a fresh, private, read-only input snapshot per stage. */
export async function materializePipeline(attempt: Attempt, ctx: AttemptContext): Promise<{ inputHashes: Record<string, string>; materializationMs: number }> {
  const started = performance.now();
  const pipeline = attempt.pipeline!, root = pipelineRoot(attempt), inputs: Record<string, RetainedInput> = {};
  if (attempt.stage === "evaluator") {
    for (const parent of pipeline.completed) inputs[parent.name] = { ref: parent.ref };
  } else {
    const stage = pipeline.definition.candidate.stages[pipeline.index]!;
    for (const [name, input] of Object.entries(stage.inputs)) {
      if ("task" in input) inputs[name] = input;
      else {
        const parent = pipeline.completed.find(value => value.name === input.stage);
        if (!parent) throw new Error(`pipeline ${stage.name}.${name}: parent seal unavailable; reconcile without rerunning uncertain work`);
        inputs[name] = { ref: parent.ref, output: input.output };
      }
    }
  }
  if (!pipeline.codeSnapshotHash) throw new Error("pipeline: frozen code snapshot receipt missing; reconcile without launching");
  const result = await retainedOperation(attempt.executor, { op: "materialize", studyId: attempt.studyId, attemptId: attempt.id,
    stage: attempt.stage === "evaluator" ? "evaluator" : pipeline.definition.candidate.stages[pipeline.index]!.name,
    expectedTaskTreeHash: pipeline.taskTreeHash, codeRoot: attempt.paths.snapshot, expectedCodeHash: pipeline.codeSnapshotHash, target: attempt.stage === "evaluator" ? posix.join(root, "candidate") : pipelineInputRoot(attempt)!, taskRoot: posix.join(root, "task"), inputs }, ctx.runner ?? spawnRunner);
  return { inputHashes: result.inputHashes ?? {}, materializationMs: performance.now() - started };
}
export function stageRetainedIdentity(attempt: Attempt) {
  const stage = attempt.pipeline!.definition.candidate.stages[attempt.pipeline!.index]!;
  return { definitionHash: sha256(canonical(stage)), inputHashes: attempt.pipeline!.inputHashes, codeTree: attempt.treeId, image: stage.image,
    argvHash: sha256(canonical(stage.command)), envHash: sha256(canonical(stage.env ?? {})), seed: attempt.seed, producerVersion: version };
}
export async function sealPipeline(attempt: Attempt, ctx: AttemptContext): Promise<RetainedRef> {
  const pipeline = attempt.pipeline!, stage = pipeline.definition.candidate.stages[pipeline.index]!, record = attempt.stages.candidate!;
  if (!record.containerId || !record.endedAt || record.exitCode !== 0) throw new Error(`pipeline ${stage.name}: observed successful termination required before sealing`);
  const metadataLimit = OUTPUT_METADATA_BYTES - Buffer.byteLength(JSON.stringify(attempt.outputs, null, 2)) - (pipeline.reusedSidecarBytes ?? 0);
  if (metadataLimit < 0) throw new EvidenceError("artifact-limit", "pipeline: output metadata exhausts the shared sidecar budget");
  const result = await retainedOperation(attempt.executor, { op: "seal", studyId: attempt.studyId, attemptId: attempt.id, stage: stage.name,
    source: attempt.paths.output, outputs: stage.outputs, metadataLimit, observed: { containerId: record.containerId, endedAt: record.endedAt, exitCode: 0 },
    ...(attempt.reuse?.stages[stage.name]?.key ? { reuseKey: attempt.reuse.stages[stage.name]!.key! } : {}),
    identity: stageRetainedIdentity(attempt) }, ctx.runner ?? spawnRunner);
  if (!result.manifest || result.manifest.files.some(file => !attempt.outputs.some(observed => observed.path === posix.join(attempt.paths.output, file.path) && observed.sha256 === file.sha256 && observed.bytes === file.bytes))) throw new Error(`pipeline ${stage.name}: retained bytes differ from observed output evidence`);
  pipeline.sidecarBytes = (result.sidecarBytes ?? 0) + (pipeline.reusedSidecarBytes ?? 0);
  if (!result.sha256) throw new Error(`pipeline ${stage.name}: missing manifest digest; reconcile the terminated stage`);
  return { attemptId: attempt.id, stage: stage.name, sha256: result.sha256 };
}
