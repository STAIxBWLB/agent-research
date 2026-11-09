import { onlyKeys, plain, sha256 } from "../study.ts";
import { canonical, validateProtocolDefinition, type ProtocolDefinition } from "./protocol.ts";
import type { CandidateStage, ProtocolV2 } from "./stages.ts";
import { reuseDigest, reuseIdentityText } from "./reuse-contract.ts";
export { validateReuseContract, type StageReuseContract } from "./reuse-contract.ts";

export const STAGE_REUSE_KEY_VERSION = 1;
export interface StageReuseEligibilityInput {
  protocol: ProtocolDefinition;
  stage: { kind: "candidate"; name: string } | { kind: "evaluator" };
  phase: string;
  mode?: "off" | "eligible";
  forceFresh?: boolean;
}
export type StageReuseReason = "force-fresh" | "mode-off" | "phase-fresh" | "evaluator-fresh" | "legacy-fresh" | "undeclared-contract" | "no-artifact-outputs" | "declared-pure-artifact";
/** Structural eligibility only; no current permission, gate, byte availability or hit is asserted. */
export interface StageReuseEligibility { v: 1; kind: "declaration-only"; eligible: boolean; reason: StageReuseReason }
export interface StageReuseKeyInput extends StageReuseEligibilityInput {
  studyId: string;
  populationSha256: string;
  codeTree: string;
  codeSnapshotSha256: string;
  inputHashes: Record<string, string>;
  seed: number;
  runtime: { semantics: string; producerVersion: string };
  platform: { os: string; arch: string; abi: string };
}
const ELIGIBILITY_KEYS = ["protocol", "stage", "phase", "mode", "forceFresh"];
function candidate(protocol: ProtocolDefinition, stage: StageReuseEligibilityInput["stage"]): CandidateStage | undefined {
  if (!plain(stage) || (stage.kind !== "candidate" && stage.kind !== "evaluator")) throw new Error("stage reuse selection: candidate or evaluator required");
  onlyKeys(stage, stage.kind === "candidate" ? ["kind", "name"] : ["kind"], "stage reuse selection");
  if (stage.kind === "evaluator") return undefined;
  reuseIdentityText(stage.name, "stage reuse candidate name", 32);
  if (protocol.v === 1) return undefined;
  const selected = protocol.candidate.stages.find(value => value.name === stage.name);
  if (!selected) throw new Error("stage reuse selection: declared candidate name required");
  return selected;
}
export function stageReuseEligibility(input: StageReuseEligibilityInput): StageReuseEligibility {
  if (!plain(input)) throw new Error("stage reuse eligibility: object required");
  onlyKeys(input, ELIGIBILITY_KEYS, "stage reuse eligibility");
  const protocol = validateProtocolDefinition(input.protocol), selected = candidate(protocol, input.stage);
  reuseIdentityText(input.phase, "stage reuse phase", 64);
  if (input.mode !== undefined && input.mode !== "off" && input.mode !== "eligible") throw new Error("stage reuse mode: off or eligible required");
  if (input.forceFresh !== undefined && typeof input.forceFresh !== "boolean") throw new Error("stage reuse forceFresh: boolean required");
  const result = (reason: StageReuseReason): StageReuseEligibility => ({ v: 1, kind: "declaration-only", eligible: reason === "declared-pure-artifact", reason });
  if (input.forceFresh) return result("force-fresh");
  if (input.mode !== "eligible") return result("mode-off");
  if (input.phase !== "investigate") return result("phase-fresh");
  if (input.stage.kind === "evaluator") return result("evaluator-fresh");
  if (protocol.v !== 2) return result("legacy-fresh");
  if (!selected?.reuse) return result("undeclared-contract");
  if (!Object.keys(selected.outputs).length) return result("no-artifact-outputs");
  return result("declared-pure-artifact");
}
/** Excludes candidate definitions: the selected stage and actual inputs bind local dataflow separately. */
function comparisonDomain(protocol: ProtocolV2) {
  const { candidate: _candidate, budget: _budget, ...domain } = protocol;
  return domain;
}
function inputIdentities(raw: unknown, stage: CandidateStage): Record<string, string> {
  if (!plain(raw)) throw new Error("stage reuse input hashes: object required");
  const names = Object.keys(stage.inputs);
  if (Object.keys(raw).length !== names.length || names.some(name => !Object.hasOwn(raw, name)) || Object.keys(raw).some(name => !names.includes(name))) throw new Error("stage reuse input hashes: every declared input needs exactly one digest and no undeclared inputs");
  return Object.fromEntries(names.map(name => [name, reuseDigest(raw[name], "stage reuse input digest")]));
}
/** A key is not a lookup, reuse receipt, independent observation or authorization to skip execution. */
export function stageReuseKey(input: StageReuseKeyInput): string {
  if (!plain(input)) throw new Error("stage reuse key: object required");
  onlyKeys(input, [...ELIGIBILITY_KEYS, "studyId", "populationSha256", "codeTree", "codeSnapshotSha256", "inputHashes", "seed", "runtime", "platform"], "stage reuse key");
  const declaration = stageReuseEligibility({ protocol: input.protocol, stage: input.stage, phase: input.phase, mode: input.mode, forceFresh: input.forceFresh });
  if (!declaration.eligible) throw new Error(`stage reuse key: ${declaration.reason}; a declared pure-artifact investigate candidate with eligible mode is required`);
  const protocol = validateProtocolDefinition(input.protocol);
  if (protocol.v !== 2) throw new Error("stage reuse key: protocol v2 required");
  const stage = candidate(protocol, input.stage)!;
  if (typeof input.studyId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(input.studyId)) throw new Error("stage reuse study: valid study identity required");
  if (!Number.isSafeInteger(input.seed) || !protocol.seeds.includes(input.seed)) throw new Error("stage reuse seed: declared integer seed required");
  if (!plain(input.runtime) || !plain(input.platform)) throw new Error("stage reuse runtime/platform: explicit version and ABI identities required");
  onlyKeys(input.runtime, ["semantics", "producerVersion"], "stage reuse runtime");
  onlyKeys(input.platform, ["os", "arch", "abi"], "stage reuse platform");
  return sha256(canonical({ v: STAGE_REUSE_KEY_VERSION, studyId: input.studyId, populationSha256: reuseDigest(input.populationSha256, "stage reuse frozen selection population digest"), domain: comparisonDomain(protocol), stage,
    codeTree: reuseDigest(input.codeTree, "stage reuse full code tree", 40), codeSnapshotSha256: reuseDigest(input.codeSnapshotSha256, "stage reuse frozen code digest"),
    inputHashes: inputIdentities(input.inputHashes, stage), seed: input.seed,
    runtime: { semantics: reuseIdentityText(input.runtime.semantics, "stage reuse runtime semantics"), producerVersion: reuseIdentityText(input.runtime.producerVersion, "stage reuse producer version") },
    platform: { os: reuseIdentityText(input.platform.os, "stage reuse operating system"), arch: reuseIdentityText(input.platform.arch, "stage reuse architecture"), abi: reuseIdentityText(input.platform.abi, "stage reuse platform ABI") },
  }));
}
