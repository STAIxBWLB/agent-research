import {plain, onlyKeys, sha256, isHarnessGate, type Actor, type LedgerEvent} from "../study.ts";
import {canonical} from "../plan/state.ts";
import {hasHarnessCredential} from "./privacy.ts";
import {validateHarnessExecution, type DeclaredExecutionRef, type HarnessRound, type DeclaredProbe} from "./rounds.ts";

export const HARNESS_CONTRASTS = 64, HARNESS_SECTIONS = 32;
export interface ProbeRef {probe: string; projectionSha256: string; outputManifestHash?: string}
interface Form {v: 1; id: string; fingerprint: string; model?: string; sourceExecution?: DeclaredExecutionRef}
export interface HarnessContrast extends Form {
  arm: string; outcome: "improved" | "unchanged" | "regressed" | "inconclusive";
  basis: "task-check" | "human-judgment" | "model-judgment"; observations: string; uncertainty: string; explanations: string[]; evidence: ProbeRef[];
}
export interface HarnessComposition extends Form {sections: {section: string; decision: "keep" | "drop" | "revise"; contrasts: {id: string; sha256: string}[]; reason: string}[]; successorSha256: string | null}
export interface HarnessAdoption extends Form {decision: "adopt" | "keep-baseline" | "inconclusive"; arm: string; reason: string; checks: ProbeRef[]}
export interface Recorded<T> {form: T; sha256: string; actor: Actor; at: string; binding: string; sourceStrength: "synthetic-fixture"; matched: false}
export interface Bucket {contrasts: Map<string, Recorded<HarnessContrast>>; composition?: Recorded<HarnessComposition>; adoption?: Recorded<HarnessAdoption>; closed?: string}
export interface TransitionState {buckets: Map<string, Bucket>; records: Map<string, Recorded<HarnessContrast | HarnessComposition | HarnessAdoption>>}
export function transitionState(): TransitionState {return {buckets: new Map(), records: new Map()};}
export function transitionBucket(state: TransitionState, round: string, binding: string): Bucket {
  const key = canonical([round, binding]); let bucket = state.buckets.get(key);
  if (!bucket) {bucket = {contrasts: new Map()}; state.buckets.set(key, bucket);} return bucket;
}
export function transitionFail(cause: string): never {throw new Error(`harness transition: ${cause}; inspect ares harness show --json, correct the admitted refs/round and use its current fingerprint before retrying`);}
function object(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!plain(raw)) transitionFail("object required"); try {onlyKeys(raw, keys, "harness transition");} catch {transitionFail(`unknown field; allowed fields: ${keys.join(", ")}`);} return raw;
}
function text(raw: unknown, max = 2000): string {if (typeof raw !== "string" || !raw.trim() || raw.includes("\0") || Buffer.byteLength(raw) > max || hasHarnessCredential(raw)) transitionFail("text is blank, over-bound or contains a URL/credential"); return raw;}
function id(raw: unknown): string {const value = text(raw, 64); if (!isHarnessGate(`harness:${value}`)) transitionFail("invalid ASCII run-name id"); return value;}
function digest(raw: unknown): string {if (typeof raw !== "string" || raw.length !== 64 || !/^[a-f0-9]{64}$/.test(raw)) transitionFail("lowercase SHA-256 required"); return raw;}
function list(raw: unknown, max: number, min = 0): unknown[] {if (!Array.isArray(raw) || raw.length < min || raw.length > max) transitionFail(`array requires ${min}..${max} items`); return raw;}
function refs(raw: unknown): ProbeRef[] {
  const result = list(raw, 16).map(raw => {const row = object(raw, ["probe", "projectionSha256", "outputManifestHash"]); return {probe: text(row.probe, 256), projectionSha256: digest(row.projectionSha256), ...(row.outputManifestHash !== undefined ? {outputManifestHash: digest(row.outputManifestHash)} : {})};});
  if (new Set(result.map(ref => ref.probe)).size !== result.length) transitionFail("duplicate probe ref"); return result;
}
function base(row: Record<string, unknown>): Form {
  if (row.v !== 1) transitionFail("unsupported form version; keep original bytes and use a supporting version");
  return {v: 1, id: id(row.id), fingerprint: digest(row.fingerprint), ...(row.model !== undefined ? {model: text(row.model, 256)} : {}), ...(row.sourceExecution !== undefined ? {sourceExecution: validateHarnessExecution(row.sourceExecution)} : {})};
}
export function parseContrast(raw: unknown): HarnessContrast {
  const row = object(raw, ["v", "id", "fingerprint", "arm", "outcome", "basis", "model", "sourceExecution", "observations", "uncertainty", "explanations", "evidence"]);
  if (!["improved", "unchanged", "regressed", "inconclusive"].includes(row.outcome as string) || !["task-check", "human-judgment", "model-judgment"].includes(row.basis as string)) transitionFail("invalid contrast outcome/basis");
  const form = {...base(row), arm: id(row.arm), outcome: row.outcome as HarnessContrast["outcome"], basis: row.basis as HarnessContrast["basis"], observations: text(row.observations), uncertainty: text(row.uncertainty), explanations: list(row.explanations, 8).map(value => text(value, 1000)), evidence: refs(row.evidence)};
  if (!form.evidence.length || form.basis === "model-judgment" && !form.model) transitionFail("contrast needs admitted evidence and model judgments need a model identity"); return form;
}
export function parseComposition(raw: unknown): HarnessComposition {
  const row = object(raw, ["v", "id", "fingerprint", "sections", "successorSha256", "model", "sourceExecution"]);
  const sections = list(row.sections, HARNESS_SECTIONS, 1).map(raw => {
    const section = object(raw, ["section", "decision", "contrasts", "reason"]);
    if (!["keep", "drop", "revise"].includes(section.decision as string)) transitionFail("invalid section decision");
    const contrasts = list(section.contrasts, 16, 1).map(raw => {const ref = object(raw, ["id", "sha256"]); return {id: id(ref.id), sha256: digest(ref.sha256)};});
    if (new Set(contrasts.map(ref => ref.id)).size !== contrasts.length) transitionFail("duplicate contrast link");
    return {section: text(section.section, 256), decision: section.decision as "keep" | "drop" | "revise", contrasts, reason: text(section.reason, 1000)};
  });
  if (new Set(sections.map(section => section.section)).size !== sections.length) transitionFail("duplicate section");
  return {...base(row), sections, successorSha256: row.successorSha256 === null ? null : digest(row.successorSha256)};
}
export function parseAdoption(raw: unknown): HarnessAdoption {
  const row = object(raw, ["v", "id", "fingerprint", "decision", "arm", "reason", "checks", "model", "sourceExecution"]);
  if (!["adopt", "keep-baseline", "inconclusive"].includes(row.decision as string)) transitionFail("invalid adoption decision");
  return {...base(row), decision: row.decision as HarnessAdoption["decision"], arm: id(row.arm), reason: text(row.reason), checks: refs(row.checks)};
}
export const recordHash = (form: unknown, actor: Actor, binding: string) => sha256(canonical({form, actor, binding}));
export const transitionKey = (round: string, kind: string, id: string) => canonical([round, kind, id]);
export function harnessEvidenceFingerprint(binding: string, probes: DeclaredProbe[], bucket: Bucket): string {
  return sha256(canonical({binding, probes: probes.map(probe => [probe.projection.id, probe.projectionSha256]), contrasts: [...bucket.contrasts.values()].map(record => record.sha256), composition: bucket.composition?.sha256 ?? null}));
}
function admitted(refs: ProbeRef[], probes: DeclaredProbe[]): void {
  const known = new Map(probes.map(probe => [probe.projection.id, probe]));
  for (const ref of refs) {const probe = known.get(ref.probe); if (!probe || probe.projectionSha256 !== ref.projectionSha256 || ref.outputManifestHash !== undefined && ref.outputManifestHash !== probe.projection.outputManifestHash) transitionFail("probe/output ref is not a current admitted projection");}
}
export function successorView(probes: DeclaredProbe[], bucket: Bucket) {
  const hash = bucket.composition?.form.successorSha256; if (!hash) return null;
  const own = probes.find(probe => probe.projection.guidanceHash === hash);
  return {guidanceSha256: hash, execution: own ? "fixture-declared" as const : "unexecuted" as const, ...(own ? {probeId: own.projection.id, status: own.projection.state} : {})};
}
export function transitionView(round: HarnessRound, binding: string, probes: DeclaredProbe[], bucket: Bucket) {
  const fingerprint = harnessEvidenceFingerprint(binding, probes, bucket), closure = bucket.closed && bucket.adoption ? {...bucket.adoption, current: bucket.adoption.form.fingerprint === fingerprint} : null;
  const successor = successorView(probes, bucket);
  const nextStep = closure?.current ? "Round disposition recorded; separately review source-backed lessons or start a new round" : closure ? "Evidence changed; use the current fingerprint to preview ares harness adopt again" : successor?.execution === "unexecuted" ? "Import the exact successor fixture with ares harness import; its parents do not execute it" : !bucket.contrasts.size ? "Record admitted comparisons with ares harness contrast, or preserve baseline/inconclusive with ares harness adopt" : !bucket.composition ? "Use ares harness compose for per-section decisions, or preview ares harness adopt to preserve baseline/inconclusive" : "Preview ares harness adopt with the current fingerprint";
  return {fingerprint, nextStep, contrasts: [...bucket.contrasts.values()], composition: bucket.composition ?? null, closure, successor, readiness: {state: closure ? closure.current ? "closed" as const : "stale" as const : "open" as const, experimental: true as const, correctness: "unavailable" as const, transfer: "not-demonstrated" as const}};
}
/** Verify each transition at its ledger position. Fixture records never manufacture native checks or metrics. */
export function applyTransition(state: TransitionState, event: LedgerEvent, round: HarnessRound, binding: string, probes: DeclaredProbe[]): void {
  const bucket = transitionBucket(state, round.id, binding), data = object(event.data, event.type === "harness.round.closed" ? ["v", "round", "binding", "adoptionSha256", "fingerprint", "sourceStrength"] : ["v", "round", "binding", "form", "sha256", "sourceStrength"]);
  if (data.v !== 1 || data.sourceStrength !== "synthetic-fixture" || data.round !== round.id || data.binding !== binding) transitionFail("transition version/binding differs from its round");
  if (event.type === "harness.round.closed") {
    if (!bucket.adoption || data.adoptionSha256 !== bucket.adoption.sha256 || data.fingerprint !== bucket.adoption.form.fingerprint || data.fingerprint !== harnessEvidenceFingerprint(binding, probes, bucket) || bucket.closed === bucket.adoption.sha256) transitionFail("closure lacks its current adoption receipt");
    bucket.closed = bucket.adoption.sha256; return;
  }
  const kind = event.type === "harness.contrast.recorded" ? "contrast" : event.type === "harness.composition.recorded" ? "composition" : event.type === "harness.adoption.decided" ? "adoption" : transitionFail("unsupported transition event");
  const form = kind === "contrast" ? parseContrast(data.form) : kind === "composition" ? parseComposition(data.form) : parseAdoption(data.form);
  const key = transitionKey(round.id, kind, form.id);
  if (data.sha256 !== recordHash(form, event.actor, binding) || state.records.has(key) || form.fingerprint !== harnessEvidenceFingerprint(binding, probes, bucket)) transitionFail("transition receipt/id or current evidence fingerprint differs");
  if (round.authoring === "controlled-lane" && (kind === "composition" || kind === "adoption" || kind === "contrast" && (form as HarnessContrast).basis === "model-judgment") && (!form.sourceExecution || !form.model)) transitionFail("controlled authored transition needs model and declared source execution");
  const record = {form, actor: event.actor, at: event.at, binding, sha256: data.sha256 as string, sourceStrength: "synthetic-fixture" as const, matched: false as const};
  if (kind === "contrast") {
    const contrast = form as HarnessContrast;
    if (bucket.contrasts.size >= HARNESS_CONTRASTS) transitionFail("64-contrast limit; revise the round explicitly");
    if (contrast.arm === "baseline" || !round.candidates.some(candidate => candidate.id === contrast.arm) && !(contrast.arm === "successor" && bucket.composition?.form.successorSha256)) transitionFail("contrast arm is not declared");
    admitted(contrast.evidence, probes);
    const evidenceIds = new Set(contrast.evidence.map(ref => ref.probe));
    const expected = contrast.arm === "successor" ? bucket.composition?.form.successorSha256 : round.candidates.find(candidate => candidate.id === contrast.arm)?.guidanceSha256;
    if (contrast.outcome !== "inconclusive" && ![round.baseline.guidanceSha256, expected].every(hash => probes.some(probe => probe.projection.guidanceHash === hash && evidenceIds.has(probe.projection.id)))) transitionFail("a non-inconclusive contrast needs its baseline and arm execution refs");
    bucket.contrasts.set(form.id, record as Recorded<HarnessContrast>);
  } else if (kind === "composition") {
    const composition = form as HarnessComposition;
    if (bucket.composition) transitionFail("one successor/composition per definition; revise the round explicitly");
    for (const section of composition.sections) for (const ref of section.contrasts) if (bucket.contrasts.get(ref.id)?.sha256 !== ref.sha256) transitionFail("section links a missing or changed contrast");
    bucket.composition = record as Recorded<HarnessComposition>;
  } else {
    const adoption = form as HarnessAdoption;
    if (bucket.adoption?.form.fingerprint === form.fingerprint) transitionFail("this evidence already has a decision; change evidence before a new disposition");
    const known = adoption.arm === "baseline" || round.candidates.some(candidate => candidate.id === adoption.arm) || adoption.arm === "successor" && !!bucket.composition?.form.successorSha256;
    if (!known || adoption.decision === "keep-baseline" && adoption.arm !== "baseline" || adoption.decision === "adopt" && adoption.arm === "baseline") transitionFail("decision arm differs from its declared candidate/baseline");
    admitted(adoption.checks, probes);
    bucket.adoption = record as Recorded<HarnessAdoption>; bucket.closed = undefined;
  }
  state.records.set(key, record);
}
