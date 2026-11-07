import { defaultReleaseRunner, waitForCi, releaseFailure, ReleaseError, type ReleaseRunner } from "./release-ci.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { plain, readBytesBounded, readTextBounded, writeAtomic } from "../src/study.ts";

export const METADATA_BYTES = 65_536, CHANGELOG_BYTES = 1024 * 1024, ARCHIVE_BYTES = 16 * 1024 * 1024, OUTPUT_BYTES = 4 * 1024 * 1024;
export interface ReleaseManifest { name: string; version: string; tag: string; commit: string; sha256: string; distTag: "latest" | "next" }
export interface ReleaseIdentity { name: string; version: string; tag: string; commit: string }
const required = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "bin/ares.js", "src/cli.ts", "src/ui/plugin.ts", "src/ui/panel.js", "src/ui/panel.css"];
function fail(message: string): never { throw new ReleaseError(`release: ${message}; correct the candidate and stage a new artifact before publishing`); }
function json(file: string, bound = METADATA_BYTES): unknown {
  try { return JSON.parse(readTextBounded(file, bound, { noFollow: true })); } catch { fail(`${file} is unreadable, oversized or invalid JSON`); }
}
function command(program: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync(program, args, { cwd, env, encoding: "utf8", maxBuffer: OUTPUT_BYTES, timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
}
export function distTagFor(version: string): "latest" | "next" {
  if (version.length > 128 || !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) fail("package version must be a path-safe semantic version");
  return version.split("+")[0]!.includes("-") ? "next" : "latest";
}
export function releaseSection(text: string, version: string): string {
  const prefix = `## [${version}] - `, lines = text.replaceAll("\r\n", "\n").split("\n"), matches = lines.map((line, index) => line.startsWith(prefix) ? index : -1).filter(index => index >= 0);
  if (matches.length !== 1) fail("CHANGELOG needs exactly one dated section for this version; Unreleased is insufficient");
  const start = matches[0]!, date = lines[start]!.slice(prefix.length);
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail("CHANGELOG release date must be a valid YYYY-MM-DD");
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end < 0) end = lines.length;
  const section = lines.slice(start + 1, end).join("\n").trim(); if (!section) fail("dated CHANGELOG section must contain release notes"); return section;
}
export function identity(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): ReleaseIdentity {
  const pkg = json(join(root, "package.json"));
  if (!plain(pkg) || pkg.name !== "@staix/agent-research" || typeof pkg.version !== "string") fail("unexpected package identity");
  distTagFor(pkg.version);
  const head = command("git", ["rev-parse", "HEAD"], root).trim(), tag = env.RELEASE_TAG ?? `v${pkg.version}`, commit = env.RELEASE_SHA ?? head;
  if (tag !== `v${pkg.version}`) fail("tag must equal v + package.json version");
  if (!/^[a-f0-9]{40}$/.test(commit) || commit !== head) fail("checkout must match the triggering commit");
  return { name: pkg.name, version: pkg.version, tag, commit };
}
export function validateRelease(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): ReleaseIdentity {
  if (!env.RELEASE_TAG || !env.RELEASE_SHA) fail("RELEASE_TAG and RELEASE_SHA are required for tag validation");
  const result = identity(root, env);
  let changelog: string;
  try { changelog = readTextBounded(join(root, "CHANGELOG.md"), CHANGELOG_BYTES); }
  catch (error) { throw releaseFailure("release CHANGELOG read", error, "check the release job inputs for a readable bounded CHANGELOG.md, then rerun", "local file problem"); }
  releaseSection(changelog, result.version); return result;
}
export async function gateRelease(root = process.cwd(), env: NodeJS.ProcessEnv = process.env, runner: ReleaseRunner = defaultReleaseRunner(root)): Promise<void> {
  try {
    const candidate = validateRelease(root, env);
    try { await runner("git", ["merge-base", "--is-ancestor", candidate.commit, "origin/main"]); }
    catch (error) { throw releaseFailure("release gate main ancestry check (tag commit must be on origin/main)", error, "check git access and merge the candidate onto main, then rerun"); }
    await waitForCi(candidate.commit, { runner });
  } catch (error) { throw releaseFailure("release gate", error, "check the release job inputs and GH_TOKEN actions:read permission, then rerun"); }
}
export function assertPackageFiles(files: string[], expected?: string[]): void {
  if (!files.length || files.length > 4096 || new Set(files).size !== files.length) fail("archive file list is empty, duplicated or exceeds 4096 entries");
  for (const file of files) {
    if (!/^[A-Za-z0-9._/-]+$/.test(file) || file.startsWith("/") || file.split("/").some(part => !part || part === "." || part === "..")) fail("unsafe archive member path");
    if (!file.startsWith("src/") && !file.startsWith("bin/") && !["package.json", "README.md", "CHANGELOG.md", "LICENSE"].includes(file)) fail(`unexpected packed path ${file}`);
  }
  for (const file of required) if (!files.includes(file)) fail(`package is missing ${file}`);
  if (expected && JSON.stringify([...files].sort()) !== JSON.stringify([...expected].sort())) fail("packed files differ from the reviewed tracked src/bin/doc file list");
}
function trackedFiles(root: string): string[] {
  return command("git", ["ls-files", "--", "src", "bin", "package.json", "README.md", "CHANGELOG.md", "LICENSE"], root).trim().split("\n").filter(Boolean);
}
function archiveFiles(archive: string, root: string): string[] {
  const names = command("tar", ["-tzf", archive], root).trim().split("\n").filter(Boolean);
  const modes = command("tar", ["-tvzf", archive], root).trim().split("\n").filter(Boolean);
  if (modes.length !== names.length || modes.some(line => !["-", "d"].includes(line[0] ?? ""))) fail("archive must contain only regular files and directories, never links");
  const files: string[] = [];
  for (const member of names) {
    if (!member.startsWith("package/")) fail("archive member is outside package/");
    const file = member.slice("package/".length);
    if (member.endsWith("/")) {
      if (file && (!/^[A-Za-z0-9._/-]+$/.test(file) || file.split("/").some(part => part === "." || part === "..") || !["src/", "bin/"].some(prefix => file.startsWith(prefix)))) fail("unexpected archive directory");
    } else files.push(file);
  }
  assertPackageFiles(files, trackedFiles(root)); return files;
}
export function isolatedEnv(work: string): NodeJS.ProcessEnv {
  const home = join(work, "home"), cache = join(work, "cache"); mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(cache, { recursive: true, mode: 0o700 });
  const userConfig = join(work, "npmrc"), globalConfig = join(work, "global-npmrc");
  writeAtomic(userConfig, "", METADATA_BYTES, 0o600); writeAtomic(globalConfig, "", METADATA_BYTES, 0o600);
  return { PATH: process.env.PATH ?? "", HOME: home, AGENTHUB_HOME: join(home, ".agenthub"), XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: cache, TMPDIR: work,
    NPM_CONFIG_CACHE: join(cache, "npm"), NPM_CONFIG_USERCONFIG: userConfig, NPM_CONFIG_GLOBALCONFIG: globalConfig, NPM_CONFIG_OFFLINE: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false", NPM_CONFIG_UPDATE_NOTIFIER: "false", LANG: "C.UTF-8" };
}
export function assertManifest(raw: unknown, expected: ReleaseIdentity, hash: string, packed: unknown): ReleaseManifest {
  if (!plain(raw) || Object.keys(raw).some(key => !["name", "version", "tag", "commit", "sha256", "distTag"].includes(key)) || raw.name !== expected.name || raw.version !== expected.version || raw.tag !== expected.tag || raw.commit !== expected.commit || raw.sha256 !== hash || raw.distTag !== distTagFor(expected.version)
    || !plain(packed) || packed.name !== expected.name || packed.version !== expected.version) fail("artifact identity, tag, commit, SHA-256 or dist-tag differs from the validated candidate");
  return raw as unknown as ReleaseManifest;
}
export function verifyStaged(dir: string, root = process.cwd(), env: NodeJS.ProcessEnv = process.env): ReleaseManifest {
  const archive = join(resolve(dir), "package.tgz"), bytes = readBytesBounded(archive, ARCHIVE_BYTES, { noFollow: true }), hash = createHash("sha256").update(bytes).digest("hex"), raw = json(join(dir, "manifest.json"));
  const expected = identity(root, env);
  // Check the digest before asking tar to inspect any artifact data.
  if (!plain(raw) || raw.sha256 !== hash) fail("staged tarball SHA-256 does not match its manifest");
  archiveFiles(archive, root);
  let packed: unknown; try { packed = JSON.parse(command("tar", ["-xzOf", archive, "package/package.json"], root)); } catch { fail("packed package.json cannot be read"); }
  return assertManifest(raw, expected, hash, packed);
}
export function stageRelease(dir: string, root = process.cwd()): ReleaseManifest {
  const expected = identity(root), target = resolve(dir);
  const fromRoot = relative(resolve(root), target);
  if (!isAbsolute(dir) || !isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`)) fail("stage directory must be absolute and outside the checkout");
  if (command("git", ["status", "--porcelain=v1", "--untracked-files=all"], root).trim()) fail("commit the complete candidate before staging");
  if (existsSync(target)) fail("stage directory already exists; choose a fresh directory");
  mkdirSync(target, { mode: 0o700 }); const work = mkdtempSync(join(tmpdir(), "ares-release-pack-"));
  try {
    const packed: unknown = JSON.parse(command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", target], root, isolatedEnv(work)));
    if (!Array.isArray(packed) || packed.length !== 1 || !plain(packed[0]) || packed[0].name !== expected.name || packed[0].version !== expected.version || typeof packed[0].filename !== "string" || !/^[A-Za-z0-9._-]+\.tgz$/.test(packed[0].filename)) fail("npm pack must stage exactly one matching package");
    renameSync(join(target, packed[0].filename), join(target, "package.tgz"));
    const bytes = readBytesBounded(join(target, "package.tgz"), ARCHIVE_BYTES, { noFollow: true });
    const manifest: ReleaseManifest = { ...expected, sha256: createHash("sha256").update(bytes).digest("hex"), distTag: distTagFor(expected.version) };
    writeAtomic(join(target, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", METADATA_BYTES, 0o600);
    return verifyStaged(target, root);
  } finally { rmSync(work, { recursive: true, force: true }); }
}
export function assertToolchain(node: string, npm: string): void {
  const parse = (value: string) => /^v?([0-9]+)\.([0-9]+)\.([0-9]+)$/.exec(value.trim())?.slice(1).map(Number);
  const n = parse(node), p = parse(npm);
  if (!n || !p || n[0]! < 24 || p[0]! < 11 || p[0] === 11 && (p[1]! < 5 || p[1] === 5 && p[2]! < 1)) fail("publishing requires Node >=24 and npm >=11.5.1");
}
export function releaseNotes(dir: string, output: string, root = process.cwd(), env: NodeJS.ProcessEnv = process.env): { assets: string; prerelease: boolean } {
  const manifest = verifyStaged(dir, root, env), section = releaseSection(readTextBounded(join(root, "CHANGELOG.md"), CHANGELOG_BYTES), manifest.version);
  const base = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}`, assets = join(resolve(dir), base);
  const notes = `${section}\n\n## Install\n\n\`\`\`sh\nbun add -g ${manifest.name}@${manifest.version}\n\`\`\`\n\nPublished with npm OIDC trusted publishing and provenance. The validated tarball and its tag/commit/SHA-256 manifest are attached. SHA-256: \`${manifest.sha256}\`.\n`;
  writeAtomic(output, notes, CHANGELOG_BYTES, 0o600);
  renameSync(join(dir, "package.tgz"), `${assets}.tgz`); renameSync(join(dir, "manifest.json"), `${assets}.manifest.json`);
  return { assets, prerelease: manifest.distTag === "next" };
}
async function main(args: string[]) {
  const [operation, directory, extra] = args;
  if (operation === "gate" && args.length === 1) {
    await gateRelease(); console.log("release CI gate: ok");
  }
  else if (operation === "validate" && args.length === 1) { validateRelease(); console.log("release tag validation: ok"); }
  else if (operation === "stage" && directory && args.length === 2) { const result = stageRelease(directory); console.log(`release stage: ${result.name}@${result.version} ${result.sha256}`); }
  else if (operation === "verify" && directory && (args.length === 2 || args.length === 3 && extra === "--publish")) {
    const result = verifyStaged(directory);
    if (extra === "--publish") { assertToolchain(command("node", ["--version"], process.cwd()), command("npm", ["--version"], process.cwd())); console.log(`NPM_DIST_TAG=${result.distTag}`); }
    else console.log(`release artifact verification: ${result.sha256}`);
  } else if (operation === "notes" && directory && extra && args.length === 3) {
    const result = releaseNotes(directory, extra); console.log(`RELEASE_ASSETS=${result.assets}\nRELEASE_PRERELEASE=${result.prerelease}`);
  } else fail("usage: release.ts gate | validate | stage DIR | verify DIR [--publish] | notes DIR FILE");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (cause) { console.error(releaseFailure("release operation", cause, "check the release job inputs, git access and GH_TOKEN permissions, then rerun").message); process.exitCode = 1; }
}
