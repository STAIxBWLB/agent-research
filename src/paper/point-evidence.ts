import { readCard } from "../lit/cards.ts";
import { ATTEMPT_BYTES, validateAttemptRecord } from "../exp/attempts.ts";
import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { openStudy, readTextBounded } from "../study.ts";

export interface PointEvidenceResolution { resolved: boolean; reason?: string }
class PointEvidenceBound extends Error {}
function physicalDirectory(file: string): boolean {
  try { const stat = lstatSync(file); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe attempt directory"); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
/** Read only the addressed payload; unrelated attempts never enter point planning or checking. */
function existingAttempt(dir: string, wanted: string): boolean {
  const {study} = openStudy(dir), runs = join(dir, "runs");
  if (study.mode !== "experiment" || !physicalDirectory(runs)) return false;
  const directory = opendirSync(runs); let count = 0, found = false;
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++count > 4096) throw new PointEvidenceBound("point evidence: more than 4096 run directories; archive the study before checking point evidence");
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.name)) throw new Error("unsafe run name");
      const run = join(runs, entry.name), attempts = join(run, "attempts");
      if (!physicalDirectory(run) || !physicalDirectory(attempts)) continue;
      const file = join(attempts, `${wanted}.json`);
      let raw: string;
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("unsafe attempt record");
        if (found) return false; // The address has no run component; duplicate matches are ambiguous.
        raw = readTextBounded(file, ATTEMPT_BYTES, {noFollow: true});
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (validateAttemptRecord(JSON.parse(raw), entry.name, wanted).studyId !== study.id) return false;
      found = true;
    }
    return found;
  } finally { directory.closeSync(); }
}
/** Existence and record integrity only, never support, correctness or a successful outcome. */
export function resolvePointEvidence(dir: string, reference: string): PointEvidenceResolution {
  if (typeof reference !== "string" || Buffer.byteLength(reference) > 4096 || reference.includes("\0")) return {resolved: false, reason: "invalid local evidence address; use card:<paper-id> or attempt:<16-hex-id>"};
  try {
    if (reference.startsWith("card:")) {
      const id = reference.slice(5);
      if (!id || !readCard(dir, id)) return {resolved: false, reason: "extraction card is missing; record it with ares lit card before setting the plan"};
      return {resolved: true};
    }
    if (reference.startsWith("attempt:")) {
      const id = reference.slice(8);
      if (!/^[a-f0-9]{16}$/.test(id)) return {resolved: false, reason: "attempt address is invalid; select an id from ares attempt list"};
      if (!existingAttempt(dir, id)) return {resolved: false, reason: "attempt is missing, ambiguous or belongs to another source; select a current-study record from ares attempt list"};
      return {resolved: true};
    }
  } catch (error) {
    if (error instanceof PointEvidenceBound) return {resolved: false, reason: error.message};
    return {resolved: false, reason: "local evidence is missing, malformed or unsupported; restore its last valid card/attempt record and rerun ares paper check"};
  }
  return {resolved: false, reason: "unsupported evidence address; use only current-study card:<paper-id> or attempt:<16-hex-id>"};
}
