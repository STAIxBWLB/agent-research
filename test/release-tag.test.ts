import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { prepareRelease, tagRelease } from "../scripts/release-tag.ts";
import type { ReleaseRunner } from "../scripts/release-ci.ts";
import { tempDir } from "./helpers.ts";
const head = "a".repeat(40), other = "b".repeat(40), notes = "# Changelog\n\n## Unreleased\n\n- Reviewed release change.\n\n## [0.1.0] - 2026-11-05\n\n- Initial release.\n";
function fixture(changelog = notes) { const root = tempDir(); writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@staix/agent-research", version: "0.1.0", keep: true }, null, 2) + "\n"); writeFileSync(join(root, "CHANGELOG.md"), changelog); return root; }
function fake(options: { branch?: string; dirty?: string; remote?: string; localTag?: string; remoteTag?: string; ci?: string; commitAfterCi?: string; pushFailure?: boolean; fetchFailure?: boolean } = {}) {
  const calls: { program: string; args: string[] }[] = []; let ciRead = false;
  const runner: ReleaseRunner = async (program, args) => {
    calls.push({ program, args: [...args] });
    if (program === "gh") {
      if (args[1]!.includes("/workflows/")) { ciRead = true; return JSON.stringify({ workflow_runs: [{ id: 7, head_sha: head, head_branch: "main", event: "push", name: "Check", status: "completed", conclusion: options.ci ?? "success", run_attempt: 1 }] }); }
      return JSON.stringify({ total_count: 1, jobs: [{ name: "ci-ok", status: "completed", conclusion: "success" }] });
    }
    if (args[0] === "branch") return options.branch ?? "main";
    if (args[0] === "status") return options.dirty ?? "";
    if (args[0] === "fetch") { if (options.fetchFailure) throw new Error("synthetic fetch failure"); return ""; }
    if (args[0] === "rev-parse") return args[1] === "HEAD" && ciRead && options.commitAfterCi ? options.commitAfterCi : args[1] === "HEAD" ? head : options.remote ?? head;
    if (args[0] === "tag" && args[1] === "--list") return options.localTag ?? "";
    if (args[0] === "ls-remote") return options.remoteTag ?? "";
    if (args[0] === "tag" && args[1] === "--annotate") return "";
    if (args[0] === "push") { if (options.pushFailure) throw new Error("synthetic push failure"); return ""; }
    throw new Error(`unscripted ${program} ${args.join(" ")}`);
  };
  return { runner, calls };
}
function files(root: string) { return ["package.json", "CHANGELOG.md"].map(file => readFileSync(join(root, file), "utf8")); }
const creates = (f: ReturnType<typeof fake>) => f.calls.filter(call => call.program === "git" && (call.args[0] === "push" || call.args[0] === "tag" && call.args[1] === "--annotate"));
function prepared() { return fixture("# Changelog\n\n## Unreleased\n\n## [0.1.0] - 2026-11-05\n\n- Initial release.\n"); }

test("prepare bumps metadata on a clean release branch and preserves release notes", async () => {
  const root = fixture(), f = fake({ branch: "feat/release-0.1.1" });
  expect(await prepareRelease("0.1.1", { root, runner: f.runner, date: "2026-11-07" })).toEqual({ version: "0.1.1", tag: "v0.1.1", date: "2026-11-07" });
  expect(JSON.parse(files(root)[0]!)).toEqual({ name: "@staix/agent-research", version: "0.1.1", keep: true });
  expect(files(root)[1]).toBe(notes.replace("## Unreleased\n", "## Unreleased\n\n## [0.1.1] - 2026-11-07\n"));
  expect(f.calls.every(call => call.program === "git" && ["branch", "status"].includes(call.args[0]!))).toBe(true);
});

test("prepare refuses dirty/main/detached, duplicate versions, empty notes and bad dates without writes", async () => {
  const cases = [
    { git: { branch: "main" }, version: "0.1.1", text: notes }, { git: { branch: "" }, version: "0.1.1", text: notes },
    { git: { branch: "release", dirty: " M unrelated.txt" }, version: "0.1.1", text: notes },
    { git: { branch: "release" }, version: "0.1.0", text: notes },
    { git: { branch: "release" }, version: "0.1.1", text: notes + "\n## [0.1.1] - 2026-10-01\n\n- Already prepared.\n" },
    { git: { branch: "release" }, version: "0.1.1", text: notes.replace("- Reviewed release change.", "") },
  ];
  for (const entry of cases) { const root = fixture(entry.text), before = files(root), f = fake(entry.git); await expect(prepareRelease(entry.version, { root, runner: f.runner, date: "2026-11-07" })).rejects.toThrow(); expect(files(root)).toEqual(before); }
  for (const version of ["invalid", "01.2.3", "1.2.3-01", "1.2.3-a..b", "1.2.3+..", "1.2.3-rc.", "1.2.3+build."]) { const root = fixture(), before = files(root); await expect(prepareRelease(version, { root, runner: fake({ branch: "release" }).runner })).rejects.toThrow(); expect(files(root)).toEqual(before); }
  const root = fixture(), before = files(root); await expect(prepareRelease("0.1.1", { root, runner: fake({ branch: "release" }).runner, date: "2026-02-30" })).rejects.toThrow("date"); expect(files(root)).toEqual(before);
});

test("tag requires exact-main successful aggregate then annotates and pushes only that tag", async () => {
  const root = prepared(), f = fake(); expect(await tagRelease({ root, runner: f.runner })).toEqual({ version: "0.1.0", tag: "v0.1.0", commit: head });
  expect(f.calls.filter(call => call.args[0] === "fetch")).toHaveLength(2);
  expect(creates(f)).toEqual([{ program: "git", args: ["tag", "--annotate", "v0.1.0", head, "--message", "Release v0.1.0"] }, { program: "git", args: ["push", "--no-follow-tags", "origin", "refs/tags/v0.1.0:refs/tags/v0.1.0"] }]);
  expect(f.calls.findIndex(call => call.program === "gh")).toBeLessThan(f.calls.findIndex(call => call.args[1] === "--annotate"));
});

test("dirty/divergent/fetch-failed/non-success main and existing local or remote tags create nothing", async () => {
  for (const options of [{ branch: "release" }, { branch: "" }, { dirty: "?? file" }, { remote: other }, { fetchFailure: true }, { ci: "failure" }, { ci: "cancelled" }, { ci: "skipped" }, { commitAfterCi: other }, { localTag: "v0.1.0\n" }, { remoteTag: `${head}\trefs/tags/v0.1.0\n` }]) {
    const f = fake(options), root = prepared(), before = files(root); await expect(tagRelease({ root, runner: f.runner })).rejects.toThrow(); expect(creates(f)).toEqual([]); expect(files(root)).toEqual(before);
  }
});

test("tag refuses undated/empty changelog and leaves a failed pushed tag for explicit inspection", async () => {
  for (const text of [notes.replace("## [0.1.0] - 2026-11-05", "## [0.1.0]"), "# Changelog\n\n## Unreleased\n\n## [0.1.0] - 2026-11-05\n\n"]) {
    const invalid = fixture(text), f = fake(); await expect(tagRelease({ root: invalid, runner: f.runner })).rejects.toThrow("release:"); expect(creates(f)).toEqual([]);
  }
  const failed = fake({ pushFailure: true }); await expect(tagRelease({ root: prepared(), runner: failed.runner })).rejects.toThrow("tag exists locally but push did not complete");
  expect(creates(failed).map(call => call.args[0])).toEqual(["tag", "push"]); expect(failed.calls.some(call => call.args.includes("--delete") || call.args.includes("--force"))).toBe(false);
});

test("prepare/tag sanitize missing metadata and git failures with the next step", async () => {
  const missing = fixture(); unlinkSync(join(missing, "package.json"));
  for (const invoke of [() => prepareRelease("0.1.1", { root: missing, runner: fake({ branch: "release" }).runner }), () => tagRelease({ root: missing, runner: fake().runner })]) {
    await expect(invoke()).rejects.toThrow("release metadata read: local file problem");
    await expect(invoke()).rejects.toThrow("then rerun");
  }
  const runner: ReleaseRunner = async () => { throw Object.assign(new Error("private https://example.invalid/token"), { code: 128 }); };
  for (const invoke of [() => prepareRelease("0.1.1", { root: fixture(), runner }), () => tagRelease({ root: prepared(), runner })]) {
    try { await invoke(); throw new Error("expected refusal"); }
    catch (cause) { const message = String(cause); expect(message).toContain("nonzero command exit"); expect(message).toContain("git access"); expect(message).toContain("then rerun"); expect(message).not.toContain("private"); expect(message).not.toContain("https://"); }
  }
});
