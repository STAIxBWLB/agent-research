import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validatePlan, readPlan } from "../src/plan/definition.ts";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp, ARES_TOOLS } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { readLedger } from "../src/study.ts";
import { tempDir, fakeHttp } from "./helpers.ts";
const ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
const step = (id = "base") => ({ id, kind: "step", command: "attempt.run", args: { repo: "../model", commit: "a".repeat(40), seed: 1 } });
const plan = () => ({ v: 1, nodes: [step(), { id: "approval", kind: "gate", binds: ["base"], needs: ["base"] }], edges: [] });
function study() { const dir = join(tempDir(), "study"); ops.init(dir, { question: "synthetic" }, ctx); return dir; }

test("valid definition starts paused, commits once, increments revision; show takes no lock", async () => {
  const dir = study();
  expect((await ops.planSet(dir, plan(), ctx)).state).toBe("paused");
  expect(readPlan(dir)?.revision).toBe(1);
  expect(readLedger(dir).filter(e => e.type === "plan.set")).toHaveLength(1);
  await ops.planSet(dir, plan(), ctx);
  expect(readPlan(dir)?.revision).toBe(2);
  writeFileSync(join(dir, ".ares.lock"), "live");
  writeFileSync(join(dir, ".ares.plan.lock"), "live");
  expect(ops.planShow(dir).definition.revision).toBe(2);
});

test("refusals name cycle, endpoints, bounds, commands, kinds, binds and arguments", () => {
  const cases: [unknown, string][] = [
    [{ ...plan(), edges: [["approval", "base"]] }, "cycle"],
    [{ ...plan(), edges: [["missing", "base"]] }, "missing endpoint"],
    [{ v: 1, nodes: [{ ...step(), needs: ["missing"] }], edges: [] }, "missing endpoint"],
    [{ v: 1, nodes: [{ ...step(), command: "scope" }], edges: [] }, "unknown command"],
    [{ v: 1, nodes: [{ ...step(), kind: "other" }], edges: [] }, "unknown node kind"],
    [{ v: 2, nodes: [], edges: [] }, "unsupported v"],
    [{ v: 1, nodes: [step(), step()], edges: [] }, "duplicate"],
    [{ ...plan(), nodes: Array.from({ length: 129 }, (_, i) => step(String(i))) }, "128 nodes"],
    [{ ...plan(), edges: Array.from({ length: 513 }, () => ["base", "approval"]) }, "512 edges"],
    [{ v: 1, nodes: [step("한".repeat(43))], edges: [] }, "128 bytes"],
    [{ v: 1, nodes: [step(), { id: "g", kind: "gate", binds: ["base"] }], edges: [] }, "upstream"],
    [{ v: 1, nodes: [{ ...step(), args: { repo: "x" } }], edges: [] }, "required option commit"],
    [{ v: 1, nodes: [{ ...step(), args: { repo: "x", commit: "a", detach: "yes" } }], edges: [] }, "controller-owned option"],
    [{ v: 1, nodes: [{ ...step(), args: { repo: true, commit: "a" } }], edges: [] }, "value required"],
    [{ v: 1, nodes: [{ ...step(), args: { repo: "x", commit: "a", surprise: 1 } }], edges: [] }, "unknown option"],
  ];
  for (const [raw, reason] of cases) expect(() => validatePlan(raw)).toThrow(reason);
});

test("transitive upstream, edge dependencies and hub definitions are accepted", () => {
  const raw = { v: 1, nodes: [step(), { id: "hub", kind: "hub", campaign: "c-7", unit: "u2", needs: ["base"] }, { id: "g", kind: "gate", binds: ["base", "hub"] }], edges: [["hub", "g"]] };
  expect(validatePlan(raw).nodes).toHaveLength(3);
});

test("invalid input and unsupported persisted formats preserve plan and ledger bytes", async () => {
  const dir = study(); await ops.planSet(dir, plan(), ctx);
  const file = join(dir, "plan.json"), ledger = join(dir, "ledger.jsonl");
  const before = readFileSync(file), events = readFileSync(ledger);
  await expect(ops.planSet(dir, { ...plan(), v: 99 }, ctx)).rejects.toThrow("unsupported v");
  expect(readFileSync(file)).toEqual(before); expect(readFileSync(ledger)).toEqual(events);
  for (const raw of [{ ...plan(), revision: 1, v: 99 }, { ...plan(), revision: 1, nodes: [{ id: "x", kind: "future" }] }]) {
    const text = JSON.stringify(raw); writeFileSync(file, text);
    expect(() => ops.planShow(dir)).toThrow();
    await expect(ops.planSet(dir, plan(), ctx)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe(text); expect(readFileSync(ledger)).toEqual(events);
  }
});

test("CLI and MCP plan set/show share validated definitions", async () => {
  const dir = study();
  const result = await run(["plan", "set", dir, "--file", "-", "--json"], {}, { http: ctx.http, readStdin: async () => JSON.stringify(plan()) });
  expect(JSON.parse(result.text).state).toBe("paused");
  const mcp = createAresMcp({}, ctx.http), tool = ARES_TOOLS.find(t => t.name === "ares_plan_set")!;
  expect(validArguments({ study: dir, plan: plan() }, tool.inputSchema)).toBe(true);
  await mcp.handlers.ares_plan_set!({ study: dir, plan: plan() });
  expect(await mcp.handlers.ares_plan_show!({ study: dir })).toEqual(JSON.parse((await run(["plan", "show", dir, "--json"], {}, { http: ctx.http })).text));
});

test("named positional args enforce required fields, bounds and controller-owned options", () => {
  const definition = (command: string, args: unknown) => ({ v: 1, nodes: [{ id: "work", kind: "step", command, args }], edges: [] });
  for (const [command, args] of [
    ["lit.search", { query: "q".repeat(1000) }],
    ["lit.search", { query: "한".repeat(333) }],
    ["lit.verify", { ids: Array.from({ length: 500 }, (_, i) => `candidate-${i}`) }],
    ["lit.verify", {}], ["cite.check", { draft: "draft.md" }],
  ] as const) expect(validatePlan(definition(command, args)).nodes).toHaveLength(1);
  for (const [command, args, reason] of [
    ["lit.search", {}, "query"], ["lit.search", { query: "한".repeat(334) }, "1000 bytes"],
    ["lit.verify", { ids: Array(501).fill("candidate") }, "500 candidate ids"],
    ["lit.verify", { ids: [42] }, "ids[0]"],
    ["lit.verify", { ids: ["a".repeat(301)] }, "ids[0]"],
    ["lit.verify", { ids: "candidate" }, "array"], ["cite.check", {}, "draft"],
    ["cite.check", { draft: false }, "draft"],
    ["attempt.run", { repo: "r", commit: "a", detach: false }, "controller-owned"],
    ...["lit.search", "lit.verify", "lit.bib", "cite.check", "attempt.run"].map(command => [command, { json: true }, "controller-owned"]),
  ] as [string, unknown, string][]) {
    expect(() => validatePlan(definition(command, args))).toThrow(reason);
    expect(() => validatePlan(definition(command, args))).toThrow("work");
    expect(() => validatePlan(definition(command, args))).toThrow("run ares plan set again");
  }
});

test("refusals identify the graph location and recovery; unsupported versions precede revision checks", async () => {
  const cases: [unknown, string][] = [
    [{ ...plan(), edges: [["approval", "base"]] }, "base -> approval -> base"],
    [{ ...plan(), edges: [["missing", "base"]] }, "edge [missing, base]"],
    [{ v: 1, nodes: [step(), step()], edges: [] }, "duplicate node id base"],
    [{ v: 1, nodes: [{ ...step(), command: "scope" }], edges: [] }, "step base: unknown command scope (allowed:"],
    [{ v: 1, nodes: [step(), { id: "g", kind: "gate", binds: ["base"] }], edges: [] }, "gate g binds base, which is not upstream"],
    [{ v: 1, nodes: [{ id: "hub", kind: "hub", campaign: "c", unit: "한".repeat(43) }], edges: [] }, "hub hub.unit"],
    [{ v: 1, nodes: [{ id: "hub", kind: "hub", task: { title: "old", unit: "u" } }], edges: [] }, "task"],
  ];
  for (const [raw, reason] of cases) {
    expect(() => validatePlan(raw)).toThrow(reason);
    expect(() => validatePlan(raw)).toThrow("run ares plan set again");
  }
  const dir = study(), file = join(dir, "plan.json");
  for (const raw of [{ v: 99 }, { ...plan(), nodes: [{ id: "future-node", kind: "future" }] }]) {
    const text = JSON.stringify(raw); writeFileSync(file, text);
    expect(() => readPlan(dir)).toThrow("use an ares version that supports this plan, keeping plan.json unchanged");
    expect(readFileSync(file, "utf8")).toBe(text);
  }
});

test("CLI and MCP accept hub references and named positional args; reject old hub tasks and reserved args atomically", async () => {
  const dir = study(), mcp = createAresMcp({}, ctx.http);
  const raw = { v: 1, nodes: [
    { id: "search", kind: "step", command: "lit.search", args: { query: "synthetic" } },
    { id: "verify", kind: "step", command: "lit.verify", args: { ids: ["synthetic-candidate"] } },
    { id: "cite", kind: "step", command: "cite.check", args: { draft: "draft.md" } },
    { id: "hub", kind: "hub", campaign: "c-7", unit: "u2" },
  ], edges: [] };
  const tool = ARES_TOOLS.find(t => t.name === "ares_plan_set")!;
  expect(validArguments({ study: dir, plan: raw }, tool.inputSchema)).toBe(true);
  await mcp.handlers.ares_plan_set!({ study: dir, plan: raw });
  const file = join(dir, "plan.json"), ledger = join(dir, "ledger.jsonl");
  const before = readFileSync(file), events = readFileSync(ledger);
  for (const node of [
    { id: "hub", kind: "hub", task: { title: "old", unit: "u" } },
    { ...step(), args: { repo: "r", commit: "a", detach: false } },
    { id: "search", kind: "step", command: "lit.search", args: { json: true } },
  ]) {
    const invalid = { v: 1, nodes: [node], edges: [] };
    await expect(mcp.handlers.ares_plan_set!({ study: dir, plan: invalid })).rejects.toThrow();
    await expect(run(["plan", "set", dir, "--file", "-"], {}, { http: ctx.http, readStdin: async () => JSON.stringify(invalid) })).rejects.toThrow();
    expect(readFileSync(file)).toEqual(before); expect(readFileSync(ledger)).toEqual(events);
  }
});
