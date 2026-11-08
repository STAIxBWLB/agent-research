import {plain, onlyKeys, sha256, isHarnessGate, type Actor, type LedgerEvent} from "../study.ts";
import {canonical} from "../plan/state.ts";
import {hasHarnessCredential} from "./privacy.ts";
import {validateHarnessExecution, type DeclaredExecutionRef, type HarnessRound, type DeclaredProbe} from "./rounds.ts";

export const HARNESS_CONTRASTS = 64, HARNESS_SECTIONS = 32;
export interface ProbeRef {probe: string; projectionSha256: string; outputManifestHash?: string}
interface Form {v: 1; id: string; fingerprint: string; model?: string; sourceExecution?: DeclaredExecutionRef}
export interface HarnessContrast extends Form {
  arm: string; outcome: "improved" | "unchanged" | "regressed" | "inconclusive";
  basis: "deterministic-check" | "blinded-judgment" | "actor-claim"; judge?: "human" | "model"; observations: string; uncertainty: string; explanations: string[]; evidence: ProbeRef[];
}
export interface HarnessComposition extends Form {sections: {section: string; decision: "keep" | "drop" | "revise"; contrasts: {id: string; sha256: string}[]; reason: string}[]; successorSha256: string | null}
export interface IndependentCheck {state: "passed" | "failed" | "unavailable"; source: {kind: "deterministic-executable" | "unavailable"; refs: ProbeRef[]}}
export interface HarnessAdoption extends Form {decision: "adopt"; arm: string; reason: string; checks: ProbeRef[]; independentCheck: IndependentCheck}
export type ClosureOutcome = "adopted-experimental" | "baseline-kept" | "inconclusive" | "withdrawn";
export interface HarnessClosure extends Form {outcome: ClosureOutcome; reason: string; adoptionSha256?: string}
export type ClosureRecord = Recorded<HarnessClosure> & {roundBinding: string; evidenceFingerprint: string; outcome: ClosureOutcome; reason: string};
export interface Recorded<T> {form: T; sha256: string; actor: Actor; at: string; binding: string; sourceStrength: "synthetic-fixture"; matched: false}
export interface Bucket {contrasts: Map<string, Recorded<HarnessContrast>>; composition?: Recorded<HarnessComposition>; adoption?: Recorded<HarnessAdoption>; closed?: ClosureRecord}
export interface TransitionState {buckets: Map<string, Bucket>; records: Map<string, Recorded<HarnessContrast | HarnessComposition | HarnessAdoption | HarnessClosure>>; closures: Map<string, ClosureRecord[]>}
export function transitionState(): TransitionState {return {buckets: new Map(), records: new Map(), closures: new Map()};}
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
function base(row: Record<string, unknown>, input: "contrast" | "compose" | "adopt" | "close"): Form {
  if (row.v !== 1) transitionFail("unsupported form version; keep original bytes and use a supporting version");
  let sourceExecution: DeclaredExecutionRef | undefined;
  if (row.sourceExecution !== undefined) {try {sourceExecution = validateHarnessExecution(row.sourceExecution);} catch {throw new Error(`harness ${input} sourceExecution: malformed or unsafe; correct sourceExecution in the ${input} input form, then retry with the current fingerprint from ares harness show --json`);}}
  return {v: 1, id: id(row.id), fingerprint: digest(row.fingerprint), ...(row.model !== undefined ? {model: text(row.model, 256)} : {}), ...(sourceExecution ? {sourceExecution} : {})};
}
export function parseContrast(raw: unknown): HarnessContrast {
  const row = object(raw, ["v", "id", "fingerprint", "arm", "outcome", "basis", "judge", "model", "sourceExecution", "observations", "uncertainty", "explanations", "evidence"]);
  if (!["improved", "unchanged", "regressed", "inconclusive"].includes(row.outcome as string) || !["deterministic-check", "blinded-judgment", "actor-claim"].includes(row.basis as string)) transitionFail("invalid contrast outcome/basis");
  const form = {...base(row, "contrast"), arm: id(row.arm), outcome: row.outcome as HarnessContrast["outcome"], basis: row.basis as HarnessContrast["basis"], ...(row.judge !== undefined ? {judge: row.judge as "human" | "model"} : {}), observations: text(row.observations), uncertainty: text(row.uncertainty), explanations: list(row.explanations, 8).map(value => text(value, 1000)), evidence: refs(row.evidence)};
  if (!form.evidence.length || form.basis === "blinded-judgment" && !["human", "model"].includes(String(form.judge)) || form.basis !== "blinded-judgment" && form.judge !== undefined || form.judge === "model" && !form.model) transitionFail("contrast needs admitted evidence and blinded judgments need a human/model identity (model name when applicable)"); return form;
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
  return {...base(row, "compose"), sections, successorSha256: row.successorSha256 === null ? null : digest(row.successorSha256)};
}
export function parseAdoption(raw: unknown): HarnessAdoption {
  const row = object(raw, ["v", "id", "fingerprint", "decision", "arm", "reason", "checks", "independentCheck", "model", "sourceExecution"]);
  if (row.decision !== "adopt") transitionFail("invalid adoption decision");
  return {...base(row, "adopt"), decision: row.decision as HarnessAdoption["decision"], arm: id(row.arm), reason: text(row.reason), checks: refs(row.checks), independentCheck: parseIndependentCheck(row.independentCheck)};
}
function parseIndependentCheck(raw: unknown): IndependentCheck {
  const row = object(raw, ["state", "source"]), source = object(row.source, ["kind", "refs"]);
  if (!["passed", "failed", "unavailable"].includes(row.state as string) || !["deterministic-executable", "unavailable"].includes(source.kind as string)) transitionFail("independentCheck needs a closed state and a deterministic-executable or unavailable source, never a judgment");
  const evidence = refs(source.refs);
  if (source.kind === "unavailable" && evidence.length || source.kind === "deterministic-executable" && !evidence.length) transitionFail("independent check source/ref shape differs");
  return {state: row.state as IndependentCheck["state"], source: {kind: source.kind as IndependentCheck["source"]["kind"], refs: evidence}};
}
export function parseClosure(raw: unknown): HarnessClosure {
  const row = object(raw, ["v", "id", "fingerprint", "outcome", "reason", "adoptionSha256", "model", "sourceExecution"]);
  if (!["adopted-experimental", "baseline-kept", "inconclusive", "withdrawn"].includes(row.outcome as string)) transitionFail("invalid closure outcome");
  return {...base(row, "close"), outcome: row.outcome as ClosureOutcome, reason: text(row.reason), ...(row.adoptionSha256 !== undefined ? {adoptionSha256: digest(row.adoptionSha256)} : {})};
}
export function closureFromAdoption(form: HarnessAdoption, adoptionSha256?: string): HarnessClosure {
  return {v: 1, id: form.id, fingerprint: form.fingerprint, outcome: "adopted-experimental", reason: form.reason, ...(form.model ? {model: form.model} : {}), ...(form.sourceExecution ? {sourceExecution: form.sourceExecution} : {}), ...(adoptionSha256 ? {adoptionSha256} : {})};
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
export function transitionView(round: HarnessRound, binding: string, probes: DeclaredProbe[], bucket: Bucket, history: readonly ClosureRecord[] = []) {
  const fingerprint = harnessEvidenceFingerprint(binding, probes, bucket), prior = bucket.closed ?? history.at(-1);
  const closure = prior ? {...prior, current: prior.binding === binding && prior.form.fingerprint === fingerprint} : null;
  const closures = history.slice(-16).map(record => ({...record, current: record.binding === binding && record.form.fingerprint === fingerprint && record.sha256 === closure?.sha256}));
  const successor = successorView(probes, bucket);
  const nextStep = closure?.current ? "Round disposition recorded; separately review source-backed lessons or start a new round" : closure ? "Round/evidence changed; use the current fingerprint to preview ares harness close/adopt again" : successor?.execution === "unexecuted" ? "Import the exact successor fixture with ares harness import; its parents do not execute it" : !bucket.contrasts.size ? "Record admitted comparisons with ares harness contrast, or close baseline-kept/inconclusive/withdrawn with ares harness close" : !bucket.composition ? "Use ares harness compose for per-section decisions, or close without adoption using ares harness close" : "Preview ares harness adopt or ares harness close with the current fingerprint";
  return {fingerprint, nextStep, contrasts: [...bucket.contrasts.values()], composition: bucket.composition ?? null, adoption: bucket.adoption ?? null, closure, closures, remainingClosures: Math.max(0, history.length - closures.length), successor, readiness: {state: closure ? closure.current ? "closed" as const : "stale" as const : "open" as const, experimental: true as const, correctness: "unavailable" as const, transfer: "not-demonstrated" as const}};
}
/** Verify each transition at its ledger position. Fixture records never manufacture native checks or metrics. */
export function applyTransition(state: TransitionState, event: LedgerEvent, round: HarnessRound, binding: string, probes: DeclaredProbe[]): void {
  const bucket = transitionBucket(state, round.id, binding), data = object(event.data, ["v", "round", "binding", "form", "sha256", "sourceStrength"]);
  if (data.v !== 1 || data.sourceStrength !== "synthetic-fixture" || data.round !== round.id || data.binding !== binding) transitionFail("transition version/binding differs from its round");
  const kind = event.type === "harness.contrast.recorded" ? "contrast" : event.type === "harness.composition.recorded" ? "composition" : event.type === "harness.adoption.decided" ? "adoption" : event.type === "harness.round.closed" ? "closure" : transitionFail("unsupported transition event");
  const form = kind === "contrast" ? parseContrast(data.form) : kind === "composition" ? parseComposition(data.form) : kind === "adoption" ? parseAdoption(data.form) : parseClosure(data.form);
  const key = transitionKey(round.id, kind, form.id);
  if (data.sha256 !== recordHash(form, event.actor, binding) || state.records.has(key) || form.fingerprint !== harnessEvidenceFingerprint(binding, probes, bucket)) transitionFail("transition receipt/id or current evidence fingerprint differs");
  if (round.authoring === "controlled-lane" && (kind === "composition" || kind === "adoption" || (kind === "contrast" || kind === "closure") && (!!form.model || !!form.sourceExecution)) && (!form.sourceExecution || !form.model)) transitionFail("controlled authored transition needs model and declared source execution");
  const record = {form, actor: event.actor, at: event.at, binding, sha256: data.sha256 as string, sourceStrength: "synthetic-fixture" as const, matched: false as const};
  if (kind === "contrast") {
    const contrast = form as HarnessContrast;
    if (bucket.contrasts.size >= HARNESS_CONTRASTS) transitionFail("64-contrast limit; revise the round explicitly");
    if (contrast.arm === "baseline" || !round.candidates.some(candidate => candidate.id === contrast.arm) && !(contrast.arm === "successor" && bucket.composition?.form.successorSha256)) transitionFail("contrast arm is not declared");
    admitted(contrast.evidence, probes);
    const evidenceIds = new Set(contrast.evidence.map(ref => ref.probe));
    if (contrast.outcome !== "inconclusive" && !["baseline", contrast.arm].every(arm => probes.some(probe => probe.projection.arm === arm && evidenceIds.has(probe.projection.id)))) transitionFail("a non-inconclusive contrast needs its baseline and arm execution refs");
    if (probes.some(probe => evidenceIds.has(probe.projection.id) && probe.projection.arm !== "baseline" && probe.projection.arm !== contrast.arm)) transitionFail("contrast evidence belongs to an unrelated arm; cite only baseline and the contrast arm, or record a separate contrast");
    bucket.contrasts.set(form.id, record as Recorded<HarnessContrast>);
  } else if (kind === "composition") {
    const composition = form as HarnessComposition;
    if (bucket.composition) transitionFail("one successor/composition per definition; revise the round explicitly");
    for (const section of composition.sections) for (const ref of section.contrasts) if (bucket.contrasts.get(ref.id)?.sha256 !== ref.sha256) transitionFail("section links a missing or changed contrast");
    bucket.composition = record as Recorded<HarnessComposition>;
  } else if (kind === "closure") {
    const closure = form as HarnessClosure;
    if (bucket.closed?.form.fingerprint === form.fingerprint) transitionFail("current evidence already has an immutable closure");
    if (closure.outcome === "adopted-experimental") {
      if (!bucket.adoption || closure.adoptionSha256 !== bucket.adoption.sha256 || closure.fingerprint !== bucket.adoption.form.fingerprint || closure.reason !== bucket.adoption.form.reason || canonical(event.actor) !== canonical(bucket.adoption.actor)) transitionFail("experimental adoption closure lacks its current adoption receipt");
    } else if (closure.adoptionSha256 !== undefined) transitionFail("non-adoption closure cannot claim an adoption receipt");
    const closed: ClosureRecord = {...record, form: closure, roundBinding: binding, evidenceFingerprint: form.fingerprint, outcome: closure.outcome, reason: closure.reason};
    bucket.closed = closed; const history = state.closures.get(round.id) ?? []; history.push(closed); state.closures.set(round.id, history);
    state.records.set(key, closed); return;
  } else {
    const adoption = form as HarnessAdoption;
    if (bucket.adoption?.form.fingerprint === form.fingerprint) transitionFail("this evidence already has a decision; change evidence before a new disposition");
    const known = adoption.arm === "baseline" || round.candidates.some(candidate => candidate.id === adoption.arm) || adoption.arm === "successor" && !!bucket.composition?.form.successorSha256;
    if (!known || adoption.arm === "baseline") transitionFail("decision arm differs from its declared candidate/baseline");
    admitted(adoption.checks, probes); admitted(adoption.independentCheck.source.refs, probes);
    const checked = new Set(adoption.checks.map(ref => ref.probe)), successor = adoption.arm === "successor" ? successorView(probes, bucket) : null;
    if (!probes.some(probe => checked.has(probe.projection.id) && (probe.projection.arm === adoption.arm || adoption.arm === "successor" && successor?.execution === "fixture-declared" && probe.projection.id === successor.probeId))) transitionFail(`adoption needs its selected arm's admitted execution in checks; import the exact ${adoption.arm} fixture with ares harness import, then cite its current probe in checks`);
    if (adoption.independentCheck.state !== "unavailable") transitionFail("independent deterministic check is unavailable for fixture-only sources; never turn a judgment or fixture into passed/failed correctness");
    if (bucket.closed?.form.fingerprint === form.fingerprint) transitionFail("current evidence already has an immutable closure");
    bucket.adoption = record as Recorded<HarnessAdoption>;
  }
  state.records.set(key, record);
}
