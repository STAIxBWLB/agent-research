import {plain} from "../study.ts";
import {readScreenedAmem, supportsScreenedAmem, type ScreenedAmemInspection} from "../memory/amem-show.ts";
import type {ProcessRunner} from "../exp/executor.ts";

export interface ExperienceSourcePin {id: string; digest: string; sourceVersion: string}
export interface ExperienceSourceObservation {
  id: string; state: ScreenedAmemInspection["state"]; digest: string | null; sourceVersion?: string; observedAt: string;
}
export const EXPERIENCE_SOURCE_LIMIT = 16;
function fail(): never {
  throw new Error("experience source pins: malformed, duplicate or over-bound snapshot; restore the original snapshot or freeze an explicitly reviewed new round before retrying");
}
/** Liveness/version recheck only, never proof of temporal eligibility, applicability or claim support. */
export async function recheckExperienceSources(dir: string, entries: readonly ExperienceSourcePin[], options: {runner?: ProcessRunner; env?: NodeJS.ProcessEnv; now?: () => number} = {}): Promise<{state: "available" | "unavailable"; observations: ExperienceSourceObservation[]}> {
  if (!Array.isArray(entries) || entries.length > EXPERIENCE_SOURCE_LIMIT) fail();
  const pins = entries.map(entry => {
    if (!plain(entry) || Object.keys(entry).some(key => !["id", "digest", "sourceVersion"].includes(key)) || typeof entry.id !== "string" || entry.id.length !== 32 || !/^[a-f0-9]{32}$/.test(entry.id) || typeof entry.digest !== "string" || entry.digest.length !== 64 || !/^[a-f0-9]{64}$/.test(entry.digest) || typeof entry.sourceVersion !== "string" || entry.sourceVersion.length > 128 || !supportsScreenedAmem(entry.sourceVersion)) fail();
    return {id: entry.id, digest: entry.digest, sourceVersion: entry.sourceVersion};
  });
  if (new Set(pins.map(pin => pin.id)).size !== pins.length) fail();
  const observations: ExperienceSourceObservation[] = [];
  // Sequential and bounded: <=16 owning reads, each with its existing total 25-second lifetime. No retry or fallback.
  for (const pin of pins) {
    let inspected: ScreenedAmemInspection;
    try {inspected = await readScreenedAmem(dir, pin.id, options);}
    catch {
      let time = Date.now(); try {const value = options.now?.(); if (value !== undefined && Number.isFinite(value) && Math.abs(value) <= 8.64e15) time = value;} catch { /* a failed clock cannot bypass the refusal */ }
      inspected = {state: "unavailable", digest: null, observedAt: new Date(time).toISOString()};
    }
    const state = inspected.state === "available" && (inspected.digest !== pin.digest || inspected.sourceVersion !== pin.sourceVersion) ? "changed" : inspected.state;
    observations.push({id: pin.id, state, digest: inspected.digest, ...(inspected.sourceVersion === undefined ? {} : {sourceVersion: inspected.sourceVersion}), observedAt: inspected.observedAt});
  }
  return {state: observations.every(observation => observation.state === "available") ? "available" : "unavailable", observations};
}
