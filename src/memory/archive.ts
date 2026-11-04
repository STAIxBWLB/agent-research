import { commit, openStudy, plain, sha256, type Actor, type LedgerEvent } from "../study.ts";
import { canonical } from "../plan/state.ts";
import { createAmemClient, type AmemNote } from "./amem.ts";
import { deriveLessons, readLessonSources } from "./lessons.ts";
import type { ProcessRunner } from "../exp/executor.ts";

export const ARCHIVE_NOTES = 200;
export interface ArchiveReceipt { sha256: string; id: string }
export interface ArchivePreview { fingerprint: string; notes: { sha256: string; note: AmemNote }[] }
export interface ArchiveResult extends ArchivePreview { written: ArchiveReceipt[] }
function hex(value: unknown, length: 32 | 64): value is string {
  return typeof value === "string" && value.length === length && /^[a-f0-9]+$/.test(value);
}
function badReceipt(): never { throw new Error("archive receipt: malformed or conflicting exported notes; restore the last valid archive.exported ledger event before retrying ares archive"); }
function exported(events: LedgerEvent[]): Set<string> {
  const known = new Map<string, string>();
  for (const event of events) if (event.type === "archive.exported") {
    if (!hex(event.data.fingerprint, 64) || !Array.isArray(event.data.notes) || event.data.notes.length > ARCHIVE_NOTES) badReceipt();
    for (const row of event.data.notes) {
      if (!plain(row) || !hex(row.sha256, 64) || !hex(row.id, 32)) badReceipt();
      if (known.has(row.sha256) && known.get(row.sha256) !== row.id) badReceipt();
      known.set(row.sha256, row.id);
    }
  }
  return new Set(known.keys());
}
/** No lock, subprocess or write: confirmation binds the full list, receipts only narrow pending writes. */
export function previewArchive(dir: string): ArchivePreview {
  const sources = readLessonSources(dir), notes = deriveLessons(sources), known = exported(sources.events);
  const unique = new Map(notes.map(note => [sha256(canonical(note)), note]));
  const pending = [...unique].filter(([hash]) => !known.has(hash)).map(([sha256, note]) => ({ sha256, note }));
  if (pending.length > ARCHIVE_NOTES) throw new Error("archive: more than 200 new notes; split the study into bounded studies before exporting");
  return { fingerprint: sha256(canonical(notes)), notes: pending };
}
/** Caller holds the study lock across the confirmed write and its single receipt commit. */
export async function exportArchive(dirArg: string, fingerprint: string, actor: Actor, runner?: ProcessRunner, env: NodeJS.ProcessEnv = process.env): Promise<ArchiveResult> {
  const { dir } = openStudy(dirArg), preview = previewArchive(dir);
  if (!hex(fingerprint, 64) || fingerprint !== preview.fingerprint) throw new Error("archive: stale fingerprint; run ares archive <dir> again and confirm its current fingerprint");
  const client = createAmemClient(dir, runner, env), written: ArchiveReceipt[] = [];
  let failure: unknown;
  for (const item of preview.notes) {
    try { written.push({ sha256: item.sha256, id: await client.add(item.note) }); }
    catch (error) { failure = error; break; }
  }
  if (written.length) commit(dir, [], [{ actor, type: "archive.exported", data: { fingerprint, notes: written } }]);
  if (failure) throw failure;
  return { ...preview, written };
}
