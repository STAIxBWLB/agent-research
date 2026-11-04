import { existsSync } from "node:fs";
import { join } from "node:path";
import { boundedText, commit, onlyKeys, openStudy, plain, readTextBounded, requireExperiment, sha256, type Actor } from "../study.ts";
import type { Protocol } from "./protocol.ts";

export interface Selection { v: 1; run: string; metric: string; baseline: { commit: string }; minSeeds: number; minDelta: number }
export const SELECTION_BYTES = 65_536;
const compatible = "use an ares version that supports this selection, keeping design/selection.json unchanged";
export function selectionPath(dir: string): string { return join(dir, "design", "selection.json"); }
export function validateSelection(raw: unknown, protocol: Protocol): Selection {
  try {
    if (!plain(raw)) throw new Error("selection: JSON object required");
    if (raw.v !== 1) throw new Error(`selection.v: unsupported version; ${compatible}`);
    onlyKeys(raw, ["v", "run", "metric", "baseline", "minSeeds", "minDelta"], "selection");
    if (typeof raw.run !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(raw.run)) throw new Error("selection.run: use 1..64 letters, digits, underscores or hyphens, starting with a letter or digit");
    if (["ablate", "final", "posthoc"].includes(raw.run)) throw new Error(`selection.run: ${raw.run} is a reserved phase run; choose another run such as investigate`);
    const metric = boundedText(raw.metric, "selection.metric", 128);
    if (!protocol.metrics.some(m => m.name === metric)) throw new Error("selection.metric: undeclared; choose a metric from design/protocol.json");
    if (!plain(raw.baseline)) throw new Error("selection.baseline: object with commit required");
    onlyKeys(raw.baseline, ["commit"], "selection.baseline");
    if (typeof raw.baseline.commit !== "string" || !/^[a-fA-F0-9]{40}$/.test(raw.baseline.commit)) throw new Error("selection.baseline.commit: full 40-hex commit required");
    if (!Number.isSafeInteger(raw.minSeeds) || (raw.minSeeds as number) < 1 || (raw.minSeeds as number) > protocol.seeds.length) throw new Error(`selection.minSeeds: integer in 1..${protocol.seeds.length} required (declared protocol seed count)`);
    if (typeof raw.minDelta !== "number" || !Number.isFinite(raw.minDelta) || raw.minDelta < 0) throw new Error("selection.minDelta: finite number >= 0 required in the metric's unit");
    return { v: 1, run: raw.run, metric, baseline: { commit: raw.baseline.commit.toLowerCase() }, minSeeds: raw.minSeeds as number, minDelta: raw.minDelta };
  } catch (error) {
    const message = error instanceof Error ? error.message : "selection: invalid rule";
    throw new Error(message.includes(compatible) ? message : `${message}; correct the rule and run ares selection <dir> --file PATH again`);
  }
}
function record(dir: string, protocol: Protocol): { selection: Selection; text: string } | undefined {
  const file = selectionPath(dir);
  if (!existsSync(file)) return undefined;
  let text: string;
  try { text = readTextBounded(file, SELECTION_BYTES); }
  catch { throw new Error(`design/selection.json: unreadable, non-regular, invalid UTF-8 or larger than ${SELECTION_BYTES} bytes; restore a readable regular UTF-8 rule within that limit before ares selection`); }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("design/selection.json: invalid JSON; restore its last valid rule before running ares selection"); }
  return { selection: validateSelection(raw, protocol), text };
}
export function readSelection(dir: string, protocol: Protocol): Selection | undefined { return record(dir, protocol)?.selection; }
/** The design seal binds original file bytes, including formatting, just like the protocol. */
export function selectionHash(dir: string, protocol: Protocol): string | undefined {
  const value = record(dir, protocol);
  return value === undefined ? undefined : sha256(value.text);
}
/** Caller holds the study lock. Identical bytes do not move the investigation cutoff. */
export function setSelection(dir: string, raw: unknown, protocol: Protocol, actor: Actor) {
  requireExperiment(openStudy(dir).study);
  const selection = validateSelection(raw, protocol), previous = record(dir, protocol);
  const text = JSON.stringify(selection, null, 2) + "\n", hash = sha256(text), changed = previous?.text !== text;
  if (changed) commit(dir, [[selectionPath(dir), text, SELECTION_BYTES]], [{ actor, type: "selection.set", data: { sha256: hash, run: selection.run, metric: selection.metric } }]);
  return { selection, sha256: hash, changed };
}
