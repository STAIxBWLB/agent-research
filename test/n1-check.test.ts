import { join, resolve } from "node:path";
import * as ops from "../src/commands.ts";
import { readProtocol, protocolHash, designBinding, PROTOCOL_BYTES } from "../src/exp/protocol.ts";
import { readTextBounded, writeAtomic } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
import { expect, test } from "bun:test";
import { compareManifests, resolveN1, studyFormatCheck, type ManifestLike } from "../scripts/n1-lib.ts";
import { checkN1Protocol, json, parseArgs, run, spawnFailure, STEPS } from "../scripts/n1-check.ts";

test("resolveN1: N-1 is the latest patch of the minor line directly below the checkout core, publication aside", () => {
  expect(resolveN1("0.2.0", ["0.1.0", "0.1.3", "0.2.0"])).toBe("0.1.3");
  expect(resolveN1("0.2.1", ["0.1.0", "0.2.0", "0.2.1"])).toBe("0.1.0");
  expect(resolveN1("0.3.0", ["0.2.0", "0.2.2"])).toBe("0.2.2");
  expect(resolveN1("0.3.0", ["0.1.0", "0.1.9", "0.2.0", "0.2.2"])).toBe("0.2.2");
  expect(resolveN1("0.2.0", ["0.0.0-stage", "0.1.0", "0.1.3"])).toBe("0.1.3");
  expect(resolveN1("1.0.0", ["0.1.0", "0.9.4", "1.0.0-rc.1"])).toBe("0.9.4");
  expect(resolveN1("0.2.0-rc.1", ["0.1.0", "0.1.3"])).toBe("0.1.3");
  expect(resolveN1("0.2.0+build.5", ["0.0.0-stage", "0.1.0"])).toBe("0.1.0");
});

test("resolveN1: the initial publication line has no N-1 and skips; a malformed checkout version fails", () => {
  expect(resolveN1("0.1.0", ["0.0.0-stage", "0.1.0"])).toBeUndefined();
  expect(resolveN1("0.1.0", [])).toBeUndefined();
  expect(resolveN1("0.1.0-rc.1", ["0.1.0"])).toBeUndefined();
  expect(() => resolveN1("next", ["0.1.0"])).toThrow("fix package.json version");
});

test("studyFormatCheck: refuse when N-1 lacks the checkout study version, read otherwise", () => {
  expect(studyFormatCheck({ formats: { study: 1 } }, { formats: { study: 2 } })).toEqual({ expect: "refuse", version: 2 });
  expect(studyFormatCheck({ formats: { study: 2 } }, { formats: { study: 2 } })).toEqual({ expect: "read", version: 2 });
  expect(studyFormatCheck({ formats: { study: 3 } }, { formats: { study: 2 } })).toEqual({ expect: "read", version: 2 });
  expect(() => studyFormatCheck({ formats: {} }, { formats: { study: 2 } })).toThrow("N-1 manifest has no valid formats.study");
  expect(() => studyFormatCheck({ formats: { study: 1 } }, {})).toThrow("checkout manifest has no valid formats.study");
});

const base: ManifestLike = {
  commands: [{ name: "status", usage: "status <dir> [--json]" }, { name: "init", usage: "init <dir> --question TEXT [--autonomy auto|gates] [--json]" }],
  mcp: { tools: [{ name: "ares_status", readOnly: true }, { name: "ares_init", readOnly: false }] },
};
const clone = (): ManifestLike => JSON.parse(JSON.stringify(base));

test("compareManifests: identical and additive changes pass", () => {
  expect(compareManifests(base, clone())).toEqual([]);
  const next = clone();
  next.commands.push({ name: "study export", usage: "study export <dir> --bundle DIR [--json]" });
  next.commands[1]!.usage = "init <dir> --question TEXT [--mode survey|experiment] [--autonomy auto|gates|copilot|step] [--json]";
  next.mcp.tools.push({ name: "ares_study_export", readOnly: false });
  expect(compareManifests(base, next)).toEqual([]);
});

test("compareManifests: a removed command fails", () => {
  const next = clone(); next.commands = next.commands.filter(c => c.name !== "status");
  expect(compareManifests(base, next)).toEqual(['CLI: command "status" removed']);
});

test("compareManifests: a removed or renamed usage word and a narrowed enum fail", () => {
  const renamed = clone(); renamed.commands[1]!.usage = "init <dir> --prompt TEXT [--autonomy auto|gates] [--json]";
  expect(compareManifests(base, renamed)[0]).toContain('CLI: command "init" usage changed');
  const narrowed = clone(); narrowed.commands[1]!.usage = "init <dir> --question TEXT [--autonomy auto] [--json]";
  expect(compareManifests(base, narrowed)[0]).toContain('CLI: command "init" usage changed');
});

test("compareManifests: a removed tool fails", () => {
  const next = clone(); next.mcp.tools = next.mcp.tools.filter(t => t.name !== "ares_init");
  expect(compareManifests(base, next)).toEqual(['MCP: tool "ares_init" removed']);
});

test("compareManifests: a flipped readOnly fails in either direction", () => {
  const next = clone(); next.mcp.tools[0]!.readOnly = false; next.mcp.tools[1]!.readOnly = true;
  expect(compareManifests(base, next)).toEqual(['MCP: tool "ares_status" readOnly changed from true to false', 'MCP: tool "ares_init" readOnly changed from false to true']);
});

test("compareManifests: a new required positional or option fails; new words inside [...] pass", () => {
  for (const usage of ["status <dir> <format> [--json]", "status <dir> --format FORMAT [--json]"]) {
    const next = clone(); next.commands[0]!.usage = usage;
    expect(compareManifests(base, next)[0]).toContain('CLI: command "status" usage changed');
  }
  const optional = clone(); optional.commands[0]!.usage = "status <dir> [--format FORMAT] [--mode survey|experiment] [--json]";
  expect(compareManifests(base, optional)).toEqual([]);
});

test("n1-check refuses unknown arguments and accepts only --version X.Y.Z", () => {
  expect(parseArgs([])).toEqual({}); expect(parseArgs(["--version", "0.1.0"])).toEqual({ version: "0.1.0" });
  for (const args of [["--versio", "0.1.0"], ["--version"], ["--version", "latest"], ["--version", "0.1.0", "extra"], ["extra"]]) expect(() => parseArgs(args)).toThrow("remove unknown arguments");
});

test("resolveN1: a prerelease or build checkout targets its own minor core", () => {
  expect(resolveN1("0.2.0-rc.1", ["0.1.0", "0.1.3"])).toBe("0.1.3");
  expect(resolveN1("0.2.0-rc.1", ["0.1.0", "0.1.3", "0.2.0"])).toBe("0.1.3");
  expect(resolveN1("0.2.0+build.5", ["0.0.0-stage", "0.1.0"])).toBe("0.1.0");
  expect(resolveN1("0.1.0-rc.1", ["0.1.0"])).toBeUndefined();
});

test("run: a missing executable fails with n1 context and an install or PATH step", async () => {
  const error = await run("ares-n1-missing-executable", [], process.cwd()).then(() => undefined, (e: Error) => e);
  expect(error?.message).toMatch(/^n1: ares-n1-missing-executable could not be started .*install ares-n1-missing-executable or add it to PATH, then rerun bun scripts\/n1-check\.ts$/);
  expect(spawnFailure("npm", new Error("Executable not found in $PATH: \"npm\"")).message).toContain("install npm or add it to PATH");
  expect(spawnFailure("npm", Object.assign(new Error("EACCES"), { code: "EACCES" })).message).toContain("check PATH and permissions for npm");
});

test("run: timeout and output-bound failures carry n1 context and a rerun step", async () => {
  const slow = await run("bun", ["-e", "await Bun.sleep(5000)"], process.cwd(), 50).then(() => undefined, (e: Error) => e);
  expect(slow?.message).toMatch(/^n1: bun timed out after 50 ms; .*rerun bun scripts\/n1-check\.ts$/);
  const loud = await run("bun", ["-e", "process.stdout.write('x'.repeat(5 * 1024 * 1024))"], process.cwd()).then(() => undefined, (e: Error) => e);
  expect(loud?.message).toMatch(/^n1: bun output exceeded \d+ bytes; .*rerun bun scripts\/n1-check\.ts$/);
});

test("json: local N-1 and checkout failures name their own step, only npm points at the registry", () => {
  const failed = { code: 1, stdout: "", stderr: "study.json: unsupported schema version" }, garbled = { code: 0, stdout: "not json", stderr: "" };
  for (const [step, local] of [[STEPS.checkout, "fix the checkout command"], [STEPS.n1, "the installed N-1 package failed"]] as const)
    for (const result of [failed, garbled]) {
      const message = (() => { try { json(result, "local", step); return ""; } catch (e) { return (e as Error).message; } })();
      expect(message).toContain(local); expect(message).not.toContain("npm registry");
    }
  expect(() => json(failed, "npm view", STEPS.npm)).toThrow("check npm registry access");
  expect(json<{ a: number }>({ code: 0, stdout: '{"a":1}', stderr: "" }, "ok", STEPS.checkout)).toEqual({ a: 1 });
});

const checkoutRoot = resolve(import.meta.dir, "..");
function protocolStudy() {
  const work = tempDir(), dir = join(work, "synthetic n1 study"), ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic offline N-1 orchestration", mode: "experiment" }, ctx);
  return { work, dir };
}
test("N-1 protocol orchestration creates with the first package and only reads with the second", async () => {
  const f = protocolStudy(), scripts: string[] = [];
  // Offline smoke uses this checkout in both roles; the network CI supplies the separately installed N-1 root.
  const result = await checkN1Protocol(checkoutRoot, checkoutRoot, f.dir, f.work, async (command, args, cwd, timeout) => {
    expect(command).toBe("bun"); expect(args[0]).toBe("-e"); scripts.push(args[1]!);
    return run(command, args, cwd, timeout);
  });
  expect(scripts).toHaveLength(2);
  expect(scripts[0]).toContain('await ops.protocol(dir,'); expect(scripts[0]).toContain('await ops.gateDecide(dir,"design","approve"');
  expect(scripts[1]).not.toContain("await ops.protocol"); expect(scripts[1]).not.toContain("writeAtomic");
  expect(readProtocol(f.dir)).not.toHaveProperty("inputs");
  expect(result.protocolHash).toBe(protocolHash(readProtocol(f.dir)!)); expect(result.designBinding).toBe(designBinding(f.dir)!);
  expect(result.gate).toMatchObject({ state: "approved", current: result.designBinding });
});

test("N-1 protocol orchestration refuses identity drift or reader byte changes", async () => {
  for (const shape of ["identity", "bytes"] as const) {
    const f = protocolStudy(); let calls = 0;
    await expect(checkN1Protocol(checkoutRoot, checkoutRoot, f.dir, f.work, async (command, args, cwd, timeout) => {
      const result = await run(command, args, cwd, timeout);
      if (++calls === 2) {
        if (shape === "identity") result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), protocolHash: "f".repeat(64) });
        else { const file = join(f.dir, "design", "protocol.json"); writeAtomic(file, readTextBounded(file, PROTOCOL_BYTES) + "\n", PROTOCOL_BYTES); }
      }
      return result;
    })).rejects.toThrow(shape === "identity" ? "changed the published N-1 no-input protocol hash" : "rewrote a published N-1 no-input protocol");
    expect(calls).toBe(2);
  }
});

test("N-1 protocol creation passes the installed package root and reports its own failure step", async () => {
  const f = protocolStudy(), installedRoot = join(f.work, "installed-published-n1");
  await expect(checkN1Protocol(installedRoot, checkoutRoot, f.dir, f.work, async (_command, args) => {
    expect(args[1]).toContain(JSON.stringify(installedRoot));
    expect(args[1]).toContain('import(base + "/src/commands.ts")');
    return { code: 1, stdout: "", stderr: "synthetic installed-package failure" };
  })).rejects.toThrow("the installed N-1 package failed");
});
