import { expect, test } from "bun:test";
import { join } from "node:path";
import { run, parse } from "../src/cli.ts";
import { cellWidth, renderHelp } from "../src/cli-output.ts";
import { COMMANDS, FLAG_DESCRIPTIONS, FLAG_OVERRIDES, findCommand, flagDescription, helpFlagLabel, helpUsage } from "../src/commands-table.ts";

const utf8 = { LANG: "C.UTF-8", COLUMNS: "80" };
const cli = join(import.meta.dir, "..", "bin", "ares.js");
function invoke(args: string[], env = utf8) {
  const child = Bun.spawnSync([process.execPath, cli, ...args], {
    env: { PATH: process.env.PATH, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: child.exitCode, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
}

function assertLayout(text: string) {
  expect(text).toBe(text.trimEnd());
  expect(text).not.toContain("\n\n\n");
  for (const line of text.split("\n")) expect(cellWidth(line)).toBeLessThanOrEqual(80);
}

test("the grouped help overview includes every command exactly once", () => {
  const overview = renderHelp(undefined, false, false);
  assertLayout(overview);
  for (const spec of COMMANDS) {
    const rows = overview.split("\n").filter(line => line.startsWith(`  ${spec.name}  `));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEndWith(spec.summary);
  }
  expect(overview.match(/--json/g)).toHaveLength(1);
  expect(overview.match(/--color/g)).toHaveLength(1);
});

test("all flag descriptions name an option in the command table", () => {
  for (const flag of Object.keys(FLAG_DESCRIPTIONS)) {
    expect(COMMANDS.some(spec => Object.hasOwn(spec.options, flag))).toBe(true);
  }
  for (const key of Object.keys(FLAG_OVERRIDES)) {
    const split = key.lastIndexOf(" ");
    const name = key.slice(0, split), flag = key.slice(split + 1);
    expect(COMMANDS.some(spec => spec.name === name && Object.hasOwn(spec.options, flag))).toBe(true);
  }
});

for (const spec of COMMANDS) {
  test(`help lint: ${spec.name}`, async () => {
    expect(spec.summary).toMatch(/^[A-Z][A-Za-z0-9 ,/-]*[^. ]$/);
    expect(cellWidth(spec.summary)).toBeLessThanOrEqual(56);
    const plain = renderHelp(spec, false, false), colored = renderHelp(spec, true, false);
    assertLayout(plain);
    assertLayout(colored);
    expect(plain).toContain("▸ Usage");
    expect(plain).toContain("▸ Description");

    for (const flag of Object.keys(spec.options).filter(flag => flag !== "--json")) {
      const description = flagDescription(spec, flag);
      expect(description?.trim()).toBeTruthy();
      const label = helpFlagLabel(spec, flag);
      expect(plain.split("\n").some(line => line.startsWith(`  ${label}  `) && line.endsWith(description!))).toBe(true);
    }

    const usage = helpUsage(spec).slice(spec.name.length).trim();
    if (usage) expect(spec.example).toBeTruthy();
    if (spec.example) {
      const argv = [...spec.name.split(" "), ...spec.example.split(" ")];
      const found = findCommand(argv);
      expect(found?.spec).toBe(spec);
      const { flags, positional } = parse(spec, found!.rest);
      const positionalUsage = usage.split(/\s+(?=\[?--)/)[0] ?? "";
      const slots = positionalUsage.split(" ").flatMap(token => {
        const slot = /^(\[)?<.*>(\.\.\.)?\]?$/.exec(token);
        return slot ? [slot] : [];
      });
      expect(positional.length).toBeGreaterThanOrEqual(slots.filter(slot => !slot[1]).length);
      if (!slots.some(slot => slot[2])) expect(positional.length).toBeLessThanOrEqual(slots.length);
      let required = usage;
      while (/\[[^\[\]]*\]/.test(required)) required = required.replace(/\[[^\[\]]*\]/g, "");
      for (const match of required.matchAll(/--[\w-]+(?:\|--[\w-]+)*/g)) {
        expect(match[0].split("|").some(flag => Object.hasOwn(flags, flag))).toBe(true);
      }
      expect(plain).toContain("▸ Examples");
    }
    for (const args of [["help", ...spec.name.split(" ")], [...spec.name.split(" "), "--help"]]) {
      expect(await run(args, utf8)).toEqual({ text: plain, code: 0 });
    }
  });
}

test("help subprocesses use stdout, shared styles and ASCII markers", () => {
  const overview = invoke(["--help", "--color=never"]);
  const colored = invoke(["--help", "--color=always"]);
  expect(overview).toEqual({ code: 0, stderr: "", stdout: renderHelp(undefined, false, false) + "\n" });
  expect(colored).toEqual({ code: 0, stderr: "", stdout: renderHelp(undefined, true, false) + "\n" });
  expect(overview.stdout.split("\n").slice(0, 9)).toEqual([
    " ares Help", "", "▸ Usage", "  ares <command> [options]",
    "  ares help <command> | ares <command> --help", "  ares --version", "", "▸ Study",
    "  init          Create a study",
  ]);
  const status = COMMANDS.find(spec => spec.name === "status")!;
  const detail = invoke(["status", "--help", "--color=always"]);
  expect(detail).toEqual({ code: 0, stderr: "", stdout: renderHelp(status, true, false) + "\n" });
  expect(invoke(["help", "status"], { ...utf8, LANG: "C" }).stdout).toContain("> Usage\n  ares status <dir>");
  const usage = invoke(["status"]);
  expect(usage.code).toBe(2);
  expect(usage.stdout).toBe("");
  expect(usage.stderr).toContain("Run 'ares help status' for details.");
  expect(invoke(["help", "missing"]).code).toBe(2);
});
