import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { assertWritable, plain, readBytesBounded, readTextBounded, sha256, writeAtomic } from "./study.ts";

export const SETUP_TARGETS = ["claude", "codex", "kimi", "pi", "qwen", "jcode", "agy"] as const;
type AgentSetupTarget = typeof SETUP_TARGETS[number];
export type SetupTarget = AgentSetupTarget | "console";
export type SetupMode = "dry-run" | "apply" | "undo";
export interface McpEntry { command: string; args: string[] }
export interface ConsoleManifest { api: 1; tool: "ares"; module: string; sha256: string }
type SetupEntry = McpEntry | ConsoleManifest;
interface Host { target: SetupTarget; file: string; key: string; format: "json" | "toml" | "manifest" }
export interface SetupAction { target: SetupTarget; file: string; entry: string; receipt: string; lock: string; change: "add" | "replace" | "unchanged" | "restore" | "remove" | "none" | "refused"; receiptChange: "add" | "replace" | "remove" | "none"; reason?: string }
export interface SetupReport { mode: SetupMode; applied: boolean; root: string; entry: McpEntry; actions: SetupAction[]; notes: string[]; console?: ConsoleManifest }
interface Receipt { v: 1; target: SetupTarget; file: string; existed: boolean; keyExisted: boolean; priorPresent: boolean; prior?: unknown; priorToml?: string; installed: SetupEntry }
interface Plan { host: Host; action: SetupAction; before: string | null; after: string | null; receiptBefore: string | null; receiptAfter: string | null }
export const SETUP_CONFIG_BYTES = 4 * 1024 * 1024, SETUP_RECEIPT_BYTES = 8 * 1024 * 1024;
const OWN_ROOT = fileURLToPath(new URL("..", import.meta.url));
class SetupError extends Error {}
function fail(message: string, nextStep = "correct the config or restore its setup receipt, then rerun ares setup"): never { throw new SetupError(`setup: ${message}; ${nextStep}`); }
function failureReason(error: unknown): string {
  return error instanceof SetupError ? error.message : `setup: ${error instanceof Error ? error.message : "file operation failed"}; check file permissions and the setup receipt, then rerun ares setup`;
}
function setupLockRefusal(file: string): never {
  fail(`target is locked by another setup: ${file}`, `if no ares setup is running, remove ${file} and rerun ares setup`);
}
function absolute(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0")) fail(`${label} must be an absolute path`, label === "--root" ? "pass --root ABS for an existing agent-research release" : `set ${label} to an absolute path and rerun ares setup`);
  return resolve(value);
}
/** Links are always refused. Ownership checks protect mutable config/receipts; release reads may be administrator-owned. */
function guard(file: string, owned = true): void {
  const parts: string[] = []; for (let current = resolve(file); ; current = dirname(current)) { parts.unshift(current); if (current === dirname(current)) break; }
  for (const part of parts) {
    let info;
    try { info = lstatSync(part); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (info.isSymbolicLink()) fail("links are refused in config and receipt paths");
    if (part === resolve(file)) {
      if (!info.isFile()) fail("config or receipt is not a regular file");
      if (owned && info.uid !== process.getuid!()) fail("config or receipt is owned by another user");
    } else {
      if (!info.isDirectory()) fail("config or receipt parent is not a directory");
      if (owned && info.uid !== 0 && info.uid !== process.getuid!()) fail("config or receipt parent is owned by another user");
    }
  }
}
function read(file: string, max: number, owned = true): string | null {
  guard(file, owned);
  try { return readTextBounded(file, max, { noFollow: true, ...(owned ? { uid: process.getuid!() } : {}) }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
function write(file: string, value: string | null, max: number, privateFile = false): void {
  guard(file);
  if (value === null) { unlinkSync(file); return; }
  assertWritable(value, max, "setup output");
  let mode = 0o600;
  try { if (!privateFile) mode = lstatSync(file).mode & 0o777; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (privateFile) privateDirectory(dirname(file), true);
  guard(file); writeAtomic(file, value, max, mode);
}
function record(value: unknown): Record<string, unknown> { if (!plain(value)) fail("config must contain an object"); return value; }
function document(host: Host, source: string | null): Record<string, unknown> {
  if (source === null) return {};
  try { return record(host.format === "toml" ? Bun.TOML.parse(source) : JSON.parse(source)); }
  catch { fail(`invalid ${host.format.toUpperCase()}; fix ${host.file} before applying setup`); }
}
function entry(host: Host, source: string | null): unknown { if (host.format === "manifest") return source === null ? undefined : document(host, source); const doc = document(host, source); return doc[host.key] === undefined ? undefined : record(doc[host.key]).ares; }
function hosts(env: NodeJS.ProcessEnv, cwd: string): Record<AgentSetupTarget, Host> {
  const home = absolute(env.HOME?.trim() || homedir(), "HOME");
  const dir = (key: string, fallback: string) => absolute(env[key]?.trim() || join(home, fallback), key);
  const json = (target: AgentSetupTarget, file: string, key = "mcpServers"): Host => ({ target, file, format: "json", key });
  return {
    claude: json("claude", env.CLAUDE_CONFIG_DIR?.trim() ? join(dir("CLAUDE_CONFIG_DIR", ".claude"), ".claude.json") : join(home, ".claude.json")),
    codex: { target: "codex", file: join(dir("CODEX_HOME", ".codex"), "config.toml"), format: "toml", key: "mcp_servers" },
    kimi: json("kimi", join(dir("KIMI_CODE_HOME", ".kimi-code"), "mcp.json")),
    pi: json("pi", join(dir("PI_CODING_AGENT_DIR", ".pi/agent"), "mcp.json")),
    qwen: json("qwen", join(dir("QWEN_HOME", ".qwen"), "settings.json")),
    jcode: json("jcode", join(dir("JCODE_HOME", ".jcode"), "mcp.json"), "servers"),
    agy: json("agy", join(absolute(cwd, "cwd"), ".agents", "mcp_config.json")),
  };
}
/** Header/key handling follows vmem setup; Bun decodes quoted keys instead of a second TOML decoder. */
function tomlKey(raw: string): string[] | undefined {
  const pattern = /\s*([A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')\s*(?:\.|$)/y, parts: string[] = [];
  while (pattern.lastIndex < raw.length) {
    const match = pattern.exec(raw); if (!match) return undefined;
    const token = match[1]!;
    try { parts.push(token.startsWith('"') || token.startsWith("'") ? record(Bun.TOML.parse(`key = ${token}`)).key as string : token); } catch { return undefined; }
  }
  return parts;
}
function header(line: string): string | undefined {
  line = line.replace(/\r?\n$/, "");
  const match = /^\s*(\[\[?)/.exec(line); if (!match) return undefined;
  let quote = "", index = match[0].length;
  for (; index < line.length; index++) {
    const char = line[index]!;
    if (quote) { if (char === "\\" && quote === '"') index++; else if (char === quote) quote = ""; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === "]") break;
  }
  const close = match[1] === "[[" ? "]]" : "]";
  return !quote && line.startsWith(close, index) && /^\s*(?:#.*)?$/.test(line.slice(index + close.length)) ? line.slice(match[0].length, index).trim() : undefined;
}
/** Multiline strings may contain apparent table headers; never treat those lines as config entries. */
function spans(lines: string[]): [number, number][] {
  const result: [number, number][] = [], comments: boolean[] = []; let start = -1, quote = "";
  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i], name = line !== undefined && !quote ? header(line) : undefined;
    comments[i] = !quote && line?.trim().startsWith("#") === true;
    if (i === lines.length || name !== undefined) {
      if (start >= 0) { let stop = i; while (stop > start && (!lines[stop - 1]!.trim() || comments[stop - 1])) stop--; result.push([start, stop]); start = -1; }
      const key = name === undefined ? undefined : tomlKey(name); if (key?.[0] === "mcp_servers" && key[1] === "ares") start = i;
    }
    for (let pos = 0; line !== undefined && pos < line.length; pos++) {
      const char = line[pos]!;
      if (!quote && char === "#") break;
      if (quote && char === "\\" && quote[0] === '"') { pos++; continue; }
      if (quote.length === 3 && line.startsWith(quote, pos)) { const end = quote[0]!; while (line[pos + 1] === end) pos++; quote = ""; }
      else if (quote.length === 1 && char === quote) quote = "";
      else if (!quote && (char === '"' || char === "'")) { quote = line.startsWith(char.repeat(3), pos) ? char.repeat(3) : char; pos += quote.length - 1; }
    }
  }
  return result;
}
const linesOf = (source: string): string[] => source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
function priorToml(source: string | null): string | undefined {
  const lines = linesOf(source ?? ""), owned = spans(lines);
  return owned.length ? owned.map(([start, stop]) => lines.slice(start, stop).join("")).join("") : undefined;
}
function put(host: Host, source: string | null, value: unknown, rawToml?: string, keepKey = false): string {
  if (host.format === "manifest") return JSON.stringify(value ?? {}, null, 2) + "\n";
  if (host.format === "json") {
    const doc = document(host, source), servers = { ...record(doc[host.key] ?? {}) };
    if (value === undefined) delete servers.ares; else servers.ares = value;
    if (Object.keys(servers).length || keepKey) doc[host.key] = servers; else delete doc[host.key];
    return JSON.stringify(doc, null, source && /\n(\t| +)"/.exec(source)?.[1] || "  ") + "\n";
  }
  const newline = source?.includes("\r\n") ? "\r\n" : "\n", lines = linesOf(source ?? ""), owned = spans(lines);
  let block = rawToml ?? "";
  if (value !== undefined && rawToml === undefined) {
    const target = record(value);
    block = `[mcp_servers.ares]${newline}command = ${JSON.stringify(target.command)}${newline}args = ${JSON.stringify(target.args)}${newline}`;
  }
  if (owned.length) {
    for (const [start, stop] of [...owned].reverse()) lines.splice(start, stop - start);
    lines.splice(owned[0]![0], 0, block);
  } else if (block) {
    const prefix = (source ?? "").endsWith("\n") || !source ? "" : newline;
    lines.push(prefix + (source ? newline : "") + block);
  }
  const output = lines.join("");
  try { const parsed = document(host, output); if (!isDeepStrictEqual(parsed.mcp_servers === undefined ? undefined : record(parsed.mcp_servers).ares, rawToml === undefined ? value : entry(host, rawToml))) throw new Error(); }
  catch { fail("TOML entry cannot be edited safely; convert inline/dotted ares settings to [mcp_servers.ares] tables first"); }
  return output;
}
function install(root: string): string {
  const requested = absolute(root, "--root");
  let location: string;
  try { location = realpathSync(requested); } catch { fail("install root is unreadable or missing", "pass --root ABS for an existing agent-research release"); }
  const source = read(join(location, "package.json"), 65_536, false);
  let pkg: unknown; try { pkg = source === null ? null : JSON.parse(source); } catch { fail("install root package.json is not valid JSON", "select or reinstall an intact agent-research release root"); }
  if (!plain(pkg) || pkg.name !== "@staix/agent-research" || typeof pkg.version !== "string") fail("--root is not an agent-research installation", "select a release root containing package.json and bin/ares.js");
  const bootstrap = join(location, "bin", "ares.js"); guard(bootstrap, false);
  try { if (!lstatSync(bootstrap).isFile()) throw new Error(); } catch { fail("install root has no regular bin/ares.js", "select or reinstall an intact agent-research release root"); }
  return location;
}
function validInstalled(host: Host, value: unknown): boolean {
  if (!plain(value)) return false;
  return host.format === "manifest"
    ? value.api === 1 && value.tool === "ares" && typeof value.module === "string" && isAbsolute(value.module) && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    : typeof value.command === "string" && Array.isArray(value.args) && value.args.every(arg => typeof arg === "string");
}
function receipt(source: string | null, host: Host): Receipt | undefined {
  if (source === null) return undefined;
  let raw: unknown; try { raw = JSON.parse(source); } catch { fail("receipt must be valid JSON"); }
  if (!plain(raw) || raw.v !== 1 || raw.target !== host.target || raw.file !== host.file || typeof raw.existed !== "boolean" || typeof raw.keyExisted !== "boolean" || typeof raw.priorPresent !== "boolean"
    || !validInstalled(host, raw.installed)
    || (raw.priorPresent && !Object.hasOwn(raw, "prior")) || (raw.priorToml !== undefined && typeof raw.priorToml !== "string")) fail("unsupported, malformed or foreign setup receipt");
  return raw as unknown as Receipt;
}
function plan(host: Host, receiptPath: string, mode: SetupMode, desired: SetupEntry, ownsLock = false): Plan {
  const action: SetupAction = { target: host.target, file: host.file, entry: host.format === "manifest" ? "console plugin manifest" : `${host.key}.ares`, receipt: receiptPath, lock: `${host.file}.ares-setup.lock`, change: "none", receiptChange: "none" };
  if (host.format === "manifest") privateDirectory(dirname(host.file));
  guard(action.lock);
  if (!ownsLock && existsSync(action.lock)) setupLockRefusal(action.lock);
  const before = read(host.file, SETUP_CONFIG_BYTES), receiptBefore = read(receiptPath, SETUP_RECEIPT_BYTES), prior = receipt(receiptBefore, host), current = entry(host, before);
  const result: Plan = { host, action, before, after: before, receiptBefore, receiptAfter: receiptBefore };
  if (mode === "undo") {
    if (!prior) return result;
    if (!isDeepStrictEqual(current, prior.installed)) fail("ares entry changed since apply; keep the user edit and reconcile the receipt manually before undo");
    result.after = put(host, before, prior.priorPresent ? prior.prior : undefined, prior.priorToml, prior.keyExisted);
    if (!prior.existed && isDeepStrictEqual(document(host, result.after), {})) result.after = null;
    result.receiptAfter = null; action.change = prior.priorPresent ? "restore" : "remove"; action.receiptChange = "remove"; return result;
  }
  if (isDeepStrictEqual(current, desired) && (host.format !== "manifest" || !privateModesNeeded(host.file))) { action.change = "unchanged"; return result; }
  const original = prior?.priorToml === undefined ? prior?.priorPresent ? prior.prior : undefined : entry(host, prior.priorToml);
  if (prior && !isDeepStrictEqual(current, prior.installed) && !isDeepStrictEqual(current, original)) fail("ares entry changed since apply; reconcile it before replacing the installed root");
  result.after = put(host, before, desired);
  const saved: Receipt = prior ?? { v: 1, target: host.target, file: host.file, existed: before !== null, keyExisted: Object.hasOwn(document(host, before), host.key), priorPresent: current !== undefined,
    ...(current === undefined ? {} : { prior: current }), ...(host.format === "toml" && current !== undefined ? { priorToml: priorToml(before) } : {}), installed: desired };
  result.receiptAfter = JSON.stringify({ ...saved, installed: desired }, null, 2) + "\n";
  assertWritable(result.receiptAfter, SETUP_RECEIPT_BYTES, "setup receipt");
  assertWritable(result.after, SETUP_CONFIG_BYTES, "client config");
  action.change = current === undefined ? "add" : "replace"; action.receiptChange = receiptBefore === null ? "add" : "replace"; return result;
}
/** Per-config, not per-family, so two family homes cannot race on the same client file. */
function acquireSetupLock(file: string): () => void {
  guard(file); mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); guard(file);
  let fd: number;
  try { fd = openSync(file, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") setupLockRefusal(file); throw error; }
  return () => { try { closeSync(fd); } finally { unlinkSync(file); } };
}
/** Agent setup only. Console dispatch is deliberately separate for the plugin integration. */
export function runSetup(target: string, mode: SetupMode, options: { env: NodeJS.ProcessEnv; cwd?: string; root?: string }): SetupReport {
  if (target === "console") return consoleManifest(mode, options.env, options.root ?? OWN_ROOT, options.root !== undefined);
  if (target !== "all" && !(SETUP_TARGETS as readonly string[]).includes(target)) fail("unknown target", `use ${SETUP_TARGETS.join("|")}|all`);
  if (!["dry-run", "apply", "undo"].includes(mode)) fail("unsupported setup mode", "choose dry-run, apply or undo and rerun ares setup");
  const env = options.env, root = install(options.root ?? OWN_ROOT), desired: McpEntry = { command: "bun", args: ["--smol", join(root, "bin", "ares.js"), "mcp"] };
  const table = hosts(env, options.cwd ?? process.cwd()), family = absolute(env.AGENTHUB_HOME?.trim() || join(absolute(env.HOME?.trim() || homedir(), "HOME"), ".agenthub"), "AGENTHUB_HOME");
  const targets = target === "all" ? SETUP_TARGETS.filter(name => name !== "agy") : [target as AgentSetupTarget], plans: Plan[] = [];
  const report: SetupReport = { mode, applied: false, root, entry: desired, actions: [], notes: target === "all" ? ["all covers user-level clients; run ares setup agy from its workspace separately"] : [] };
  for (const name of targets) {
    const host = table[name], receiptPath = join(family, "research", "setup", `${name}-${sha256(host.file).slice(0, 16)}.json`);
    try { const item = plan(host, receiptPath, mode, desired); plans.push(item); report.actions.push(item.action); }
    catch (error) { report.actions.push({ target: name, file: host.file, entry: host.format === "manifest" ? "console plugin manifest" : `${host.key}.ares`, receipt: receiptPath, lock: `${host.file}.ares-setup.lock`, change: "refused", receiptChange: "none", reason: failureReason(error) }); }
  }
  return executePlans(plans, mode, desired, report);
}
function executePlans(plans: Plan[], mode: SetupMode, desired: SetupEntry, report: SetupReport): SetupReport {
  if (mode === "dry-run" || report.actions.some(action => action.change === "refused")) return report;
  for (let item of plans) {
    if (["none", "unchanged"].includes(item.action.change)) continue;
    let release: (() => void) | undefined;
    try {
      release = acquireSetupLock(item.action.lock);
      const fresh = plan(item.host, item.action.receipt, mode, desired, true);
      Object.assign(item.action, fresh.action); item = { ...fresh, action: item.action };
      if (["none", "unchanged"].includes(item.action.change)) continue;
      if (read(item.host.file, SETUP_CONFIG_BYTES) !== item.before || read(item.action.receipt, SETUP_RECEIPT_BYTES) !== item.receiptBefore) fail("config or receipt changed during setup; rerun preview before applying");
      // Receipt is durable before apply changes client config. Undo keeps the receipt until restoration succeeds.
      if (mode === "apply") write(item.action.receipt, item.receiptAfter, SETUP_RECEIPT_BYTES);
      try {
        if (read(item.host.file, SETUP_CONFIG_BYTES) !== item.before) fail("client config changed after receipt creation; rerun preview before applying");
        write(item.host.file, item.after, SETUP_CONFIG_BYTES, item.host.format === "manifest");
      }
      catch (error) { if (mode === "apply" && read(item.action.receipt, SETUP_RECEIPT_BYTES) === item.receiptAfter) write(item.action.receipt, item.receiptBefore, SETUP_RECEIPT_BYTES); throw error; }
      if (mode === "undo") write(item.action.receipt, null, SETUP_RECEIPT_BYTES);
      report.applied = true;
    } catch (error) { item.action.change = "refused"; item.action.reason = failureReason(error); break; }
    finally { release?.(); }
  }
  return report;
}

/** The manifest directory must satisfy agent-console's private user-owned registration boundary. */
function privateDirectory(dir: string, apply = false): void {
  let info;
  try { info = lstatSync(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (!info.isDirectory() || info.isSymbolicLink()) fail("console plugin directory must be a real directory");
  if (info.uid !== process.getuid!()) fail("console plugin directory is owned by another user");
  if (apply) chmodSync(dir, 0o700);
}
function privateModesNeeded(file: string): boolean {
  try { if ((lstatSync(dirname(file)).mode & 0o777) !== 0o700) return true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { return (lstatSync(file).mode & 0o777) !== 0o600; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; }
}
/** Console registration is separate from agent-client `all`; no instruction blocks or other manifests are touched. */
export function consoleManifest(mode: SetupMode, env: NodeJS.ProcessEnv, requestedRoot = OWN_ROOT, versioned = false): SetupReport {
  if (!["dry-run", "apply", "undo"].includes(mode)) fail("unsupported setup mode", "choose dry-run, apply or undo and rerun ares setup");
  const root = install(requestedRoot), module = join(root, "src", "ui", "plugin.ts");
  const mcp: McpEntry = { command: "bun", args: ["--smol", join(root, "bin", "ares.js"), "mcp"] };
  let desired: SetupEntry = mcp;
  if (mode !== "undo") {
    guard(module, false);
    let bytes: Buffer;
    try { bytes = readBytesBounded(module, SETUP_CONFIG_BYTES, { noFollow: true }); }
    catch { fail("console plugin module is missing, unreadable or over 4 MiB", "select an intact release containing src/ui/plugin.ts and rerun ares setup console"); }
    desired = { api: 1, tool: "ares", module, sha256: sha256(bytes) };
  }
  const pkg = record(JSON.parse(read(join(root, "package.json"), 65_536, false)!)), version = pkg.version;
  if (versioned && (typeof version !== "string" || version.length > 64 || !/^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.+-]{1,40})?$/.test(version))) fail("release version cannot name a console registration", "use an agent-research root with a semantic package version: three 1..9-digit parts, optional -/+ suffix of 1..40 characters from 0-9A-Za-z.+-, and at most 64 characters total");
  const family = absolute(env.AGENTHUB_HOME?.trim() || join(absolute(env.HOME?.trim() || homedir(), "HOME"), ".agenthub"), "AGENTHUB_HOME");
  const file = join(family, "console", "plugins", versioned ? `ares@${version}.json` : "ares.json");
  const host: Host = { target: "console", file, key: "", format: "manifest" }, receiptPath = join(family, "research", "setup", `console-${sha256(file).slice(0, 16)}.json`);
  const report: SetupReport = { mode, applied: false, root, entry: mcp, ...(mode === "undo" ? {} : { console: desired as ConsoleManifest }), actions: [], notes: ["Registers only the ares console plugin; restart the console to load changed code."] };
  let item: Plan;
  try { item = plan(host, receiptPath, mode, desired); }
  catch (error) { report.actions.push({ target: "console", file, entry: "console plugin manifest", receipt: receiptPath, lock: `${file}.ares-setup.lock`, change: "refused", receiptChange: "none", reason: failureReason(error) }); return report; }
  report.actions.push(item.action); return executePlans([item], mode, desired, report);
}
