import { isAbsolute } from "node:path";
import { readBytesBounded, readTextBounded } from "../src/study.ts";
import { ARCHIVE_BYTES, CHANGELOG_BYTES, METADATA_BYTES, distTagFor } from "./release.ts";
import { defaultReleaseRunner, type ReleaseRunner } from "./release-ci.ts";

export interface GitHubReleaseOptions {
  tag: string;
  repo: string;
  /** Absolute prefix emitted as RELEASE_ASSETS by release.ts notes. */
  assets: string;
  notesFile: string;
  prerelease: boolean;
}
export type ReleaseSleep = (milliseconds: number) => Promise<void>;
const sleep: ReleaseSleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function fail(message: string): never { throw new Error(`GitHub release: ${message}; inspect the release job inputs and rerun it`); }
function httpStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; statusCode?: unknown; message?: unknown; stderr?: unknown };
  for (const status of [value.status, value.statusCode]) if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  for (const text of [value.message, value.stderr]) {
    const match = /\bHTTP\s+(\d{3})\b/i.exec(typeof text === "string" ? text : Buffer.isBuffer(text) ? text.toString("utf8") : "");
    if (match) return Number(match[1]);
  }
  return undefined;
}
/** Only HTTP throttling and server failures retry; authentication and local failures fail immediately. */
async function request(runner: ReleaseRunner, args: string[], pause: ReleaseSleep): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try { return await runner("gh", args); }
    catch (error) {
      const status = httpStatus(error);
      if (attempt >= 3 || status !== 429 && !(status !== undefined && status >= 500 && status <= 599)) throw error;
      await pause(1000 * 2 ** (attempt - 1));
    }
  }
}

/** Create or edit one existing-tag release, then replace only the two verified workflow assets. */
export async function publishGitHubRelease(options: GitHubReleaseOptions, runner: ReleaseRunner = defaultReleaseRunner(process.cwd()), pause: ReleaseSleep = sleep): Promise<void> {
  const { tag, repo, assets, notesFile, prerelease } = options;
  if (typeof tag !== "string" || !tag.startsWith("v")) fail("a version tag is required");
  distTagFor(tag.slice(1));
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail("an explicit owner/repository is required");
  if (!isAbsolute(assets) || !isAbsolute(notesFile)) fail("asset prefix and notes file must be absolute");
  if (typeof prerelease !== "boolean") fail("prerelease must explicitly be true or false");
  // release.ts notes binds these exact files to the verified artifact; never glob the directory.
  readBytesBounded(`${assets}.tgz`, ARCHIVE_BYTES, { noFollow: true });
  readTextBounded(`${assets}.manifest.json`, METADATA_BYTES, { noFollow: true });
  readTextBounded(notesFile, CHANGELOG_BYTES, { noFollow: true });
  try {
    // Both create and edit must refer to a tag already present in the explicit remote repository.
    await request(runner, ["api", `repos/${repo}/git/ref/tags/${tag}`], pause);
    let exists = true;
    try { await request(runner, ["api", `repos/${repo}/releases/tags/${tag}`], pause); }
    catch (error) { if (httpStatus(error) === 404) exists = false; else throw error; }
    const flags = ["--repo", repo, "--title", tag, "--notes-file", notesFile, `--prerelease=${prerelease}`];
    await request(runner, ["release", exists ? "edit" : "create", tag, ...flags, ...(exists ? [] : ["--verify-tag"])], pause);
    await request(runner, ["release", "upload", tag, `${assets}.tgz`, `${assets}.manifest.json`, "--repo", repo, "--clobber"], pause);
  } catch (error) {
    const status = httpStatus(error);
    fail(status === undefined ? "GitHub operation failed" : `GitHub operation failed with HTTP ${status}`);
  }
}

if (import.meta.main) {
  const notesFile = process.argv[2], env = process.env;
  try {
    if (process.argv.length !== 3 || !notesFile || !env.RELEASE_TAG || !env.GITHUB_REPOSITORY || !env.RELEASE_ASSETS || !["true", "false"].includes(env.RELEASE_PRERELEASE ?? "")) fail("use release-github.ts NOTES_FILE with RELEASE_TAG, GITHUB_REPOSITORY, RELEASE_ASSETS and RELEASE_PRERELEASE=true|false");
    await publishGitHubRelease({ tag: env.RELEASE_TAG, repo: env.GITHUB_REPOSITORY, assets: env.RELEASE_ASSETS, notesFile, prerelease: env.RELEASE_PRERELEASE === "true" });
    console.log("GitHub release: notes and assets updated");
  } catch (error) { console.error(error instanceof Error ? error.message : "GitHub release: failed; inspect the job and retry"); process.exitCode = 1; }
}
