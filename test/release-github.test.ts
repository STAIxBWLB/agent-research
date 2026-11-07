import { expect, test } from "bun:test";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishGitHubRelease, type GitHubReleaseOptions } from "../scripts/release-github.ts";
import type { ReleaseRunner } from "../scripts/release-ci.ts";
import { tempDir } from "./helpers.ts";
function fixture(): GitHubReleaseOptions {
  const dir = tempDir(), assets = join(dir, "synthetic-0.1.0"), notesFile = join(dir, "notes.md");
  writeFileSync(`${assets}.tgz`, "synthetic archive"); writeFileSync(`${assets}.manifest.json`, "{}"); writeFileSync(notesFile, "Synthetic release notes");
  return { tag: "v0.1.0", repo: "example/synthetic", assets, notesFile, prerelease: false };
}
const http = (status: number) => new Error(`private diagnostic (HTTP ${status})`);
function fake(responses: (string | Error)[]) {
  const calls: { program: string; args: string[] }[] = [], delays: number[] = [];
  const runner: ReleaseRunner = async (program, args) => {
    calls.push({ program, args: [...args] });
    const response = responses.shift(); if (response === undefined) throw new Error("unexpected fake invocation");
    if (response instanceof Error) throw response; return response;
  };
  return { calls, delays, runner, pause: async (ms: number) => { delays.push(ms); } };
}

test("missing release creates against verified tag, explicit repo/notes/prerelease and exact clobber assets", async () => {
  const f = fixture(), gh = fake(["{}", http(404), "created", "uploaded"]);
  await publishGitHubRelease(f, gh.runner, gh.pause);
  expect(gh.calls).toEqual([
    { program: "gh", args: ["api", "repos/example/synthetic/git/ref/tags/v0.1.0"] },
    { program: "gh", args: ["api", "repos/example/synthetic/releases/tags/v0.1.0"] },
    { program: "gh", args: ["release", "create", f.tag, "--repo", f.repo, "--title", f.tag, "--notes-file", f.notesFile, "--prerelease=false", "--verify-tag"] },
    { program: "gh", args: ["release", "upload", f.tag, `${f.assets}.tgz`, `${f.assets}.manifest.json`, "--repo", f.repo, "--clobber"] },
  ]); expect(gh.delays).toEqual([]);
});

test("rerunning an existing prerelease edits notes and reuploads assets rather than creating", async () => {
  const f = { ...fixture(), tag: "v0.2.0-rc.1", prerelease: true }, gh = fake(["{}", "{}", "edited", "uploaded", "{}", "{}", "edited", "uploaded"]);
  await publishGitHubRelease(f, gh.runner, gh.pause); await publishGitHubRelease(f, gh.runner, gh.pause);
  const edits = gh.calls.filter(call => call.args[1] === "edit"), uploads = gh.calls.filter(call => call.args[1] === "upload");
  expect(edits).toHaveLength(2); expect(uploads).toHaveLength(2); expect(edits[0]!.args).toContain("--prerelease=true");
  expect(edits[0]!.args).toContain(f.notesFile); expect(gh.calls.some(call => call.args[1] === "create")).toBe(false);
  expect(uploads.every(call => call.args.includes("--clobber"))).toBe(true); expect(gh.delays).toEqual([]);
});

test("only 404 release lookup means absence; forbidden and missing tags never create", async () => {
  for (const responses of [["{}", http(403)], [http(404)], ["{}", new Error("spawn failed")]]) {
    const gh = fake(responses);
    await expect(publishGitHubRelease(fixture(), gh.runner, gh.pause)).rejects.toThrow("GitHub operation failed");
    expect(gh.calls.every(call => call.args[0] === "api")).toBe(true); expect(gh.delays).toEqual([]);
  }
});

test("429 and 5xx retry the failed command only with three-attempt exponential backoff", async () => {
  const f = fixture(), gh = fake(["{}", "{}", http(429), http(503), "edited", http(500), "uploaded"]);
  await publishGitHubRelease(f, gh.runner, gh.pause);
  expect(gh.delays).toEqual([1000, 2000, 1000]);
  expect(gh.calls.slice(2, 5).map(call => call.args)).toEqual(Array(3).fill(gh.calls[2]!.args));
  expect(gh.calls.slice(5).map(call => call.args)).toEqual(Array(2).fill(gh.calls[5]!.args));
});

test("retry exhaustion is bounded and diagnostics never echo the upstream output", async () => {
  const gh = fake(["{}", http(502), http(502), http(502)]);
  await expect(publishGitHubRelease(fixture(), gh.runner, gh.pause)).rejects.toThrow("HTTP 502");
  expect(gh.calls).toHaveLength(4); expect(gh.delays).toEqual([1000, 2000]);
  const privateError = fake(["{}", http(401)]);
  try { await publishGitHubRelease(fixture(), privateError.runner, privateError.pause); throw new Error("expected refusal"); }
  catch (error) { expect(String(error)).not.toContain("private diagnostic"); expect(String(error)).toContain("HTTP 401"); }
  expect(privateError.delays).toEqual([]);
});

test("nonretryable mutation failures stop before asset upload", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    const gh = fake(["{}", "{}", http(status)]);
    await expect(publishGitHubRelease(fixture(), gh.runner, gh.pause)).rejects.toThrow(`HTTP ${status}`);
    expect(gh.calls).toHaveLength(3); expect(gh.delays).toEqual([]);
  }
});

test("bad workflow inputs and missing or linked asset files refuse before gh", async () => {
  const f = fixture();
  for (const options of [{ ...f, tag: "other" }, { ...f, repo: "missing-owner" }, { ...f, assets: "relative" }, { ...f, notesFile: "relative" }, { ...f, prerelease: undefined }]) {
    const gh = fake([]); await expect(publishGitHubRelease(options as GitHubReleaseOptions, gh.runner, gh.pause)).rejects.toThrow(); expect(gh.calls).toEqual([]);
  }
  const gh = fake([]); await expect(publishGitHubRelease({ ...f, assets: join(tempDir(), "missing") }, gh.runner, gh.pause)).rejects.toThrow(); expect(gh.calls).toEqual([]);
  const linked = join(tempDir(), "notes-link"); symlinkSync(f.notesFile, linked);
  await expect(publishGitHubRelease({ ...f, notesFile: linked }, gh.runner, gh.pause)).rejects.toThrow(); expect(gh.calls).toEqual([]);
});
