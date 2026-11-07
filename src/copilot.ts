import { lstatSync, opendirSync } from "node:fs";
import { join } from "node:path";
import { ACCEPT_ARTIFACTS, resolveAutonomy, type AcceptArtifact } from "./autonomy.ts";
import { canonical } from "./plan/state.ts";
import { gateState, openStudy, readBytesBounded, readLedger, readTextBounded, sha256 } from "./study.ts";

export const COPILOT_HYPOTHESES_BYTES = 2 * 1024 * 1024;
export const COPILOT_PAPER_BYTES = 64 * 1024 * 1024;
export const COPILOT_PAPER_FILES = 500, COPILOT_PAPER_DIRECTORIES = 1000, COPILOT_PAPER_DEPTH = 64;
export class CopilotAcceptError extends Error {}
class DraftReadError extends CopilotAcceptError {}
function refuse(artifact: AcceptArtifact, reason: string): never {
  throw new DraftReadError(`copilot draft ${artifact}: ${reason}; restore the last valid bounded regular draft files and ledger, then run ares gate list and ares gate approve <dir> accept:${artifact} before retrying`);
}
function draftLedger(dir: string, artifact: AcceptArtifact) {
  try { return readLedger(dir); }
  catch (error) {
    if (error instanceof Error && /^ledger\.jsonl line [0-9]+: unsupported schema version/.test(error.message)) throw new DraftReadError(`copilot draft ${artifact}: unsupported ledger version; keep its bytes unchanged and use a compatible ares version before ares gate approve <dir> accept:${artifact}`);
    refuse(artifact, "acceptance ledger is unreadable, malformed or over-bound");
  }
}
function metadata(file: string) {
  try { return lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function paperTree(dir: string): [string, string][] {
  const root = join(dir, "paper"), entries: [string, string][] = [];
  const rootStat = metadata(root);
  if (rootStat === undefined) return entries;
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) refuse("paper", "paper source root must be a directory without symbolic links");
  const derived = metadata(join(root, "build"));
  let bytes = 0, directories = 0;
  function walk(relative: string, depth: number): void {
    // paper/build is derived output; manuscript sources include all other notes and assets.
    if (relative === "build") return;
    const file = relative ? join(root, relative) : root, stat = lstatSync(file);
    // Respect the filesystem's case aliases without excluding a distinct source directory on case-sensitive hosts.
    if (depth === 1 && relative.toLowerCase() === "build" && derived && derived.dev === stat.dev && derived.ino === stat.ino) return;
    if (stat.isSymbolicLink()) refuse("paper", "symbolic links refused");
    if (stat.isDirectory()) {
      if (depth > COPILOT_PAPER_DEPTH || ++directories > COPILOT_PAPER_DIRECTORIES) refuse("paper", `source tree exceeds ${COPILOT_PAPER_DIRECTORIES} directories or ${COPILOT_PAPER_DEPTH} levels`);
      const directory = opendirSync(file);
      try { for (let entry = directory.readSync(); entry; entry = directory.readSync()) walk(relative ? `${relative}/${entry.name}` : entry.name, depth + 1); }
      finally { directory.closeSync(); }
    } else {
      if (!relative || !stat.isFile()) refuse("paper", "regular files within the paper directory required");
      if (entries.length >= COPILOT_PAPER_FILES) refuse("paper", `file count exceeds ${COPILOT_PAPER_FILES}`);
      if (stat.size > COPILOT_PAPER_BYTES - bytes) refuse("paper", `aggregate bytes exceed ${COPILOT_PAPER_BYTES}`);
      const content = readBytesBounded(file, COPILOT_PAPER_BYTES - bytes, { noFollow: true });
      bytes += content.byteLength; entries.push([relative, sha256(content)]);
    }
  }
  walk("", 0);
  return entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

/** Only active, present drafts have accept bindings. Irrelevant and acceptance events are excluded. */
export function copilotBinding(dirArg: string, artifact: AcceptArtifact): string | undefined {
  if (!ACCEPT_ARTIFACTS.includes(artifact)) throw new Error("copilot draft: unknown artifact; select hypotheses, paper or reviews and retry ares gate list");
  const { dir, study } = openStudy(dirArg);
  if (resolveAutonomy(study.autonomy, `accept:${artifact}`) !== "copilot") return undefined;
  try {
    if (artifact === "paper") {
      const files = paperTree(dir);
      return files.length ? sha256(canonical(files)) : undefined;
    }
    const events = draftLedger(dir, artifact).filter(event => artifact === "hypotheses" ? event.type === "idea.added" || event.type === "idea.decided" : event.type === "review.added" || event.type === "review.resolved");
    if (artifact === "reviews") return events.length ? sha256(canonical(events)) : undefined;
    const file = join(dir, "hypotheses.md"), stat = metadata(file);
    let hypotheses: string | undefined;
    if (stat !== undefined) {
      if (stat.isSymbolicLink() || !stat.isFile()) refuse(artifact, "regular hypotheses file required; symbolic links refused");
      if (stat.size > COPILOT_HYPOTHESES_BYTES) refuse(artifact, `hypotheses source exceeds ${COPILOT_HYPOTHESES_BYTES} bytes`);
      hypotheses = readTextBounded(file, COPILOT_HYPOTHESES_BYTES, { noFollow: true });
    }
    return hypotheses !== undefined || events.length ? sha256(canonical([hypotheses === undefined ? null : sha256(hypotheses), events])) : undefined;
  } catch (error) {
    if (error instanceof DraftReadError) throw error;
    refuse(artifact, "artifact or ledger is unreadable, non-regular, invalid UTF-8 or over-bound");
  }
}

/** Acceptance records the existing gate actor; neither agents nor people receive an implicit approval. */
export function requireCopilotAccept(dir: string, artifact: AcceptArtifact): void {
  const binding = copilotBinding(dir, artifact);
  if (binding === undefined) return;
  const events = draftLedger(dir, artifact);
  const gate = `accept:${artifact}` as const, state = gateState(gate, events, () => binding);
  if (state.state === "approved") return;
  throw new CopilotAcceptError(`copilot draft ${artifact}: ${state.state} acceptance; run ares gate approve <dir> ${gate} for the current draft before retrying`);
}
