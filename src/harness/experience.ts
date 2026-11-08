import {lstatSync} from "node:fs";
import {join} from "node:path";
import {commit, openStudy, requireExperiment, isHarnessGate, readLedger, readTextBounded, onlyKeys, plain, sha256, type Actor, type LedgerEvent} from "../study.ts";
import {canonical} from "../plan/state.ts";
import {hasHarnessCredential} from "./privacy.ts";
import {createAmemClient} from "../memory/amem.ts";
import {rankLessons} from "../memory/lessons.ts";
import {readScreenedAmem} from "../memory/amem-show.ts";
import {recheckExperienceSources} from "./experience-source.ts";
import type {ProcessRunner} from "../exp/executor.ts";

export const EXPERIENCE_BYTES = 16_384, EXPERIENCE_INDEX_BYTES = 1_048_576, EXPERIENCE_LIMIT = 16;
export interface HarnessStream {v: 1; id: string; revision: number; tasks: string[]}
export interface ExperienceRequest {
  v: 1; round: string; taskId: string; condition: "baseline" | "no-library" | "retrieval-only" | "prior-experience";
  model: string; runtime: string; selected: {id: string; reason: string}[];
}
export interface FrozenExperience extends Omit<ExperienceRequest, "selected"> {
  streamSha256: string; entries: {id: string; digest: string; sourceVersion: string; reason: string}[];
}
export interface ExperienceReadOptions {runner?: ProcessRunner; env?: NodeJS.ProcessEnv; now?: () => number}
const streamPath = (dir: string) => join(dir, "design", "harness-stream.json");
const contextPath = (dir: string) => join(dir, "design", "harness-experience.json");
const hash = (value: unknown) => sha256(canonical(value));
function fail(cause: string): never {throw new Error(`experience: ${cause}; restore the recorded stream/context or start a new study/round with explicit experience freeze, then retry`);}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!plain(value)) fail("object required"); try {onlyKeys(value, fields, "experience");} catch {fail(`unknown field; allowed fields: ${fields.join(", ")}`);} return value;
}
function text(value: unknown, bound: number): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > bound || hasHarnessCredential(value)) fail("text is blank, over-bound or contains a URL/credential"); return value;
}
function id(value: unknown): string {const result = text(value, 64); if (!isHarnessGate(`harness:${result}`)) fail("round/stream id must follow the ASCII run-name rule"); return result;}
function digest(value: unknown): string {if (typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) fail("lowercase SHA-256 required"); return value;}
export function validateHarnessStream(raw: unknown): HarnessStream {
  const row = object(raw, ["v", "id", "revision", "tasks"]);
  if (row.v !== 1) fail("unsupported stream version; keep original bytes and use a supporting version");
  if (!Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || !Array.isArray(row.tasks) || !row.tasks.length || row.tasks.length > EXPERIENCE_LIMIT) fail("stream requires a positive revision and 1..16 tasks");
  const tasks = row.tasks.map(value => text(value, 256)); if (new Set(tasks).size !== tasks.length) fail("stream task ids must be unique");
  return {v: 1, id: id(row.id), revision: row.revision as number, tasks};
}
export function validateExperienceRequest(raw: unknown): ExperienceRequest {
  const row = object(raw, ["v", "round", "taskId", "condition", "model", "runtime", "selected"]);
  if (row.v !== 1) fail("unsupported context version; keep original bytes and use a supporting version");
  if (!["baseline", "no-library", "retrieval-only", "prior-experience"].includes(row.condition as string) || !Array.isArray(row.selected) || row.selected.length > EXPERIENCE_LIMIT) fail("invalid condition or more than 16 selected entries");
  const selected = row.selected.map(value => {const item = object(value, ["id", "reason"]); if (typeof item.id !== "string" || item.id.length !== 32 || !/^[a-f0-9]{32}$/.test(item.id)) fail("full exact amem id required"); return {id: item.id, reason: text(item.reason, 1000)};});
  if (new Set(selected.map(value => value.id)).size !== selected.length) fail("duplicate selected id");
  if (["baseline", "no-library"].includes(row.condition as string) && selected.length) fail("baseline/no-library conditions cannot receive experience");
  const result = {v: 1 as const, round: id(row.round), taskId: text(row.taskId, 256), condition: row.condition as ExperienceRequest["condition"], model: text(row.model, 128), runtime: text(row.runtime, 128), selected};
  if (Buffer.byteLength(canonical(result)) > EXPERIENCE_BYTES) fail("selection exceeds 16 KiB"); return result;
}
function boundedSnapshot(raw: unknown): FrozenExperience {
  // Omit index-only keys before validating the request's strict allowlist.
  const row = object(raw, ["v", "round", "taskId", "condition", "model", "runtime", "streamSha256", "entries"]);
  if (!Array.isArray(row.entries) || row.entries.length) fail("nonempty frozen source provenance unavailable until completed round/lesson receipts exist");
  const {streamSha256, entries: _entries, ...rest} = row;
  const {selected: _selected, ...request} = validateExperienceRequest({...rest, selected: []});
  if (!["baseline", "no-library"].includes(request.condition)) fail("nonempty experience source chain is unavailable; only empty baseline/no-library can freeze");
  const value: FrozenExperience = {...request, streamSha256: digest(streamSha256), entries: []};
  if (Buffer.byteLength(canonical(value)) > EXPERIENCE_BYTES) fail("frozen snapshot exceeds 16 KiB"); return value;
}
function file(dir: string, name: string, max: number): unknown | undefined {
  try {
    const design = lstatSync(join(dir, "design"), {throwIfNoEntry: false});
    if (design && (!design.isDirectory() || design.isSymbolicLink())) fail("design is not a regular directory");
    const stat = lstatSync(name, {throwIfNoEntry: false}); if (!stat) return undefined;
    if (!stat.isFile() || stat.isSymbolicLink()) fail("record is not a regular file");
    return JSON.parse(readTextBounded(name, max, {noFollow: true}));
  } catch {return fail("record is linked, unreadable, malformed or over-bound");}
}
function store(dirArg: string, provided?: LedgerEvent[]) {
  const {dir, study} = openStudy(dirArg); requireExperiment(study); const events = provided ?? readLedger(dir);
  let stream: HarnessStream | undefined; const snapshots = new Map<string, FrozenExperience>();
  const startedRounds = new Set<string>();
  for (const event of events) {
    if (event.type === "harness.round.set") {if (plain(event.data.round) && typeof event.data.round.id === "string") startedRounds.add(event.data.round.id); else fail("malformed round receipt");}
    if (event.type === "experience.stream.set") {
      const value = validateHarnessStream(event.data.stream);
      if (event.data.sha256 !== hash(value) || stream || startedRounds.size) fail("stream receipt differs or stream was changed/created after a round"); stream = value;
    } else if (event.type === "experience.frozen") {
      const value = boundedSnapshot(event.data.snapshot);
      if (!stream || event.data.sha256 !== hash(value) || value.streamSha256 !== hash(stream) || !stream.tasks.includes(value.taskId) || snapshots.has(value.round) || snapshots.size >= EXPERIENCE_LIMIT) fail("frozen context receipt differs, is duplicated, or lacks its stream");
      if (startedRounds.has(value.round)) fail("context was frozen after its round started");
      if ([...snapshots.values()].some(old => old.taskId === value.taskId)) fail("duplicate frozen task identity");
      snapshots.set(value.round, value);
    } else if (event.type.startsWith("experience.")) fail("unsupported experience event; use a supporting version without changing history");
  }
  const diskStream = file(dir, streamPath(dir), EXPERIENCE_BYTES), diskContexts = file(dir, contextPath(dir), EXPERIENCE_INDEX_BYTES);
  if (canonical(diskStream === undefined ? null : validateHarnessStream(diskStream)) !== canonical(stream ?? null)) fail("stream file differs from its receipt");
  if (diskContexts === undefined) {if (snapshots.size) fail("frozen context file missing");}
  else {const index = object(diskContexts, ["v", "contexts"]); if (index.v !== 1) fail("unsupported frozen index version; keep original bytes and use a supporting version"); if (!Array.isArray(index.contexts) || index.contexts.length > EXPERIENCE_LIMIT || canonical(index.contexts.map(boundedSnapshot)) !== canonical([...snapshots.values()])) fail("frozen context index differs from its receipts");}
  return {dir, study, stream, snapshots, events};
}
export function readHarnessStream(dir: string) {const current = store(dir); return {v: 1, stream: current.stream ?? null, streamSha256: current.stream ? hash(current.stream) : null};}
/** Caller holds the study lock. Stream identity and order are immutable, including before a round starts. */
export function setHarnessStream(dir: string, raw: unknown, actor: Actor) {
  const current = store(dir), stream = validateHarnessStream(raw);
  if (current.stream) {if (canonical(current.stream) === canonical(stream)) return readHarnessStream(dir); fail("stream identity/membership/order is immutable");}
  if (current.events.some(event => event.type === "harness.round.set")) fail("stream must be fixed before the first round");
  commit(current.dir, [[streamPath(current.dir), JSON.stringify(stream, null, 2) + "\n", EXPERIENCE_BYTES]], [{actor, type: "experience.stream.set", data: {stream, sha256: hash(stream)}}]); return readHarnessStream(dir);
}
function target(current: ReturnType<typeof store>, request: ExperienceRequest) {
  if (!current.stream || !current.stream.tasks.includes(request.taskId)) fail("task is not in a recorded stream; run ares harness stream set before creating rounds");
  if (current.events.some(event => event.type === "harness.round.set" && plain(event.data.round) && event.data.round.id === request.round)) fail("round already started; freeze context before its first definition");
  return current.stream;
}
/** Source ordering never relies on wall clocks, title matching, directory scans or untrusted closure claims. */
export function experienceSourceEligibility(stream: HarnessStream, studyId: string, targetTask: string, source: {studyId: string; taskId: string; model: string; runtime: string}, requested: {model: string; runtime: string}) {
  const from = stream.tasks.indexOf(source.taskId), to = stream.tasks.indexOf(targetTask);
  if (source.studyId !== studyId) return {state: "unavailable" as const, reason: "cross-study-source"};
  if (from < 0 || to < 0) return {state: "unavailable" as const, reason: "unregistered-task"};
  if (from >= to) return {state: "unavailable" as const, reason: "current-or-future-task"};
  if (source.model !== requested.model || source.runtime !== requested.runtime) return {state: "unavailable" as const, reason: "model-runtime-incompatible"};
  return {state: "unavailable" as const, reason: "completed-round-lesson-receipts-unavailable"};
}
/** Ranking is advisory only. Only explicit selected full ids receive screened exact-id reads; no body escapes. */
export async function selectExperience(dir: string, raw: unknown, options: ExperienceReadOptions = {}) {
  const current = store(dir), request = validateExperienceRequest(raw); target(current, request);
  const now = options.now?.() ?? Date.now();
  const ranked = rankLessons(await createAmemClient(current.dir, options.runner, options.env).search(current.study.question), now, {limit: EXPERIENCE_LIMIT});
  const inspections = [];
  for (const item of request.selected) {
    const observed = await readScreenedAmem(current.dir, item.id, options);
    inspections.push({id: item.id, reason: item.reason, ...observed, state: "unavailable" as const, sourceState: observed.state, cause: "completed-round-lesson-receipts-unavailable"});
  }
  const emptyControl = ["baseline", "no-library"].includes(request.condition);
  return {v: 1, ranked, selected: inspections, eligible: false, state: emptyControl ? "available" : "unavailable", cause: emptyControl ? "empty-selection" : "completed-round-lesson-receipts-unavailable", nextStep: "Use an empty baseline/no-library context; nonempty experience requires native completed-round and lesson receipts"};
}
function requestFields(value: FrozenExperience) {const {streamSha256: _stream, entries: _entries, ...rest} = value; return rest;}
/** Caller holds the lock. Only empty controls can be durably frozen before native source closure ships. */
export function freezeExperience(dir: string, raw: unknown, actor: Actor) {
  const current = store(dir), request = validateExperienceRequest(raw);
  const existing = current.snapshots.get(request.round);
  if (existing) {
    const {selected: _selected, ...rest} = request;
    if (!request.selected.length && canonical(rest) === canonical(requestFields(existing))) return {...existing, improverContextHash: hash(existing)};
    fail("frozen context cannot change; use a new study/round");
  }
  const stream = target(current, request);
  if ([...current.snapshots.values()].some(value => value.taskId === request.taskId)) fail("task already has a frozen context");
  if (request.selected.length || !["baseline", "no-library"].includes(request.condition)) fail("nonempty experience unavailable: completed round/lesson receipt chain is not implemented; choose an empty baseline/no-library control");
  const {selected: _selected, ...rest} = request, value = boundedSnapshot({...rest, streamSha256: hash(stream), entries: []});
  if (current.snapshots.size >= EXPERIENCE_LIMIT) fail("16-context limit reached");
  commit(current.dir, [[contextPath(current.dir), JSON.stringify({v: 1, contexts: [...current.snapshots.values(), value]}, null, 2) + "\n", EXPERIENCE_INDEX_BYTES]], [{actor, type: "experience.frozen", data: {snapshot: value, sha256: hash(value)}}]);
  return {...value, improverContextHash: hash(value)};
}
/** Local integrity check for round writes/imports; never resolves a memory or starts a process. */
export function requireRoundExperiences(dir: string, rounds: readonly {id: string; task: {id: string}; experience: unknown[]; context?: {streamSha256: string; improverContextHash: string}}[], events?: LedgerEvent[]) {
  const current = store(dir, events);
  for (const round of rounds) {
    if (!round.context) {if (current.stream) fail("a stream-bound round requires a frozen context"); continue;}
    const value = current.snapshots.get(round.id);
    if (!current.stream || !value || value.taskId !== round.task.id || round.context.streamSha256 !== hash(current.stream) || round.context.improverContextHash !== hash(value) || round.experience.length) fail("round context differs from its recorded frozen snapshot");
  }
}
export async function checkExperience(dir: string, roundId: string, identity: {model: string; runtime: string}, options: ExperienceReadOptions = {}) {
  const checkedIdentity = object(identity, ["model", "runtime"]); text(checkedIdentity.model, 128); text(checkedIdentity.runtime, 128);
  const current = store(dir), value = current.snapshots.get(id(roundId)); if (!value) fail("frozen context missing; run ares experience freeze");
  const compatible = value.model === checkedIdentity.model && value.runtime === checkedIdentity.runtime;
  const observed = await recheckExperienceSources(current.dir, value.entries.map(({id, digest, sourceVersion}) => ({id, digest, sourceVersion})), options);
  // Re-read after any policy/source observation. Never serve a context from mixed local generations.
  const after = store(dir); if (canonical([...current.snapshots]) !== canonical([...after.snapshots]) || canonical(current.stream) !== canonical(after.stream)) fail("stream/context changed during recheck");
  return {v: 1, round: value.round, state: compatible ? observed.state : "unavailable", cause: compatible ? null : "model-runtime-incompatible", nextStep: compatible ? null : "Use the frozen model/runtime or freeze a new round", streamSha256: value.streamSha256, improverContextHash: hash(value), model: value.model, runtime: value.runtime, workerContext: "baseline-only", condition: value.condition, context: compatible && observed.state === "available" ? "" : null, bytes: 0, observations: observed.observations, assurance: "observed-policy-source-only; no distributed atomicity"};
}
