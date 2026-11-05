import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertManifest, assertPackageFiles, assertToolchain, distTagFor, identity, isolatedEnv, releaseNotes, releaseSection, validateRelease, verifyStaged } from "../scripts/release.ts";
import { tempDir } from "./helpers.ts";
const files = ["package.json", "README.md", "CHANGELOG.md", "LICENSE", "bin/ares.js", "src/cli.ts", "src/ui/plugin.ts", "src/ui/panel.js", "src/ui/panel.css"];
const dated = "# Changelog\n\n## Unreleased\n\n## [0.1.0] - 2026-11-05\n\n- Initial publication.\n\n## [0.0.1] - 2026-01-01\n\n- Older fixture.\n";
function fixture() {
  const root = tempDir(), work = tempDir(), dir = join(work, "stage"); mkdirSync(dir);
  const pkg = { name: "@staix/agent-research", version: "0.1.0", bin: { ares: "bin/ares.js" } };
  const content = (file: string) => file === "package.json" ? JSON.stringify(pkg) : file === "CHANGELOG.md" ? dated : "synthetic fixture\n";
  for (const file of files) { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), content(file)); }
  const env = { ...isolatedEnv(work), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "-q"]); git(["add", "."]); git(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "fixture"]);
  const expected = identity(root, {}), packed = join(work, "package");
  for (const file of files) { mkdirSync(join(packed, file, ".."), { recursive: true }); writeFileSync(join(packed, file), content(file)); }
  const pack = () => execFileSync("tar", ["-czf", join(dir, "package.tgz"), "-C", work, "package"], { stdio: ["ignore", "pipe", "pipe"] });
  pack();
  const manifest = { ...expected, sha256: createHash("sha256").update(readFileSync(join(dir, "package.tgz"))).digest("hex"), distTag: "latest" as const };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return { root, work, dir, pkg, expected, manifest, packed, pack };
}
test("release tag, exact checkout and dated changelog are all required", () => {
  const f = fixture(), env = { RELEASE_TAG: f.expected.tag, RELEASE_SHA: f.expected.commit };
  expect(validateRelease(f.root, env)).toEqual(f.expected);
  expect(() => validateRelease(f.root, {})).toThrow("RELEASE_TAG and RELEASE_SHA");
  expect(() => validateRelease(f.root, { ...env, RELEASE_TAG: "v0.1.1" })).toThrow("tag must equal");
  expect(() => validateRelease(f.root, { ...env, RELEASE_SHA: "a".repeat(40) })).toThrow("checkout must match");
  expect(releaseSection(dated, "0.1.0")).toBe("- Initial publication.");
  for (const invalid of ["## Unreleased\n- Pending", dated.replace("2026-11-05", "2026-02-30"), dated + "\n## [0.1.0] - 2026-11-06\n- Duplicate"])
    expect(() => releaseSection(invalid, "0.1.0")).toThrow("release:");
});
test("packed inventory requires bootstrap/UI/docs and refuses tests, scripts, links and path escapes", () => {
  expect(() => assertPackageFiles(files, files)).not.toThrow();
  for (const extra of ["test/private.test.ts", "scripts/release.ts", ".github/workflows/release.yml", "node_modules/x/index.js", "src/../private", "/src/private"])
    expect(() => assertPackageFiles([...files, extra])).toThrow("release:");
  expect(() => assertPackageFiles(files.filter(file => file !== "src/ui/panel.css"))).toThrow("missing src/ui/panel.css");
  const f = fixture(); unlinkSync(join(f.packed, "src/cli.ts")); symlinkSync("../../outside", join(f.packed, "src/cli.ts")); f.pack();
  const manifest = { ...f.manifest, sha256: createHash("sha256").update(readFileSync(join(f.dir, "package.tgz"))).digest("hex") }; writeFileSync(join(f.dir, "manifest.json"), JSON.stringify(manifest));
  expect(() => verifyStaged(f.dir, f.root, {})).toThrow("never links");
});
test("artifact verification binds the staged bytes and package identity to tag and commit", () => {
  const f = fixture(); expect(verifyStaged(f.dir, f.root, {})).toEqual(f.manifest);
  for (const update of [{ commit: "f".repeat(40) }, { tag: "v0.1.1" }, { version: "0.1.1" }, { name: "@other/package" }, { sha256: "f".repeat(64) }, { distTag: "next" }, { extra: true }])
    expect(() => assertManifest({ ...f.manifest, ...update }, f.expected, f.manifest.sha256, f.pkg)).toThrow("differs");
  writeFileSync(join(f.dir, "package.tgz"), Buffer.concat([readFileSync(join(f.dir, "package.tgz")), Buffer.from("tamper")]));
  expect(() => verifyStaged(f.dir, f.root, {})).toThrow("SHA-256");
});
test("publish toolchain and dist-tags are explicit, and notes use only the version section", () => {
  expect(() => assertToolchain("v24.0.0", "11.5.1")).not.toThrow(); expect(() => assertToolchain("v24.18.1", "12.0.0")).not.toThrow();
  expect(() => assertToolchain("v23.0.0", "11.5.1")).toThrow("Node >=24"); expect(() => assertToolchain("v24.0.0", "11.5.0")).toThrow("npm >=11.5.1");
  expect(distTagFor("0.1.0")).toBe("latest"); expect(distTagFor("0.2.0-rc.1")).toBe("next"); expect(distTagFor("0.1.0+build-with-dash")).toBe("latest");
  const f = fixture(), output = join(f.work, "notes.md"), result = releaseNotes(f.dir, output, f.root, {}), notes = readFileSync(output, "utf8");
  expect(result.prerelease).toBe(false); expect(notes).toContain("Initial publication."); expect(notes).not.toContain("Older fixture"); expect(notes).not.toContain("## Unreleased"); expect(notes).toContain(f.manifest.sha256);
});
