import {recheckLessonExports, boundLessonExportBatch} from "../harness/lesson-candidates.ts";
import type {SkillCheckOptions} from "./skill-check.ts";
import { ACCEPT_ARTIFACTS } from "../autonomy.ts";
import { requireCopilotAccept } from "../copilot.ts";
import { commit, prepareCommit, openStudy, plain, sha256, type Actor, type LedgerEvent } from "../study.ts";
import { canonical } from "../plan/state.ts";
import { createAmemClient, type AmemNote } from "./amem.ts";
import { deriveLessons, readLessonSources } from "./lessons.ts";
import type { ProcessRunner } from "../exp/executor.ts";

export const ARCHIVE_NOTES = 200;
export interface ArchiveReceipt { sha256: string; id: string }
export interface ArchivePreview { recovery?: string; fingerprint: string; notes: { sha256: string; note: AmemNote }[] }
export interface ArchiveResult extends ArchivePreview { written: ArchiveReceipt[]; remaining: number }
/** Carries receipt progress for adapters; CLI/MCP retain the existing retry instruction verbatim. */
export class ArchivePartialError extends Error {
  readonly failureMessage: string;
  constructor(readonly exportedCount: number, failure: unknown) {
    const detail = failure instanceof Error ? failure.message : "amem failure; check amem --version before retrying";
    super(`archive: ${exportedCount} note(s) written and receipted; rerun with the same --confirm to continue; ${detail}; receipt-only recovery cannot detect earlier unreceipted writes: reconcile with the owner before retrying an interrupted/crashed archive`);
    this.failureMessage = detail;
  }
}
function hex(value: unknown, length: 32 | 64): value is string {
  return typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
}
function badReceipt(): never { throw new Error("archive receipt: malformed or conflicting exported notes; restore the last valid archive.exported ledger event before retrying ares archive"); }
export function archiveReceiptIndex(events: LedgerEvent[]): Map<string, string> {
  const known = new Map<string, string>();
  for (const event of events) if (event.type === "archive.exported") {
    if (!hex(event.data.fingerprint, 64) || !Array.isArray(event.data.notes) || event.data.notes.length > ARCHIVE_NOTES) badReceipt();
    for (const row of event.data.notes) {
      if (!plain(row) || !hex(row.sha256, 64) || !hex(row.id, 32)) badReceipt();
      if (known.has(row.sha256) && known.get(row.sha256) !== row.id) badReceipt();
      known.set(row.sha256, row.id);
    }
  }
  return known;
}
/** No lock, subprocess or write: confirmation binds the full list, receipts only narrow pending writes. */
export function previewArchive(dir: string): ArchivePreview {
  for (const artifact of ACCEPT_ARTIFACTS) requireCopilotAccept(dir, artifact);
  const sources = readLessonSources(dir), notes = deriveLessons(sources), known = new Set(archiveReceiptIndex(sources.events).keys());
  const unique = new Map(notes.map(note => [sha256(canonical(note)), note]));
  const pending = [...unique].filter(([hash]) => !known.has(hash)).map(([sha256, note]) => ({ sha256, note }));
  return {fingerprint: sha256(canonical(notes)), notes: pending, ...(sources.contrastNotes?.length ? {recovery: "Receipt-only dedupe: if an earlier archive was interrupted after amem add, operator reconciliation is required before retry; unreceipted writes cannot be detected and may duplicate"} : {})};
}
/** Preview and confirmed export use the same note/source bounds and ordered prefix. */
export function archiveExportBatch(dir: string, notes: ArchivePreview["notes"]) {
  const bounded = notes.slice(0, ARCHIVE_NOTES);
  return openStudy(dir).study.mode === "experiment" ? boundLessonExportBatch(dir, bounded) : bounded;
}
/** Caller holds the study lock across the confirmed write and its single receipt commit. */
export async function exportArchive(dirArg: string, fingerprint: string, actor: Actor, runner?: ProcessRunner, env: NodeJS.ProcessEnv = process.env, sourceOptions: SkillCheckOptions = {}): Promise<ArchiveResult> {
  const { dir } = openStudy(dirArg), preview = previewArchive(dir);
  if (!hex(fingerprint, 64) || fingerprint !== preview.fingerprint) throw new Error("archive: stale fingerprint; run ares archive <dir> again and confirm its current fingerprint");
  const batch = archiveExportBatch(dir, preview.notes);
  if (openStudy(dirArg).study.mode === "experiment") await recheckLessonExports(dirArg, batch.map(note => note.sha256), sourceOptions);
  if (previewArchive(dirArg).fingerprint !== preview.fingerprint) throw new Error("archive: lesson sources changed during preflight; open a fresh preview and reconcile any unreceipted prior write before retrying");
  if (batch.length) {
    try { prepareCommit(dir, [], [{ actor, type: "archive.exported", data: {
      fingerprint, notes: batch.map(note => ({ sha256: note.sha256, id: "f".repeat(32) })),
    } }]); }
    catch { throw new Error("archive receipt: capacity check failed; restore a valid bounded ledger or start a new study before exporting"); }
  }
  const client = createAmemClient(dir, runner, env), written: ArchiveReceipt[] = [];
  let failure: unknown;
  for (const item of batch) {
    try { written.push({ sha256: item.sha256, id: await client.add(item.note) }); }
    catch (error) { failure = error; break; }
  }
  if (written.length) commit(dir, [], [{ actor, type: "archive.exported", data: { fingerprint, notes: written } }]);
  if (failure) throw new ArchivePartialError(written.length, failure);
  return { ...preview, written, remaining: preview.notes.length - written.length };
}
