import { validateAutonomy, validateAutonomyMode, resolveAutonomy, ACCEPT_ARTIFACTS, type Autonomy, type Phase, type AcceptArtifact } from "./autonomy.ts";
export type { Autonomy } from "./autonomy.ts";
import { hostname } from "node:os";
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync, appendFileSync, lstatSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export type Mode = "survey" | "experiment";
export type GateName = "scope" | "screen" | "design" | "final" | "review" | `plan:${string}` | `accept:${AcceptArtifact}` | `harness:${string}`;
export const GATES: readonly GateName[] = ["scope", "screen", "design", "final", "review"];
export const HARNESS_GATE_ID_BYTES = 64;
export function isHarnessGate(value: unknown): value is `harness:${string}` {
  if (typeof value !== "string" || !value.startsWith("harness:")) return false;
  const id = value.slice("harness:".length);
  return id.length >= 1 && id.length <= HARNESS_GATE_ID_BYTES && /^[A-Za-z0-9]/.test(id) && !/[^A-Za-z0-9_-]/.test(id);
}
function invalidHarnessGate(): never {
  throw new Error("harness gate: invalid round id; use harness:<round-id> with 1..64 ASCII letters, digits, underscores or hyphens starting with a letter or digit, then retry");
}
export interface Study { v: 1 | 2; id: string; question: string; mode: Mode; autonomy: Autonomy; createdAt: string }
export interface Actor { kind: "person" | "agent" | "auto"; id?: string }
export function requireExperiment(study: Study): void {
  if (study.mode !== "experiment") throw new Error("experiment command: study mode must be experiment; create a study with ares init <dir> --question TEXT --mode experiment");
}
export interface LedgerEvent { v: 1; at: string; actor: Actor; type: string; data: Record<string, unknown> }

const EVENT_BYTES = 65_536, LEDGER_BYTES = 64 * 1024 * 1024;
const LOCK_STALE_MS = 10 * 60_000;
const QUESTION_MAX = 2000;
export const STUDY_BYTES = 65_536;

/** Agent environment markers the family uses; the first match names the actor. */
const AGENT_MARKERS: readonly [string, string | undefined][] = [
  ["AGENTHUB_PEER_ID", undefined], ["CLAUDECODE", "claude"], ["CLAUDE_CODE_SESSION_ID", "claude"], ["CODEX_THREAD_ID", "codex"], ["PI_SESSION_ID", "pi"],
];
export function detectActor(env: NodeJS.ProcessEnv): Actor {
  for (const [marker, name] of AGENT_MARKERS) {
    const value = env[marker]?.trim();
    if (value) return { kind: "agent", id: (name ?? value).slice(0, 64) };
  }
  return { kind: "person" };
}

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

/**
 * Write a file by temp + fsync + rename so readers never see a partial file. `maxBytes` must be the bound the
 * file's reader uses, so nothing is written that the tool cannot read back.
 */
export function writeAtomic(path: string, text: string, maxBytes: number, mode = 0o644): void {
  assertWritable(text, maxBytes, path);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (error) { try { unlinkSync(tmp); } catch { /* already gone */ } throw error; }
}

/** Read a regular file, stopping one byte past `maxBytes`: special files and oversize files are refused without buffering them. */
export interface ReadOptions { noFollow?: boolean; uid?: number }
function readChunksBounded(path: string, maxBytes: number, options: ReadOptions, consume: (chunk: Buffer) => void): number {
  // Non-blocking open: a FIFO without a writer would otherwise block before the type check.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (options.noFollow ? constants.O_NOFOLLOW : 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${path}: not a regular file`);
    if (options.uid !== undefined && info.uid !== options.uid) throw new Error(`${path}: owned by another user`);
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, 1 << 20));
    let total = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new Error(`${path}: larger than ${maxBytes} bytes`);
      consume(buffer.subarray(0, n));
    }
    return total;
  } finally { closeSync(fd); }
}
export function readBytesBounded(path: string, maxBytes: number, options: ReadOptions = {}): Buffer {
  const parts: Buffer[] = [];
  readChunksBounded(path, maxBytes, options, chunk => parts.push(Buffer.from(chunk)));
  return Buffer.concat(parts);
}
/** Hash a regular file through the bounded reader without retaining its contents. */
export function hashFileBounded(path: string, maxBytes: number, options: ReadOptions = {}): {sha256: string; bytes: number} {
  const hash = createHash("sha256"), bytes = readChunksBounded(path, maxBytes, options, chunk => { hash.update(chunk); });
  return { sha256: hash.digest("hex"), bytes };
}
export function readTextBounded(path: string, maxBytes: number, options: ReadOptions = {}): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(readBytesBounded(path, maxBytes, options)); }
  catch (error) { if (error instanceof TypeError) throw new Error(`${path}: not valid UTF-8`); throw error; }
}
export function readJsonFile(path: string, maxBytes: number): unknown {
  const text = readTextBounded(path, maxBytes);
  try { return JSON.parse(text); } catch { throw new Error(`${path}: not valid JSON`); }
}
/** Refuse a write that the matching bounded read could not load back. */
export function assertWritable(text: string, maxBytes: number, what: string): void {
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`${what} would exceed ${maxBytes} bytes`);
}

export const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Refuse keys outside `allowed`, so a typo never silently drops a field. */
export function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(value).filter(key => !allowed.includes(key));
  if (extra.length) throw new Error(`${what}: unknown field ${extra[0]}`);
}

export function boundedText(value: unknown, what: string, max: number, min = 1): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error(`${what}: text required`);
  const text = value.trim();
  if (text.length < min || text.length > max) throw new Error(`${what}: ${min}..${max} characters`);
  return text;
}

export function studyFile(dir: string, ...parts: string[]): string { return join(dir, ...parts); }

/** Resolve a study directory: it must hold a valid study.json. */
export function openStudy(dir: string): { dir: string; study: Study } {
  const root = resolve(dir), file = join(root, "study.json");
  if (!existsSync(file)) throw new Error(`${root}: no study.json (run ares init first)`);
  return { dir: root, study: validateStudy(readJsonFile(file, STUDY_BYTES)) };
}

export function validateStudy(raw: unknown): Study {
  if (plain(raw) && raw.v !== 1 && raw.v !== 2) throw new Error("study.json: unsupported schema version; use an ares version that supports this study, keeping the original file unchanged");
  if (!plain(raw) || (raw.v !== 1 && raw.v !== 2) || typeof raw.id !== "string" || typeof raw.question !== "string" || typeof raw.createdAt !== "string" ||
    !["survey", "experiment"].includes(raw.mode as string)) throw new Error("study.json: malformed");
  let autonomy: Autonomy;
  try { autonomy = validateAutonomy(raw.autonomy); }
  catch { throw new Error("study.json: unsupported or malformed autonomy policy; restore the last valid study.json or use a compatible ares version before retrying"); }
  if (raw.v === 1 && (typeof autonomy !== "string" || autonomy === "copilot" || autonomy === "step")) throw new Error("study.json: this autonomy policy requires study v2; restore the valid v1 study and use ares autonomy set with a compatible ares version");
  return { ...raw, autonomy } as unknown as Study;
}

export function initStudy(dir: string, options: { question: string; mode?: string; autonomy?: string }, actor: Actor): Study {
  const root = resolve(dir);
  if (existsSync(join(root, "study.json"))) throw new Error(`${root}: a study already exists here`);
  const mode = options.mode ?? "survey", autonomy = validateAutonomyMode(options.autonomy ?? "gates");
  if (mode !== "survey" && mode !== "experiment") throw new Error("--mode: survey or experiment");
  const study: Study = { v: autonomy === "auto" || autonomy === "gates" ? 1 : 2, id: randomUUID(), question: boundedText(options.question, "--question", QUESTION_MAX), mode, autonomy, createdAt: new Date().toISOString() };
  for (const sub of ["", "literature", "literature/cards", "refs"]) mkdirSync(join(root, sub), { recursive: true });
  // link() refuses an existing target, so two concurrent inits cannot both create the study.
  const text = JSON.stringify(study, null, 2) + "\n", tmp = join(root, `study.json.${randomUUID()}.tmp`);
  assertWritable(text, STUDY_BYTES, "study.json");
  const fd = openSync(tmp, "wx", 0o644);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, join(root, "study.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${root}: a study already exists here`); throw error; }
  finally { unlinkSync(tmp); }
  appendEvent(root, actor, "study.init", { id: study.id, mode, autonomy });
  return study;
}

/**
 * Exclusive write lock for one study. A lock older than 10 minutes is treated as abandoned and replaced.
 * ponytail: mtime-based staleness, no owner liveness check. The inode check before unlink is best-effort:
 * a replacement between lstat and unlink can still be removed, after stale takeover of a live owner has
 * already broken exclusion. Upgrade path: an owner liveness probe, including shared-host ownership.
 */
const ownedStudyLocks = new Set<() => void>();
/** MCP termination only: call immediately before process exit, never while continuing async work. */
export function releaseStudyLocksForExit(): void { for (const release of [...ownedStudyLocks]) release(); }
export class StudyLockBusyError extends Error {}
export async function withLock<T>(dir: string, fn: () => Promise<T> | T, inspectOwner: (fd: number) => ReturnType<typeof fstatSync> = fstatSync): Promise<T> {
  const path = join(dir, ".ares.lock");
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let age = 0;
    try { age = Date.now() - statSync(path).mtimeMs; } catch { /* removed meanwhile */ }
    if (age < LOCK_STALE_MS) throw new StudyLockBusyError(`study is locked by another ares command (${path}); retry when it finishes`);
    try { unlinkSync(path); } catch { /* raced with another cleaner */ }
    fd = openSync(path, "wx", 0o600);
  }
  let owner: ReturnType<typeof fstatSync>;
  try { owner = inspectOwner(fd); }
  catch (error) {
    try { unlinkSync(path); } catch { /* the just-created lock may already be absent */ }
    finally { try { closeSync(fd); } catch { /* preserve the original probe failure */ } }
    throw error;
  }
  let released = false;
  const release = () => {
    if (released) return; released = true;
    try { const current = lstatSync(path); if (current.dev === owner.dev && current.ino === owner.ino) unlinkSync(path); }
    catch { /* absent or replaced; never remove a different owner's lock */ }
    finally { try { closeSync(fd); } catch { /* process exit also closes owned descriptors */ } ownedStudyLocks.delete(release); }
  };
  ownedStudyLocks.add(release);
  try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); }
  catch (error) { release(); throw error; }
  // Keep the descriptor open until release so an unlinked inode cannot be reused by a replacement lock.
  try { return await fn(); } finally { release(); }
}

export interface PendingEvent { actor: Actor; type: string; data: Record<string, unknown> }
export type FileWrite = [path: string, text: string, maxBytes: number];

/** Validate command capacity without writing; callers can reserve receipt space before outward effects. */
export function prepareCommit(dir: string, files: FileWrite[], pending: PendingEvent[]): { events: LedgerEvent[]; lines: string[] } {
  const at = new Date().toISOString(), events: LedgerEvent[] = pending.map(e => ({ v: 1, at, ...e }));
  const lines = events.map(e => JSON.stringify(e) + "\n");
  lines.forEach((line, i) => { if (Buffer.byteLength(line) > EVENT_BYTES) throw new Error(`ledger event ${events[i]!.type} exceeds ${EVENT_BYTES} bytes`); });
  const ledger = join(dir, "ledger.jsonl"), size = existsSync(ledger) ? statSync(ledger).size : 0;
  if (size + Buffer.byteLength(lines.join("")) > LEDGER_BYTES) throw new Error(`ledger.jsonl would exceed ${LEDGER_BYTES} bytes; start a new study`);
  for (const [path, text, max] of files) assertWritable(text, max, path);
  return { events, lines };
}
/**
 * Apply one command's changes: every file and ledger bound is checked first (file sizes, event sizes, the ledger's
 * total against its read limit), then the files are written and all events appended in one write. A failed check
 * changes nothing.
 * ponytail: no write-ahead log; a crash between the file writes and the append leaves files without their event.
 */
export function commit(dir: string, files: FileWrite[], pending: PendingEvent[]): LedgerEvent[] {
  const { events, lines } = prepareCommit(dir, files, pending), ledger = join(dir, "ledger.jsonl");
  for (const [path, text, max] of files) { mkdirSync(dirname(path), { recursive: true }); writeAtomic(path, text, max); }
  if (lines.length) appendFileSync(ledger, lines.join(""), { mode: 0o644 });
  return events;
}

export function appendEvent(dir: string, actor: Actor, type: string, data: Record<string, unknown>): LedgerEvent {
  return commit(dir, [], [{ actor, type, data }])[0]!;
}

/** Read the whole ledger; a malformed line fails closed with its line number. */
export function readLedger(dir: string): LedgerEvent[] {
  const path = join(dir, "ledger.jsonl");
  if (!existsSync(path)) return [];
  return parseLedger(readTextBounded(path, LEDGER_BYTES));
}
/** Shared v1 replay validation for bounded, already captured ledger bytes. */
export function parseLedger(text: string): LedgerEvent[] {
  if (Buffer.byteLength(text) > LEDGER_BYTES) throw new Error("ledger.jsonl exceeds its reader bound; restore a bounded ledger before reading");
  const lines = text.split("\n");
  const events: LedgerEvent[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new Error(`ledger.jsonl line ${index + 1}: not JSON`); }
    if (plain(event) && event.v !== 1) throw new Error(`ledger.jsonl line ${index + 1}: unsupported schema version; use an ares version that supports this ledger, keeping all original lines unchanged`);
    if (!plain(event) || event.v !== 1 || typeof event.type !== "string" || !plain(event.data) || !plain(event.actor)) throw new Error(`ledger.jsonl line ${index + 1}: malformed event`);
    events.push(event as unknown as LedgerEvent);
  });
  return events;
}

export interface GateState { gate: GateName; state: "none" | "pending" | "approved" | "rejected"; current?: string; decided?: { decision: "approve" | "reject"; binding: string; actor: Actor; at: string; reason?: string } }

/** The content a gate approval binds to. `undefined` means there is nothing to decide yet. */
export type Binder = (gate: GateName) => string | undefined;

export function gateState(gate: GateName, events: LedgerEvent[], binder: Binder): GateState {
  const current = binder(gate);
  let decided: GateState["decided"];
  for (const event of events) {
    if ((event.type === "gate.approve" || event.type === "gate.reject") && event.data.gate === gate && typeof event.data.binding === "string")
      decided = { decision: event.type === "gate.approve" ? "approve" : "reject", binding: event.data.binding, actor: event.actor, at: event.at, ...(typeof event.data.reason === "string" ? { reason: event.data.reason } : {}) };
  }
  if (current === undefined) return { gate, state: "none", ...(decided ? { decided } : {}) };
  if (!decided || decided.binding !== current) return { gate, state: "pending", current, ...(decided ? { decided } : {}) };
  return { gate, state: decided.decision === "approve" ? "approved" : "rejected", current, decided };
}

export function decideGate(dir: string, gate: GateName, decision: "approve" | "reject", actor: Actor, binder: Binder, reason?: string): GateState {
  if (gate.startsWith("harness:")) {if (!isHarnessGate(gate)) invalidHarnessGate(); requireExperiment(openStudy(dir).study);}
  if (!GATES.includes(gate) && !ACCEPT_ARTIFACTS.some(artifact => gate === `accept:${artifact}`) && !gate.startsWith("plan:") && !isHarnessGate(gate)) throw new Error(`unknown gate: ${gate}; run ares gate list to select a gate`);
  const before = gateState(gate, readLedger(dir), binder);
  if (before.state === "none" && gate.startsWith("accept:")) throw new Error(`gate ${gate}: no current copilot draft; inspect ares autonomy show, create the phase artifact, then use ares gate list and ares gate approve <dir> ${gate}`);
  if (before.state === "none" && isHarnessGate(gate)) throw new Error(`gate ${gate}: nothing to decide yet; run ares harness show / ares harness set to create the round, then run ares gate list`);
  if (before.state === "none") throw new Error(`gate ${gate}: nothing to decide yet${gate.startsWith("plan:") ? "; finish every upstream node with output references, then run ares gate list" : ""}`);
  if (decision === "reject" && !reason) throw new Error(`gate ${gate}: a rejection needs --reason`);
  appendEvent(dir, actor, decision === "approve" ? "gate.approve" : "gate.reject", { gate, binding: before.current!, ...(reason ? { reason } : {}) });
  return gateState(gate, readLedger(dir), binder);
}

/**
 * Pass when the gate is approved for the current content. In auto mode a pending gate passes too, and the returned
 * `auto` approval goes into the command's own commit only when the command succeeds, so a failed command never
 * changes a gate.
 */
export function requireGate(dir: string, study: Study, gate: GateName, binder: Binder, guardedPhase?: Phase): PendingEvent[] {
  if (gate.startsWith("harness:") && !isHarnessGate(gate)) invalidHarnessGate();
  if (gate === "design" || gate === "final" || isHarnessGate(gate)) requireExperiment(study);
  const state = gateState(gate, readLedger(dir), binder);
  if (state.state === "approved") return [];
  if (state.state === "pending" && !gate.startsWith("accept:") && resolveAutonomy(study.autonomy, gate, guardedPhase) === "auto") return [{ actor: { kind: "auto" }, type: "gate.approve", data: { gate, binding: state.current! } }];
  if (state.state === "none" && gate.startsWith("accept:")) throw new Error(`gate ${gate}: no current copilot draft; create the phase artifact, then run ares gate list and ares gate approve <dir> ${gate}`);
  if (state.state === "none" && gate === "final") throw new Error("gate final: complete reserved seeds and close investigate/required ablate inputs before final approval");
  if (state.state === "none" && gate.startsWith("plan:")) throw new Error(`gate ${gate}: upstream outputs are not complete; finish every upstream node and run ares gate list again`);
  if (state.state === "none" && isHarnessGate(gate)) throw new Error(`gate ${gate}: no current round binding; run ares harness show / ares harness set to complete the round inputs, then run ares gate list before retrying`);
  if (state.state === "none") throw new Error(gate === "scope" ? "gate scope: no scope yet (run ares scope)" : gate === "design" ? "gate design: no protocol yet (run ares protocol)" : "gate screen: no included candidates yet");
  if (state.state === "rejected") throw new Error(`gate ${gate} is rejected${state.decided?.reason ? `: ${state.decided.reason}` : ""}; change the content and ask again`);
  throw new Error(`gate ${gate} is pending: run ares gate approve <dir> ${gate}`);
}


export interface PlanOwner { pid: number; host: string; startedAt: string; token: string }
/** Kernel process start identity, rather than lock age, detects a reused PID. */
export function processStart(pid: number): string | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2000, maxBuffer: 4096, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" } });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return undefined;
}
export function readPlanOwner(dir: string): PlanOwner | undefined {
  const file = join(dir, ".ares.plan.lock");
  let stat;
  try { stat = lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("plan controller lock: regular file required; restore the study lock file without links before running ares run");
  const raw = readJsonFile(file, 4096);
  if (!plain(raw) || !Number.isSafeInteger(raw.pid) || (raw.pid as number) < 1 || typeof raw.host !== "string" || !raw.host || typeof raw.startedAt !== "string" || !raw.startedAt || typeof raw.token !== "string" || !raw.token) throw new Error("plan controller lock: malformed owner; inspect the owner process and restore a valid lock before ares run");
  return raw as unknown as PlanOwner;
}
export function assertPlanOwner(dir: string, owner: PlanOwner): void {
  const current = readPlanOwner(dir);
  if (!current || current.token !== owner.token || current.pid !== owner.pid || current.host !== owner.host || current.startedAt !== owner.startedAt) throw new Error("plan controller: ownership changed; stop this controller and inspect ares plan show before restarting");
}
export async function withPlanLock<T>(dir: string, fn: (owner: PlanOwner) => Promise<T>): Promise<T> {
  const startedAt = processStart(process.pid);
  if (!startedAt) throw new Error("plan controller: process start identity unavailable; check local ps access before running ares run");
  const owner: PlanOwner = { pid: process.pid, host: hostname(), startedAt, token: randomUUID() };
  await withLock(dir, () => {
    const previous = readPlanOwner(dir);
    if (previous) {
      const busy = () => new Error(`plan controller: owned by pid ${previous.pid} on ${previous.host} (started ${previous.startedAt}); stop that controller or run on its host after it exits`);
      if (previous.host !== owner.host) throw busy();
      let alive = true;
      try { process.kill(previous.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw busy(); }
      if (alive) {
        const observed = processStart(previous.pid);
        if (!observed || observed === previous.startedAt) throw busy();
      }
      // Short study lock serializes contenders. Never recover by age.
      unlinkSync(join(dir, ".ares.plan.lock"));
    }
    const fd = openSync(join(dir, ".ares.plan.lock"), "wx", 0o600);
    try { writeSync(fd, JSON.stringify(owner) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  });
  try { return await fn(owner); }
  finally {
    // A live matching owner cannot be replaced by any valid contender.
    try {
      const current = readPlanOwner(dir);
      if (current?.token === owner.token) unlinkSync(join(dir, ".ares.plan.lock"));
    } catch { /* Preserve the original failure; never remove a malformed or unverified owner. */ }
  }
}
