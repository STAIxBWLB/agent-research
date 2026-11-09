import { plain, sha256 } from "../study.ts";
import { PROTOCOL_BYTES, canonical, validateProtocol, type Protocol } from "./protocol.ts";

/** T1 definition only. The v1 executor must never interpret this as a single candidate. */
export type StageInput = { task: string } | { stage: string; output: string };
export interface CandidateStage {
  name: string;
  image: string;
  command: string[];
  env?: Record<string, string>;
  seed: boolean;
  code: "snapshot";
  needs: string[];
  inputs: Record<string, StageInput>;
  outputs: Record<string, string>;
}
export interface ProtocolV2 extends Omit<Protocol, "v" | "candidate" | "inputs"> {
  v: 2;
  candidate: { stages: CandidateStage[] };
}
export const STAGE_LIMIT = 16, STAGE_PORT_LIMIT = 32;

function object(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plain(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw new Error(`${label}: object with declared fields required; remove unknown fields`);
  return raw;
}
function name(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(raw) || ["constructor", "prototype", "__proto__", "evaluator"].includes(raw)) throw new Error(`${label}: use a nonreserved lowercase name of 1..32 letters, digits, underscores or hyphens starting with a letter`);
  return raw;
}
function relativePath(raw: unknown, label: string): string {
  if (typeof raw !== "string" || raw.length > 256 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(raw) || raw.split("/").some(part => part === "." || part === "..")) throw new Error(`${label}: normalized relative path required; remove absolute paths, dot segments and unsafe characters`);
  return raw;
}
function ports(raw: unknown, label: string): [string, unknown][] {
  if (!plain(raw) || Object.keys(raw).length > STAGE_PORT_LIMIT) throw new Error(`${label}: object with at most ${STAGE_PORT_LIMIT} named ports required`);
  return Object.entries(raw).map(([key, value]) => [name(key, label), value]);
}
function outputs(raw: unknown, label: string): Record<string, string> {
  const entries: [string, string][] = [];
  for (const [key, value] of ports(raw, label)) {
    const path = relativePath(value, `${label}.${key}`);
    if (entries.some(([, other]) => path === other || path.startsWith(`${other}/`) || other.startsWith(`${path}/`))) throw new Error(`${label}: overlapping output paths; declare disjoint files or directories`);
    entries.push([key, path]);
  }
  return Object.fromEntries(entries);
}
function inputs(raw: unknown, prior: ReadonlyMap<string, CandidateStage>, label: string): Record<string, StageInput> {
  return Object.fromEntries(ports(raw, label).map(([key, value]): [string, StageInput] => {
    if (plain(value) && Object.hasOwn(value, "task")) {
      const input = object(value, ["task"], label), path = relativePath(input.task, `${label}.${key}.task`);
      if (path === "evaluator" || path.startsWith("evaluator/")) throw new Error(`${label}: evaluator inputs are private; choose a candidate task snapshot path`);
      return [key, { task: path }];
    }
    const input = object(value, ["stage", "output"], label), producer = name(input.stage, `${label}.${key}.stage`), output = name(input.output, `${label}.${key}.output`);
    const parent = prior.get(producer);
    if (!parent || !Object.hasOwn(parent.outputs, output)) throw new Error(`${label}: undeclared or forward stage output; refer only to a named output of an earlier stage`);
    return [key, { stage: producer, output }];
  }));
}
function candidateStages(raw: unknown, common: Protocol): CandidateStage[] {
  const candidate = object(raw, ["stages"], "candidate");
  if (!Array.isArray(candidate.stages) || !candidate.stages.length || candidate.stages.length > STAGE_LIMIT) throw new Error(`candidate.stages: declare 1..${STAGE_LIMIT} stages in execution order`);
  const prior = new Map<string, CandidateStage>();
  for (const rawStage of candidate.stages) {
    const s = object(rawStage, ["name", "image", "command", "env", "seed", "code", "needs", "inputs", "outputs"], "stage"), stageName = name(s.name, "stage.name");
    if (prior.has(stageName)) throw new Error("stage.name: duplicate; give each stage a unique name");
    if (typeof s.seed !== "boolean" || s.code !== "snapshot") throw new Error('stage: declare boolean seed use and code: "snapshot"; mutable code inputs are unsupported');
    if (!Array.isArray(s.needs) || s.needs.length > STAGE_LIMIT) throw new Error("stage.needs: declare an array of earlier stage names (empty allowed)");
    const needs = s.needs.map(value => name(value, "stage.needs"));
    if (new Set(needs).size !== needs.length || needs.some(value => !prior.has(value))) throw new Error("stage.needs: duplicate, cyclic or forward ordering edge; refer only to unique earlier stages");
    // Share v1 image/argv/env validation, bounds and secret/reserved-key refusals.
    const execution = validateProtocol({ ...common, candidate: { image: s.image, command: s.command, ...(s.env === undefined ? {} : { env: s.env }) } }).candidate;
    prior.set(stageName, { name: stageName, ...execution, seed: s.seed, code: "snapshot", needs,
      inputs: inputs(s.inputs, prior, "stage.inputs"), outputs: outputs(s.outputs, "stage.outputs") });
  }
  return [...prior.values()];
}

/** Pure preflight: no study writes, process calls, mounts or artifact availability claims. */
export function validateStageProtocol(raw: unknown): ProtocolV2 {
  const p = object(raw, ["v", "method", "candidate", "evaluator", "metrics", "seeds", "limits", "network", "budget"], "protocol");
  if (p.v !== 2) throw new Error("protocol.v: unsupported stage version; use a compatible ares release, keeping the original definition unchanged");
  // Validate common fields with the authoritative v1 validator; no common bound is multiplied.
  const common = validateProtocol({ ...p, v: 1, candidate: p.evaluator });
  const { v: _v, candidate: _candidate, inputs: _inputs, ...base } = common;
  const result: ProtocolV2 = { ...base, v: 2, candidate: { stages: candidateStages(p.candidate, common) } };
  if (Buffer.byteLength(JSON.stringify(result, null, 2) + "\n") > PROTOCOL_BYTES) throw new Error(`protocol: too large; reduce the formatted protocol to at most ${PROTOCOL_BYTES} bytes`);
  return result;
}
/** Every stage, declared order, ordering/data edge and execution field participates. Budget stays seal-only. */
export function stageProtocolHash(protocol: ProtocolV2): string {
  const { budget: _budget, ...identity } = validateStageProtocol(protocol);
  return sha256(canonical(identity));
}
/** Pure protocol/task component of a future design seal; not an approval or full study binding. */
export function stageDesignBinding(protocol: ProtocolV2, treeHash: string): string {
  if (!/^[a-f0-9]{64}$/.test(treeHash)) throw new Error("task tree: expected a SHA-256 identity from bounded task snapshot validation");
  return sha256(canonical({ protocol: validateStageProtocol(protocol), treeHash }));
}
