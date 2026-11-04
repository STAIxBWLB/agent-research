import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../commands-table.ts";
import { boundedText, commit, onlyKeys, plain, readJsonFile, sha256, type Actor } from "../study.ts";

export const PLAN_BYTES = 65_536;
export const STEP_COMMANDS = ["lit.search", "lit.verify", "lit.bib", "cite.check", "attempt.run"] as const;
export type StepCommand = typeof STEP_COMMANDS[number];
type BaseNode = { id: string; needs: string[] };
export type PlanNode = BaseNode & (
  { kind: "step"; command: StepCommand; args: Record<string, string | number | boolean> } |
  { kind: "hub"; task: { title: string; unit: string } } |
  { kind: "gate"; binds: string[] }
);
export interface PlanDefinition { v: 1; revision: number; nodes: PlanNode[]; edges: [string, string][] }
function nodeId(raw: unknown): string {
  const id = boundedText(raw, "plan node id", 128);
  if (Buffer.byteLength(id) > 128) throw new Error("plan node id: at most 128 bytes");
  return id;
}
function references(raw: unknown, name: string): string[] {
  if (!Array.isArray(raw) || raw.length > 128) throw new Error(`${name}: at most 128 node ids required`);
  return raw.map(nodeId);
}
function stepArgs(raw: unknown, command: StepCommand): Record<string, string | number | boolean> {
  if (!plain(raw)) throw new Error("plan step.args: object required");
  const spec = COMMANDS.find(c => c.name === command.replace(".", " "))!;
  const args: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    const option = Object.hasOwn(spec.options, `--${key}`) ? spec.options[`--${key}`] : undefined;
    if (!option) throw new Error(`plan ${command}: unknown option ${key}`);
    if (option === "flag" ? typeof value !== "boolean" : !["string", "number"].includes(typeof value)) throw new Error(`plan ${command}.${key}: ${option === "flag" ? "boolean flag" : "string or number value"} required`);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`plan ${command}.${key}: finite value required`);
    if (typeof value === "string") boundedText(value, `plan ${command}.${key}`, 4096);
    args[key] = value as string | number | boolean;
  }
  if (command === "attempt.run") for (const key of ["repo", "commit"]) if (!Object.hasOwn(args, key)) throw new Error(`plan attempt.run: required option ${key}`);
  return args;
}
export function validatePlan(raw: unknown): PlanDefinition {
  if (!plain(raw)) throw new Error("plan: object required");
  onlyKeys(raw, ["v", "revision", "nodes", "edges"], "plan");
  if (raw.v !== 1) throw new Error("plan: unsupported v (expected 1)");
  const revision = raw.revision ?? 1;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error("plan: revision must be a positive safe integer");
  if (!Array.isArray(raw.nodes) || raw.nodes.length > 128) throw new Error("plan: at most 128 nodes required");
  if (!Array.isArray(raw.edges) || raw.edges.length > 512) throw new Error("plan: at most 512 edges required");
  const nodes: PlanNode[] = raw.nodes.map((n: unknown) => {
    if (!plain(n)) throw new Error("plan node: object required");
    const id = nodeId(n.id), needs = n.needs === undefined ? [] : references(n.needs, "plan needs");
    const base = { id, needs };
    switch (n.kind) {
      case "step": {
        onlyKeys(n, ["id", "kind", "needs", "command", "args"], "plan step");
        if (!STEP_COMMANDS.includes(n.command as StepCommand)) throw new Error("plan step: unknown command");
        const command = n.command as StepCommand;
        return { ...base, kind: "step", command, args: stepArgs(n.args ?? {}, command) };
      }
      case "hub": {
        onlyKeys(n, ["id", "kind", "needs", "task"], "plan hub");
        if (!plain(n.task)) throw new Error("plan hub.task: object required");
        onlyKeys(n.task, ["title", "unit"], "plan hub.task");
        return { ...base, kind: "hub", task: { title: boundedText(n.task.title, "plan hub.task.title", 500), unit: boundedText(n.task.unit, "plan hub.task.unit", 128) } };
      }
      case "gate":
        onlyKeys(n, ["id", "kind", "needs", "binds"], "plan gate");
        return { ...base, kind: "gate", binds: references(n.binds, "plan gate.binds") };
      default: throw new Error("plan node: unknown node kind");
    }
  });
  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length) throw new Error("plan: duplicate node id");
  const edges: [string, string][] = raw.edges.map((e: unknown) => {
    if (!Array.isArray(e) || e.length !== 2) throw new Error("plan edge: pair required");
    return [nodeId(e[0]), nodeId(e[1])];
  });
  const parents = new Map(nodes.map(n => [n.id, new Set(n.needs)]));
  for (const [from, to] of edges) {
    if (!ids.has(from) || !ids.has(to)) throw new Error("plan edge: missing endpoint");
    parents.get(to)!.add(from);
  }
  for (const n of nodes) for (const p of n.needs) if (!ids.has(p)) throw new Error("plan needs: missing endpoint");
  const visiting = new Set<string>(), visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error("plan: cycle detected");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const parent of parents.get(id)!) visit(parent);
    visiting.delete(id); visited.add(id);
  }
  for (const n of nodes) visit(n.id);
  const ancestorCache = new Map<string, Set<string>>();
  function ancestors(id: string): Set<string> {
    const cached = ancestorCache.get(id);
    if (cached) return cached;
    const result = new Set<string>();
    for (const parent of parents.get(id)!) {
      result.add(parent);
      for (const ancestor of ancestors(parent)) result.add(ancestor);
    }
    ancestorCache.set(id, result);
    return result;
  }
  for (const n of nodes) if (n.kind === "gate") for (const bound of n.binds) {
    if (!ids.has(bound) || !ancestors(n.id).has(bound)) throw new Error("plan gate.binds: node must be upstream");
  }
  const result: PlanDefinition = { v: 1, revision: revision as number, nodes, edges };
  if (Buffer.byteLength(JSON.stringify(result, null, 2) + "\n") > PLAN_BYTES) throw new Error(`plan: exceeds ${PLAN_BYTES} bytes`);
  return result;
}
export function readPlan(dir: string): PlanDefinition | undefined {
  const file = join(dir, "plan.json");
  if (!existsSync(file)) return undefined;
  const raw: unknown = readJsonFile(file, PLAN_BYTES);
  if (!plain(raw) || raw.revision === undefined) throw new Error("plan: stored revision required");
  return validatePlan(raw);
}
/** Caller holds the study lock; definition and initial state share one transaction. */
export function setPlan(dir: string, raw: unknown, actor: Actor) {
  const definition = validatePlan(raw), previous = readPlan(dir);
  definition.revision = (previous?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(definition.revision)) throw new Error("plan: revision exhausted");
  const text = JSON.stringify(definition, null, 2) + "\n";
  commit(dir, [[join(dir, "plan.json"), text, PLAN_BYTES]], [{ actor, type: "plan.set", data: { revision: definition.revision, definition, state: "paused", sha256: sha256(text) } }]);
  return { definition, state: "paused" as const };
}
