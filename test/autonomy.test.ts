import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { commit, gateState, openStudy, readLedger, requireGate } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
function fixture(mode = "gates") {
  const home = tempDir(), dir = join(home, "study"), env = { HOME: home, AGENTHUB_HOME: join(home, "family"), AGENTHUB_PEER_ID: "synthetic" };
  const created = ops.init(dir, { question: "Synthetic autonomy", autonomy: mode }, ctx);
  return { dir, env, created, server: createAresMcp(env, ctx.http) };
}
const bytes = (dir: string) => ["study.json", "ledger.jsonl"].map(file => readFileSync(join(dir, file), "utf8"));

test("legacy auto/gates study shape and bytes survive all read-only policy paths", async () => {
  for (const mode of ["auto", "gates"] as const) {
    const f = fixture(mode), before = bytes(f.dir);
    expect(f.created.study.v).toBe(1); expect(f.created.study.autonomy).toBe(mode);
    expect(before[0]).toBe(JSON.stringify(f.created.study, null, 2) + "\n");
    openStudy(f.dir); ops.status(f.dir); ops.autonomyShow(f.dir);
    const cli = JSON.parse((await run(["autonomy", "show", f.dir, "--json"], f.env)).text);
    expect(await f.server.handlers.ares_autonomy_show!({ study: f.dir })).toEqual(cli);
    expect(Object.values(cli.effective).every(value => value === mode)).toBe(true);
    expect(bytes(f.dir)).toEqual(before);
  }
});

test("CLI/MCP policy writes preserve overrides/extensions, record actor/from/to/phase and never downgrade", async () => {
  const f = fixture(), file = join(f.dir, "study.json");
  writeFileSync(file, JSON.stringify({ ...openStudy(f.dir).study, extension: { kept: true } }, null, 2) + "\n");
  await f.server.handlers.ares_autonomy_set!({ study: f.dir, mode: "auto", phase: "literature" });
  const configured = openStudy(f.dir).study;
  expect(configured.v).toBe(2); expect(configured.autonomy).toEqual({ default: "gates", phases: { literature: "auto" } });
  expect(JSON.parse(readFileSync(file, "utf8")).extension).toEqual({ kept: true });
  expect(readLedger(f.dir).at(-1)).toMatchObject({ type: "autonomy.set", actor: { kind: "agent", id: "synthetic" }, data: { from: "gates", to: configured.autonomy, phase: "literature" } });
  const cli = await run(["autonomy", "set", f.dir, "copilot", "--json"], f.env);
  expect(JSON.parse(cli.text).autonomy).toEqual({ default: "copilot", phases: { literature: "auto" } });
  expect(readLedger(f.dir).at(-1)!.data.phase).toBeNull();
  await ops.autonomySet(f.dir, "gates", undefined, ctx); expect(openStudy(f.dir).study.v).toBe(2);
  for (const mode of ["copilot", "step"]) {
    const other = fixture(mode); expect(other.created.study.v).toBe(2);
    await ops.autonomySet(other.dir, "gates", undefined, ctx);
    expect(openStudy(other.dir).study).toMatchObject({ v: 2, autonomy: "gates" });
  }
  const legacy = fixture(); await ops.autonomySet(legacy.dir, "auto", undefined, ctx);
  expect(openStudy(legacy.dir).study).toMatchObject({ v: 1, autonomy: "auto" });
});

test("unknown modes/phases refuse CLI and MCP before changing study or ledger", async () => {
  const f = fixture(), before = bytes(f.dir), schema = ARES_TOOLS.find(tool => tool.name === "ares_autonomy_set")!.inputSchema;
  for (const [mode, phase] of [["unknown", undefined], ["AUTO", undefined], ["auto", "unknown"], ["gates", "Scope"]]) {
    const args = { study: f.dir, mode, ...(phase === undefined ? {} : { phase }) };
    expect(validArguments(args, schema)).toBe(true);
    await expect(f.server.handlers.ares_autonomy_set!(args)).rejects.toThrow("autonomy.");
    await expect(run(["autonomy", "set", f.dir, mode!, ...(phase === undefined ? [] : ["--phase", phase])], f.env)).rejects.toThrow("autonomy.");
    expect(bytes(f.dir)).toEqual(before);
  }
  expect(validArguments({ study: f.dir, mode: "auto", unknown: true }, schema)).toBe(false);
});

test("new policy semantics require v2; malformed or future records are left untouched", () => {
  const f = fixture(), file = join(f.dir, "study.json"), base = openStudy(f.dir).study;
  for (const raw of [
    { ...base, v: 1, autonomy: "copilot" }, { ...base, v: 1, autonomy: { default: "gates", phases: {} } },
    { ...base, v: 2, autonomy: { default: "gates", phases: { unknown: "auto" } } },
    { ...base, v: 2, autonomy: { default: "unknown", phases: {} } }, { ...base, v: 2, autonomy: { default: "gates", phases: {}, future: true } }, { ...base, v: 3 },
  ]) {
    const text = JSON.stringify(raw) + "\n"; writeFileSync(file, text);
    expect(() => openStudy(f.dir)).toThrow("study.json:"); expect(readFileSync(file, "utf8")).toBe(text);
  }
});

test("only auto grants its phase and changing policy never re-decides earlier gate decisions", async () => {
  const f = fixture(); await ops.scope(f.dir, { question: "Synthetic scope" }, ctx);
  writeFileSync(join(f.dir, "literature", "candidates.json"), JSON.stringify([{ id: "synthetic", title: "Synthetic", authors: [], sources: ["openalex"], status: "included", addedAt: "2030-01-01T00:00:00Z" }]));
  await ops.autonomySet(f.dir, "auto", "literature", ctx);
  const bind = ops.binder(f.dir);
  expect(() => requireGate(f.dir, openStudy(f.dir).study, "scope", bind)).toThrow("pending");
  const approval = requireGate(f.dir, openStudy(f.dir).study, "screen", bind);
  expect(approval).toHaveLength(1); expect(approval[0]).toMatchObject({ actor: { kind: "auto" }, data: { gate: "screen" } });
  commit(f.dir, [], approval);
  const decisions = readLedger(f.dir).filter(event => event.type === "gate.approve");
  for (const mode of ["gates", "copilot", "step"]) {
    await ops.autonomySet(f.dir, mode, "literature", ctx);
    expect(requireGate(f.dir, openStudy(f.dir).study, "screen", bind)).toEqual([]);
    expect(gateState("scope", readLedger(f.dir), bind).state).toBe("pending");
    expect(readLedger(f.dir).filter(event => event.type === "gate.approve")).toEqual(decisions);
  }
  for (const mode of ["gates", "copilot", "step"]) {
    await ops.autonomySet(f.dir, mode, "scope", ctx);
    expect(() => requireGate(f.dir, openStudy(f.dir).study, "scope", bind)).toThrow("pending");
  }
  await ops.gateDecide(f.dir, "scope", "reject", "Synthetic explicit rejection", ctx);
  const rejected = readLedger(f.dir).filter(event => event.type.startsWith("gate."));
  await ops.autonomySet(f.dir, "auto", "scope", ctx);
  expect(() => requireGate(f.dir, openStudy(f.dir).study, "scope", bind)).toThrow("rejected");
  expect(readLedger(f.dir).filter(event => event.type.startsWith("gate."))).toEqual(rejected);
});
