import { expect, test } from "bun:test";
import { join } from "node:path";
import { ROLE_SGR, cellWidth, paint } from "@staix/cli-output";
import { status } from "../src/commands.ts";
import { tempDir } from "./helpers.ts";

const cli = join(import.meta.dir, "..", "bin", "ares.js");
const esc = ROLE_SGR.header[0]!;
const utf8 = { LANG: "C.UTF-8" };
function invoke(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  const env = { PATH: process.env.PATH, ...utf8, ...overrides };
  const result = Bun.spawnSync([process.execPath, cli, ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: result.exitCode };
}

test("status color and ASCII policy, stable JSON bytes and pipe width", () => {
  const dir = join(tempDir(), "study");
  expect(invoke(["init", dir, "--question", "Study question"]).code).toBe(0);
  const result = invoke(["status", dir, "--color=auto"], { NO_COLOR: "1", FORCE_COLOR: "1" });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain(esc);
  expect(result.stdout.replace(status(dir).study, "<study>").split("\n").slice(0, 8)).toEqual([
    " ares Status",
    "  Study:     <study>",
    "  Question:  Study question",
    "  Mode:      survey",
    "  Autonomy:  gates",
    "  Bib:       (unset)",
    "  Events:    1",
    "",
  ]);
  const colored = invoke(["status", dir, "--color=always"], { NO_COLOR: "1" });
  expect(colored.stdout.split("\n")[0]).toBe(paint([{ text: " ares Status", role: "header" }], true));
  expect(colored.stdout).toContain(ROLE_SGR.section);
  expect(invoke(["status", dir], { FORCE_COLOR: "1" }).stdout).toBe(colored.stdout);
  const json = invoke(["status", dir, "--json", "--color=always"], { FORCE_COLOR: "1" });
  expect(json).toEqual({ stdout: JSON.stringify(status(dir)) + "\n", stderr: "", code: 0 });
  expect(json.stdout).not.toContain(esc);
  const narrow = invoke(["status", dir], { LANG: "C", COLUMNS: "80" });
  expect(narrow.stdout).toContain("> Gates");
  for (const line of narrow.stdout.split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(80);
  expect(invoke(["gate", "list", dir]).stdout).toContain("ares Gate list");
  expect(invoke(["autonomy", "show", dir]).stdout).toContain("ares Autonomy show");
});

test("usage and operational failures stay on stderr and preserve the next step", () => {
  const missing = join(tempDir(), "missing");
  const operational = invoke(["status", missing]);
  expect(operational.code).toBe(1);
  expect(operational.stdout).toBe("");
  expect(operational.stderr).toStartWith("ares: ");
  expect(operational.stderr).toContain("\n  → ares init first");
  for (const args of [["missing-command"], ["status"], ["status", missing, "--bad"], ["status", missing, "--color=bad"]]) {
    const usage = invoke(args);
    expect(usage.code).toBe(2);
    expect(usage.stdout).toBe("");
    expect(usage.stderr).toStartWith("ares: ");
    expect(usage.stderr).toContain("\nUsage: ares ");
  }

  const dir = join(tempDir(), "study");
  expect(invoke(["init", dir, "--question", "Study question"]).code).toBe(0);
  const next = invoke(["watch", "run", dir], { LANG: "C" });
  expect(next.code).toBe(1);
  expect(next.stdout).toBe("");
  expect(next.stderr).toContain("\n  -> ares watch set");
});
