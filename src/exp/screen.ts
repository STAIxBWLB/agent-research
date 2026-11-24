import { hashExecutorInputBlobs, spawnRunner, type Executor, type ProcessRunner, type ProcessResult } from "./executor.ts";
import { canonical, type ProtocolInput, type ProtocolScreen } from "./protocol.ts";
import { sha256 } from "../study.ts";

export interface ScreenHit { rule: string; path: string; line?: number }
export interface ScreenSummary { rules: string[]; sha256: string }
/** Directory inputs are screened file by file; above this count the screen refuses instead of vouching partially. */
export const SCREEN_FILES = 20_000, SCREEN_OUTPUT_BYTES = 1_048_576, SCREEN_HITS = 16;

function passed(result: ProcessResult): boolean { return result.exitCode === 0 && !result.timedOut && !result.truncated; }
function git(repo: string, args: string[], runner: ProcessRunner): Promise<ProcessResult> {
  return runner({ command: "git", args: ["-C", repo, ...args], timeoutMs: 300_000, maxOutputBytes: SCREEN_OUTPUT_BYTES });
}
function gitFailure(step: string): Error {
  return new Error(`attempt screen: Git ${step} failed; check --repo and that --commit names an existing commit, then retry ares attempt run`);
}
/** Object ids only: the commit's file bytes are never read on this host. */
async function treeBlobs(repo: string, commit: string, runner: ProcessRunner): Promise<Map<string, string[]>> {
  const format = await git(repo, ["rev-parse", "--show-object-format"], runner);
  if (!passed(format)) throw gitFailure("object format");
  // A sha-256 repository issues 64-hex blob ids, so an input's sha-1 blob id could never match.
  if (format.stdout.trim() !== "sha1") throw new Error("attempt screen: evaluator inputs cannot be compared in a repository whose object format is not sha-1; screen the declared literals only, or use a sha-1 candidate repository");
  const listing = await git(repo, ["ls-tree", "-r", "-z", "--full-tree", commit], runner);
  if (listing.truncated) throw new Error(`attempt screen: candidate commit lists more files than the screen reads (${SCREEN_OUTPUT_BYTES} bytes of git ls-tree); screen the declared literals only, or screen a smaller commit`);
  if (!passed(listing)) throw gitFailure("tree listing");
  const blobs = new Map<string, string[]>();
  for (const entry of listing.stdout.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const [, type, oid] = entry.slice(0, tab).split(" ");
    if (type !== "blob" || oid === undefined || !/^[a-f0-9]{40}$/.test(oid)) continue;
    const paths = blobs.get(oid) ?? [];
    paths.push(entry.slice(tab + 1)); blobs.set(oid, paths);
  }
  return blobs;
}
/** Verbatim search only: every hit is a fixed string, so transformed material passes unguarded. */
async function literalPaths(repo: string, commit: string, value: string, runner: ProcessRunner): Promise<string[]> {
  const result = await git(repo, ["grep", "--no-color", "-a", "-F", "-l", "-z", "-e", value, commit, "--"], runner);
  if (result.exitCode === 1 && !result.truncated && !result.timedOut) return [];
  if (!passed(result)) throw gitFailure("literal search");
  const prefix = `${commit}:`;
  return result.stdout.split("\0").filter(Boolean).map(entry => entry.startsWith(prefix) ? entry.slice(prefix.length) : entry).sort();
}
async function literalLine(repo: string, commit: string, path: string, value: string, runner: ProcessRunner): Promise<number | undefined> {
  const result = await git(repo, ["grep", "--no-color", "-a", "-F", "-n", "-z", "-e", value, commit, "--", path], runner);
  if (!passed(result)) return undefined;
  // With -z git terminates both the tree-qualified name and the line number with NUL: name\0line\0text.
  const nul = result.stdout.indexOf("\0");
  if (nul < 0 || result.stdout.slice(0, nul) !== `${commit}:${path}`) return undefined;
  const line = /^(\p{Nd}+)\u0000/u.exec(result.stdout.slice(nul + 1))?.[1];
  return line === undefined ? undefined : Number(line);
}
/** Runs before the executor is asked to execute anything: no attempt record and no budget exist yet. */
export async function screenCandidate(repo: string, commit: string, screen: ProtocolScreen, inputs: Record<string, ProtocolInput>, executor: Executor, runner: ProcessRunner = spawnRunner): Promise<{ hits: ScreenHit[]; summary: ScreenSummary }> {
  const hits: ScreenHit[] = [], rules: string[] = [];
  if (screen.evaluatorInputs) {
    rules.push("evaluatorInputs");
    const tree = await treeBlobs(repo, commit, runner);
    for (const [name, input] of Object.entries(inputs)) {
      // Only an evaluator-only mount is invisible to the candidate at run time, so only that leak matters.
      if (!input.mount.evaluator || input.mount.candidate) continue;
      if (input.path === undefined) throw new Error(`attempt screen: evaluator input ${name} has no executor locator; restore its path in design/protocol.json before attempt run`);
      let blobs: { blobs: string[] };
      try { blobs = await hashExecutorInputBlobs(executor, input.path, SCREEN_FILES, runner); }
      catch (error) { throw new Error(`attempt screen: evaluator input ${name}: ${error instanceof Error ? error.message : "blob list could not be read"}`); }
      for (const blob of blobs.blobs) {
        for (const path of tree.get(blob) ?? []) if (hits.length < SCREEN_HITS) hits.push({ rule: `evaluator-input:${name}`, path });
      }
    }
  }
  if (screen.literals) {
    rules.push("literals");
    for (const [index, value] of screen.literals.entries()) {
      for (const path of await literalPaths(repo, commit, value, runner)) {
        if (hits.length >= SCREEN_HITS) break;
        const line = await literalLine(repo, commit, path, value, runner);
        hits.push({ rule: `literal:${index}`, path, ...(line === undefined ? {} : { line }) });
      }
    }
  }
  return { hits, summary: { rules, sha256: sha256(canonical({ commit, screen })) } };
}
