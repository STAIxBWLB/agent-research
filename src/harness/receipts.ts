import {HARNESS_MODEL_BYTES} from "./limits.ts";
import {hasHarnessCredential} from "./privacy.ts";
/** Ares-owned synthetic fixture projections, not the wire schemas or assurance receipts of agent-hub producers. */
import {plain} from "../study.ts";
import {validateExecutionReference, type ExecutionReferenceV1} from "../provenance.ts";

export const HARNESS_FIXTURE_BYTES = 65_536;
export interface VariantFixtureProjectionV1 {
  v: 1; projectKey: string; taskId: string; revision: number; baselineRoleId: string; baselineRoleHash: string; baselineBytes: number;
  candidateHash: string; candidateBytes: number; author: string; problemHypothesis: string; expectedObservableDifference: string; rationale: string; evidence: ExecutionReferenceV1[];
}
export interface ProbeFixtureProjectionV1 {
  v: 1; id: string; experimentId: string; arm: string; taskId: string; taskRevision: number; taskInputHash: string; workerEffectiveInputHash: string; codeTreeHash: string; baselineHash: string; guidanceHash: string; baselineContextHash: string; libraryHash: string;
  requestedModel: string; requestedConfigHash: string; servedModel: string | null; servedConfigHash: string | null;
  toolsetHash: string; hostRuntimeHash: string; budgetHash: string; outputManifestHash: string | null;
  state: "succeeded" | "failed" | "cancelled" | "unknown" | "unavailable"; usage: "unknown"; samplingControl: "unknown";
}
const VARIANT = ["v", "projectKey", "taskId", "revision", "baselineRoleId", "baselineRoleHash", "baselineBytes", "candidateHash", "candidateBytes", "author", "problemHypothesis", "expectedObservableDifference", "rationale", "evidence"];
const PROBE = ["v", "id", "experimentId", "arm", "taskId", "taskRevision", "taskInputHash", "workerEffectiveInputHash", "codeTreeHash", "baselineHash", "guidanceHash", "baselineContextHash", "libraryHash", "requestedModel", "requestedConfigHash", "servedModel", "servedConfigHash", "toolsetHash", "hostRuntimeHash", "budgetHash", "outputManifestHash", "state", "usage", "samplingControl"];
function fail(field: string): never {throw new Error(`harness fixture ${field}: invalid synthetic projection; correct the bounded ares-owned fixture fields without paths, transcripts, environment, credentials or assurance claims before retrying`);}
function object(raw: unknown, fields: string[], kind: string): Record<string, unknown> {
  let value = raw;
  if (typeof value === "string") {if (Buffer.byteLength(value) > HARNESS_FIXTURE_BYTES) fail(`${kind} bound`); try {value = JSON.parse(value);} catch {fail(`${kind} JSON`);}}
  if (!plain(value) || Object.keys(value).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key)) || value.v !== 1) fail(`${kind} shape/version`);
  try {if (Buffer.byteLength(JSON.stringify(value)) > HARNESS_FIXTURE_BYTES) fail(`${kind} bound`);} catch {fail(`${kind} bound/JSON`);}
  return value;
}
function text(raw: unknown, field: string, bound = 256): string {
  if (typeof raw !== "string" || !raw.trim() || Buffer.byteLength(raw) > bound || raw.includes("\0") || hasHarnessCredential(raw)) fail(field);
  return raw;
}
function hash(raw: unknown, field: string): string {if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) fail(field); return raw;}
function integer(raw: unknown, field: string, min: number, max: number): number {if (!Number.isSafeInteger(raw) || Number(raw) < min || Number(raw) > max) fail(field); return raw as number;}
function model(raw: unknown, field: string): string {const value = text(raw, field, HARNESS_MODEL_BYTES); if (/[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) fail(field); return value;}
export function parseVariantFixture(raw: unknown): VariantFixtureProjectionV1 {
  const value = object(raw, VARIANT, "variant");
  if (!Array.isArray(value.evidence) || value.evidence.length > 16) fail("variant evidence");
  const evidence = value.evidence.map(raw => {
    let ref: ExecutionReferenceV1; try {ref = validateExecutionReference(raw);} catch {return fail("variant evidence");}
    text(ref.projectKey, "variant evidence projectKey"); text(ref.id, "variant evidence id"); if (ref.revision !== undefined) text(ref.revision, "variant evidence revision", 128); return ref;
  });
  return {v: 1, projectKey: text(value.projectKey, "projectKey"), taskId: text(value.taskId, "taskId"), revision: integer(value.revision, "revision", 1, Number.MAX_SAFE_INTEGER),
    baselineRoleId: text(value.baselineRoleId, "baselineRoleId", 128), baselineRoleHash: hash(value.baselineRoleHash, "baselineRoleHash"), baselineBytes: integer(value.baselineBytes, "baselineBytes", 0, 8192),
    candidateHash: hash(value.candidateHash, "candidateHash"), candidateBytes: integer(value.candidateBytes, "candidateBytes", 0, 8192), author: text(value.author, "author", 128),
    problemHypothesis: text(value.problemHypothesis, "problemHypothesis", 2000), expectedObservableDifference: text(value.expectedObservableDifference, "expectedObservableDifference", 2000), rationale: text(value.rationale, "rationale", 2000), evidence};
}
export function parseProbeFixture(raw: unknown): ProbeFixtureProjectionV1 {
  const value = object(raw, PROBE, "probe");
  if (!["succeeded", "failed", "cancelled", "unknown", "unavailable"].includes(String(value.state)) || value.usage !== "unknown" || value.samplingControl !== "unknown") fail("probe outcome/usage/sampling");
  return {v: 1, id: text(value.id, "id"), experimentId: text(value.experimentId, "experimentId"), arm: text(value.arm, "arm"), taskId: text(value.taskId, "taskId"), taskRevision: integer(value.taskRevision, "taskRevision", 1, Number.MAX_SAFE_INTEGER),
    taskInputHash: hash(value.taskInputHash, "taskInputHash"), workerEffectiveInputHash: hash(value.workerEffectiveInputHash, "workerEffectiveInputHash"), codeTreeHash: hash(value.codeTreeHash, "codeTreeHash"), baselineHash: hash(value.baselineHash, "baselineHash"), guidanceHash: hash(value.guidanceHash, "guidanceHash"), baselineContextHash: hash(value.baselineContextHash, "baselineContextHash"), libraryHash: hash(value.libraryHash, "libraryHash"),
    requestedModel: model(value.requestedModel, "requestedModel"), requestedConfigHash: hash(value.requestedConfigHash, "requestedConfigHash"), servedModel: value.servedModel === null ? null : model(value.servedModel, "servedModel"), servedConfigHash: value.servedConfigHash === null ? null : hash(value.servedConfigHash, "servedConfigHash"),
    toolsetHash: hash(value.toolsetHash, "toolsetHash"), hostRuntimeHash: hash(value.hostRuntimeHash, "hostRuntimeHash"), budgetHash: hash(value.budgetHash, "budgetHash"), outputManifestHash: value.outputManifestHash === null ? null : hash(value.outputManifestHash, "outputManifestHash"), state: value.state as ProbeFixtureProjectionV1["state"], usage: "unknown", samplingControl: "unknown"};
}
export interface ProbeFixtureComparison {compatible: boolean; matched: false; sourceStrength: "synthetic-fixture"; endToEndEvaluation: "unavailable"; reasons: string[]; confounders: string[]}
export function compareProbeFixtures(left: ProbeFixtureProjectionV1, right: ProbeFixtureProjectionV1): ProbeFixtureComparison {
  const a = parseProbeFixture(left), b = parseProbeFixture(right), reasons: string[] = [];
  const keys = ["experimentId", "taskId", "taskRevision", "taskInputHash", "baselineHash", "baselineContextHash", "libraryHash", "codeTreeHash", "hostRuntimeHash", "toolsetHash", "requestedModel", "requestedConfigHash", "servedModel", "servedConfigHash", "budgetHash"] as const;
  for (const key of keys) if (a[key] !== b[key]) reasons.push(`${key}-mismatch`);
  for (const [label, probe] of [["left", a], ["right", b]] as const) {
    if (probe.servedModel === null) reasons.push(`${label}-served-model-unavailable`); else if (probe.servedModel !== probe.requestedModel) reasons.push(`${label}-model-fallback`);
    if (probe.servedConfigHash === null) reasons.push(`${label}-served-config-unavailable`); else if (probe.servedConfigHash !== probe.requestedConfigHash) reasons.push(`${label}-config-fallback`);
  }
  if (a.guidanceHash === b.guidanceHash && a.workerEffectiveInputHash !== b.workerEffectiveInputHash) reasons.push("workerEffectiveInputHash-mismatch");
  return {compatible: reasons.length === 0, matched: false, sourceStrength: "synthetic-fixture", endToEndEvaluation: "unavailable", reasons, confounders: ["synthetic-fixture", "producer-unavailable", "sampling-unknown"]};
}
/** No real producer wire reader exists here; absent and denied addresses deliberately look identical. */
export function realHubProbeUnavailable(_address?: unknown) {
  return {state: "unavailable", matched: false, sourceStrength: "producer-unavailable", endToEndEvaluation: "unavailable", reasons: ["producer-unavailable"]} as const;
}
