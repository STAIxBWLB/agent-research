import { existsSync, lstatSync, mkdirSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { boundedText, commit, onlyKeys, openStudy, plain, readBytesBounded, readJsonFile, requireExperiment, sha256, type Actor } from "../study.ts";

export interface Limits { cpus: number; memoryMb: number; pidsLimit: number; wallSeconds: number; gpus: number }
export interface Protocol {
  v: 1; method: string;
  candidate: { image: string; command: string[]; env?: Record<string, string> };
  evaluator: { image: string; command: string[] };
  metrics: { name: string; unit: string; direction: "max" | "min" }[];
  seeds: number[]; limits: Limits; network: "none";
  budget: { maxAttempts: number; maxWallHours: number; maxGpuHours: number };
}
export const PROTOCOL_BYTES = 65_536, TASK_FILES = 500, TASK_BYTES = 64 * 1024 * 1024;
export const LIMIT_BOUNDS = { cpus: [0.1, 256], memoryMb: [16, 1_048_576], pidsLimit: [1, 65_536], wallSeconds: [1, 604_800], gpus: [0, 64] } as const;
function object(raw: unknown, keys: string[], what: string): Record<string, unknown> {
  if (!plain(raw)) throw new Error(`${what}: object required`);
  onlyKeys(raw, keys, what); return raw;
}
function number(raw: unknown, what: string, min: number, max: number, integer = true): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || (integer && !Number.isSafeInteger(raw)) || raw < min || raw > max) throw new Error(`${what}: ${min}..${max}${integer ? " integer" : ""}`);
  return raw;
}
function array(raw: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) throw new Error(`${what}: array of 1..${max} items required`);
  return raw;
}
// Preserve argv and environment bytes; trimming these would change execution.
function literal(raw: unknown, what: string, max: number, empty = false): string {
  if (typeof raw !== "string" || raw.includes("\0") || raw.length > max || (!empty && !raw.trim())) throw new Error(`${what}: bounded text required`);
  return raw;
}
function stage(raw: unknown, what: string, envAllowed: boolean): Protocol["candidate"] {
  const value = object(raw, envAllowed ? ["image", "command", "env"] : ["image", "command"], what);
  const image = literal(value.image, `${what}.image`, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`${what}.image: digest-pinned image required`);
  const command = array(value.command, `${what}.command`, 128).map(v => literal(v, `${what}.command`, 4096, true));
  if (!command[0]?.trim()) throw new Error(`${what}.command: executable required`);
  if (value.env === undefined) return { image, command };
  const rawEnv = object(value.env, Object.keys(plain(value.env) ? value.env : {}), `${what}.env`);
  if (Object.keys(rawEnv).length > 64) throw new Error(`${what}.env: at most 64 keys`);
  const entries: [string, string][] = [];
  for (const [key, val] of Object.entries(rawEnv)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) || /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) throw new Error(`${what}.env: refused key`);
    entries.push([key, literal(val, `${what}.env value`, 4096, true)]);
  }
  return { image, command, env: Object.fromEntries(entries) };
}
export function validateProtocol(raw: unknown): Protocol {
  const p = object(raw, ["v", "method", "candidate", "evaluator", "metrics", "seeds", "limits", "network", "budget"], "protocol");
  if (p.v !== 1) throw new Error("protocol.v: 1 required");
  if (p.network !== "none") throw new Error("protocol.network: none required");
  const limitsRaw = object(p.limits, Object.keys(LIMIT_BOUNDS), "protocol.limits");
  const limits = Object.fromEntries(Object.entries(LIMIT_BOUNDS).map(([key, [min, max]]) => [key, number(limitsRaw[key], `protocol.limits.${key}`, min, max, key !== "cpus")])) as unknown as Limits;
  const budget = object(p.budget, ["maxAttempts", "maxWallHours", "maxGpuHours"], "protocol.budget");
  const metrics = array(p.metrics, "protocol.metrics", 100).map(rawMetric => {
    const m = object(rawMetric, ["name", "unit", "direction"], "metric");
    if (m.direction !== "max" && m.direction !== "min") throw new Error("metric.direction: max or min required");
    return { name: boundedText(m.name, "metric.name", 128), unit: boundedText(m.unit, "metric.unit", 64), direction: m.direction };
  });
  if (new Set(metrics.map(m => m.name)).size !== metrics.length) throw new Error("metrics: duplicate name");
  const seeds = array(p.seeds, "protocol.seeds", 1000).map(v => number(v, "protocol.seed", -2_147_483_648, 2_147_483_647));
  if (new Set(seeds).size !== seeds.length) throw new Error("seeds: duplicate seed");
  const protocol: Protocol = { v: 1, method: boundedText(p.method, "protocol.method", 4000), candidate: stage(p.candidate, "candidate", true), evaluator: stage(p.evaluator, "evaluator", false), metrics, seeds, limits, network: "none", budget: {
    maxAttempts: number(budget.maxAttempts, "budget.maxAttempts", 1, 1_000_000),
    maxWallHours: number(budget.maxWallHours, "budget.maxWallHours", 0.000001, 1_000_000, false),
    maxGpuHours: number(budget.maxGpuHours, "budget.maxGpuHours", 0, 64_000_000, false),
  } };
  if (Buffer.byteLength(JSON.stringify(protocol, null, 2) + "\n") > PROTOCOL_BYTES) throw new Error("protocol: too large");
  return protocol;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function protocolHash(protocol: Protocol): string {
  const { budget: _budget, ...comparable } = validateProtocol(protocol);
  return sha256(canonical(comparable));
}
export function readProtocol(dir: string): Protocol | undefined {
  const file = join(dir, "design", "protocol.json");
  return existsSync(file) ? validateProtocol(readJsonFile(file, PROTOCOL_BYTES)) : undefined;
}
/** Hash unambiguous sorted [relative path, file hash] pairs; directory entries are never followed. */
export function taskTreeHash(dir: string): string {
  const root = join(dir, "task"), entries: [string, string][] = [];
  let bytes = 0, directories = 0;
  function walk(relative: string, depth: number): void {
    const path = relative ? join(root, relative) : root, stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("task/: symlink refused");
    if (!relative && !stat.isDirectory()) throw new Error("task/: directory required");
    if (stat.isDirectory()) {
      if (depth > 64 || ++directories > 1000) throw new Error("task/: too many directories or nesting too deep");
      const directory = opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) walk(relative ? `${relative}/${entry.name}` : entry.name, depth + 1);
      } finally { directory.closeSync(); }
    } else {
      if (!stat.isFile()) throw new Error("task/: regular files only");
      if (entries.length >= TASK_FILES) throw new Error(`task/: more than ${TASK_FILES} files`);
      if (stat.size > TASK_BYTES - bytes) throw new Error(`task/: larger than ${TASK_BYTES} bytes`);
      const content = readBytesBounded(path, TASK_BYTES - bytes);
      bytes += content.length; entries.push([relative, sha256(content)]);
    }
  }
  walk("", 0);
  return sha256(JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}
export function designBinding(dir: string): string | undefined {
  const file = join(dir, "design", "protocol.json");
  if (!existsSync(file)) return undefined;
  readProtocol(dir);
  return sha256(JSON.stringify([sha256(readBytesBounded(file, PROTOCOL_BYTES)), taskTreeHash(dir)]));
}
/** Caller holds the study lock, as with setScope. Validate everything before any write. */
export function setProtocol(dir: string, raw: unknown, actor: Actor): Protocol {
  requireExperiment(openStudy(dir).study);
  const protocol = validateProtocol(raw), treeHash = taskTreeHash(dir), text = JSON.stringify(protocol, null, 2) + "\n";
  mkdirSync(join(dir, "design"), { recursive: true });
  commit(dir, [[join(dir, "design", "protocol.json"), text, PROTOCOL_BYTES]], [{ actor, type: "protocol.set", data: { sha256: sha256(text), protocolHash: protocolHash(protocol), treeHash } }]);
  return protocol;
}
