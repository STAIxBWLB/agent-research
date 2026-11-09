import { readCard } from "../lit/cards.ts";
import { showAttempt } from "../exp/attempts.ts";
import { openStudy } from "../study.ts";

export interface PointEvidenceResolution { resolved: boolean; reason?: string }
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
      const attempt = showAttempt(dir, id);
      if (attempt.studyId !== openStudy(dir).study.id || attempt.id !== id) return {resolved: false, reason: "attempt belongs to another source; select a current-study record from ares attempt list"};
      return {resolved: true};
    }
  } catch {
    return {resolved: false, reason: "local evidence is missing, malformed or unsupported; restore its last valid card/attempt record and rerun ares paper check"};
  }
  return {resolved: false, reason: "unsupported evidence address; use only current-study card:<paper-id> or attempt:<16-hex-id>"};
}
