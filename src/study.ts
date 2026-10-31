import { closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, statSync, unlinkSync, writeSync, appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export type Mode = "survey" | "experiment";
export type Autonomy = "auto" | "gates";
export type GateName = "scope" | "screen";
export const GATES: readonly GateName[] = ["scope", "screen"];
export interface Study { v: 1; id: string; question: string; mode: Mode; autonomy: Autonomy; createdAt: string }
export interface Actor { kind: "person" | "agent" | "auto"; id?: string }
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
export function writeAtomic(path: string, text: string, maxBytes: number): void {
  assertWritable(text, maxBytes, path);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o644);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (error) { try { unlinkSync(tmp); } catch { /* already gone */ } throw error; }
}

/** Read a regular file, stopping one byte past `maxBytes`: special files and oversize files are refused without buffering them. */
export function readBytesBounded(path: string, maxBytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`${path}: not a regular file`);
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, 1 << 20)), parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const n = readSync(fd, buffer, 0, buffer.length, null);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) throw new Error(`${path}: larger than ${maxBytes} bytes`);
      parts.push(Buffer.from(buffer.subarray(0, n)));
    }
    return Buffer.concat(parts);
  } finally { closeSync(fd); }
}
export function readTextBounded(path: string, maxBytes: number): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(readBytesBounded(path, maxBytes)); }
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
  return { dir: root, study: validStudy(readJsonFile(file, STUDY_BYTES)) };
}

function validStudy(raw: unknown): Study {
  if (!plain(raw) || raw.v !== 1 || typeof raw.id !== "string" || typeof raw.question !== "string" || typeof raw.createdAt !== "string" ||
    !["survey", "experiment"].includes(raw.mode as string) || !["auto", "gates"].includes(raw.autonomy as string)) throw new Error("study.json: malformed");
  return raw as unknown as Study;
}

export function initStudy(dir: string, options: { question: string; mode?: string; autonomy?: string }, actor: Actor): Study {
  const root = resolve(dir);
  if (existsSync(join(root, "study.json"))) throw new Error(`${root}: a study already exists here`);
  const mode = options.mode ?? "survey", autonomy = options.autonomy ?? "gates";
  if (mode !== "survey" && mode !== "experiment") throw new Error("--mode: survey or experiment");
  if (autonomy !== "auto" && autonomy !== "gates") throw new Error("--autonomy: auto or gates");
  const study: Study = { v: 1, id: randomUUID(), question: boundedText(options.question, "--question", QUESTION_MAX), mode, autonomy, createdAt: new Date().toISOString() };
  for (const sub of ["", "literature", "literature/cards", "refs"]) mkdirSync(join(root, sub), { recursive: true });
  writeAtomic(join(root, "study.json"), JSON.stringify(study, null, 2) + "\n", STUDY_BYTES);
  appendEvent(root, actor, "study.init", { id: study.id, mode, autonomy });
  return study;
}

/**
 * Exclusive write lock for one study. A lock older than 10 minutes is treated as abandoned and replaced.
 * ponytail: mtime-based staleness, no owner liveness check; add a pid probe if two hosts share a study.
 */
export async function withLock<T>(dir: string, fn: () => Promise<T> | T): Promise<T> {
  const path = join(dir, ".ares.lock");
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let age = 0;
    try { age = Date.now() - statSync(path).mtimeMs; } catch { /* removed meanwhile */ }
    if (age < LOCK_STALE_MS) throw new Error(`study is locked by another ares command (${path}); retry when it finishes`);
    try { unlinkSync(path); } catch { /* raced with another cleaner */ }
    fd = openSync(path, "wx", 0o600);
  }
  try { writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`); } finally { closeSync(fd); }
  try { return await fn(); } finally { try { unlinkSync(path); } catch { /* already removed */ } }
}

export function appendEvent(dir: string, actor: Actor, type: string, data: Record<string, unknown>): LedgerEvent {
  const event: LedgerEvent = { v: 1, at: new Date().toISOString(), actor, type, data };
  const line = JSON.stringify(event) + "\n";
  if (Buffer.byteLength(line) > EVENT_BYTES) throw new Error(`ledger event ${type} exceeds ${EVENT_BYTES} bytes`);
  appendFileSync(join(dir, "ledger.jsonl"), line, { mode: 0o644 });
  return event;
}

/** Read the whole ledger; a malformed line fails closed with its line number. */
export function readLedger(dir: string): LedgerEvent[] {
  const path = join(dir, "ledger.jsonl");
  if (!existsSync(path)) return [];
  const lines = readTextBounded(path, LEDGER_BYTES).split("\n");
  const events: LedgerEvent[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    let event: unknown;
    try { event = JSON.parse(line); } catch { throw new Error(`ledger.jsonl line ${index + 1}: not JSON`); }
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
  if (!GATES.includes(gate)) throw new Error(`unknown gate: ${gate}`);
  const before = gateState(gate, readLedger(dir), binder);
  if (before.state === "none") throw new Error(`gate ${gate}: nothing to decide yet`);
  if (decision === "reject" && !reason) throw new Error(`gate ${gate}: a rejection needs --reason`);
  appendEvent(dir, actor, decision === "approve" ? "gate.approve" : "gate.reject", { gate, binding: before.current!, ...(reason ? { reason } : {}) });
  return gateState(gate, readLedger(dir), binder);
}

/** Pass when the gate is approved for the current content; in auto mode approve it as `auto` first. */
export function requireGate(dir: string, study: Study, gate: GateName, binder: Binder): void {
  const state = gateState(gate, readLedger(dir), binder);
  if (state.state === "approved") return;
  if (state.state === "pending" && study.autonomy === "auto") {
    appendEvent(dir, { kind: "auto" }, "gate.approve", { gate, binding: state.current! });
    return;
  }
  if (state.state === "none") throw new Error(gate === "scope" ? "gate scope: no scope yet (run ares scope)" : "gate screen: no included candidates yet");
  if (state.state === "rejected") throw new Error(`gate ${gate} is rejected${state.decided?.reason ? `: ${state.decided.reason}` : ""}; change the content and ask again`);
  throw new Error(`gate ${gate} is pending: run ares gate approve <dir> ${gate}`);
}
