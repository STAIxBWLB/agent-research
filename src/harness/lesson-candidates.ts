import {validateSkillInspections} from "../memory/skill-format.ts";
import {archiveReceiptIndex} from "../memory/archive.ts";
import {lstatSync} from "node:fs";
import {join} from "node:path";
import {commit, openStudy, requireExperiment, onlyKeys, plain, readLedger, readTextBounded, sha256, isHarnessGate, type Actor, type LedgerEvent, prepareCommit, assertStudyReadLock} from "../study.ts";
import {canonical} from "../plan/state.ts";
import {readHarnessViews, validateHarnessExecution, type DeclaredExecutionRef} from "./rounds.ts";
import {hasHarnessCredential} from "./privacy.ts";
import {skillEvidenceReference, type SkillEvidenceReference, type EvidenceInspection} from "../memory/evidence.ts";
import {inspectSkillEvidenceSet, compareSkillInspections, semanticInspection, type SkillCheckOptions} from "../memory/skill-check.ts";
import type {AmemNote} from "../memory/amem.ts";

export const LESSON_BYTES = 16_384, LESSON_INDEX_BYTES = 1_048_576, LESSON_CANDIDATES = 64;
export const FIXTURE_LESSON_STRENGTH = "synthetic-fixture; not evidence of real agent behavior";
export interface LessonInput {
  v: 1; name: string; round: string; closureSha256: string; kind: "observation" | "fail" | "limitation" | "no-lesson";
  summary: string; procedure: string[]; applicability: string; limitations: string[]; whenNotToUse: string[]; failure: string; retryWhen: string;
  change: {kind: "contrast" | "composition"; id: string; sha256: string}[];
  behavior: {probe: string; projectionSha256: string; outputManifestHash?: string}[];
  counterevidence: SkillEvidenceReference[]; reflection?: {model: string; sourceExecution: DeclaredExecutionRef};
}
export interface LessonProposal extends LessonInput {
  studyId: string; taskId: string; taskInputSha256: string; roundBinding: string; sourceFingerprint: string;
  sourceStrength: "synthetic-fixture"; transfer: "not-demonstrated"; evidenceLabel: "single-task-observation";
  compatibility: {model: string; runtime: string; toolsetSha256: string} | null; inspections: EvidenceInspection[];
}
export interface LessonRow {proposal: LessonProposal; sha256: string; actor: Actor; at: string; state: "proposed" | "accepted" | "rejected" | "withdrawn"; disposition?: {decision: "accept" | "reject" | "withdraw"; proposalSha256: string; evidenceFingerprint: string; reason: string; acknowledgeStrength?: string; actor: Actor; at: string; inspections: EvidenceInspection[]; sha256: string}}
const hash = (value: unknown) => sha256(canonical(value)), file = (dir: string) => join(dir, "proposals", "lessons.json");
function fail(cause: string): never {throw new Error(`lesson: ${cause}; inspect ares lesson list/check, restore the recorded source or create a revised proposal with honest limitations before retrying`);}
function object(value: unknown, fields: string[]) {if (!plain(value)) fail("object required"); try {onlyKeys(value, fields, "lesson");} catch {fail(`unknown field; use ${fields.join(", ")}`);} return value;}
function text(value: unknown, max = 1000): string {if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > max || hasHarnessCredential(value)) fail("text is blank, over-bound or contains URL/credentials"); return value;}
function id(value: unknown): string {const name = text(value, 64); if (!isHarnessGate(`harness:${name}`)) fail("invalid run-name id"); return name;}
function digest(value: unknown): string {if (typeof value !== "string" || value.length !== 64 || !/^[a-f0-9]{64}$/.test(value)) fail("lowercase SHA-256 required"); return value;}
function list(value: unknown, max = 16): unknown[] {if (!Array.isArray(value) || value.length > max) fail(`array exceeds ${max} items`); return value;}
const INPUT = ["v", "name", "round", "closureSha256", "kind", "summary", "procedure", "applicability", "limitations", "whenNotToUse", "failure", "retryWhen", "change", "behavior", "counterevidence", "reflection"];
function input(raw: unknown, studyId: string): LessonInput {
  const row = object(raw, INPUT); if (row.v !== 1) fail("unsupported proposal version; keep original bytes and use a supporting ares version");
  if (!["observation", "fail", "limitation", "no-lesson"].includes(row.kind as string)) fail("kind must be observation, fail, limitation or no-lesson; successful improvement/transfer is not supported");
  const change = list(row.change).map(raw => {const r = object(raw, ["kind", "id", "sha256"]); if (r.kind !== "contrast" && r.kind !== "composition") fail("change must cite contrast/composition"); return {kind: r.kind as "contrast" | "composition", id: id(r.id), sha256: digest(r.sha256)};});
  const behavior = list(row.behavior).map(raw => {const r = object(raw, ["probe", "projectionSha256", "outputManifestHash"]); return {probe: text(r.probe, 256), projectionSha256: digest(r.projectionSha256), ...(r.outputManifestHash !== undefined ? {outputManifestHash: digest(r.outputManifestHash)} : {})};});
  if (new Set(change.map(r => `${r.kind}:${r.id}`)).size !== change.length || new Set(behavior.map(r => r.probe)).size !== behavior.length) fail("duplicate source ref");
  const counterevidence = list(row.counterevidence).map(raw => {const ref = skillEvidenceReference(raw, studyId); if (!ref || Object.values(ref).some(value => typeof value === "string" && hasHarnessCredential(value))) fail("unsupported/wrong-study counterevidence"); return ref;});
  const reflection = row.reflection === undefined ? undefined : object(row.reflection, ["model", "sourceExecution"]);
  const result: LessonInput = {v: 1, name: id(row.name), round: id(row.round), closureSha256: digest(row.closureSha256), kind: row.kind as LessonInput["kind"], summary: text(row.summary, 2000), procedure: list(row.procedure).map(value => text(value)), applicability: text(row.applicability, 2000), limitations: list(row.limitations).map(value => text(value)), whenNotToUse: list(row.whenNotToUse).map(value => text(value)), failure: text(row.failure), retryWhen: text(row.retryWhen), change, behavior, counterevidence, ...(reflection ? {reflection: {model: text(reflection.model, 256), sourceExecution: validateHarnessExecution(reflection.sourceExecution)}} : {})};
  if (result.kind !== "no-lesson" && (!result.procedure.length || !change.length || !behavior.length)) fail("exportable lessons require procedure and concrete change/behavior refs");
  if (Buffer.byteLength(canonical(result)) > LESSON_BYTES) fail("proposal exceeds 16 KiB"); return result;
}
export function currentLessonSource(dir: string, value: Pick<LessonProposal, "round" | "closureSha256" | "change" | "behavior">, views?: ReturnType<typeof readHarnessViews>) {
  const round = (views ?? readHarnessViews(dir, value.round)).find(round => round.definition.id === value.round); if (!round) fail("source view capped or unavailable; inspect a single bounded round");
  const closure = round.transitions.closure;
  if (!closure?.current || closure.sha256 !== value.closureSha256) fail("source round closure is missing, changed or stale");
  for (const ref of value.change) if ((ref.kind === "contrast" ? round.transitions.contrasts.find(r => r.form.id === ref.id) : (round.transitions.composition?.form.id === ref.id ? round.transitions.composition : undefined))?.sha256 !== ref.sha256) fail("change ref is missing or changed");
  for (const ref of value.behavior) {const probe = round.probes.find(r => r.projection.id === ref.probe); if (!probe || probe.projectionSha256 !== ref.projectionSha256 || ref.outputManifestHash !== undefined && ref.outputManifestHash !== probe.projection.outputManifestHash) fail("behavior ref is missing or changed");}
  return round;
}
export function lessonReferences(value: LessonProposal): SkillEvidenceReference[] {return [{v: 1, tool: "ares", projectKey: value.studyId, kind: "harness-closure", id: value.round, sha256: value.closureSha256}, ...value.counterevidence];}
export function lessonEvidenceFingerprint(value: LessonProposal, inspections = value.inspections, currentFingerprint = value.sourceFingerprint): string {return hash({proposal: hash(value), source: currentFingerprint, inspections: inspections.map(semanticInspection)});}
function parseProposal(raw: unknown, studyId: string): LessonProposal {
  const row = object(raw, [...INPUT, "studyId", "taskId", "taskInputSha256", "roundBinding", "sourceFingerprint", "sourceStrength", "transfer", "evidenceLabel", "compatibility", "inspections"]);
  const authored = input(Object.fromEntries(INPUT.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])), studyId);
  if (row.studyId !== studyId || row.sourceStrength !== "synthetic-fixture" || row.transfer !== "not-demonstrated" || row.evidenceLabel !== "single-task-observation" || !Array.isArray(row.inspections)) fail("unsupported source strength/study or inspections");
  const compatibility = row.compatibility === null ? null : object(row.compatibility, ["model", "runtime", "toolsetSha256"]);
  const value: LessonProposal = {...authored, studyId, taskId: text(row.taskId, 256), taskInputSha256: digest(row.taskInputSha256), roundBinding: digest(row.roundBinding), sourceFingerprint: digest(row.sourceFingerprint), sourceStrength: "synthetic-fixture", transfer: "not-demonstrated", evidenceLabel: "single-task-observation", compatibility: compatibility ? {model: text(compatibility.model, 256), runtime: digest(compatibility.runtime), toolsetSha256: digest(compatibility.toolsetSha256)} : null, inspections: row.inspections as EvidenceInspection[]};
  value.inspections = validateSkillInspections(row.inspections, lessonReferences(value), studyId);
  if (Buffer.byteLength(canonical(value)) > LESSON_BYTES) fail("proposal and source metadata exceed 16 KiB"); return value;
}
function fold(events: LedgerEvent[], studyId: string) {
  const rows = new Map<string, LessonRow>();
  for (const event of events) if (event.type === "lesson.proposed") {
    const proposal = parseProposal(event.data.proposal, studyId), sha256 = hash(proposal);
    if (event.data.v !== 1 || event.data.sha256 !== sha256 || rows.has(proposal.name) || rows.size >= LESSON_CANDIDATES) fail("invalid/duplicate/over-bound proposal receipt"); rows.set(proposal.name, {proposal, sha256, actor: event.actor, at: event.at, state: "proposed"});
  } else if (event.type === "lesson.decided") {
    const data = object(event.data, ["v", "name", "decision", "proposalSha256", "evidenceFingerprint", "reason", "acknowledgeStrength", "inspections", "sha256"]), row = rows.get(id(data.name));
    if (data.v !== 1 || !row || row.sha256 !== data.proposalSha256 || !["accept", "reject", "withdraw"].includes(data.decision as string) || row.state !== "proposed" && !(row.state === "accepted" && data.decision === "withdraw")) fail("invalid or terminal disposition");
    const body = {decision: data.decision as "accept" | "reject" | "withdraw", proposalSha256: digest(data.proposalSha256), evidenceFingerprint: digest(data.evidenceFingerprint), reason: text(data.reason, 2000), ...(data.acknowledgeStrength !== undefined ? {acknowledgeStrength: text(data.acknowledgeStrength)} : {}), inspections: validateSkillInspections(data.inspections, lessonReferences(row.proposal), studyId)};
    if (body.decision === "accept" && (body.acknowledgeStrength !== FIXTURE_LESSON_STRENGTH || compareSkillInspections(row.proposal.inspections, body.inspections).length || body.evidenceFingerprint !== lessonEvidenceFingerprint(row.proposal, body.inspections))) fail("accepted lesson lacks unchanged reviewed evidence/explicit fixture strength acknowledgement");
    if (hash({...body, actor: event.actor}) !== data.sha256) fail("disposition hash mismatch");
    row.state = body.decision === "accept" ? "accepted" : body.decision === "reject" ? "rejected" : "withdrawn"; row.disposition = {...body, actor: event.actor, at: event.at, sha256: data.sha256 as string};
  } else if (event.type.startsWith("lesson.")) fail("unsupported lesson event version; keep original bytes and use a supporting ares version");
  return [...rows.values()];
}
function read(dirArg: string) {
  const {dir, study} = openStudy(dirArg); requireExperiment(study); const events = readLedger(dir), folded = fold(events, study.id), rows = new Map(folded.map(row => [row.proposal.name, row]));
  for (const parent of [join(dir, "proposals")]) {const stat = lstatSync(parent, {throwIfNoEntry: false}); if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) fail("proposal directory linked or unavailable");}
  const stat = lstatSync(file(dir), {throwIfNoEntry: false});
  if (!stat) {if (rows.size) fail("lesson index missing");}
  else {if (!stat.isFile() || stat.isSymbolicLink()) fail("lesson index must be regular"); let raw: unknown; try {raw = JSON.parse(readTextBounded(file(dir), LESSON_INDEX_BYTES, {noFollow: true}));} catch {return fail("lesson index unreadable/malformed/over-bound");} const index = object(raw, ["v", "proposals"]); if (index.v !== 1 || canonical(index.proposals) !== canonical([...rows.values()].map(row => row.proposal))) fail("lesson index differs from original receipts or has unsupported version");}
  return {dir, study, events, rows: [...rows.values()]};
}
export function listLessonCandidates(dir: string) {const current = read(dir); if (!current.rows.length) return []; const views = readHarnessViews(dir); return current.rows.map(row => {let current = false; try {const source = currentLessonSource(dir, row.proposal, views); current = source.binding === row.proposal.roundBinding && source.transitions.fingerprint === row.proposal.sourceFingerprint;} catch { /* explicit stale view */ } return {...row, current, evidenceFingerprint: lessonEvidenceFingerprint(row.proposal), exportable: row.state === "accepted" && current && row.proposal.kind !== "no-lesson", needsSourceRecheck: true};});}
export async function proposeLesson(dirArg: string, raw: unknown, actor: Actor, options: SkillCheckOptions = {}) {
  const current = read(dirArg); if (!options.lock) fail("proposal requires an owned study transaction"); assertStudyReadLock(current.dir, options.lock);
  const authored = input(raw, current.study.id), source = currentLessonSource(current.dir, authored);
  if (current.rows.length >= LESSON_CANDIDATES || current.rows.some(row => row.proposal.name === authored.name)) fail("64-proposal cap or duplicate name; choose another name/study");
  const selected = authored.behavior.map(ref => source.probes.find(p => p.projection.id === ref.probe)!.projection), first = selected[0];
  const compatibility = first?.servedModel && selected.every(p => p.servedModel === first.servedModel && p.hostRuntimeHash === first.hostRuntimeHash && p.toolsetHash === first.toolsetHash) ? {model: first.servedModel, runtime: first.hostRuntimeHash, toolsetSha256: first.toolsetHash} : null;
  const base: LessonProposal = {...authored, studyId: current.study.id, taskId: source.definition.task.id, taskInputSha256: source.definition.task.inputSha256, roundBinding: source.binding, sourceFingerprint: source.transitions.fingerprint, sourceStrength: "synthetic-fixture", transfer: "not-demonstrated", evidenceLabel: "single-task-observation", compatibility, inspections: []};
  const checked = await inspectSkillEvidenceSet(current.dir, lessonReferences(base), options), proposal = parseProposal({...base, inspections: checked.inspections}, current.study.id);
  candidateNote({proposal, sha256: hash(proposal), actor, at: new Date(0).toISOString(), state: "proposed"});
  if (!checked.recheck() || currentLessonSource(current.dir, proposal).transitions.fingerprint !== proposal.sourceFingerprint) fail("sources changed or source budget expired during proposal");
  if (canonical(read(current.dir).rows) !== canonical(current.rows)) fail("lesson journal/index changed before proposal");
  assertStudyReadLock(current.dir, options.lock);
  commit(current.dir, [[file(current.dir), JSON.stringify({v: 1, proposals: [...current.rows.map(row => row.proposal), proposal]}, null, 2) + "\n", LESSON_INDEX_BYTES]], [{actor, type: "lesson.proposed", data: {v: 1, proposal, sha256: hash(proposal)}}]); return listLessonCandidates(current.dir).find(row => row.proposal.name === proposal.name)!;
}
export async function checkLesson(dir: string, name: string, options: SkillCheckOptions = {}) {
  const row = read(dir).rows.find(row => row.proposal.name === id(name)); if (!row) fail("proposal missing");
  let current = false; try {const source = currentLessonSource(dir, row.proposal); current = source.binding === row.proposal.roundBinding && source.transitions.fingerprint === row.proposal.sourceFingerprint;} catch { /* stale */ }
  if (!current) return {name, proposalSha256: row.sha256, state: "changed", acceptReady: false, evidenceFingerprint: lessonEvidenceFingerprint(row.proposal), inspections: row.proposal.inspections, sourceStrength: "synthetic-fixture", nextStep: "Create a revised proposal from a non-stale closed round"};
  const checked = await inspectSkillEvidenceSet(dir, lessonReferences(row.proposal), options), reasons = compareSkillInspections(row.proposal.inspections, checked.inspections);
  let same = false; try {same = currentLessonSource(dir, row.proposal).transitions.fingerprint === row.proposal.sourceFingerprint && canonical(read(dir).rows.find(value => value.proposal.name === name)) === canonical(row);} catch { /* changed source */ }
  const ready = checked.recheck() && same && !reasons.length;
  return {name, proposalSha256: row.sha256, state: ready ? "available" : "unavailable", acceptReady: ready && row.state === "proposed", evidenceFingerprint: lessonEvidenceFingerprint(row.proposal, checked.inspections), inspections: checked.inspections, sourceStrength: "synthetic-fixture", nextStep: "Review the fixture strength and limitations; no improvement/transfer is established"};
}
export async function decideLesson(dir: string, name: string, raw: unknown, actor: Actor, options: SkillCheckOptions = {}) {
  const current = read(dir); if (!options.lock) fail("review requires an owned study transaction"); assertStudyReadLock(current.dir, options.lock);
  const row = current.rows.find(row => row.proposal.name === id(name)); if (!row) fail("proposal missing");
  const r = object(raw, ["decision", "proposalSha256", "evidenceFingerprint", "reason", "acknowledgeStrength"]);
  if (!["accept", "reject", "withdraw"].includes(r.decision as string) || r.proposalSha256 !== row.sha256 || r.evidenceFingerprint !== lessonEvidenceFingerprint(row.proposal)) fail("disposition or proposal/evidence fingerprint differs");
  const reason = text(r.reason, 2000), decision = r.decision as "accept" | "reject" | "withdraw";
  if (row.state !== "proposed" && !(row.state === "accepted" && decision === "withdraw")) fail("disposition is final; create a revised proposal");
  let inspections = row.proposal.inspections;
  if (decision === "accept") {
    if (r.acknowledgeStrength !== FIXTURE_LESSON_STRENGTH) fail("accept must explicitly acknowledge synthetic-fixture; not evidence of real agent behavior");
    const checked = await checkLesson(dir, name, options); if (!checked.acceptReady || checked.evidenceFingerprint !== r.evidenceFingerprint) fail("required sources/counterevidence changed or unavailable"); inspections = checked.inspections;
  }
  const body = {decision, proposalSha256: row.sha256, evidenceFingerprint: r.evidenceFingerprint as string, reason, ...(r.acknowledgeStrength !== undefined ? {acknowledgeStrength: text(r.acknowledgeStrength)} : {}), inspections};
  if (canonical(read(dir).rows) !== canonical(current.rows)) fail("lesson journal/index changed before disposition");
  assertStudyReadLock(current.dir, options.lock);
  const pending = [{actor, type: "lesson.decided", data: {v: 1, name, ...body, sha256: hash({...body, actor})}}];
  const prepared = prepareCommit(current.dir, [], pending); fold([...current.events, ...prepared.events], current.study.id);
  commit(current.dir, [], pending); return listLessonCandidates(dir).find(row => row.proposal.name === name)!;
}
export function candidateNote(row: LessonRow): AmemNote | null {
  const p = row.proposal; if (p.kind === "no-lesson") return null;
  const text = `${FIXTURE_LESSON_STRENGTH}\nSingle-task observation; transfer: not-demonstrated\nLesson ${p.name} (${row.sha256}); round ${p.round} (${p.closureSha256})\n${p.summary}\nProcedure:\n${p.procedure.map(value => `- ${value}`).join("\n")}\nApplicability: ${p.applicability}\nLimitations: ${p.limitations.join("; ")}\nWhen not to use: ${p.whenNotToUse.join("; ")}\nFailure: ${p.failure}\nRetry when: ${p.retryWhen}`;
  if (Buffer.byteLength(text) > LESSON_BYTES) fail("export text exceeds 16 KiB; create a shorter revised proposal");
  return {kind: p.kind === "observation" ? "finding" : "fail", title: p.name, text, ...(p.kind === "observation" ? {} : {approach: p.summary, symptom: p.failure, cause: "Reviewer-described limitation, not causal proof", retryWhen: p.retryWhen}), evidence: [`ares:${p.studyId}/harness-closure:${p.round}`]};
}
export function eligibleLessonNotes(dir: string) {return listLessonCandidates(dir).filter(row => row.exportable).map(row => ({row, note: candidateNote(row)!}));}
export function boundLessonExportBatch(dir: string, notes: {sha256: string; note: AmemNote}[]) {
  const byHash = new Map(eligibleLessonNotes(dir).map(value => [hash(value.note), value.row])), known = new Set<string>(), batch: typeof notes = [];
  for (const note of notes) {const row = byHash.get(note.sha256), refs = row ? lessonReferences(row.proposal).map(canonical) : []; if (new Set([...known, ...refs]).size > 64) break; refs.forEach(ref => known.add(ref)); batch.push(note);}
  return batch;
}
export async function recheckLessonExports(dir: string, hashes: readonly string[], options: SkillCheckOptions = {}) {
  const pending = eligibleLessonNotes(dir).filter(value => hashes.includes(hash(value.note)));
  const refs = [...new Map(pending.flatMap(value => lessonReferences(value.row.proposal)).map(ref => [canonical(ref), ref])).values()];
  if (!refs.length) return;
  const checked = await inspectSkillEvidenceSet(dir, refs, options); if (!checked.recheck()) fail("sources changed or export source budget expired");
  const byRef = new Map(checked.inspections.map(value => [canonical(value.ref), value]));
  for (const {row} of pending) {currentLessonSource(dir, row.proposal); const now = lessonReferences(row.proposal).map(ref => byRef.get(canonical(ref))!); if (compareSkillInspections(row.proposal.inspections, now).length || lessonEvidenceFingerprint(row.proposal, now) !== row.disposition?.evidenceFingerprint) fail("accepted lesson source/counterevidence changed before export");}
}
export function archivedLessonSources(dir: string) {
  const current = read(dir), receipts = archiveReceiptIndex(current.events), counts = new Map<string, number>(), known = new Map<string, {row: LessonRow; note: AmemNote; noteSha256: string}>();
  for (const id of receipts.values()) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const row of listLessonCandidates(dir)) if (row.exportable) {const note = candidateNote(row); if (!note) continue; const noteSha256 = hash(note), id = receipts.get(noteSha256); if (id && counts.get(id) === 1) known.set(id, {row, note, noteSha256});}
  return known;
}
