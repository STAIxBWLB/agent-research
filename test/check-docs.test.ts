import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../scripts/check-docs.mjs", import.meta.url));
const env = { ...process.env, GITHUB_ACTIONS: "", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

test("a stamped document under its described path does not keep stamps stale after its own repair", () => {
  const root = mkdtempSync(join(tmpdir(), "ares-docs-"));
  const git = (...args: string[]) => { const r = spawnSync("git", args, { cwd: root, env, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
  const stamp = (commit: string) => write("docs/verified.json", JSON.stringify({ schemaVersion: 1, documents: { "README.md": { verifiedAgainst: commit, paths: ["src/"] }, "src/playbook.ts": { verifiedAgainst: commit, paths: ["src/"] } } }));
  const check = () => spawnSync(process.execPath, [script, "--require-fresh", root], { env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  write("README.md", "readme\n"); write("src/playbook.ts", "export const PLAYBOOK = 'old';\n"); write("src/cli.ts", "export {};\n");
  git("add", "-A"); git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  // Release PR: repair the playbook prose and stamp the base commit, as one squashed commit.
  write("src/playbook.ts", "export const PLAYBOOK = 'new';\n"); stamp(base);
  git("add", "-A"); git("commit", "-q", "-m", "release");
  expect(check().status).toBe(0);
  // A described source change still makes both documents stale and refuses the release.
  write("src/cli.ts", "export const x = 1;\n"); git("add", "-A"); git("commit", "-q", "-m", "source");
  const stale = check();
  expect(stale.status).toBe(1);
  expect(stale.stdout).toContain("README.md: stale (1 source commit");
  expect(stale.stdout).toContain("src/playbook.ts: stale (1 source commit");
});
