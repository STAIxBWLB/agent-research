import {archivedLessonSources, recheckLessonExports} from "./lesson-candidates.ts";
import {sourceBudget} from "../memory/source-budget.ts";
import {supportsScreenedAmem} from "../memory/amem-show.ts";
import {lstatSync} from "node:fs";
import {join} from "node:path";
import {commit, openStudy, requireExperiment, isHarnessGate, readLedger, readTextBounded, onlyKeys, plain, sha256, type Actor, type LedgerEvent, type StudyReadLock, assertStudyReadLock} from "../study.ts";
import {canonical} from "../plan/state.ts";
import {hasHarnessCredential} from "./privacy.ts";
import {createAmemClient} from "../memory/amem.ts";
import {rankLessons} from "../memory/lessons.ts";
import {readScreenedAmem} from "../memory/amem-show.ts";
import type {ProcessRunner} from "../exp/executor.ts";

export const EXPERIENCE_BYTES = 16_384, EXPERIENCE_INDEX_BYTES = 1_048_576, EXPERIENCE_LIMIT = 16;
export interface HarnessStream {v: 1; id: string; revision: number; tasks: string[]}
export interface ExperienceRequest {
  v: 1; round: string; taskId: string; condition: "baseline" | "no-library" | "retrieval-only" | "prior-experience";
  model: string; runtime: string; toolsetSha256?: string; selected: {id: string; reason: string}[];
}
export interface FrozenEntry {
  id: string; digest: string; sourceVersion: string; observedAt: string; reason: string;
  lesson: string; lessonSha256: string; dispositionSha256: string; noteSha256: string;
  round: string; taskId: string; roundBinding: string; closureSha256: string; sourceFingerprint: string;
  model: string; runtime: string; toolsetSha256: string; sourceStrength: "synthetic-fixture"; transfer: "not-demonstrated";
}
export interface FrozenExperience extends Omit<ExperienceRequest, "selected"> {
  streamSha256: string; entries: FrozenEntry[]; sourceStrength?: "synthetic-fixture"; transfer?: "not-demonstrated";
}
export interface ExperienceReadOptions {runner?: ProcessRunner; env?: NodeJS.ProcessEnv; now?: () => number; lock?: StudyReadLock}
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
  const row = object(raw, ["v", "round", "taskId", "condition", "model", "runtime", "toolsetSha256", "selected"]);
  if (row.v !== 1) fail("unsupported context version; keep original bytes and use a supporting version");
  if (!["baseline", "no-library", "retrieval-only", "prior-experience"].includes(row.condition as string) || !Array.isArray(row.selected) || row.selected.length > EXPERIENCE_LIMIT) fail("invalid condition or more than 16 selected entries");
  const selected = row.selected.map(value => {const item = object(value, ["id", "reason"]); if (typeof item.id !== "string" || item.id.length !== 32 || !/^[a-f0-9]{32}$/.test(item.id)) fail("full exact amem id required"); return {id: item.id, reason: text(item.reason, 1000)};});
  if (new Set(selected.map(value => value.id)).size !== selected.length) fail("duplicate selected id");
  if (["baseline", "no-library"].includes(row.condition as string) && selected.length) fail("baseline/no-library conditions cannot receive experience");
  const result = {v: 1 as const, round: id(row.round), taskId: text(row.taskId, 256), condition: row.condition as ExperienceRequest["condition"], model: text(row.model, 128), runtime: text(row.runtime, 128), ...(row.toolsetSha256 !== undefined ? {toolsetSha256: digest(row.toolsetSha256)} : {}), selected};
  if (Buffer.byteLength(canonical(result)) > EXPERIENCE_BYTES) fail("selection exceeds 16 KiB"); return result;
}
function entry(raw: unknown): FrozenEntry {
  const row = object(raw, ["id", "digest", "sourceVersion", "observedAt", "reason", "lesson", "lessonSha256", "dispositionSha256", "noteSha256", "round", "taskId", "roundBinding", "closureSha256", "sourceFingerprint", "model", "runtime", "toolsetSha256", "sourceStrength", "transfer"]);
  if (typeof row.id !== "string" || row.id.length !== 32 || !/^[a-f0-9]{32}$/.test(row.id) || !supportsScreenedAmem(row.sourceVersion) || typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt)) || row.observedAt.length > 64 || row.sourceStrength !== "synthetic-fixture" || row.transfer !== "not-demonstrated") fail("invalid frozen source identity/version/strength");
  return {id: row.id, digest: digest(row.digest), sourceVersion: row.sourceVersion, observedAt: row.observedAt, reason: text(row.reason, 1000), lesson: id(row.lesson), lessonSha256: digest(row.lessonSha256), dispositionSha256: digest(row.dispositionSha256), noteSha256: digest(row.noteSha256), round: id(row.round), taskId: text(row.taskId, 256), roundBinding: digest(row.roundBinding), closureSha256: digest(row.closureSha256), sourceFingerprint: digest(row.sourceFingerprint), model: text(row.model, 256), runtime: digest(row.runtime), toolsetSha256: digest(row.toolsetSha256), sourceStrength: "synthetic-fixture", transfer: "not-demonstrated"};
}
function boundedSnapshot(raw: unknown): FrozenExperience {
  const row = object(raw, ["v", "round", "taskId", "condition", "model", "runtime", "toolsetSha256", "streamSha256", "entries", "sourceStrength", "transfer"]);
  if (!Array.isArray(row.entries) || row.entries.length > EXPERIENCE_LIMIT) fail("frozen entries exceed16 sources");
  const entries = row.entries.map(entry), {streamSha256, entries: _entries, sourceStrength: _strength, transfer: _transfer, ...rest} = row;
  const {selected: _selected, ...request} = validateExperienceRequest({...rest, selected: entries.map(value => ({id: value.id, reason: value.reason}))});
  if (new Set(entries.map(value => value.id)).size !== entries.length || entries.some(value => value.model !== request.model || value.runtime !== request.runtime || value.toolsetSha256 !== request.toolsetSha256)) fail("duplicate/incompatible frozen sources");
  if (entries.length ? row.sourceStrength !== "synthetic-fixture" || row.transfer !== "not-demonstrated" : row.sourceStrength !== undefined || row.transfer !== undefined) fail("frozen context strength differs from its entries");
  if (!entries.length && !["baseline", "no-library"].includes(request.condition)) fail("retrieval/prior context needs admitted sources; use baseline/no-library for an empty control");
  const value: FrozenExperience = {...request, streamSha256: digest(streamSha256), entries, ...(entries.length ? {sourceStrength: "synthetic-fixture" as const, transfer: "not-demonstrated" as const} : {})};
  if (Buffer.byteLength(canonical(value)) > EXPERIENCE_BYTES) fail("frozen snapshot exceeds16KiB"); return value;
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
export function experienceSourceEligibility(stream: HarnessStream, studyId: string, targetTask: string, source: {studyId: string; taskId: string; model: string; runtime: string; completed?: boolean}, requested: {model: string; runtime: string}) {
  const from = stream.tasks.indexOf(source.taskId), to = stream.tasks.indexOf(targetTask);
  if (source.studyId !== studyId) return {state: "unavailable" as const, reason: "cross-study-source"};
  if (from < 0 || to < 0) return {state: "unavailable" as const, reason: "unregistered-task"};
  if (from >= to) return {state: "unavailable" as const, reason: "current-or-future-task"};
  if (source.model !== requested.model || source.runtime !== requested.runtime) return {state: "unavailable" as const, reason: "model-runtime-incompatible"};
  return source.completed ? {state: "available" as const, reason: "earlier-reviewed-receipted-fixture-source"} : {state: "unavailable" as const, reason: "completed-round-lesson-receipts-unavailable"};
}
async function resolveSelected(current: ReturnType<typeof store>, request: ExperienceRequest, options: ExperienceReadOptions, pins?: readonly FrozenEntry[]) {
  if (!request.selected.length) return {state: "available" as const, entries: [], observations: [], context: "", bytes: 0};
  const sources = archivedLessonSources(current.dir), budget = sourceBudget(options.now), entries: FrozenEntry[] = [], observations: {id: string; state: string; digest: string | null; observedAt?: string; sourceVersion?: string}[] = [], context: string[] = [];
  try {await recheckLessonExports(current.dir, request.selected.flatMap(selected => {const source = sources.get(selected.id); return source ? [source.noteSha256] : [];}), {...options, budget});}
  catch {return {state: "unavailable" as const, entries, observations: request.selected.map(value => ({id: value.id, state: "unavailable", digest: null})), context: null, bytes: 0};}
  for (const selected of request.selected) {
    const source = sources.get(selected.id), p = source?.row.proposal, compat = p?.compatibility;
    if (!source || !p || !compat || request.toolsetSha256 !== compat.toolsetSha256 || experienceSourceEligibility(current.stream!, current.study.id, request.taskId, {studyId: p.studyId, taskId: p.taskId, ...compat, completed: true}, request).state !== "available") {observations.push({id: selected.id, state: "unavailable", digest: null}); continue;}
    let bodyMatched = false;
    const observed = await readScreenedAmem(current.dir, selected.id, {...options, budget, onText: text => {bodyMatched = text === source.note.text;}});
    const value = observed.state === "available" && observed.digest && observed.sourceVersion && observed.kind === source.note.kind && bodyMatched ? entry({id: selected.id, digest: observed.digest, sourceVersion: observed.sourceVersion, observedAt: observed.observedAt, reason: selected.reason, lesson: p.name, lessonSha256: source.row.sha256, dispositionSha256: source.row.disposition!.sha256, noteSha256: source.noteSha256, round: p.round, taskId: p.taskId, roundBinding: p.roundBinding, closureSha256: p.closureSha256, sourceFingerprint: p.sourceFingerprint, ...compat, sourceStrength: "synthetic-fixture", transfer: "not-demonstrated"}) : null;
    const pinned = pins?.find(pin => pin.id === selected.id), content = (row: FrozenEntry) => {const {observedAt: _at, ...rest} = row; return rest;};
    if (!value || pinned && canonical(content(value)) !== canonical(content(pinned))) {observations.push({id: selected.id, state: observed.state === "available" ? "changed" : observed.state, digest: observed.digest, observedAt: observed.observedAt}); continue;}
    entries.push(value); observations.push({id: selected.id, state: "available", digest: value.digest, sourceVersion: value.sourceVersion, observedAt: value.observedAt});
    context.push(source.note.text);
  }
  const refreshed = archivedLessonSources(current.dir), unchanged = entries.every(value => {const source = refreshed.get(value.id); return source?.row.sha256 === value.lessonSha256 && source.row.disposition?.sha256 === value.dispositionSha256 && source.noteSha256 === value.noteSha256;});
  const rendered = context.join("\n\n"), available = unchanged && entries.length === request.selected.length && Buffer.byteLength(rendered) <= EXPERIENCE_BYTES && budget.remainingMs() > 0;
  return {state: available ? "available" as const : "unavailable" as const, entries, observations, context: available ? rendered : null, bytes: available ? Buffer.byteLength(rendered) : 0};
}
/** Ranking is advisory; only chain-proven explicit selections receive an owning exact-id read. */
export async function selectExperience(dir: string, raw: unknown, options: ExperienceReadOptions = {}) {
  const current = store(dir), request = validateExperienceRequest(raw); target(current, request);
  const now = options.now?.() ?? Date.now(), ranked = rankLessons(await createAmemClient(current.dir, options.runner, options.env).search(current.study.question), now, {limit: EXPERIENCE_LIMIT});
  const resolved = await resolveSelected(current, request, options), empty = ["baseline", "no-library"].includes(request.condition), available = empty || request.selected.length > 0 && resolved.state === "available";
  return {v: 1, ranked, selected: resolved.observations, eligible: !empty && available, state: available ? "available" : "unavailable", prepareOnly: true, liveEligible: false, sourceStrength: resolved.entries.length ? "synthetic-fixture" : null, transfer: "not-demonstrated", cause: available ? null : "source-chain-order-policy-or-compatibility-unavailable", nextStep: "Select reviewed/receipted earlier same-study sources, or use baseline/no-library; fixture entries never qualify a live trial"};
}
function requestFields(value: FrozenExperience) {const {streamSha256: _stream, entries: _entries, sourceStrength: _strength, transfer: _transfer, ...rest} = value; return rest;}
/** Caller holds the lock. Durable snapshots contain source identities only, never the screened body. */
export async function freezeExperience(dir: string, raw: unknown, actor: Actor, options: ExperienceReadOptions = {}) {
  const current = store(dir), request = validateExperienceRequest(raw);
  if (!options.lock) fail("freeze requires an owned study transaction"); assertStudyReadLock(current.dir, options.lock);
  const existing = current.snapshots.get(request.round);
  if (existing) {
    const {selected: _selected, ...rest} = request;
    if (canonical(request.selected) === canonical(existing.entries.map(value => ({id: value.id, reason: value.reason}))) && canonical(rest) === canonical(requestFields(existing))) return {...existing, improverContextHash: hash(existing)};
    fail("frozen context cannot change; use a new study/round");
  }
  const stream = target(current, request);
  if ([...current.snapshots.values()].some(value => value.taskId === request.taskId)) fail("task already has a frozen context");
  const resolved = await resolveSelected(current, request, options);
  if (resolved.state !== "available" || !request.selected.length && !["baseline", "no-library"].includes(request.condition)) fail("nonempty experience unavailable: use earlier reviewed/receipted same-study sources or an empty baseline/no-library control");
  const {selected: _selected, ...rest} = request, value = boundedSnapshot({...rest, streamSha256: hash(stream), entries: resolved.entries, ...(resolved.entries.length ? {sourceStrength: "synthetic-fixture", transfer: "not-demonstrated"} : {})});
  if (current.snapshots.size >= EXPERIENCE_LIMIT) fail("16-context limit reached");
  const after = store(dir); if (canonical(after.events) !== canonical(current.events)) fail("source journal changed during freeze");
  assertStudyReadLock(current.dir, options.lock);
  commit(current.dir, [[contextPath(current.dir), JSON.stringify({v: 1, contexts: [...current.snapshots.values(), value]}, null, 2) + "\n", EXPERIENCE_INDEX_BYTES]], [{actor, type: "experience.frozen", data: {snapshot: value, sha256: hash(value)}}]);
  return {...value, improverContextHash: hash(value)};
}
/** Local integrity check for round writes/imports; never resolves a memory or starts a process. */
export function requireRoundExperiences(dir: string, rounds: readonly {id: string; task: {id: string}; experience: unknown[]; authoring?: string; context?: {streamSha256: string; improverContextHash: string}}[], events?: LedgerEvent[]) {
  const current = store(dir, events);
  for (const round of rounds) {
    if (!round.context) {if (current.stream) fail("a stream-bound round requires a frozen context"); continue;}
    const value = current.snapshots.get(round.id);
    if (round.authoring === "controlled-lane" && value?.entries.some(entry => entry.sourceStrength === "synthetic-fixture")) fail("controlled-lane refuses synthetic-fixture context; freeze a context from real-source lessons or use baseline/no-library");
    if (!current.stream || !value || value.taskId !== round.task.id || round.context.streamSha256 !== hash(current.stream) || round.context.improverContextHash !== hash(value) || round.experience.length) fail("round context differs from its recorded frozen snapshot");
  }
}
export async function checkExperience(dir: string, roundId: string, identity: {model: string; runtime: string; toolsetSha256?: string}, options: ExperienceReadOptions = {}) {
  const checkedIdentity = object(identity, ["model", "runtime", "toolsetSha256"]); text(checkedIdentity.model, 128); text(checkedIdentity.runtime, 128);
  const current = store(dir), value = current.snapshots.get(id(roundId)); if (!value) fail("frozen context missing; run ares experience freeze");
  if (checkedIdentity.toolsetSha256 !== undefined) digest(checkedIdentity.toolsetSha256);
  const compatible = value.model === checkedIdentity.model && value.runtime === checkedIdentity.runtime && (!value.entries.length || value.toolsetSha256 === checkedIdentity.toolsetSha256);
  const request: ExperienceRequest = {...requestFields(value), selected: value.entries.map(entry => ({id: entry.id, reason: entry.reason}))};
  const observed = await resolveSelected(current, request, options, value.entries);
  // Re-read after any policy/source observation. Never serve a context from mixed local generations.
  const after = store(dir); if (canonical([...current.snapshots]) !== canonical([...after.snapshots]) || canonical(current.stream) !== canonical(after.stream)) fail("stream/context changed during recheck");
  return {v: 1, round: value.round, state: compatible ? observed.state : "unavailable", cause: !compatible ? "model-runtime-incompatible" : observed.state === "available" ? null : "frozen-source-chain-unavailable-or-changed", nextStep: !compatible ? "Use the frozen model/runtime/toolset or freeze a new round" : observed.state === "available" ? null : "Restore the exact screened source and its reviewed local receipts, or freeze a new context; fixture entries never qualify a controlled/live trial", streamSha256: value.streamSha256, improverContextHash: hash(value), model: value.model, runtime: value.runtime, sourceStrength: value.sourceStrength ?? null, transfer: "not-demonstrated", prepareOnly: true, workerContext: "baseline-only", retrievalGuidanceSlot: compatible && value.condition === "retrieval-only" ? observed.context : null, condition: value.condition, context: compatible && observed.state === "available" ? observed.context : null, bytes: compatible ? observed.bytes : 0, observations: observed.observations, assurance: "observed-policy-source-only; no distributed atomicity"};
}
