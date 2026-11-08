import {lstatSync} from "node:fs";
import {join} from "node:path";
import {commit, openStudy, requireExperiment, readTextBounded, readLedger, onlyKeys, plain, sha256, requireGate, isHarnessGate, type Actor, type LedgerEvent} from "../study.ts";
import {canonical} from "../plan/state.ts";
import {validateExecutionReference} from "../provenance.ts";
import {skillEvidenceReference, type SkillEvidenceReference} from "../memory/evidence.ts";
import {parseProbeFixture, compareProbeFixtures, type ProbeFixtureProjectionV1} from "./receipts.ts";

export const HARNESS_ROUNDS = 16, HARNESS_FORM_BYTES = 65_536, HARNESS_INDEX_BYTES = 1_048_576;
export interface DeclaredExecutionRef {v: 1; tool: "ahub"; projectKey: string; kind: string; id: string; revision?: string; sha256: string}
export interface HarnessRound {
  v: 1; id: string; task: {id: string; inputSha256: string}; baseline: {guidanceSha256: string};
  candidates: {id: string; guidanceSha256: string; category?: "procedure" | "domain"}[];
  hypothesis: {deficiency: string; predictedChange: string}; experience: {ref: SkillEvidenceReference; digest: string}[];
  authoring: "uncontrolled-authoring" | "controlled-lane";
  sourceExecutions?: Partial<Record<"proposal1" | "proposal2" | "composition" | "selection" | "reflection", DeclaredExecutionRef>>;
}
interface DeclaredProbe {round: string; binding: string; projectionSha256: string; sourceStrength: "synthetic-fixture"; projection: ProbeFixtureProjectionV1}
function fail(cause: string): never {throw new Error(`harness: ${cause}; inspect ares harness show, restore the recorded definition or revise it explicitly before retrying`);}
function object(raw: unknown, keys: string[], label: string): Record<string, unknown> {if (!plain(raw)) fail(`${label} object required`); try {onlyKeys(raw, keys, label);} catch {fail(`${label} has an unknown field`);} return raw;}
function text(raw: unknown, bound: number, label: string): string {
  if (typeof raw !== "string" || !raw.trim() || raw.includes("\0") || Buffer.byteLength(raw) > bound || /(?:bearer\s+[a-z0-9._-]{8,}|sk-[a-z0-9_-]{16,}|(?:api[_-]?key|secret|password|(?:access[_-]?)?token)\s*[:=]\s*\S+)/i.test(raw)) fail(`${label} must be bounded nonblank text without credentials or NUL`); return raw;
}
function checkMetadata(value: unknown): void {
  if (typeof value === "string") {text(value, HARNESS_FORM_BYTES, "round metadata"); return;}
  if (Array.isArray(value)) {for (const item of value) checkMetadata(item);}
  else if (plain(value)) for (const item of Object.values(value)) checkMetadata(item);
}
function id(raw: unknown): string {if (typeof raw !== "string" || !isHarnessGate(`harness:${raw}`)) fail("round/candidate id must follow the 1..64 ASCII run-name rule"); return raw;}
function hash(raw: unknown): string {if (typeof raw !== "string" || !/^[a-f0-9]{64}$/.test(raw)) fail("lowercase SHA-256 required"); return raw;}
function execution(raw: unknown): DeclaredExecutionRef {
  const row = object(raw, ["v", "tool", "projectKey", "kind", "id", "revision", "sha256"], "source execution ref");
  if (row.v !== 1 || row.tool !== "ahub") fail("source execution must name a declared ahub receipt address");
  const checked = validateExecutionReference({...row, tool: "ares", kind: "artifact"});
  return {...checked, tool: "ahub", kind: text(row.kind, 128, "producer kind"), sha256: hash(row.sha256)};
}
/** Ares-owned round schema, not a producer manifest or execution admission. */
export function validateHarnessRound(raw: unknown, studyId?: string): HarnessRound {
  const row = object(raw, ["v", "id", "task", "baseline", "candidates", "hypothesis", "experience", "authoring", "sourceExecutions"], "round");
  if (row.v !== 1) fail("unsupported round version; use a version supporting the original record, keeping it unchanged");
  const task = object(row.task, ["id", "inputSha256"], "task"), baseline = object(row.baseline, ["guidanceSha256"], "baseline"), hypothesis = object(row.hypothesis, ["deficiency", "predictedChange"], "hypothesis");
  if (!Array.isArray(row.candidates) || row.candidates.length > 2 || !Array.isArray(row.experience) || row.experience.length > 16 || !["uncontrolled-authoring", "controlled-lane"].includes(row.authoring as string)) fail("invalid candidate/experience count or authoring mode");
  const candidates = row.candidates.map(raw => {const candidate = object(raw, ["id", "guidanceSha256", "category"], "candidate"), name = id(candidate.id); if (["baseline", "successor"].includes(name) || candidate.category !== undefined && candidate.category !== "procedure" && candidate.category !== "domain") fail("candidate id/category invalid or reserved"); return {id: name, guidanceSha256: hash(candidate.guidanceSha256), ...(candidate.category !== undefined ? {category: candidate.category as "procedure" | "domain"} : {})};});
  if (new Set(candidates.map(candidate => candidate.id)).size !== candidates.length) fail("duplicate candidate id");
  const experience = row.experience.map(raw => {const value = object(raw, ["ref", "digest"], "experience"), ref = skillEvidenceReference(value.ref, studyId); if (!ref) fail("unsupported or wrong-study experience ref"); const digest = hash(value.digest); if (ref.tool === "ares" && ref.sha256 !== undefined && ref.sha256 !== digest) fail("experience ref and digest disagree"); return {ref, digest};});
  const sources = row.sourceExecutions === undefined ? undefined : object(row.sourceExecutions, ["proposal1", "proposal2", "composition", "selection", "reflection"], "source executions");
  const sourceExecutions = sources && Object.fromEntries(Object.entries(sources).map(([stage, value]) => [stage, execution(value)]));
  if (row.authoring === "controlled-lane" && candidates.some((_candidate, index) => !sourceExecutions?.[`proposal${index + 1}`])) fail("controlled model-authored proposals require their source execution receipt refs");
  const round: HarnessRound = {v: 1, id: id(row.id), task: {id: text(task.id, 256, "task id"), inputSha256: hash(task.inputSha256)}, baseline: {guidanceSha256: hash(baseline.guidanceSha256)}, candidates, hypothesis: {deficiency: text(hypothesis.deficiency, 2000, "deficiency"), predictedChange: text(hypothesis.predictedChange, 2000, "predicted change")}, experience, authoring: row.authoring as HarnessRound["authoring"], ...(sourceExecutions ? {sourceExecutions} : {})};
  checkMetadata(round);
  if (Buffer.byteLength(JSON.stringify(round)) > HARNESS_FORM_BYTES) fail("round exceeds 64 KiB"); return round;
}
function matchesRound(round: HarnessRound, projection: ProbeFixtureProjectionV1): boolean {
  const expected = projection.arm === "baseline" ? round.baseline.guidanceSha256 : round.candidates.find(candidate => candidate.id === projection.arm)?.guidanceSha256;
  return !!expected && projection.taskId === round.task.id && projection.taskInputHash === round.task.inputSha256 && projection.guidanceHash === expected && projection.baselineHash === round.baseline.guidanceSha256;
}
const binding = (round: HarnessRound) => sha256(canonical(round));
const path = (dir: string) => join(dir, "design", "harness.json");
function replay(events: LedgerEvent[], studyId: string) {
  const rounds = new Map<string, HarnessRound>(), tasks = new Map<string, string>(), probes: DeclaredProbe[] = [];
  for (const event of events) {
    if (!event.type.startsWith("harness.")) continue;
    if (event.data.v !== 1) fail("unsupported harness event version; keep original bytes and use a supporting version");
    if (event.type === "harness.round.set") {
      const round = validateHarnessRound(event.data.round, studyId), old = rounds.get(round.id);
      if (event.data.binding !== binding(round) || old && canonical(old.task) !== canonical(round.task) || tasks.has(canonical(round.task)) && tasks.get(canonical(round.task)) !== round.id) fail("round receipt hash or immutable/unique task identity mismatch");
      if (!old && rounds.size >= HARNESS_ROUNDS) fail("more than 16 rounds");
      rounds.set(round.id, round); tasks.set(canonical(round.task), round.id);
    } else if (event.type === "harness.probe.declared") {
      const round = rounds.get(String(event.data.round)), projection = parseProbeFixture(event.data.projection);
      if (!round || !matchesRound(round, projection) || event.data.binding !== binding(round) || event.data.projectionSha256 !== sha256(canonical(projection)) || event.data.sourceStrength !== "synthetic-fixture") fail("declared probe receipt mismatch");
      if (probes.some(probe => probe.round === round.id && (probe.projection.id === projection.id || probe.binding === binding(round) && probe.projection.arm === projection.arm))) fail("duplicate declared probe journal event");
      probes.push({round: round.id, binding: binding(round), projectionSha256: event.data.projectionSha256 as string, sourceStrength: "synthetic-fixture", projection});
    } else fail("unsupported harness form; keep its history and use a version supporting it");
  }
  return {rounds: [...rounds.values()], probes};
}
function read(dirArg: string) {
  const {dir, study} = openStudy(dirArg); requireExperiment(study);
  const events = readLedger(dir), folded = replay(events, study.id), file = path(dir);
  let stat;
  try {
    const design = lstatSync(join(dir, "design"), {throwIfNoEntry: false});
    if (design && (!design.isDirectory() || design.isSymbolicLink())) fail("design must be a regular directory, not a link");
    stat = lstatSync(file, {throwIfNoEntry: false});
  } catch {return fail("harness index metadata unavailable or linked; restore a regular design directory and index");}
  if (!stat) {if (folded.rounds.length) fail("design/harness.json missing; restore its committed index"); return {dir, study, events, ...folded};}
  if (!stat.isFile() || stat.isSymbolicLink()) fail("harness index must be a regular file, not a link");
  let parsed: unknown; try {parsed = JSON.parse(readTextBounded(file, HARNESS_INDEX_BYTES, {noFollow: true}));} catch {return fail("index is missing, unreadable, malformed or over 1 MiB; restore design/harness.json");}
  const raw = object(parsed, ["v", "rounds"], "index");
  if (raw.v !== 1) fail("unsupported harness index version; keep it unchanged and use a supporting version");
  if (!Array.isArray(raw.rounds) || raw.rounds.length > HARNESS_ROUNDS || canonical(raw.rounds.map(row => validateHarnessRound(row, study.id))) !== canonical(folded.rounds)) fail("harness index differs from its recorded definitions");
  return {dir, study, events, ...folded};
}
export function readHarnessRounds(dir: string): HarnessRound[] {return read(dir).rounds;}
export function harnessBinding(dir: string, roundId: string): string | undefined {const name = id(roundId), round = read(dir).rounds.find(round => round.id === name); return round && binding(round);}
/** Caller holds the study lock. Definition updates preserve the prior events and reopen only this round's gate. */
export function setHarnessRound(dirArg: string, raw: unknown, actor: Actor): HarnessRound {
  const current = read(dirArg), round = validateHarnessRound(raw, current.study.id), old = current.rounds.find(value => value.id === round.id);
  if (old && canonical(old.task) !== canonical(round.task) || current.rounds.some(value => value.id !== round.id && canonical(value.task) === canonical(round.task))) fail("task identity is immutable and may have only one round");
  if (old && binding(old) === binding(round)) return old;
  if (!old && current.rounds.length >= HARNESS_ROUNDS) fail("16-round limit reached; use another experiment study");
  const rounds = old ? current.rounds.map(value => value.id === round.id ? round : value) : [...current.rounds, round];
  commit(current.dir, [[path(current.dir), JSON.stringify({v: 1, rounds}, null, 2) + "\n", HARNESS_INDEX_BYTES]], [{actor, type: "harness.round.set", data: {v: 1, round, binding: binding(round)}}]); return round;
}
/** Local fixture import is a declaration only. It can never be a real producer resolution or matched comparison. */
export function importHarnessFixture(dirArg: string, roundId: string, raw: unknown, actor: Actor) {
  const current = read(dirArg), round = current.rounds.find(value => value.id === id(roundId)); if (!round) fail("round missing");
  const projection = parseProbeFixture(raw), hash = sha256(canonical(projection));
  const old = current.probes.find(value => value.round === round.id && value.projection.id === projection.id);
  if (old) {if (old.projectionSha256 !== hash || old.binding !== binding(round)) fail("probe id reused with changed bytes or round binding"); return {...old, matched: false as const, endToEndEvaluation: "unavailable" as const};}
  if (!matchesRound(round, projection)) fail("declared probe arm/task/guidance differs from the bound round");
  if (current.probes.some(value => value.round === round.id && value.binding === binding(round) && value.projection.arm === projection.arm)) fail("an arm already has its declared execution; create a separately identified experiment rather than count it twice");
  if (current.probes.filter(value => value.round === round.id && value.binding === binding(round)).length >= 3) fail("this round already has its baseline and two candidate declarations");
  const approval = requireGate(current.dir, current.study, `harness:${round.id}`, name => name === `harness:${round.id}` ? binding(round) : undefined);
  commit(current.dir, [], [...approval, {actor, type: "harness.probe.declared", data: {v: 1, round: round.id, binding: binding(round), projectionSha256: hash, sourceStrength: "synthetic-fixture", projection}}]);
  return {round: round.id, binding: binding(round), projectionSha256: hash, sourceStrength: "synthetic-fixture" as const, matched: false as const, endToEndEvaluation: "unavailable" as const, projection};
}
export function showHarness(dirArg: string, roundId?: string) {
  const current = read(dirArg), rounds = roundId === undefined ? current.rounds : current.rounds.filter(round => round.id === id(roundId));
  if (roundId !== undefined && !rounds.length) fail("round missing");
  const views = rounds.map(round => {
    const probes = current.probes.filter(probe => probe.round === round.id), active = probes.filter(probe => probe.binding === binding(round)), baseline = active.find(probe => probe.projection.arm === "baseline");
    return {definition: round, binding: binding(round), historicalImports: probes.length - active.length, probes: active, comparisons: active.filter(probe => probe.projection.arm !== "baseline").map(probe => ({arm: probe.projection.arm, ...(baseline ? compareProbeFixtures(baseline.projection, probe.projection) : {compatible: false, matched: false, sourceStrength: "synthetic-fixture", endToEndEvaluation: "unavailable", reasons: ["baseline-unavailable"], confounders: ["producer-unavailable"]})}))};
  });
  const result = (visible: typeof views) => ({v: 1, endToEndEvaluation: "unavailable" as const, realImport: "unavailable" as const, rounds: visible, truncated: visible.length !== views.length, remaining: views.length - visible.length});
  const visible: typeof views = [];
  for (const view of views) {if (Buffer.byteLength(JSON.stringify(result([...visible, view]))) > HARNESS_INDEX_BYTES) break; visible.push(view);}
  return result(visible);
}
