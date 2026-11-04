import { existsSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../commands-table.ts";
import { boundedText, commit, onlyKeys, plain, readJsonFile, sha256, type Actor } from "../study.ts";

export const PLAN_BYTES = 65_536;
export const STEP_COMMANDS = ["lit.search", "lit.verify", "lit.bib", "cite.check", "attempt.run", "investigate.close"] as const;
export type StepCommand = typeof STEP_COMMANDS[number];
export type StepArgs = Record<string, string | number | boolean | string[]>;
type BaseNode = { id: string; needs: string[] };
export type PlanNode = BaseNode & (
  { kind: "step"; command: StepCommand; args: StepArgs } |
  { kind: "hub"; campaign: string; unit: string } |
  { kind: "gate"; binds: string[] }
);
export interface PlanDefinition { v: 1; revision: number; nodes: PlanNode[]; edges: [string, string][] }
const retry = "correct the definition and run ares plan set again";
const compatible = "use an ares version that supports this plan, keeping plan.json unchanged";
function nodeId(raw: unknown, what = "plan node id"): string {
  const id = boundedText(raw, what, 128);
  if (Buffer.byteLength(id) > 128) throw new Error(`${what}: at most 128 bytes`);
  return id;
}
function references(raw: unknown, name: string): string[] {
  if (!Array.isArray(raw) || raw.length > 128) throw new Error(`${name}: at most 128 node ids required`);
  return raw.map((id, i) => nodeId(id, `${name}[${i}]`));
}
function stepArgs(raw: unknown, command: StepCommand, id: string): StepArgs {
  const where = `plan step ${id} (${command})`;
  if (!plain(raw)) throw new Error(`${where}.args: object required`);
  const spec = COMMANDS.find(c => c.name === command.replace(".", " "))!;
  const args: StepArgs = {};
  for (const [key, value] of Object.entries(raw)) {
    const field = `${where}.args.${key}`;
    if (key === "json" || (command === "attempt.run" && key === "detach")) throw new Error(`${field}: controller-owned option; remove ${key} and run ares plan set again`);
    if (command === "lit.search" && key === "query") {
      const query = boundedText(value, field, 1000);
      if (Buffer.byteLength(query) > 1000) throw new Error(`${field}: at most 1000 bytes`);
      args[key] = query; continue;
    }
    if (command === "cite.check" && key === "draft") {
      args[key] = boundedText(value, field, 4096); continue;
    }
    if (command === "lit.verify" && key === "ids") {
      if (!Array.isArray(value) || value.length > 500) throw new Error(`${field}: array of at most 500 candidate ids required`);
      args[key] = value.map((item, i) => boundedText(item, `${field}[${i}]`, 300)); continue;
    }
    const option = Object.hasOwn(spec.options, `--${key}`) ? spec.options[`--${key}`] : undefined;
    if (!option) throw new Error(`${field}: unknown option ${key}`);
    if (option === "flag" ? typeof value !== "boolean" : !["string", "number"].includes(typeof value)) throw new Error(`${field}: ${option === "flag" ? "boolean flag" : "string or number value"} required`);
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`${field}: finite value required`);
    if (typeof value === "string") boundedText(value, field, 4096);
    args[key] = value as string | number | boolean;
  }
  const required = command === "attempt.run" ? ["repo", "commit"] : command === "lit.search" ? ["query"] : command === "cite.check" ? ["draft"] : [];
  for (const key of required) if (!Object.hasOwn(args, key)) throw new Error(`${where}: required option ${key}; add args.${key} and run ares plan set again`);
  return args;
}
export function validatePlan(raw: unknown): PlanDefinition {
  try { return validateDefinition(raw); }
  catch (error) {
    const message = error instanceof Error ? error.message : "plan: invalid definition";
    throw new Error(message.includes(compatible) || message.includes("run ares plan set again") ? message : `${message}; ${retry}`);
  }
}
function validateDefinition(raw: unknown): PlanDefinition {
  if (!plain(raw)) throw new Error("plan: object required");
  if (raw.v !== 1) throw new Error(`plan: unsupported v ${String(raw.v)} (expected 1); ${compatible}`);
  onlyKeys(raw, ["v", "revision", "nodes", "edges"], "plan");
  const revision = raw.revision ?? 1;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) throw new Error("plan: revision must be a positive safe integer");
  if (!Array.isArray(raw.nodes) || raw.nodes.length > 128) throw new Error("plan: at most 128 nodes required");
  if (!Array.isArray(raw.edges) || raw.edges.length > 512) throw new Error("plan: at most 512 edges required");
  const nodes: PlanNode[] = raw.nodes.map((n: unknown, index: number) => {
    if (!plain(n)) throw new Error(`plan node[${index}]: object required`);
    const id = nodeId(n.id, `plan node[${index}].id`), needs = n.needs === undefined ? [] : references(n.needs, `plan node ${String(n.id)}.needs`);
    const base = { id, needs };
    switch (n.kind) {
      case "step": {
        onlyKeys(n, ["id", "kind", "needs", "command", "args"], `plan step ${id}`);
        if (!STEP_COMMANDS.includes(n.command as StepCommand)) throw new Error(`plan step ${id}: unknown command ${String(n.command)} (allowed: ${STEP_COMMANDS.join(", ")})`);
        const command = n.command as StepCommand;
        return { ...base, kind: "step", command, args: stepArgs(n.args ?? {}, command, id) };
      }
      case "hub": {
        onlyKeys(n, ["id", "kind", "needs", "campaign", "unit"], `plan hub ${id}`);
        return { ...base, kind: "hub", campaign: nodeId(n.campaign, `plan hub ${id}.campaign`), unit: nodeId(n.unit, `plan hub ${id}.unit`) };
      }
      case "gate":
        onlyKeys(n, ["id", "kind", "needs", "binds"], `plan gate ${id}`);
        return { ...base, kind: "gate", binds: references(n.binds, `plan gate ${id}.binds`) };
      default: throw new Error(`plan node ${id}: unknown node kind ${String(n.kind)}; ${compatible}`);
    }
  });
  const ids = new Set(nodes.map(n => n.id));
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) throw new Error(`plan: duplicate node id ${n.id}; rename the duplicate node and update its references`);
    seen.add(n.id);
  }
  const edges: [string, string][] = raw.edges.map((e: unknown, index: number) => {
    if (!Array.isArray(e) || e.length !== 2) throw new Error(`plan edge[${index}]: pair required`);
    return [nodeId(e[0], `plan edge[${index}].from`), nodeId(e[1], `plan edge[${index}].to`)];
  });
  const parents = new Map(nodes.map(n => [n.id, new Set(n.needs)]));
  for (const [from, to] of edges) {
    if (!ids.has(from) || !ids.has(to)) throw new Error(`plan edge [${from}, ${to}]: missing endpoint, no node ${!ids.has(from) ? from : to}; add that node or remove this edge`);
    parents.get(to)!.add(from);
  }
  for (const n of nodes) for (const p of n.needs) if (!ids.has(p)) throw new Error(`plan node ${n.id}.needs: missing endpoint, no node ${p}; add that node or remove this dependency`);
  const visiting = new Set<string>(), visited = new Set<string>();
  const stack: string[] = [];
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`plan: cycle through ${[...stack.slice(stack.indexOf(id)), id].reverse().join(" -> ")}; remove one dependency and run ares plan set again`);
    if (visited.has(id)) return;
    visiting.add(id); stack.push(id);
    for (const parent of parents.get(id)!) visit(parent);
    stack.pop(); visiting.delete(id); visited.add(id);
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
    if (!ids.has(bound) || !ancestors(n.id).has(bound)) throw new Error(`plan gate ${n.id} binds ${bound}, which is not upstream; add an upstream dependency or remove this binding`);
  }
  const result: PlanDefinition = { v: 1, revision: revision as number, nodes, edges };
  if (Buffer.byteLength(JSON.stringify(result, null, 2) + "\n") > PLAN_BYTES) throw new Error(`plan: exceeds ${PLAN_BYTES} bytes`);
  return result;
}
export function readPlan(dir: string): PlanDefinition | undefined {
  const file = join(dir, "plan.json");
  if (!existsSync(file)) return undefined;
  const raw: unknown = readJsonFile(file, PLAN_BYTES);
  const definition = validatePlan(raw);
  if (!plain(raw) || raw.revision === undefined) throw new Error(`plan.json: stored revision required; restore a revisioned definition before running ares plan set again`);
  return definition;
}
/** Caller holds the study lock; definition and initial state share one transaction. */
export function setPlan(dir: string, raw: unknown, actor: Actor) {
  const definition = validatePlan(raw), previous = readPlan(dir);
  definition.revision = (previous?.revision ?? 0) + 1;
  if (!Number.isSafeInteger(definition.revision)) throw new Error("plan.revision: exhausted; create a new study before setting another plan");
  const text = JSON.stringify(definition, null, 2) + "\n";
  commit(dir, [[join(dir, "plan.json"), text, PLAN_BYTES]], [{ actor, type: "plan.set", data: { revision: definition.revision, definition, state: "paused", sha256: sha256(text) } }]);
  return { definition, state: "paused" as const };
}
