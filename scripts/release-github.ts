import { isAbsolute } from "node:path";
import { readBytesBounded, readTextBounded } from "../src/study.ts";
import { ARCHIVE_BYTES, CHANGELOG_BYTES, METADATA_BYTES, distTagFor } from "./release.ts";
import { defaultReleaseRunner, httpStatus, releaseFailure, ReleaseError, type ReleaseRunner } from "./release-ci.ts";

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
function fail(message: string): never { throw new ReleaseError(`GitHub release: ${message}; inspect the release job inputs and rerun it`); }
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
  try {
    readBytesBounded(`${assets}.tgz`, ARCHIVE_BYTES, { noFollow: true });
    readTextBounded(`${assets}.manifest.json`, METADATA_BYTES, { noFollow: true });
    readTextBounded(notesFile, CHANGELOG_BYTES, { noFollow: true });
  } catch (error) { throw releaseFailure("GitHub release assets/notes read", error, "check the release job inputs for missing, oversized or linked files, then rerun", "local file problem"); }
  try {
    // Both create and edit must refer to a tag already present in the explicit remote repository.
    await request(runner, ["api", `repos/${repo}/git/ref/tags/${tag}`], pause);
    const exists = async (): Promise<boolean> => {
      try { await request(runner, ["api", `repos/${repo}/releases/tags/${tag}`], pause); return true; }
      catch (error) { if (httpStatus(error) === 404) return false; throw error; }
    };
    const flags = ["--repo", repo, "--title", tag, "--notes-file", notesFile, `--prerelease=${prerelease}`];
    const edit = () => request(runner, ["release", "edit", tag, ...flags], pause);
    if (await exists()) await edit();
    else for (let attempt = 1; ; attempt++) {
      try { await runner("gh", ["release", "create", tag, ...flags, "--verify-tag"]); break; }
      catch (error) {
        const status = httpStatus(error), retryable = status === 429 || status !== undefined && status >= 500 && status <= 599;
        if (!retryable && status !== 422) throw error;
        // Create can commit before its response fails. Reconcile before another create.
        if (await exists()) { await edit(); break; }
        if (!retryable || attempt >= 3) throw error;
        await pause(1000 * 2 ** (attempt - 1));
      }
    }
    await request(runner, ["release", "upload", tag, `${assets}.tgz`, `${assets}.manifest.json`, "--repo", repo, "--clobber"], pause);
  } catch (error) {
    throw releaseFailure("GitHub operation failed", error, "check the release job inputs and GH_TOKEN permissions, then rerun");
  }
}

if (import.meta.main) {
  const notesFile = process.argv[2], env = process.env;
  try {
    if (process.argv.length !== 3 || !notesFile || !env.RELEASE_TAG || !env.GITHUB_REPOSITORY || !env.RELEASE_ASSETS || !["true", "false"].includes(env.RELEASE_PRERELEASE ?? "")) fail("use release-github.ts NOTES_FILE with RELEASE_TAG, GITHUB_REPOSITORY, RELEASE_ASSETS and RELEASE_PRERELEASE=true|false");
    await publishGitHubRelease({ tag: env.RELEASE_TAG, repo: env.GITHUB_REPOSITORY, assets: env.RELEASE_ASSETS, notesFile, prerelease: env.RELEASE_PRERELEASE === "true" });
    console.log("GitHub release: notes and assets updated");
  } catch (error) { console.error(releaseFailure("GitHub release", error, "check the release job inputs and GH_TOKEN permissions, then rerun").message); process.exitCode = 1; }
}
