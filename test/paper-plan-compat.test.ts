import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { checkPaper } from "../src/paper/check.ts";
import { saveCandidates, verifySubject, type Candidate } from "../src/lit/candidates.ts";
import { readBytesBounded, readTextBounded, writeAtomic } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

// Exact pre-change merged-main source, including the merged hygiene and review features.
// This is a local source-compatibility baseline, not a published npm N-1 claim.
const BASE = "c18c0c83ca11c4c2505ef9cfac036638e8161cd9";
const SOURCE_BYTES = 8 * 1024 * 1024, LIST_BYTES = 256 * 1024;
const MANUSCRIPT_BYTES = 1024 * 1024, EVIDENCE_BYTES = 8 * 1024 * 1024, LEDGER_BYTES = 64 * 1024 * 1024;
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };

function legacySource() {
  const root = fileURLToPath(new URL("../", import.meta.url)), privateRoot = tempDir();
  const sourceRoot = join(privateRoot, "source"), privateHome = join(privateRoot, "home");
  mkdirSync(sourceRoot, { mode: 0o700 }); mkdirSync(privateHome, { mode: 0o700 });
  // A curated environment prevents personal Git configuration, credentials, hooks and lazy network fetches.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: privateHome, XDG_CONFIG_HOME: privateHome, COPYFILE_DISABLE: "1", LANG: "C", LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_ASKPASS: "false", SSH_ASKPASS: "false",
  };
  const gitArgs = ["--no-optional-locks", "-c", "protocol.allow=never", "-c", "core.hooksPath=/dev/null", "-C", root];
  const commit = spawnSync("git", [...gitArgs, "cat-file", "-e", `${BASE}^{commit}`], { env, timeout: 3000, maxBuffer: LIST_BYTES });
  if (commit.error || commit.status !== 0) throw new Error(`paper no-plan compatibility: baseline ${BASE} is unavailable; restore full local repository history before running this check (automatic fetch and skip are forbidden)`);
  const archive = spawnSync("git", [...gitArgs, "archive", "--format=tar", BASE, "--", "src", "package.json"], { env, timeout: 10_000, maxBuffer: SOURCE_BYTES });
  if (archive.error || archive.status !== 0 || !archive.stdout?.length || archive.stdout.length > SOURCE_BYTES) throw new Error("paper no-plan compatibility: bounded baseline source archive unavailable; restore full local history and its source blobs, then rerun without fetching from this test");
  const listing = spawnSync("tar", ["-tf", "-"], { env, input: archive.stdout, timeout: 5000, maxBuffer: LIST_BYTES });
  if (listing.error || listing.status !== 0 || listing.stdout.length > LIST_BYTES) throw new Error("paper no-plan compatibility: baseline source archive listing failed; restore a readable trusted baseline and native tar");
  const names = new TextDecoder("utf-8", { fatal: true }).decode(listing.stdout).split("\n").filter(Boolean);
  if (!names.length || names.length > 1000 || names.some(name => name.length > 4096 || /[\\\p{Cc}]/u.test(name) || !(name === "package.json" || name === "src" || name.startsWith("src/")) || name.replace(/\/$/, "").split("/").some(part => !part || part === "." || part === ".."))) throw new Error("paper no-plan compatibility: trusted baseline archive exceeds its source entry/path bounds");
  // The uncompressed archive is byte-bounded and comes only from the fixed, trusted own commit.
  const extracted = spawnSync("tar", ["--no-same-owner", "--no-same-permissions", "-xf", "-", "-C", sourceRoot], { env, input: archive.stdout, timeout: 5000, maxBuffer: LIST_BYTES });
  if (extracted.error || extracted.status !== 0) throw new Error("paper no-plan compatibility: baseline extraction failed; restore native tar and the owned private source directory");
  return sourceRoot;
}
function study(text: string, settings?: string): string {
  const dir = tempDir(); ops.init(dir, { question: "Synthetic no-plan compatibility", mode: "survey" }, ctx);
  mkdirSync(join(dir, "paper"), { mode: 0o700 });
  const candidates = [..."abcdefgh"].map((letter, index): Candidate => {
    const candidate: Candidate = { id: `doi:10.1/synthetic-compat-${index}`, title: `Synthetic compatibility source ${letter}`, authors: [], year: 2026, sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status: "included", citekey: `${letter}2026`, verify: { syntax: "ok", exists: "yes", match: "yes", checkedAt: "2030-01-01T00:00:00Z" } };
    candidate.verify!.subject = verifySubject(candidate); return candidate;
  });
  const unverified: Candidate = { ...candidates[0]!, id: "doi:10.1/synthetic-compat-unverified", title: "Synthetic unverified compatibility source", citekey: "unverified2026", verify: { syntax: "ok", exists: "no", match: "unknown", checkedAt: "2030-01-01T00:00:00Z" } };
  unverified.verify!.subject = verifySubject(unverified); candidates.push(unverified); saveCandidates(dir, candidates);
  writeAtomic(join(dir, "paper", "manuscript.md"), text, MANUSCRIPT_BYTES, 0o600);
  if (settings !== undefined) writeAtomic(join(dir, "study.toml"), settings, 16 * 1024, 0o600);
  expect(existsSync(join(dir, "paper", "plan.json"))).toBe(false);
  return dir;
}

test("no-plan reports and v1 evidence remain byte-identical to the exact pre-change merged source", async () => {
  const sourceRoot = legacySource();
  const oldCheck = await import(pathToFileURL(join(sourceRoot, "src", "paper", "check.ts")).href) as Pick<typeof import("../src/paper/check.ts"), "checkPaper">;
  const oldBuild = await import(pathToFileURL(join(sourceRoot, "src", "paper", "build.ts")).href) as Pick<typeof import("../src/paper/build.ts"), "buildPaper" | "paperBuildPaths">;
  const oldStudy = await import(pathToFileURL(join(sourceRoot, "src", "study.ts")).href) as Pick<typeof import("../src/study.ts"), "withLock">;
  const fixtures = [
    { text: "# Intro\n\nPrior work [@a2026; @a2026] and [@b2026][@b2026].\n" },
    { text: "# Intro\n\nUnknown [@missing2026] and unverified [@unverified2026].\n" },
    { text: "# Intro\n\nKnown [@a2026]. Literal {{lit:cohort 2026}} and `code 123`.\nA [paper](https://example.test/research/2026) and [ref][link].\n\n[link]: https://example.test/reference/2026\n" },
    { text: "서론\r\n=====\r\n\r\n문헌 [@a2026].\r\n\r\n방법 `cache 42`\r\n----------------\r\n\r\n기록 `x 73`와 {{lit:조건 2026}}.\r\n\r\n방법 `cache 42`\r\n----------------\r\n" },
    { text: "# Intro\n\nMany [@a2026; @b2026; @c2026; @d2026; @e2026; @f2026; @g2026].\nOne [@a2026; @b2026; @c2026]. Two [@c2026; @b2026; @a2026]. Three [@a2026; @b2026; @c2026].\n" },
    { text: "# Intro\n\nRepeated [@a2026; @a2026].\n", settings: '[paper]\nblocking = ["adjacent-duplicate-citation"]\n' },
  ];
  let built = 0, refused = 0;
  for (const fixture of fixtures) {
    const dir = study(fixture.text, fixture.settings), report = checkPaper(dir), previous = oldCheck.checkPaper(dir);
    expect(JSON.stringify(report)).toBe(JSON.stringify(previous));
    expect(Object.hasOwn(report, "planSha256")).toBe(false);
    if (!report.ok) { refused++; continue; }
    await oldStudy.withLock(dir, () => oldBuild.buildPaper(dir, actor));
    const paths = oldBuild.paperBuildPaths(dir), oldEvidence = readBytesBounded(paths.evidence, EVIDENCE_BYTES);
    const oldManuscript = readBytesBounded(paths.manuscript, MANUSCRIPT_BYTES), oldLedger = readBytesBounded(join(dir, "ledger.jsonl"), LEDGER_BYTES);
    const body: unknown = JSON.parse(readTextBounded(paths.evidence, EVIDENCE_BYTES));
    expect(typeof body).toBe("object"); expect(body).not.toBeNull();
    expect((body as { v: unknown }).v).toBe(1); expect(Object.hasOwn(body as object, "planSha256")).toBe(false);
    const current = await ops.paperBuild(dir, ctx);
    expect(current.changed).toBe(false);
    expect(readBytesBounded(paths.evidence, EVIDENCE_BYTES)).toEqual(oldEvidence);
    expect(readBytesBounded(paths.manuscript, MANUSCRIPT_BYTES)).toEqual(oldManuscript);
    expect(readBytesBounded(join(dir, "ledger.jsonl"), LEDGER_BYTES)).toEqual(oldLedger);
    built++;
  }
  expect(built).toBeGreaterThanOrEqual(3); expect(refused).toBeGreaterThanOrEqual(2);

  // The same older writer must refuse a new plan-bound evidence body instead of silently stripping it.
  const planned = study("# Intro\n\nKnown source [@a2026].\n");
  await ops.paperPlanSet(planned, { v: 1 as const, sections: [{ id: "intro", heading: "Intro", cites: ["a2026"] }] }, ctx);
  expect(checkPaper(planned).ok).toBe(true);
  await ops.paperBuild(planned, ctx);
  const paths = oldBuild.paperBuildPaths(planned), evidence = readBytesBounded(paths.evidence, EVIDENCE_BYTES);
  const ledger = readBytesBounded(join(planned, "ledger.jsonl"), LEDGER_BYTES), manuscript = readBytesBounded(paths.manuscript, MANUSCRIPT_BYTES);
  const body = JSON.parse(readTextBounded(paths.evidence, EVIDENCE_BYTES)) as Record<string, unknown>;
  expect(body.v).toBe(2); expect(typeof body.planSha256).toBe("string"); expect(body.planSha256 as string).toMatch(/^[a-f0-9]{64}$/);
  await expect(oldStudy.withLock(planned, () => oldBuild.buildPaper(planned, actor))).rejects.toThrow("unsupported version");
  expect(readBytesBounded(paths.evidence, EVIDENCE_BYTES)).toEqual(evidence);
  expect(readBytesBounded(join(planned, "ledger.jsonl"), LEDGER_BYTES)).toEqual(ledger);
  expect(readBytesBounded(paths.manuscript, MANUSCRIPT_BYTES)).toEqual(manuscript);
}, 30_000);
