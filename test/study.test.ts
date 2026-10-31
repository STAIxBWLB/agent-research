import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { detectActor, readLedger } from "../src/study.ts";
import { loadCandidates } from "../src/lit/candidates.ts";
import { fakeHttp, searchRoutes, tempDir } from "./helpers.ts";

const person = { kind: "person" as const };
const SCOPE = { question: "How do research agents verify references?", subquestions: ["citation verification"], maxCandidates: 100 };
async function study(autonomy: "auto" | "gates") {
  const dir = join(tempDir(), "s");
  ops.init(dir, { question: "Q?", autonomy }, { actor: person });
  const { http } = fakeHttp(searchRoutes());
  const ctx = { actor: person, http };
  await ops.scope(dir, SCOPE, ctx);
  return { dir, ctx };
}

describe("study and actor", () => {
  test("init writes study.json and a first ledger event; a second init is refused", () => {
    const dir = join(tempDir(), "s");
    ops.init(dir, { question: "Q?" }, { actor: person });
    expect(JSON.parse(readFileSync(join(dir, "study.json"), "utf8")).autonomy).toBe("gates");
    expect(readLedger(dir).map(e => e.type)).toEqual(["study.init"]);
    expect(() => ops.init(dir, { question: "Q?" }, { actor: person })).toThrow("already exists");
  });
  test("agent markers name the actor; no marker means a person", () => {
    expect(detectActor({ CLAUDECODE: "1" })).toEqual({ kind: "agent", id: "claude" });
    expect(detectActor({ AGENTHUB_PEER_ID: "codex-2", CLAUDECODE: "1" })).toEqual({ kind: "agent", id: "codex-2" });
    expect(detectActor({})).toEqual({ kind: "person" });
  });
  test("a held lock refuses a second writer", async () => {
    const { dir, ctx } = await study("gates");
    writeFileSync(join(dir, ".ares.lock"), "other\n");
    await expect(ops.scope(dir, { ...SCOPE, question: "changed?" }, ctx)).rejects.toThrow("locked");
  });
  test("a malformed scope is refused and nothing is written", async () => {
    const { dir, ctx } = await study("gates");
    const before = readFileSync(join(dir, "scope.json"), "utf8"), events = readLedger(dir).length;
    await expect(ops.scope(dir, { ...SCOPE, extra: 1 }, ctx)).rejects.toThrow("unknown field extra");
    await expect(ops.scope(dir, { ...SCOPE, yearFrom: 2025, yearTo: 2020 }, ctx)).rejects.toThrow("yearFrom after yearTo");
    expect(readFileSync(join(dir, "scope.json"), "utf8")).toBe(before);
    expect(readLedger(dir)).toHaveLength(events);
    expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
  });
});

describe("gates", () => {
  test("AC2: gates mode refuses search until scope is approved; a scope change returns the gate to pending", async () => {
    const { dir, ctx } = await study("gates");
    await expect(ops.search(dir, "verification", {}, ctx)).rejects.toThrow("gate scope is pending");
    await ops.gateDecide(dir, "scope", "approve", undefined, ctx);
    expect((await ops.search(dir, "verification", {}, ctx)).added).toBeGreaterThan(0);
    await ops.scope(dir, { ...SCOPE, subquestions: ["something else"] }, ctx);
    expect(ops.gateList(dir).find(g => g.gate === "scope")!.state).toBe("pending");
    await expect(ops.search(dir, "verification", {}, ctx)).rejects.toThrow("pending");
  });
  test("AC2: auto mode approves a pending gate as actor auto, recorded in the ledger", async () => {
    const { dir, ctx } = await study("auto");
    await ops.search(dir, "verification", {}, ctx);
    const approval = readLedger(dir).find(e => e.type === "gate.approve");
    expect(approval?.actor).toEqual({ kind: "auto" });
    expect(approval?.data.gate).toBe("scope");
  });
  test("rejection needs a reason and blocks until the content changes", async () => {
    const { dir, ctx } = await study("gates");
    await expect(ops.gateDecide(dir, "scope", "reject", undefined, ctx)).rejects.toThrow("needs --reason");
    await ops.gateDecide(dir, "scope", "reject", "too broad", ctx);
    await expect(ops.search(dir, "x", {}, ctx)).rejects.toThrow("rejected: too broad");
  });
  test("AC3: changing the included set after screen approval returns screen to pending and bib is refused", async () => {
    const { dir, ctx } = await study("gates");
    await ops.gateDecide(dir, "scope", "approve", undefined, ctx);
    await ops.search(dir, "verification", {}, ctx);
    const [a, b] = loadCandidates(dir);
    await expect(ops.gateDecide(dir, "screen", "approve", undefined, ctx)).rejects.toThrow("nothing to decide");
    await ops.screen(dir, [a!.id], "include", undefined, ctx);
    await ops.gateDecide(dir, "screen", "approve", undefined, ctx);
    expect(ops.gateList(dir).find(g => g.gate === "screen")!.state).toBe("approved");
    await ops.screen(dir, [b!.id], "include", undefined, ctx);
    expect(ops.gateList(dir).find(g => g.gate === "screen")!.state).toBe("pending");
    await expect(ops.bib(dir, ctx)).rejects.toThrow("gate screen is pending");
  });
});
