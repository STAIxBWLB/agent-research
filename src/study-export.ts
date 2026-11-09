import {urlOrKeyLike} from "./privacy.ts";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, isAbsolute, sep } from "node:path";
import { readAttemptRecords, type Attempt, type AttemptStatus } from "./exp/attempts.ts";
import { ablateResultPath, readClosedAblate } from "./exp/ablate.ts";
import { finalResultPath, readClosedFinal } from "./exp/final.ts";
import { readClosedInvestigation } from "./exp/investigate.ts";
import { readSelection } from "./exp/selection.ts";
import { designBinding, protocolHash, readProtocol } from "./exp/protocol.ts";
import { FORMAT_VERSIONS } from "./manifest.ts";
import { PAPER_EVIDENCE_BYTES, paperBuildPaths } from "./paper/build.ts";
import { assertWritable, openStudy, plain, readLedger, readTextBounded, sha256, withLock, writeAtomic, type LedgerEvent } from "./study.ts";

/** Reader bound for every bundle file; writeAtomic refuses anything larger. */
export const BUNDLE_FILE_BYTES = 64 * 1024 * 1024;
export const BUNDLE_FILES = ["manifest.json", "ledger.jsonl", "attempts.jsonl", "results.json", "reviews.jsonl", "evidence.json"] as const;
const STATUSES: AttemptStatus[] = ["running", "succeeded", "failed", "cancelled", "unknown"];
const SHA256 = /^[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{16,64}$/;
const TOKEN = /^[a-z][a-z0-9_.:-]{0,47}$/;
const GIT_ID = /^[a-f0-9]{40}$/, ATTEMPT_ID = /^[a-f0-9]{16}$/;
const ACTOR_KINDS = new Set(["person", "agent", "auto"]), EVIDENCE_FAMILIES = new Set(["attempt", "posthoc", "investigate", "ablate", "final"]);
/** Exact-shape field or null: hand-edited free text in an identity field is never copied. */
const shaped = (value: unknown, pattern: RegExp): string | null => typeof value === "string" && pattern.test(value) ? value : null;
const finite = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const METRIC_KEYS = new Set(["name", "unit", "metric"]);
/** Closed data keys per ledger event type; unlisted types keep the envelope with empty data. Never host, containerId or hubProject. */
const LEDGER_KEYS: Record<string, readonly string[]> = {
  "scope.set": ["sha256"], "autonomy.set": ["from", "to", "phase"], "gate.approve": ["gate", "binding"], "gate.reject": ["gate", "binding"],
  "lit.search": ["sources", "added", "merged", "total"], "lit.screen": ["decision"], "lit.card": ["id", "sha256"], "lit.bib": ["entries", "sha256"], "lit.verify": ["verified", "failed"],
  "archive.exported": ["fingerprint"], "skill.proposed": ["skillProposal", "sha256"], "skill.decided": ["skillProposal", "decision"], "watch.set": ["sha256"],
  "plan.set": ["revision", "state", "sha256"], "plan.gates": ["revision"], "plan.paused": ["revision"], "plan.control": ["revision"], "node.observed": ["revision", "status"], "node.intent": ["revision"],
  "executor.set": ["kind"], "protocol.set": ["sha256", "identitySha256", "protocolHash", "treeHash"], "selection.set": ["sha256", "metric"], "final.seeds.set": ["sha256"],
  "investigate.closed": ["run", "sha256", "ruleSha256", "winner"], "ablate.closed": ["sha256", "investigateSha256"], "final.closed": ["sha256", "status", "investigateSha256"],
  "idea.decided": ["decision"], "paper.built": ["manuscriptSha256", "evidenceSha256", "sourceManuscriptSha256"], "review.added": [], "review.resolved": ["buildSha256"],
  "attempt.started": ["id", "run", "seed", "commit", "treeId"],
};
for (const t of ["attempt.run", "attempt.snapshot", "attempt.stage.changed", "attempt.stage.evidence", "attempt.stage.recovered", "attempt.stage.started", "attempt.succeeded", "attempt.failed", "attempt.cancelled", "attempt.unknown"]) LEDGER_KEYS[t] = ["id", "run", "stage", "status"];

export interface BundleManifest {
  bundle: 1; formats: typeof FORMAT_VERSIONS; studyIdSha256: string; mode: string; protocolHash: string | null; sealBinding: string | null;
  window: { from: string | null; to: string | null }; counts: { attempts: number; byStatus: Record<AttemptStatus, number>; byRun: Record<string, Record<AttemptStatus, number>>; ledgerEvents: number; reviews: number };
  files: Record<string, string>;
}
export interface BundleListing { bundle: string; files: string[]; wouldWrite: true }

/** A closed scalar: numbers, booleans, hashes and enum-like tokens survive; free text, paths and URLs do not. */
function closed(value: unknown): value is number | boolean | string | null {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  return typeof value === "string" && (HEX.test(value) || TOKEN.test(value));
}
function reduceData(data: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) { const value = Object.hasOwn(data, key) ? data[key] : undefined; if (closed(value) || (METRIC_KEYS.has(key) && typeof value === "string")) out[key] = value; else if (Array.isArray(value) && value.every(closed)) out[key] = value; }
  return out;
}
/** Result keys that hold free text even when a value happens to be one token. */
const FREE_TEXT_KEYS = new Set(["removes", "description", "note", "notes", "label", "text", "message", "cause", "retryWhen", "method", "question"]);
/** Keep numbers, booleans, null, hashes and closed tokens recursively; drop free-text keys and every other string. */
function project(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(project).filter(v => v !== undefined);
  if (plain(value)) { const out: Record<string, unknown> = {}; for (const [k, v] of Object.entries(value)) { if (FREE_TEXT_KEYS.has(k)) continue; const p = METRIC_KEYS.has(k) && typeof v === "string" ? v : project(v); if (p !== undefined) out[k] = p; } return out; }
  return closed(value) ? value : undefined;
}
/** A parseable ISO timestamp or null. */
const isoAt = (value: unknown): string | null => typeof value === "string" && value.length <= 64 && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
function reduceEvent(event: LedgerEvent) {
  const actor = { kind: ACTOR_KINDS.has(event.actor?.kind as string) ? event.actor.kind : "other", ...(event.actor.id !== undefined ? { idSha256: sha256(event.actor.id) } : {}) };
  const at = isoAt(event.at);
  return { v: event.v, at, actor, type: TOKEN.test(event.type) ? event.type : "other", data: reduceData(plain(event.data) ? event.data : {}, (Object.hasOwn(LEDGER_KEYS, event.type) ? LEDGER_KEYS[event.type]! : [])) };
}
// Closed codes emitted by attempts.ts, metrics.ts and artifacts.ts; never derive a class from user prose.
const ATTEMPT_REASON_CODES = new Set([
  "executor-start", "executor-start-uncertain", "preparation", "lost", "wall-clock", "candidate-exit", "evaluator-exit",
  "evidence-read", "invalid-metrics", "malformed-metrics", "undeclared-metric", "missing-metric", "invalid-metric-value",
  "nonfinite-metric", "metrics-limit", "duplicate-metric", "missing-metrics", "missing-receipt", "changed-output",
  "artifact-limit", "artifact-read", "invalid-artifact", "invalid-log-state", "missing-logs",
]);
function reasonClass(reason: string | undefined, status: AttemptStatus): string | undefined {
  if (reason === undefined) return undefined;
  if (status === "cancelled") return "cancel-reason";
  return ATTEMPT_REASON_CODES.has(reason) ? reason : "other";
}
function duration(start: unknown, end: unknown): number | null {
  if (typeof start !== "string" || typeof end !== "string") return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) ? ms : null;
}
function digest(image: unknown): string | null {
  const match = typeof image === "string" ? /@(sha256:[a-f0-9]{64})$/.exec(image) : null;
  return match?.[1] ?? null;
}
function attemptRow(a: Attempt) {
  const stages: Record<string, unknown> = {};
  for (const name of ["candidate", "evaluator"] as const) {
    const stage = plain(a.stages) && Object.hasOwn(a.stages, name) ? a.stages[name] : undefined;
    if (!plain(stage)) continue;
    stages[name] = { exitCode: Number.isSafeInteger(stage.exitCode) ? stage.exitCode : null, durationMs: duration(stage.startedAt, stage.endedAt), network: stage.network === "none" ? "none" : "other", limits: plain(stage.limits) ? reduceData(stage.limits, ["cpus", "memoryMb", "pidsLimit", "wallSeconds", "gpus"]) : null, imageDigest: digest(stage.image) };
  }
  for (const parent of a.pipeline?.completed ?? []) {
    const stage = parent.record;
    stages[parent.name] = { exitCode: stage.exitCode ?? null, durationMs: duration(stage.startedAt, stage.endedAt), network: "none", imageDigest: digest(stage.image), manifestSha256: parent.ref.sha256, inputIndependent: false };
  }
  const reason = reasonClass(a.reason, a.status);
  return {
    id: a.id, run: a.run, studyIdSha256: sha256(String(a.studyId)), protocolHash: shaped(a.protocolHash, SHA256), sealBinding: shaped(a.sealBinding, SHA256), commit: shaped(a.commit, GIT_ID), treeId: shaped(a.treeId, GIT_ID),
    snapshotSha256: shaped(a.snapshotSha256, SHA256), seed: Number.isSafeInteger(a.seed) ? a.seed : null, labelSha256: sha256(String(a.label ?? "")), retryOf: shaped(a.retryOf, ATTEMPT_ID), status: a.status, stage: a.stage, ...(reason ? { reasonClass: reason } : {}),
    ...(a.verifiedInputs !== undefined ? { inputs: Object.fromEntries(Object.entries(a.verifiedInputs).map(([name, hash]) => [name, shaped(hash, SHA256)])) } : {}),
    ...(a.gpuDevices !== undefined ? { gpuDeviceCount: a.gpuDevices.length } : {}),
    durationMs: duration(a.startedAt, a.endedAt), stages,
    metrics: (Array.isArray(a.metrics) ? a.metrics : []).map(m => ({ name: m.name, unit: m.unit, value: finite(m.value), provenance: m.provenance === "ares-observed" ? "ares-observed" : "other" })),
    outputs: (Array.isArray(a.outputs) ? a.outputs : []).map(o => ({ sha256: shaped(o.sha256, SHA256), bytes: finite(o.bytes) })),
    sealing: plain(a.sealing) ? { separateContainers: a.sealing.separateContainers === true, evaluatorReadOnly: a.sealing.evaluatorReadOnly === true, candidateHasNoEvaluator: a.sealing.candidateHasNoEvaluator === true } : null,
  };
}
function closedResult<T>(name: string, read: () => { result: T }): unknown {
  try { return project(read().result); }
  catch (error) { throw new Error(`study export: ${name} result is not a verified closed result (${(error as Error).message}); fix it as that message says, then export again`); }
}
function reviews(events: LedgerEvent[]) {
  const resolved = new Map<string, number>();
  for (const e of events) if (e.type === "review.resolved" && typeof e.data.reviewId === "string") resolved.set(e.data.reviewId, (resolved.get(e.data.reviewId) ?? 0) + 1);
  return events.filter(e => e.type === "review.added" && plain(e.data.review)).map(e => {
    const review = e.data.review as Record<string, unknown>, findings = Array.isArray(review.findings) ? review.findings as Record<string, unknown>[] : [];
    const reviewer = plain(review.reviewer) ? review.reviewer : {}, kinds: Record<string, number> = {};
    for (const f of findings) { const kind = typeof f.kind === "string" && TOKEN.test(f.kind) ? f.kind : "other"; kinds[kind] = (kinds[kind] ?? 0) + 1; }
    const id = typeof e.data.id === "string" ? e.data.id : "";
    const family = typeof reviewer.modelFamily === "string" ? reviewer.modelFamily.trim().toLowerCase() : "";
    return { idSha256: sha256(id), at: isoAt(e.at), modelFamily: /^[a-z0-9][a-z0-9 ._-]{0,47}$/.test(family) ? family : "other", buildSha256: typeof review.buildSha256 === "string" && HEX.test(review.buildSha256) ? review.buildSha256 : null, findings: findings.length, blocking: findings.filter(f => f.blocking === true).length, kinds, resolved: resolved.get(id) ?? 0 };
  });
}
function evidence(dir: string) {
  const path = paperBuildPaths(dir).evidence;
  if (!existsSync(path)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readTextBounded(path, PAPER_EVIDENCE_BYTES)); } catch { throw new Error("study export: paper/build/evidence.json is unreadable, invalid JSON or oversized; rebuild the paper before exporting"); }
  if (!plain(raw) || raw.v !== 1 || !Array.isArray(raw.placeholders)) throw new Error("study export: paper/build/evidence.json has an unsupported shape; rebuild the paper before exporting");
  return {
    v: 1, manuscriptSha256: typeof raw.manuscriptSha256 === "string" && SHA256.test(raw.manuscriptSha256) ? raw.manuscriptSha256 : null,
    placeholders: (raw.placeholders as Record<string, unknown>[]).filter(p => p.kind === "number").map(p => {
      const ref = typeof p.ref === "string" ? p.ref : "", attempt = /^(?:attempt|posthoc):([a-f0-9]{16})\./.exec(ref)?.[1];
      const source = plain(p.source) ? p.source : {};
      return { refSha256: sha256(ref), family: ((f: string | undefined) => f && EVIDENCE_FAMILIES.has(f) ? f : "other")(/^[a-z]+/.exec(ref)?.[0]), ...(attempt ? { attempt } : {}), sourceSha256: typeof source.sha256 === "string" && SHA256.test(source.sha256) ? source.sha256 : null };
    }),
  };
}

/** Path rules run on decoded keys and string values, so a boundary is a real character (a raw newline or tab included). */
const PATH_SCANS: RegExp[] = [
  // POSIX: `/` or `~/` not preceded by a letter, digit or underscore; units such as tokens/s keep a word character there.
  /(?<![\p{L}\p{N}_])(?:\/|~\/)/u,
  /\b[A-Za-z]:\\/,
  // Windows root-relative (\Users\x), bare \ and UNC (\\server): any backslash not preceded by a word character or backslash.
  /(?<![\p{L}\p{N}_\\])\\/u,
];
const ENV_VALUE = /(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*=[^\s"]/;
/** Every key and string value of a JSON document, or of each JSONL line; text that is not JSON is scanned as one string. */
function* decodedStrings(text: string): Generator<string> {
  const walk = function* (value: unknown): Generator<string> {
    if (typeof value === "string") yield value;
    else if (Array.isArray(value)) for (const item of value) yield* walk(item);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { yield key; yield* walk(item); }
  };
  let whole: unknown, parsed = false;
  try { whole = JSON.parse(text); parsed = true; } catch { /* JSONL or plain text */ }
  if (parsed) { yield* walk(whole); return; }
  for (const line of text.split("\n")) {
    if (!line) continue;
    try { yield* walk(JSON.parse(line)); } catch { yield line; }
  }
}
/** Refuse the whole bundle if any file carries a path, URL, env assignment or key-like token. */
export function scanBundle(files: Record<string, string>): void {
  const refuse = (name: string, kind: string): never => { throw new Error(`study export: refused; ${name} would contain a ${kind}. Remove it from the study record (for example an attempt label or ledger field) and retry; nothing was written`); };
  for (const [name, text] of Object.entries(files)) {
    for (const value of decodedStrings(text)) {
      if (PATH_SCANS.some(pattern => pattern.test(value))) refuse(name, "absolute path");
      const marker = urlOrKeyLike(value);
      if (marker) refuse(name, marker);
      if (ENV_VALUE.test(value)) refuse(name, "env value");
    }
  }
}

function emptyDir(path: string): void {
  if (existsSync(path)) { if (!lstatSync(path).isDirectory()) throw new Error("study export: --bundle exists and is not a directory; choose a new or empty directory"); if (readdirSync(path).length) throw new Error("study export: --bundle directory is not empty; choose a new or empty directory"); }
  else mkdirSync(path, { recursive: true });
}

/** Real path of the nearest existing ancestor with the missing tail re-appended, so symlinks cannot hide containment. */
function realTarget(path: string): string {
  const tail: string[] = [];
  let current = path;
  while (!existsSync(current)) { const parent = dirname(current); if (parent === current) break; tail.unshift(basename(current)); current = parent; }
  return join(realpathSync(current), ...tail);
}
/** Caller holds the study lock across every bounded source read. */
function readBundle(dirArg: string, maxFileBytes: number) {
  const { dir, study } = openStudy(dirArg);
  const events = readLedger(dir);
  const zero = () => Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<AttemptStatus, number>;
  const byStatus = zero(), runCounts = new Map<string, Record<AttemptStatus, number>>(), attemptLines: string[] = [];
  let attemptBytes = 0;
  // One pass; only the projected row and counts outlive each raw record.
  for (const a of study.mode === "experiment" ? readAttemptRecords(dir) : []) {
    const line = JSON.stringify(attemptRow(a)) + "\n";
    attemptBytes += Buffer.byteLength(line);
    if (attemptBytes > maxFileBytes) throw new Error(`study export: attempts.jsonl would exceed ${maxFileBytes} bytes; nothing was written`);
    attemptLines.push(line);
    byStatus[a.status]++;
    let row = runCounts.get(a.run); if (!row) runCounts.set(a.run, row = zero()); row[a.status]++;
  }
  const byRun: Record<string, Record<AttemptStatus, number>> = Object.create(null);
  for (const [run, row] of [...runCounts].sort(([x], [y]) => x < y ? -1 : 1)) byRun[run] = row;
  const experiment = study.mode === "experiment", current = experiment ? readProtocol(dir) : undefined, rule = current ? readSelection(dir, current) : undefined;
  const investigate: Record<string, unknown> = {};
  if (rule && existsSync(join(dir, "runs", rule.run, "investigate.json"))) investigate[rule.run] = closedResult("investigate", () => readClosedInvestigation(dir));
  const reviewRows = reviews(events), protocol = study.mode === "experiment" ? readProtocol(dir) : undefined;
  const lines = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const files: Record<string, string> = {
    "ledger.jsonl": lines(events.map(reduceEvent)),
    "attempts.jsonl": attemptLines.join(""),
    "results.json": JSON.stringify({
      investigate,
      ablate: experiment && existsSync(ablateResultPath(dir)) ? closedResult("ablate", () => readClosedAblate(dir)) : null,
      final: experiment && existsSync(finalResultPath(dir)) ? closedResult("final", () => readClosedFinal(dir)) : null,
    }, null, 2) + "\n",
    "reviews.jsonl": lines(reviewRows),
    "evidence.json": JSON.stringify(evidence(dir), null, 2) + "\n",
  };
  const manifest: BundleManifest = {
    bundle: 1, formats: { ...FORMAT_VERSIONS }, studyIdSha256: sha256(study.id), mode: study.mode,
    protocolHash: protocol ? protocolHash(protocol) : null, sealBinding: study.mode === "experiment" ? designBinding(dir) ?? null : null,
    window: (() => { const ats = events.map(e => isoAt(e.at)).filter((v): v is string => v !== null); return { from: ats[0] ?? null, to: ats.at(-1) ?? null }; })(),
    counts: { attempts: attemptLines.length, byStatus, byRun, ledgerEvents: events.length, reviews: reviewRows.length },
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])),
  };
  files["manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";
  return { files, manifest };
}

/** Read one locked study snapshot, then validate and publish without holding the study lock. */
export async function exportBundle(dirArg: string, options: { bundle: string; list?: boolean }, maxFileBytes = BUNDLE_FILE_BYTES): Promise<BundleManifest | BundleListing> {
  const dir = resolve(dirArg), target = resolve(options.bundle), inside = relative(realpathSync(dir), realTarget(target));
  if (inside === "" || (!(inside === ".." || inside.startsWith(".." + sep)) && !isAbsolute(inside))) throw new Error("study export: --bundle is inside the study directory; choose a directory outside the study");
  if (options.list) {
    await withLock(dir, () => openStudy(dir));
    return { bundle: options.bundle, files: [...BUNDLE_FILES], wouldWrite: true };
  }
  const { files, manifest } = await withLock(dir, () => readBundle(dir, maxFileBytes));
  scanBundle(files);
  for (const name of BUNDLE_FILES) assertWritable(files[name]!, maxFileBytes, `study export: ${name}; nothing was written`);
  emptyDir(target);
  for (const name of BUNDLE_FILES) writeAtomic(join(target, name), files[name]!, maxFileBytes);
  return manifest;
}
