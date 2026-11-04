import { openStudy, readLedger, type LedgerEvent, type Study } from "../study.ts";
import { foldIdeas } from "../exp/ideas.ts";
import { readProtocol } from "../exp/protocol.ts";
import { readSelection, selectionHash, type Selection } from "../exp/selection.ts";
import { readClosedInvestigation, type InvestigateResult } from "../exp/investigate.ts";
import { readClosedFinal, readFinalSeeds, finalSeedsHash, type FinalResult, type FinalSeeds } from "../exp/final.ts";
import { foldReviews } from "../paper/review.ts";
import type { AmemNote } from "./amem.ts";

export interface LessonSources {
  study: Pick<Study, "id" | "question">; events: LedgerEvent[];
  investigation?: InvestigateResult; final?: FinalResult; selection?: Selection; finalSeeds?: FinalSeeds;
}
export const LESSON_EVIDENCE_REFS = 16;
/** Read current committed sources only. An absent close yields no lesson; an invalid close refuses. */
export function readLessonSources(dirArg: string): LessonSources {
  const { dir, study } = openStudy(dirArg), events = readLedger(dir), protocol = readProtocol(dir);
  const sources: LessonSources = { study, events };
  if (protocol) {
    sources.selection = readSelection(dir, protocol);
    sources.finalSeeds = readFinalSeeds(dir, protocol);
    for (const [type, value, hash] of [["selection.set", sources.selection, selectionHash(dir, protocol)], ["final.seeds.set", sources.finalSeeds, finalSeedsHash(dir, protocol)]]) {
      if (value && events.findLast(event => event.type === type)?.data.sha256 !== hash) throw new Error("lessons: design file lacks a matching receipt; restore the committed selection/final seeds with ares selection or ares final seeds");
    }
  }
  if (sources.selection && events.some(event => event.type === "investigate.closed" && event.data.run === sources.selection!.run)) sources.investigation = readClosedInvestigation(dir).result;
  if (events.some(event => event.type === "final.closed")) sources.final = readClosedFinal(dir).result;
  return sources;
}
/** Pure derivation. Ledger order, fixed source order and evidence chunks keep export fingerprints stable. */
export function deriveLessons(sources: LessonSources): AmemNote[] {
  const { study, events } = sources, notes: AmemNote[] = [], prefix = `${study.id}: ${study.question}\n`;
  const attemptRef = (id: string) => `ares:${study.id}/attempt:${id}`;
  const runRef = (run: string) => `ares:${study.id}/run:${run}`;
  const add = (note: AmemNote) => {
    const refs = [...new Set(note.evidence ?? [])];
    // Split long evidence lists rather than silently dropping cited attempts.
    for (let index = 0; index < Math.max(1, refs.length); index += LESSON_EVIDENCE_REFS) {
      notes.push({ ...note, text: prefix + note.text, evidence: refs.slice(index, index + LESSON_EVIDENCE_REFS) });
    }
  };
  for (const idea of foldIdeas(events)) {
    for (const decision of idea.decisions) if (decision.decision === "pivot") add({ kind: "fail", title: idea.title,
      text: `Pivot ${idea.id}: ${decision.reason}`, approach: `${idea.title}\n${idea.hypothesis}`, symptom: decision.reason,
      cause: decision.cause ?? "not recorded", retryWhen: decision.retryWhen ?? "not recorded", evidence: decision.attempts.map(attemptRef) });
  }
  const investigation = sources.investigation;
  if (investigation) {
    const winner = investigation.winner, candidate = investigation.candidates.find(row => row.commit === winner?.commit);
    add({ kind: "finding", title: `Investigation ${investigation.run}`,
      text: winner ? `Investigation ${investigation.run}: winner ${winner.commit}; paired delta ${winner.delta}; seeds ${JSON.stringify(candidate?.pairedSeeds ?? [])}`
        : `Investigation ${investigation.run}: no winner; reason ${investigation.reason}`,
      evidence: [runRef(investigation.run), ...(winner?.attempts ?? []).map(attemptRef)] });
  }
  const final = sources.final;
  if (final) add({ kind: "finding", title: `Final ${final.status}`,
    text: `Final ${final.status}: winner ${final.winner}; baseline ${final.baseline}; reason ${final.reason ?? "qualified"}; paired delta ${final.delta}; seeds ${JSON.stringify(final.seeds)}`,
    evidence: [runRef("final"), ...final.decisive.map(row => attemptRef(row.id))] });
  if (sources.selection) add({ kind: "decision", title: "Selection rule", text: `Selection rule: ${JSON.stringify(sources.selection)}`, evidence: [runRef(sources.selection.run)] });
  if (sources.finalSeeds) add({ kind: "decision", title: "Final seeds", text: `Final seeds: ${JSON.stringify(sources.finalSeeds.seeds)}`, evidence: [runRef("final")] });
  for (const review of foldReviews(events)) {
    for (const finding of review.report.findings) {
      const resolution = review.resolutions[finding.id];
      if (finding.kind === "contradiction" && resolution) add({ kind: "finding", title: `Review ${review.id}/${finding.id}`,
        text: `Review contradiction ${review.id}/${finding.id}: ${finding.text}; resolution: ${resolution.reason}`, evidence: [] });
    }
  }
  return notes;
}
