import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertWritable, plain, readTextBounded, writeAtomic } from "../src/study.ts";
import { CHANGELOG_BYTES, METADATA_BYTES, distTagFor, releaseSection } from "./release.ts";
import { defaultReleaseRunner, requireCi, releaseFailure, ReleaseError, type ReleaseRunner } from "./release-ci.ts";

interface Options { root?: string; runner?: ReleaseRunner }
export interface PrepareOptions extends Options { date?: string }
export interface TagOptions extends Options { repo?: string }
function fail(message: string): never { throw new ReleaseError(`release tag: ${message}; inspect the release branch, main CI and tag refs before retrying`); }
function readMetadata(file: string, bound: number): string {
  try { return readTextBounded(file, bound, { noFollow: true }); }
  catch (error) { throw releaseFailure("release metadata read", error, "check package.json/CHANGELOG.md for missing, oversized or linked files, then rerun", "local file problem"); }
}
function metadata(root: string): { source: string; pkg: Record<string, unknown>; version: string } {
  const source = readMetadata(join(root, "package.json"), METADATA_BYTES);
  let pkg: unknown; try { pkg = JSON.parse(source); } catch { fail("package.json must be valid JSON"); }
  if (!plain(pkg) || pkg.name !== "@staix/agent-research" || typeof pkg.version !== "string") fail("package identity is not @staix/agent-research with a version");
  distTagFor(pkg.version); return { source, pkg, version: pkg.version };
}
async function cleanBranch(runner: ReleaseRunner): Promise<string> {
  const branch = (await runner("git", ["branch", "--show-current"])).trim();
  if (!branch) fail("detached HEAD is not a release branch; check out the intended branch");
  if ((await runner("git", ["status", "--porcelain=v1", "--untracked-files=all"])).trim()) fail("working tree is dirty; commit or preserve unrelated work first");
  return branch;
}
function validVersion(version: string): void {
  distTagFor(version);
  const [core, build] = version.split("+"), [numbers, prerelease] = core!.split(/-(.*)/s);
  if ([prerelease, build].some(value => value !== undefined && value.split(".").some(part => !part))) fail("version identifiers cannot be empty");
  if (!numbers!.split(".").every(part => part === "0" || !part.startsWith("0")) || prerelease?.split(".").some(part => /^0[0-9]+$/.test(part))) fail("version must be semantic without leading-zero numeric identifiers");
}
/** Only edits the two release metadata files; the resulting candidate still lands through a PR. */
async function prepare(version: string, options: PrepareOptions = {}): Promise<{ version: string; tag: string; date: string }> {
  validVersion(version);
  const root = resolve(options.root ?? process.cwd()), runner = options.runner ?? defaultReleaseRunner(root), branch = await cleanBranch(runner);
  if (branch === "main") fail("prepare must run on a release branch, not main");
  const { source, pkg, version: previous } = metadata(root), file = join(root, "CHANGELOG.md"), changelog = readMetadata(file, CHANGELOG_BYTES);
  if (version === previous) fail("target version must differ from package.json");
  if (changelog.split(/\r?\n/).some(line => line.startsWith(`## [${version}]`))) fail("CHANGELOG already contains this version");
  const headings = [...changelog.matchAll(/^## Unreleased[ \t]*\r?$/gm)];
  if (headings.length !== 1) fail("CHANGELOG needs exactly one Unreleased heading");
  const heading = headings[0]!, start = heading.index!, lineEnd = changelog.indexOf("\n", start), after = lineEnd < 0 ? changelog.length : lineEnd + 1;
  const rest = changelog.slice(after), next = /^## /m.exec(rest), notes = rest.slice(0, next?.index ?? rest.length);
  if (!notes.trim()) fail("Unreleased has no notes; record the reviewed changes before preparing");
  const date = options.date ?? new Date().toISOString().slice(0, 10), newline = changelog.includes("\r\n") ? "\r\n" : "\n";
  const dated = changelog.slice(0, start) + `## Unreleased${newline}${newline}## [${version}] - ${date}${newline}` + rest;
  releaseSection(dated, version);
  const indent = /\n(\t| +)"/.exec(source)?.[1] ?? "  ", packageText = JSON.stringify({ ...pkg, version }, null, indent) + "\n";
  assertWritable(packageText, METADATA_BYTES, "package.json"); assertWritable(dated, CHANGELOG_BYTES, "CHANGELOG.md");
  if (await cleanBranch(runner) !== branch) fail("branch changed while preparing");
  if (readMetadata(join(root, "package.json"), METADATA_BYTES) !== source || readMetadata(file, CHANGELOG_BYTES) !== changelog) fail("metadata changed while preparing");
  writeAtomic(join(root, "package.json"), packageText, METADATA_BYTES);
  try { writeAtomic(file, dated, CHANGELOG_BYTES); }
  catch {
    if (readMetadata(join(root, "package.json"), METADATA_BYTES) === packageText) writeAtomic(join(root, "package.json"), source, METADATA_BYTES);
    fail("could not write CHANGELOG.md; check metadata permissions and review both files");
  }
  return { version, tag: `v${version}`, date };
}
async function mainHead(runner: ReleaseRunner): Promise<string> {
  if (await cleanBranch(runner) !== "main") fail("tagging requires checked-out main");
  await runner("git", ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"]);
  const head = (await runner("git", ["rev-parse", "HEAD"])).trim(), remote = (await runner("git", ["rev-parse", "refs/remotes/origin/main"])).trim();
  if (!/^[a-f0-9]{40}$/.test(head) || head !== remote) fail("main must equal freshly fetched origin/main");
  return head;
}
/** Explicit operator action only: no tag is created until exact-HEAD CI and fresh Git checks pass. */
async function tag(options: TagOptions = {}): Promise<{ version: string; tag: string; commit: string }> {
  const root = resolve(options.root ?? process.cwd()), runner = options.runner ?? defaultReleaseRunner(root), commit = await mainHead(runner), { version } = metadata(root), tag = `v${version}`;
  validVersion(version); releaseSection(readMetadata(join(root, "CHANGELOG.md"), CHANGELOG_BYTES), version);
  await requireCi(commit, { runner, ...(options.repo ? { repo: options.repo } : {}) });
  if (await mainHead(runner) !== commit) fail("HEAD moved while checking CI; inspect CI for the new commit");
  if ((await runner("git", ["tag", "--list", tag])).trim()) fail("tag already exists locally; never move an existing release tag");
  if ((await runner("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`])).trim()) fail("tag already exists on origin; never move an existing release tag");
  await runner("git", ["tag", "--annotate", tag, commit, "--message", `Release ${tag}`]);
  try { await runner("git", ["push", "--no-follow-tags", "origin", `refs/tags/${tag}:refs/tags/${tag}`]); }
  catch { fail("annotated tag exists locally but push did not complete; inspect origin and the local tag before retrying without force"); }
  return { version, tag, commit };
}
export async function prepareRelease(version: string, options: PrepareOptions = {}): Promise<{ version: string; tag: string; date: string }> {
  try { return await prepare(version, options); }
  catch (error) { throw releaseFailure("release prepare", error, "check package.json/CHANGELOG.md and git access on the clean release branch, then rerun"); }
}
export async function tagRelease(options: TagOptions = {}): Promise<{ version: string; tag: string; commit: string }> {
  try { return await tag(options); }
  catch (error) { throw releaseFailure("release tag", error, "check release metadata, git access and GH_TOKEN actions:read permission, then rerun"); }
}
async function main(args: string[]): Promise<void> {
  if (args[0] === "prepare" && args[1] && args.length === 2) { const result = await prepareRelease(args[1]); console.log(`release prepared: ${result.tag} (${result.date}); review and commit the release PR`); }
  else if (args[0] === "tag" && args.length === 1) { const result = await tagRelease(); console.log(`release tag pushed: ${result.tag} at ${result.commit}`); }
  else fail("usage: release-tag.ts prepare VERSION | tag");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (error) { console.error(releaseFailure("release tag", error, "check release metadata, git access and GH_TOKEN actions:read permission, then rerun").message); process.exitCode = 1; }
}
