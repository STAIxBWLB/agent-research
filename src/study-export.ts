import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readAttemptRecords, type Attempt, type AttemptStatus } from "./exp/attempts.ts";
import { ABLATE_BYTES, ablateResultPath } from "./exp/ablate.ts";
import { FINAL_RESULT_BYTES, finalResultPath } from "./exp/final.ts";
import { INVESTIGATE_BYTES, investigateResultPath } from "./exp/investigate.ts";
import { designBinding, protocolHash, readProtocol } from "./exp/protocol.ts";
import { FORMAT_VERSIONS } from "./manifest.ts";
import { PAPER_EVIDENCE_BYTES, paperBuildPaths } from "./paper/build.ts";
import { openStudy, plain, readLedger, readTextBounded, sha256, writeAtomic, type LedgerEvent } from "./study.ts";

/** Reader bound for every bundle file; writeAtomic refuses anything larger. */
export const BUNDLE_FILE_BYTES = 64 * 1024 * 1024;
export const BUNDLE_FILES = ["manifest.json", "ledger.jsonl", "attempts.jsonl", "results.json", "reviews.jsonl", "evidence.json"] as const;
const STATUSES: AttemptStatus[] = ["running", "succeeded", "failed", "cancelled", "unknown"];
const HEX = /^[a-f0-9]{16,64}$/;
const TOKEN = /^[a-z][a-z0-9_.:-]{0,47}$/;
const RUN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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
function reduceData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) if (closed(value)) out[key] = value;
  return out;
}
function reduceEvent(event: LedgerEvent) {
  const actor = { kind: event.actor.kind, ...(event.actor.id !== undefined ? { idSha256: sha256(event.actor.id) } : {}) };
  return { v: event.v, at: event.at, actor, type: event.type, data: reduceData(plain(event.data) ? event.data : {}) };
}
function reasonClass(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const head = reason.split(/[\s:;,]/, 1)[0] ?? "";
  return TOKEN.test(head) ? head : "other";
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
  for (const [name, stage] of Object.entries(a.stages ?? {})) {
    if (!stage) continue;
    stages[name] = { exitCode: Number.isSafeInteger(stage.exitCode) ? stage.exitCode : null, durationMs: duration(stage.startedAt, stage.endedAt), network: stage.network === "none" ? "none" : "other", limits: plain(stage.limits) ? reduceData(stage.limits) : null, imageDigest: digest(stage.image) };
  }
  const reason = reasonClass(a.reason);
  return {
    id: a.id, run: a.run, studyIdSha256: sha256(String(a.studyId)), protocolHash: a.protocolHash ?? null, sealBinding: a.sealBinding ?? null, commit: a.commit, treeId: a.treeId ?? null,
    snapshotSha256: a.snapshotSha256 ?? null, seed: a.seed, label: a.label ?? "", retryOf: a.retryOf ?? null, status: a.status, stage: a.stage, ...(reason ? { reasonClass: reason } : {}),
    durationMs: duration(a.startedAt, a.endedAt), stages,
    metrics: (Array.isArray(a.metrics) ? a.metrics : []).map(m => ({ name: m.name, unit: m.unit, value: m.value, provenance: m.provenance })),
    outputs: (Array.isArray(a.outputs) ? a.outputs : []).map(o => ({ sha256: o.sha256, bytes: o.bytes })),
    sealing: plain(a.sealing) ? { separateContainers: a.sealing.separateContainers === true, evaluatorReadOnly: a.sealing.evaluatorReadOnly === true, candidateHasNoEvaluator: a.sealing.candidateHasNoEvaluator === true } : null,
  };
}
const PATH_KEYS = new Set(["path", "paths", "file", "files", "workdir", "mounts", "mount", "argv", "env", "containerId", "host", "image"]);
/** Results stay verbatim except path-like keys and absolute-path strings. */
function stripPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPaths);
  if (plain(value)) return Object.fromEntries(Object.entries(value).filter(([k]) => !PATH_KEYS.has(k)).map(([k, v]) => [k, stripPaths(v)]));
  if (typeof value === "string" && /^(\/|[A-Za-z]:\\)/.test(value)) return null;
  return value;
}
function readResult(path: string, bound: number): unknown {
  if (!existsSync(path)) return null;
  try { return stripPaths(JSON.parse(readTextBounded(path, bound))); }
  catch { throw new Error("study export: a closed result file is unreadable, invalid JSON or oversized; restore it before exporting"); }
}
function reviews(events: LedgerEvent[]) {
  const resolved = new Map<string, number>();
  for (const e of events) if (e.type === "review.resolved" && typeof e.data.reviewId === "string") resolved.set(e.data.reviewId, (resolved.get(e.data.reviewId) ?? 0) + 1);
  return events.filter(e => e.type === "review.added" && plain(e.data.review)).map(e => {
    const review = e.data.review as Record<string, unknown>, findings = Array.isArray(review.findings) ? review.findings as Record<string, unknown>[] : [];
    const reviewer = plain(review.reviewer) ? review.reviewer : {}, kinds: Record<string, number> = {};
    for (const f of findings) { const kind = typeof f.kind === "string" && TOKEN.test(f.kind) ? f.kind : "other"; kinds[kind] = (kinds[kind] ?? 0) + 1; }
    const id = typeof e.data.id === "string" ? e.data.id : "";
    return { idSha256: sha256(id), at: e.at, modelFamily: typeof reviewer.modelFamily === "string" && TOKEN.test(reviewer.modelFamily.toLowerCase()) ? reviewer.modelFamily.toLowerCase() : "other", buildSha256: typeof review.buildSha256 === "string" && HEX.test(review.buildSha256) ? review.buildSha256 : null, findings: findings.length, blocking: findings.filter(f => f.blocking === true).length, kinds, resolved: resolved.get(id) ?? 0 };
  });
}
function evidence(dir: string) {
  const path = paperBuildPaths(dir).evidence;
  if (!existsSync(path)) return null;
  let raw: unknown;
  try { raw = JSON.parse(readTextBounded(path, PAPER_EVIDENCE_BYTES)); } catch { throw new Error("study export: paper/build/evidence.json is unreadable, invalid JSON or oversized; rebuild the paper before exporting"); }
  if (!plain(raw) || raw.v !== 1 || !Array.isArray(raw.placeholders)) throw new Error("study export: paper/build/evidence.json has an unsupported shape; rebuild the paper before exporting");
  return {
    v: 1, manuscriptSha256: typeof raw.manuscriptSha256 === "string" ? raw.manuscriptSha256 : null,
    placeholders: (raw.placeholders as Record<string, unknown>[]).filter(p => p.kind === "number").map(p => {
      const ref = typeof p.ref === "string" ? p.ref : "", attempt = /^(?:attempt|posthoc):([a-f0-9]{16})\./.exec(ref)?.[1];
      const source = plain(p.source) ? p.source : {};
      return { refSha256: sha256(ref), family: /^[a-z]+/.exec(ref)?.[0] ?? "other", ...(attempt ? { attempt } : {}), sourceSha256: typeof source.sha256 === "string" ? source.sha256 : null };
    }),
  };
}

const SCANS: [string, RegExp][] = [
  ["absolute path", /(^|[\s"'=:(,[])(\/(?:Users|home|root|tmp|var|etc|opt|mnt|srv|workspace|private|Volumes|data)\b|~\/|\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)/],
  ["absolute path", /\b[A-Za-z]:\\/],
  ["url", /\b[a-z][a-z0-9+.-]*:\/\//i],
  ["key-like token", /\b(?:sk|pk|rk)[-_][A-Za-z0-9_-]{12,}|\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{12,}|\bxox[abprs]-[A-Za-z0-9-]{8,}|\bAKIA[0-9A-Z]{12,}|\beyJ[A-Za-z0-9_-]{16,}/],
  ["key-like token", /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/],
  ["env value", /\b[A-Z][A-Z0-9_]{2,}=[^\s"]/],
];
/** Refuse the whole bundle if any file carries a path, URL, env assignment or key-like token. */
export function scanBundle(files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) for (const [kind, pattern] of SCANS)
    if (pattern.test(text)) throw new Error(`study export: refused; ${name} would contain a ${kind}. Remove it from the study record (for example an attempt label or ledger field) and retry; nothing was written`);
}

function emptyDir(path: string): void {
  if (existsSync(path)) { if (readdirSync(path).length) throw new Error("study export: --bundle directory is not empty; choose a new or empty directory"); }
  else mkdirSync(path, { recursive: true });
}

/** Build the content-free bundle from committed study files only; never reads the executor workdir. */
export function exportBundle(dirArg: string, options: { bundle: string; list?: boolean }): BundleManifest | BundleListing {
  if (options.list) { openStudy(dirArg); return { bundle: options.bundle, files: [...BUNDLE_FILES], wouldWrite: true }; }
  const { dir, study } = openStudy(dirArg), events = readLedger(dir);
  const attempts = study.mode === "experiment" ? [...readAttemptRecords(dir)] : [];
  const zero = () => Object.fromEntries(STATUSES.map(s => [s, 0])) as Record<AttemptStatus, number>;
  const byStatus = zero(), byRun: Record<string, Record<AttemptStatus, number>> = {};
  for (const a of attempts) { byStatus[a.status]++; (byRun[a.run] ??= zero())[a.status]++; }
  const runs = study.mode === "experiment" && existsSync(join(dir, "runs")) ? readdirSync(join(dir, "runs")).filter(r => RUN.test(r)).sort() : [];
  const investigate: Record<string, unknown> = {};
  for (const run of runs) { const result = readResult(investigateResultPath(dir, run), INVESTIGATE_BYTES); if (result !== null) investigate[run] = result; }
  const reviewRows = reviews(events), protocol = study.mode === "experiment" ? readProtocol(dir) : undefined;
  const lines = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
  const files: Record<string, string> = {
    "ledger.jsonl": lines(events.map(reduceEvent)),
    "attempts.jsonl": lines(attempts.map(attemptRow)),
    "results.json": JSON.stringify({ investigate, ablate: readResult(ablateResultPath(dir), ABLATE_BYTES), final: readResult(finalResultPath(dir), FINAL_RESULT_BYTES) }, null, 2) + "\n",
    "reviews.jsonl": lines(reviewRows),
    "evidence.json": JSON.stringify(evidence(dir), null, 2) + "\n",
  };
  const manifest: BundleManifest = {
    bundle: 1, formats: { ...FORMAT_VERSIONS }, studyIdSha256: sha256(study.id), mode: study.mode,
    protocolHash: protocol ? protocolHash(protocol) : null, sealBinding: study.mode === "experiment" ? designBinding(dir) ?? null : null,
    window: { from: events[0]?.at ?? null, to: events.at(-1)?.at ?? null },
    counts: { attempts: attempts.length, byStatus, byRun, ledgerEvents: events.length, reviews: reviewRows.length },
    files: Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)])),
  };
  files["manifest.json"] = JSON.stringify(manifest, null, 2) + "\n";
  scanBundle(files);
  emptyDir(options.bundle);
  for (const name of BUNDLE_FILES) writeAtomic(join(options.bundle, name), files[name]!, BUNDLE_FILE_BYTES);
  return manifest;
}
