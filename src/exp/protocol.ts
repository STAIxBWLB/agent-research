import { validateStageProtocol, stageProtocolHash, type ProtocolV2 } from "./stages.ts";
import { requireCopilotAccept } from "../copilot.ts";
import { finalSeedsHash } from "./final.ts";
import { selectionHash } from "./selection.ts";
import { existsSync, lstatSync, opendirSync } from "node:fs";
import { join, posix } from "node:path";
import { commit, openStudy, plain, readBytesBounded, readJsonFile, readTextBounded, requireExperiment, sha256, type Actor } from "../study.ts";

export interface Limits { cpus: number; memoryMb: number; pidsLimit: number; wallSeconds: number; gpus: number }
export interface ProtocolInput { path?: string; sha256: string; mount: { candidate?: string; evaluator?: string } }
export interface Protocol {
  v: 1; method: string; inputs?: Record<string, ProtocolInput>;
  candidate: { image: string; command: string[]; env?: Record<string, string> };
  evaluator: { image: string; command: string[] };
  metrics: { name: string; unit: string; direction: "max" | "min" }[];
  seeds: number[]; limits: Limits; network: "none";
  budget: { maxAttempts: number; maxWallHours: number; maxGpuHours: number };
}
export type ProtocolDefinition = Protocol | ProtocolV2;
export function validateProtocolDefinition(raw: unknown): ProtocolDefinition {
  if (plain(raw) && raw.v === 2) return validateStageProtocol(raw);
  if (!plain(raw) || raw.v !== 1) throw new Error("protocol.v: unsupported version; use a compatible ares release, keeping the original definition unchanged");
  return validateProtocol(raw);
}
export const METRIC_LIMIT = 100;
export const PROTOCOL_BYTES = 65_536, TASK_FILES = 500, TASK_BYTES = 64 * 1024 * 1024;
export const LIMIT_BOUNDS = { cpus: [0.1, 256], memoryMb: [16, 1_048_576], pidsLimit: [1, 65_536], wallSeconds: [1, 604_800], gpus: [0, 64] } as const;
function object(raw: unknown, keys: string[], what: string): Record<string, unknown> {
  if (!plain(raw)) throw new Error(`${what}: object required; set ${what} to a JSON object`);
  const extra = Object.keys(raw).find(key => !keys.includes(key));
  if (extra !== undefined) throw new Error(`${what}: unknown field ${extra}; remove it and use only ${keys.join(", ")}`);
  return raw;
}
function number(raw: unknown, what: string, min: number, max: number, integer = true): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || (integer && !Number.isSafeInteger(raw)) || raw < min || raw > max) throw new Error(`${what}: invalid number; set ${what} to a finite ${integer ? "integer" : "number"} in ${min}..${max}`);
  return raw;
}
function array(raw: unknown, what: string, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > max) throw new Error(`${what}: invalid array; set ${what} to a JSON array of 1..${max} items`);
  return raw;
}
// Preserve argv and environment bytes; trimming these would change execution.
function literal(raw: unknown, what: string, max: number, empty = false): string {
  if (typeof raw !== "string" || raw.includes("\0") || raw.length > max || (!empty && !raw.trim())) throw new Error(`${what}: invalid text; set ${what} to a ${empty ? "possibly empty" : "nonblank"} string of at most ${max} characters without NUL`);
  return raw;
}
function stage(raw: unknown, what: string, envAllowed: boolean): Protocol["candidate"] {
  const value = object(raw, envAllowed ? ["image", "command", "env"] : ["image", "command"], what);
  const image = literal(value.image, `${what}.image`, 512);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:\-]*@sha256:[a-f0-9]{64}$/.test(image)) throw new Error(`${what}.image: digest-pinned image required; set ${what}.image to name@sha256:<64 lowercase hex digits>`);
  const command = array(value.command, `${what}.command`, 128).map((v, i) => literal(v, `${what}.command[${i}]`, 4096, true));
  if (!command[0]?.trim()) throw new Error(`${what}.command[0]: executable missing; set the first argv item to a nonblank executable`);
  if (value.env === undefined) return { image, command };
  const rawEnv = object(value.env, Object.keys(plain(value.env) ? value.env : {}), `${what}.env`);
  if (Object.keys(rawEnv).length > 64) throw new Error(`${what}.env: too many keys; reduce ${what}.env to at most 64 keys`);
  const entries: [string, string][] = [];
  for (const [key, val] of Object.entries(rawEnv)) {
    if (key === "ARES_SEED") throw new Error(`${what}.env: key ARES_SEED is reserved for the selected attempt seed; remove it from candidate.env and select a declared seed with ares attempt run --seed N`);
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error(`${what}.env: key ${key} is reserved for object internals; remove or rename that env entry before setting the protocol`);
    if (/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) throw new Error(`${what}.env: key ${key} looks like a secret; pass secrets through the image, not the protocol`);
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)) throw new Error(`${what}.env: key ${key} is invalid; use 1..128 letters, digits or underscores, starting with a letter or underscore`);
    entries.push([key, literal(val, `${what}.env.${key}`, 4096, true)]);
  }
  return { image, command, env: Object.fromEntries(entries) };
}
export function canonicalExecutorPath(value: string): string { return posix.normalize(value).replace(/\/+$/, "") || "/"; }
/** Input locators stay executor-local; only strict read-only /in targets are supported. */
export function validateProtocolInputs(raw: unknown): Record<string, ProtocolInput> {
  return protocolInputs(raw, false);
}
function protocolInputs(raw: unknown, stored: boolean): Record<string, ProtocolInput> {
  const value = object(raw, Object.keys(plain(raw) ? raw : {}), "protocol.inputs"), entries = Object.entries(value);
  if (entries.length > 8) throw new Error("protocol.inputs: invalid count; declare at most 8 named inputs");
  const result: [string, ProtocolInput][] = [];
  for (const [name, descriptor] of entries) {
    if (["__proto__", "prototype", "constructor"].includes(name)) throw new Error("protocol.inputs: reserved input name; rename __proto__, prototype or constructor before setting the protocol");
    if (!/^[a-z0-9_-]{1,32}$/.test(name)) throw new Error("protocol.inputs: invalid name; use 1..32 lowercase letters, digits, underscores or hyphens");
    if (stored && plain(descriptor) && Object.hasOwn(descriptor, "path")) throw new Error(`stored protocol.inputs.${name}.path: executor locators are forbidden; restore a path-free frozen protocol with sha256 and mount only`);
    const input = object(descriptor, stored ? ["sha256", "mount"] : ["path", "sha256", "mount"], `protocol.inputs.${name}`);
    if (!stored && (typeof input.path !== "string" || input.path.length > 4096 || !input.path.startsWith("/") || /[\0\r\n,"]/.test(input.path))) throw new Error(`protocol.inputs.${name}.path: invalid locator; use an absolute executor path without NUL, newlines, commas or double quotes`);
    if (typeof input.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) throw new Error(`protocol.inputs.${name}.sha256: invalid manifest hash; run ares executor inputs hash <dir> <path> and use its 64 lowercase hex digest`);
    const targets = object(input.mount, ["candidate", "evaluator"], `protocol.inputs.${name}.mount`);
    if (!Object.keys(targets).length) throw new Error(`protocol.inputs.${name}.mount: missing stage; declare candidate, evaluator or both`);
    const mount: ProtocolInput["mount"] = {};
    for (const stage of ["candidate", "evaluator"] as const) if (Object.hasOwn(targets, stage)) {
      const target = targets[stage];
      if (typeof target !== "string" || target.length > 256 || !/^\/in\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(target) || target.split("/").some(part => part === "." || part === "..")) throw new Error(`protocol.inputs.${name}.mount.${stage}: invalid target; choose a normalized path under /in/ without dot segments`);
      for (const [, prior] of result) {
        const other = prior.mount[stage];
        if (other && (other === target || other.startsWith(`${target}/`) || target.startsWith(`${other}/`))) throw new Error(`protocol.inputs.${name}.mount.${stage}: overlapping targets; use disjoint /in/ targets for each stage`);
      }
      mount[stage] = target;
    }
    result.push([name, { ...(!stored ? { path: canonicalExecutorPath(input.path as string) } : {}), sha256: input.sha256, mount }]);
  }
  return Object.fromEntries(result);
}
/** Public configuration always requires executor-local locators for declared inputs. */
export function validateProtocol(raw: unknown): Protocol { return protocolShape(raw, false); }
/** Frozen attempt records carry identities only, never executor-host locators. */
export function validateStoredProtocol(raw: unknown): Protocol { return protocolShape(raw, true); }
function protocolShape(raw: unknown, stored: boolean): Protocol {
  const p = object(raw, ["v", "method", "candidate", "evaluator", "metrics", "seeds", "limits", "network", "budget", "inputs"], "protocol");
  if (p.v !== 1) throw new Error("protocol.v: unsupported version; this executor supports v1 only; use a compatible ares release for stage protocols, keeping the original definition unchanged");
  if (p.network !== "none") throw new Error('protocol.network: network access is unsupported; set protocol.network to "none"');
  const limitsRaw = object(p.limits, Object.keys(LIMIT_BOUNDS), "protocol.limits");
  const limits = Object.fromEntries(Object.entries(LIMIT_BOUNDS).map(([key, [min, max]]) => [key, number(limitsRaw[key], `protocol.limits.${key}`, min, max, key !== "cpus")])) as unknown as Limits;
  const budget = object(p.budget, ["maxAttempts", "maxWallHours", "maxGpuHours"], "protocol.budget");
  const metrics = array(p.metrics, "protocol.metrics", METRIC_LIMIT).map((rawMetric): Protocol["metrics"][number] => {
    const m = object(rawMetric, ["name", "unit", "direction"], "metric");
    if (m.direction !== "max" && m.direction !== "min") throw new Error("metric.direction: unknown direction; set metric.direction to max or min");
    return { name: literal(m.name, "metric.name", 128).trim(), unit: literal(m.unit, "metric.unit", 64).trim(), direction: m.direction };
  });
  if (new Set(metrics.map(m => m.name)).size !== metrics.length) throw new Error("metrics: duplicate name; give each metric a unique name");
  const seeds = array(p.seeds, "protocol.seeds", 1000).map(v => number(v, "protocol.seed", -2_147_483_648, 2_147_483_647));
  if (new Set(seeds).size !== seeds.length) throw new Error("seeds: duplicate seed; remove repeated seeds from protocol.seeds");
  const protocol: Protocol = { v: 1, method: literal(p.method, "protocol.method", 4000).trim(), candidate: stage(p.candidate, "candidate", true), evaluator: stage(p.evaluator, "evaluator", false), metrics, seeds, limits, network: "none", budget: {
    maxAttempts: number(budget.maxAttempts, "budget.maxAttempts", 1, 1_000_000),
    maxWallHours: number(budget.maxWallHours, "budget.maxWallHours", 0.000001, 1_000_000, false),
    maxGpuHours: number(budget.maxGpuHours, "budget.maxGpuHours", 0, 64_000_000, false),
  } };
  if (p.inputs !== undefined) protocol.inputs = protocolInputs(p.inputs, stored);
  if (Buffer.byteLength(JSON.stringify(protocol, null, 2) + "\n") > PROTOCOL_BYTES) throw new Error(`protocol: too large; reduce the formatted protocol to at most ${PROTOCOL_BYTES} bytes`);
  return protocol;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Accept full public or already-frozen records, but never mixed locator/identity descriptors. */
export function frozenProtocol(protocol: Protocol): Protocol;
export function frozenProtocol(protocol: ProtocolV2): ProtocolV2;
export function frozenProtocol(protocol: ProtocolDefinition): ProtocolDefinition;
export function frozenProtocol(protocol: ProtocolDefinition): ProtocolDefinition {
  if (protocol.v === 2) return validateStageProtocol(protocol);
  const hasLocators = plain(protocol.inputs) && Object.values(protocol.inputs).some(input => plain(input) && Object.hasOwn(input, "path"));
  const normalized = hasLocators ? validateProtocol(protocol) : validateStoredProtocol(protocol);
  if (normalized.inputs !== undefined) normalized.inputs = Object.fromEntries(Object.entries(normalized.inputs).map(([name, input]) => [name, { sha256: input.sha256, mount: { ...input.mount } }]));
  return normalized;
}
export function protocolHash(protocol: ProtocolDefinition): string {
  if (protocol.v === 2) return stageProtocolHash(protocol);
  const { budget: _budget, ...comparable } = frozenProtocol(protocol);
  return sha256(canonical(comparable));
}
/** Locator edits do not alter the input identities a frozen attempt consumes. */
export function sameProtocolInputs(left: Protocol, right: Protocol): boolean {
  return canonical(frozenProtocol(left).inputs ?? {}) === canonical(frozenProtocol(right).inputs ?? {});
}
/** Preserve legacy raw-byte design seals when inputs are absent. */
function protocolSealHash(protocol: ProtocolDefinition, sourceText: string): string {
  if (protocol.v === 2) return sha256(canonical(validateStageProtocol(protocol)));
  return sha256(protocol.inputs === undefined ? sourceText : canonical(frozenProtocol(protocol)));
}
export function readProtocol(dir: string): ProtocolDefinition | undefined {
  const file = join(dir, "design", "protocol.json");
  return existsSync(file) ? validateProtocolDefinition(readJsonFile(file, PROTOCOL_BYTES)) : undefined;
}
/** Hash unambiguous sorted [relative path, file hash] pairs; directory entries are never followed. */
export function taskTreeHash(dir: string): string {
  const root = join(dir, "task"), entries: [string, string][] = [];
  let bytes = 0, directories = 0;
  function walk(relative: string, depth: number): void {
    const path = relative ? join(root, relative) : root, label = relative ? `task/${relative}` : "task/";
    let stat;
    try { stat = lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label}: missing; write task/task.md and task/evaluator/ before ares protocol`);
      throw new Error(`${label}: metadata could not be read; check its permissions and restore a readable task tree`);
    }
    if (stat.isSymbolicLink()) throw new Error(`${label}: symlink refused; replace it with a regular file or directory inside task/`);
    if (!relative && !stat.isDirectory()) throw new Error("task/: directory required; replace task with a directory containing task.md and evaluator/");
    if (stat.isDirectory()) {
      if (depth > 64 || ++directories > 1000) throw new Error(`${label}: too many directories or nesting too deep; reduce task/ to at most 1000 directories and 64 levels`);
      const directory = opendirSync(path);
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) walk(relative ? `${relative}/${entry.name}` : entry.name, depth + 1);
      } finally { directory.closeSync(); }
    } else {
      if (!stat.isFile()) throw new Error(`${label}: regular files only; replace this special file with a regular file or remove it`);
      if (entries.length >= TASK_FILES) throw new Error(`task/: more than ${TASK_FILES} files; remove files until task/ contains at most ${TASK_FILES}`);
      if (stat.size > TASK_BYTES - bytes) throw new Error(`task/: larger than ${TASK_BYTES} bytes; reduce total task/ file bytes to at most ${TASK_BYTES}`);
      const content = readBytesBounded(path, TASK_BYTES - bytes);
      bytes += content.length; entries.push([relative, sha256(content)]);
    }
  }
  walk("", 0);
  return sha256(JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
}
export function designBinding(dir: string): string | undefined {
  return readDesign(dir)?.binding;
}
/** Capture the validated protocol and design seal; input identities omit locators, legacy bytes stay bound. */
export function readDesign(dir: string): { protocol: ProtocolDefinition; treeHash: string; binding: string } | undefined {
  const file = join(dir, "design", "protocol.json");
  if (!existsSync(file)) return undefined;
  const text = readTextBounded(file, PROTOCOL_BYTES);
  let raw: unknown; try { raw = JSON.parse(text); } catch { throw new Error("protocol: invalid JSON; restore design/protocol.json with a valid ares protocol input"); }
  const protocol = validateProtocolDefinition(raw), treeHash = taskTreeHash(dir);
  const selected = selectionHash(dir, protocol), reserved = finalSeedsHash(dir, protocol);
  return { protocol, treeHash, binding: sha256(JSON.stringify([protocolSealHash(protocol, text), treeHash, ...(selected !== undefined ? [selected] : []), ...(reserved !== undefined ? [reserved] : [])])) };
}
/** Caller holds the study lock, as with setScope. Validate everything before any write. */
export function setProtocol(dir: string, raw: unknown, actor: Actor): ProtocolDefinition {
  requireExperiment(openStudy(dir).study);
  const protocol = validateProtocolDefinition(raw);
  requireCopilotAccept(dir, "hypotheses");
  const treeHash = taskTreeHash(dir), text = JSON.stringify(protocol, null, 2) + "\n";
  // Never commit a protocol that makes its existing selection unreadable.
  selectionHash(dir, protocol);
  finalSeedsHash(dir, protocol);
  commit(dir, [[join(dir, "design", "protocol.json"), text, PROTOCOL_BYTES]], [{ actor, type: "protocol.set", data: { sha256: sha256(text), ...((protocol.v === 1 && protocol.inputs === undefined) ? {} : { identitySha256: protocolSealHash(protocol, text) }), protocolHash: protocolHash(protocol), treeHash } }]);
  return protocol;
}
