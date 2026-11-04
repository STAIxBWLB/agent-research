import { existsSync } from "node:fs";
import { join } from "node:path";
import { commit, onlyKeys, openStudy, plain, readTextBounded, requireExperiment, sha256, type Actor } from "../study.ts";
import type { Protocol } from "./protocol.ts";

export interface FinalSeeds { v: 1; seeds: number[] }
export const FINAL_SEEDS_BYTES = 65_536;
const compatible = "use an ares version that supports this final-seeds file, keeping design/final.json unchanged";
export function finalSeedsPath(dir: string): string { return join(dir, "design", "final.json"); }
export function validateFinalSeeds(raw: unknown, protocol: Protocol): FinalSeeds {
  try {
    if (!plain(raw)) throw new Error("final seeds: JSON object required");
    if (raw.v !== 1) throw new Error(`final seeds.v: unsupported version; ${compatible}`);
    onlyKeys(raw, ["v", "seeds"], "final seeds");
    const max = Math.floor(protocol.seeds.length / 2);
    if (!max) throw new Error("final seeds: protocol needs at least two declared seeds to reserve at most half");
    if (!Array.isArray(raw.seeds) || !raw.seeds.length || raw.seeds.length > max) throw new Error(`final seeds.seeds: nonempty list of at most ${max} seeds required (half the declared protocol seeds)`);
    if (raw.seeds.some(s => !Number.isSafeInteger(s) || !protocol.seeds.includes(s as number))) throw new Error("final seeds.seeds: undeclared seed; use only declared integer protocol seeds");
    if (new Set(raw.seeds).size !== raw.seeds.length) throw new Error("final seeds.seeds: duplicate seed; name each reserved seed once");
    return { v: 1, seeds: [...raw.seeds] as number[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "final seeds: invalid input";
    throw new Error(message.includes(compatible) ? message : `${message}; correct the file or protocol and run ares final seeds <dir> --file PATH again`);
  }
}
function record(dir: string, protocol: Protocol): { value: FinalSeeds; text: string } | undefined {
  const file = finalSeedsPath(dir);
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readTextBounded(file, FINAL_SEEDS_BYTES); }
  catch { throw new Error(`design/final.json: unreadable, non-regular, invalid UTF-8 or larger than ${FINAL_SEEDS_BYTES} bytes; restore a valid regular final-seeds file within this bound`); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("design/final.json: invalid JSON; restore the last valid final-seeds file before continuing"); }
  return { value: validateFinalSeeds(raw, protocol), text };
}
export function readFinalSeeds(dir: string, protocol: Protocol): FinalSeeds | undefined { return record(dir, protocol)?.value; }
export function finalSeedsHash(dir: string, protocol: Protocol): string | undefined {
  const value = record(dir, protocol); return value === undefined ? undefined : sha256(value.text);
}
/** Caller holds the study lock; identical bytes never move the reservation event boundary. */
export function setFinalSeeds(dir: string, raw: unknown, protocol: Protocol, actor: Actor, readUsedSeeds: () => ReadonlySet<number>) {
  requireExperiment(openStudy(dir).study);
  const final = validateFinalSeeds(raw, protocol), previous = record(dir, protocol), text = JSON.stringify(final, null, 2) + "\n", hash = sha256(text), changed = previous?.text !== text;
  if (changed) {
    const used = readUsedSeeds();
    const seen = final.seeds.find(seed => used.has(seed));
    if (seen !== undefined) throw new Error(`final seeds: seed ${seen} was already used by an existing attempt; choose an unused declared seed`);
    commit(dir, [[finalSeedsPath(dir), text, FINAL_SEEDS_BYTES]], [{ actor, type: "final.seeds.set", data: { sha256: hash, seeds: final.seeds } }]);
  }
  return { final, sha256: hash, changed };
}
