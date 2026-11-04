import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertWritable, boundedText, commit, onlyKeys, openStudy, plain, readLedger, readTextBounded, requireExperiment, sha256, type Actor, type LedgerEvent } from "../study.ts";
import { listAttempts, type AttemptStatus } from "./attempts.ts";
import { readProtocol } from "./protocol.ts";
import { readFinalSeeds, finalSeedsHash } from "./final.ts";
import { metricValue, pairSamples, readClosedInvestigation, type Sample, type PairedSamples } from "./investigate.ts";

export const MAX_ABLATIONS = 200, ABLATE_BYTES = 1_048_576;
export interface Ablation { id: string; commit: string; removes: string }
type Exclusion = "other-protocol" | "before-selection" | "missing-start-event" | "undeclared-seed" | "reserved-seed" | "undeclared-ablation" | "later-success";
type AttemptsByStatus = Record<AttemptStatus, string[]>;
export interface AblateRow extends Ablation { attempts: AttemptsByStatus; perSeed: Sample[]; paired: PairedSamples; reason: "no-data" | "reference-seeds" | "no-shared-seeds" | "paired" }
export interface AblateResult {
  v: 1; run: "ablate"; investigateSha256: string; inputsSha256: string; protocolHash: string;
  metric: { name: string; unit: string; direction: "max" | "min" };
  reference: { commit: string; attempts: AttemptsByStatus; perSeed: Sample[] };
  ablations: AblateRow[];
  totals: { attempts: number; byStatus: Record<AttemptStatus, number>; countedSuccesses: number; excluded: number };
  excluded: { id: string; commit: string; seed: number; status: AttemptStatus; reasons: Exclusion[] }[];
}
function bad(reason: string): never { throw new Error(`ablate: ${reason}; inspect ares investigate show and ares attempt list, then correct the inputs and retry ablate`); }
function canonical(raw: unknown): string {
  if (Array.isArray(raw)) return `[${raw.map(canonical).join(",")}]`;
  if (plain(raw)) return `{${Object.keys(raw).sort().map(k => `${JSON.stringify(k)}:${canonical(raw[k])}`).join(",")}}`;
  return JSON.stringify(raw) ?? "null";
}
function declaration(raw: unknown, strict: boolean): Ablation {
  if (!plain(raw)) bad("declaration object required");
  if (strict) onlyKeys(raw, ["id", "commit", "removes"], "ablate declaration");
  if (typeof raw.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.id)) bad("id must be a run name of 1..64 characters");
  if (typeof raw.commit !== "string" || !/^[a-fA-F0-9]{40}$/.test(raw.commit)) bad("commit must be a full 40-hex SHA");
  const removes = boundedText(raw.removes, "ablate removes", 2000);
  if (Buffer.byteLength(removes) > 2000) bad("removes exceeds 2000 bytes");
  return { id: raw.id, commit: raw.commit.toLowerCase(), removes };
}
export function foldAblations(events: LedgerEvent[]): Ablation[] {
  const rows: Ablation[] = [];
  for (const e of events) if (e.type === "ablation.added") {
    const row = declaration(e.data.ablation, false);
    if (rows.length >= MAX_ABLATIONS || rows.some(old => old.id === row.id || old.commit === row.commit)) bad("journal has duplicate ablation id/commit or exceeds 200 declarations; restore the last valid ledger");
    rows.push(row);
  }
  return rows;
}
function context(dirArg: string) {
  const { dir, study } = openStudy(dirArg); requireExperiment(study);
  const closed = readClosedInvestigation(dir), protocol = readProtocol(dir)!;
  if (!closed.result.winner) bad("investigation has no winner; finish and close an investigation with a winner first");
  const events = readLedger(dir), declarations = foldAblations(events);
  return { dir, study, closed, protocol, events, declarations, winner: closed.result.winner.commit, baseline: closed.result.baseline.commit };
}
/** Caller holds the study lock; declarations never dispatch work or rewrite earlier journal entries. */
export function addAblation(dirArg: string, raw: unknown, actor: Actor): Ablation {
  try {
    const input = context(dirArg), row = declaration(raw, true);
    if (input.declarations.length >= MAX_ABLATIONS) bad("200 declarations reached; start a new study for more ablations");
    if (input.declarations.some(old => old.id === row.id)) bad(`duplicate id ${row.id}; choose a unique id`);
    if (input.declarations.some(old => old.commit === row.commit)) bad(`duplicate commit for ${row.id}; choose a unique frozen ablation`);
    if (row.commit === input.winner || row.commit === input.baseline) bad("commit is the winner or selection baseline; use a distinct ablation commit");
    commit(input.dir, [], [{ actor, type: "ablation.added", data: { ablation: row } }]); return row;
  } catch (error) {
    const message = error instanceof Error ? error.message : "ablate: invalid declaration";
    throw new Error(message.includes("retry ablate") ? message : `${message}; correct the file and run ares ablate add --file PATH again`);
  }
}
function empty(): AttemptsByStatus { return { running: [], succeeded: [], failed: [], cancelled: [], unknown: [] }; }
function calculate(input: ReturnType<typeof context>): { result: AblateResult; running: boolean } {
  const { dir, study, closed, protocol, events, declarations, winner } = input;
  const attempts = listAttempts(dir, { run: "ablate" }).attempts, reserved = readFinalSeeds(dir, protocol)?.seeds ?? [];
  const cutoff = events.findLastIndex(e => e.type === "selection.set"), starts = new Map<string, { index: number; data: Record<string, unknown> }>();
  events.forEach((e, index) => { if (e.type === "attempt.started" && typeof e.data.id === "string") { if (starts.has(e.data.id)) bad(`duplicate start receipt ${e.data.id}`); starts.set(e.data.id, { index, data: e.data }); } });
  const ordered = [...attempts].sort((a, b) => (starts.get(a.id)?.index ?? -1) - (starts.get(b.id)?.index ?? -1) || a.id.localeCompare(b.id));
  const reference = { commit: winner, attempts: empty(), perSeed: [] as Sample[] };
  const rows = declarations.map(d => ({ ...d, attempts: empty(), perSeed: [] as Sample[] }));
  const byStatus = { running: 0, succeeded: 0, failed: 0, cancelled: 0, unknown: 0 }, excluded: AblateResult["excluded"] = [];
  for (const a of ordered) {
    if (a.studyId !== study.id || typeof a.commit !== "string" || !/^[a-f0-9]{40}$/.test(a.commit) || !Number.isSafeInteger(a.seed)) bad(`attempt ${a.id} has invalid study/commit/seed metadata`);
    byStatus[a.status]++;
    const row = a.commit === winner ? reference : rows.find(r => r.commit === a.commit);
    if (row) row.attempts[a.status].push(a.id);
    const reasons: Exclusion[] = [], start = starts.get(a.id);
    if (!row) reasons.push("undeclared-ablation");
    if (a.protocolHash !== closed.result.protocolHash) reasons.push("other-protocol");
    if (!start) reasons.push("missing-start-event");
    else {
      if (start.data.run !== a.run || start.data.commit !== a.commit || start.data.seed !== a.seed) bad(`attempt ${a.id} start receipt identity mismatch`);
      if (start.index <= cutoff) reasons.push("before-selection");
    }
    if (!protocol.seeds.includes(a.seed)) reasons.push("undeclared-seed");
    if (reserved.includes(a.seed)) reasons.push("reserved-seed");
    if (!reasons.length && a.status === "succeeded" && row) {
      if (row.perSeed.some(s => s.seed === a.seed)) reasons.push("later-success");
      else row.perSeed.push({ seed: a.seed, attempt: a.id, value: metricValue(a, closed.result.metric) });
    }
    if (reasons.length) excluded.push({ id: a.id, commit: a.commit, seed: a.seed, status: a.status, reasons });
  }
  reference.perSeed.sort((a, b) => a.seed - b.seed);
  const ablations: AblateRow[] = rows.map(row => {
    row.perSeed.sort((a, b) => a.seed - b.seed);
    const paired = pairSamples(row.perSeed, reference.perSeed, closed.result.metric.direction, row.commit);
    const reason = !row.perSeed.length ? "no-data" : !reference.perSeed.length ? "reference-seeds" : !paired.pairedSeeds.length ? "no-shared-seeds" : "paired";
    return { ...row, paired, reason };
  });
  const result: AblateResult = {
    v: 1, run: "ablate", investigateSha256: closed.sha256, protocolHash: closed.result.protocolHash, metric: closed.result.metric,
    inputsSha256: sha256(canonical({ investigate: closed.sha256, declarations, finalSeeds: finalSeedsHash(dir, protocol) ?? null, attempts: ordered.map(a => ({ record: sha256(canonical(a)), start: starts.get(a.id)?.index ?? null })) })),
    reference, ablations, totals: { attempts: attempts.length, byStatus, countedSuccesses: reference.perSeed.length + rows.reduce((n, r) => n + r.perSeed.length, 0), excluded: excluded.length }, excluded,
  };
  assertWritable(JSON.stringify(result, null, 2) + "\n", ABLATE_BYTES, "ablate result; archive this study and use a new bounded run");
  return { result, running: attempts.some(a => a.status === "running") };
}
export function ablateResultPath(dir: string): string { return join(dir, "runs", "ablate", "ablate.json"); }
function previous(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readTextBounded(file, ABLATE_BYTES); } catch { bad("result is unreadable or oversized; restore the last valid bounded ablate.json"); }
  let value: unknown; try { value = JSON.parse(text); } catch { bad("result JSON is malformed; restore the last valid ablate.json"); }
  if (!plain(value) || value.v !== 1) throw new Error("ablate result: unsupported version; use an ares version that supports it, keeping ablate.json unchanged");
  return text;
}
export function showAblate(dirArg: string): AblateResult { const input = context(dirArg); previous(ablateResultPath(input.dir)); return calculate(input).result; }
/** Caller holds the study lock; result and receipt share one commit. */
export function closeAblate(dirArg: string, actor: Actor): AblateResult {
  const input = context(dirArg), file = ablateResultPath(input.dir), old = previous(file), next = calculate(input);
  if (next.running) throw new Error("ablate close: an ablate attempt is running; run ares attempt reconcile before closing");
  const text = JSON.stringify(next.result, null, 2) + "\n";
  if (old !== text) commit(input.dir, [[file, text, ABLATE_BYTES]], [{ actor, type: "ablate.closed", data: { sha256: sha256(text), investigateSha256: input.closed.sha256 } }]);
  return next.result;
}

export function readClosedAblate(dirArg: string): { result: AblateResult; sha256: string } {
  const input = context(dirArg), text = previous(ablateResultPath(input.dir));
  if (text === undefined) throw new Error("ablate result: not closed; run ares ablate close before final approval");
  const hash = sha256(text), receipt = input.events.findLast(e => e.type === "ablate.closed");
  if (!receipt || receipt.data.sha256 !== hash) throw new Error("ablate result: bytes disagree with the latest close receipt; run ares ablate close again");
  const next = calculate(input);
  if (next.running || text !== JSON.stringify(next.result, null, 2) + "\n") throw new Error("ablate result: stale inputs or running work; reconcile attempts and run ares ablate close again");
  return { result: next.result, sha256: hash };
}
