import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { PHASES, type AutonomyMode, type Phase } from "../src/autonomy.ts";
import { guardedPlanPhase, validatePlan } from "../src/plan/definition.ts";
import { runPlan, type ControllerRuntime } from "../src/plan/controller.ts";
import { readLedger } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const gate = { id: "guard", kind: "gate", binds: [] };
const target = (id: string, phase?: string, needs = ["guard"]) => ({ id, kind: "step", command: "lit.bib", args: {}, needs, ...(phase === undefined ? {} : { phase }) });
const hub = (phase?: string) => ({ id: "hub", kind: "hub", campaign: "synthetic", unit: "synthetic", needs: ["guard"], ...(phase === undefined ? {} : { phase }) });
const definition = (targets: unknown[], edges: string[][] = []) => ({ v: 1, nodes: [gate, ...targets], edges });

async function study(raw: unknown, mode: AutonomyMode = "gates") {
  const dir = join(tempDir(), "study");
  ops.init(dir, { question: "Synthetic plan autonomy", autonomy: mode }, ctx);
  await ops.planSet(dir, raw, ctx);
  return dir;
}
async function controller(dir: string, beforeResume?: () => Promise<unknown>) {
  const stop = new AbortController(); let resumed = false, calls = 0, sleeps = 0;
  const runtime: ControllerRuntime = {
    actor, signal: stop.signal,
    prepare: async () => ({}),
    execute: async () => { calls++; return { status: "done", output: { sha256: "synthetic" } }; },
    reconcile: async () => { throw new Error("unexpected reconciliation"); },
    sleep: async () => {
      if (++sleeps > 20) { stop.abort(); throw new Error("controller did not reach the synthetic gate boundary"); }
      if (!resumed) {
        resumed = true;
        await beforeResume?.();
        await ops.planControl(dir, { action: "resume", commandId: "synthetic-resume", expectedRevision: ops.planShow(dir).revision }, ctx);
      } else {
        const state = ops.planShow(dir);
        // A pending non-auto gate, or a ready hub target, is a finite observation boundary.
        if (state.nodes.find(node => node.id === "guard")?.gate?.state === "pending" || state.nodes.some(node => node.kind === "hub" && node.status === "ready")) stop.abort();
      }
    },
  };
  try { return { state: await runPlan(dir, {}, runtime), calls }; }
  finally { stop.abort(); }
}

test("validated node phases are optional, strict and retained on every node kind", async () => {
  const plain = validatePlan(definition([target("next")]));
  expect(plain.nodes.every(node => !Object.hasOwn(node, "phase"))).toBe(true);
  expect(JSON.stringify(plain)).not.toContain('"phase"');
  for (const phase of PHASES) {
    const value = validatePlan({ v: 1, nodes: [{ ...gate, phase }, target("next", phase), hub(phase)], edges: [] });
    expect(value.nodes.map(node => node.phase)).toEqual([phase, phase, phase]);
  }
  const dir = await study(definition([target("next")])), before = readFileSync(join(dir, "plan.json"));
  for (const phase of [null, 1, "", "unknown", "screen", "Scope"]) {
    await expect(ops.planSet(dir, definition([target("next", phase as string)]), ctx)).rejects.toThrow("autonomy.phase");
    expect(readFileSync(join(dir, "plan.json"))).toEqual(before);
  }
});

test("guarded phase uses immediate needs and edges only, with explicit uniform declarations", () => {
  const cases: [unknown[], string[][], Phase | undefined][] = [
    [[target("next", "literature")], [], "literature"],
    [[target("next", "literature", [])], [["guard", "next"]], "literature"],
    [[target("one", "literature"), target("two", "literature")], [], "literature"],
    [[target("one", "literature"), target("two", "design")], [], undefined],
    [[target("one", "literature"), target("two")], [], undefined],
    [[target("one")], [], undefined],
    [[hub("literature")], [], undefined],
    [[target("one", "literature"), hub("literature")], [], undefined],
    [[], [], undefined],
    [[target("next", "literature"), target("indirect", "design", ["next"])], [], "literature"],
  ];
  for (const [targets, edges, expected] of cases) {
    const value = validatePlan(definition(targets, edges));
    expect(guardedPlanPhase(value, "plan:guard")).toBe(expected);
    expect(guardedPlanPhase(value, "scope")).toBeUndefined();
    expect(guardedPlanPhase(value, "plan:missing")).toBeUndefined();
    expect(guardedPlanPhase(value, "plan:next")).toBeUndefined();
  }
});

test("controller autoapproves only the effective guarded phase, with default for mixed/undeclared/hub targets", async () => {
  const cases: { targets: unknown[]; default: AutonomyMode; override: AutonomyMode; approve: boolean; edges?: string[][] }[] = [
    { targets: [target("next", "literature")], default: "gates", override: "auto", approve: true },
    { targets: [target("next", "literature", [])], edges: [["guard", "next"]], default: "gates", override: "auto", approve: true },
    { targets: [target("next", "literature")], default: "auto", override: "gates", approve: false },
    { targets: [target("next", "literature")], default: "auto", override: "copilot", approve: false },
    { targets: [target("next", "literature")], default: "auto", override: "step", approve: false },
    { targets: [target("one", "literature"), target("two", "design")], default: "gates", override: "auto", approve: false },
    { targets: [target("one", "literature"), target("two", "design")], default: "auto", override: "gates", approve: true },
    { targets: [target("one", "literature"), target("two")], default: "gates", override: "auto", approve: false },
    { targets: [target("next")], default: "auto", override: "gates", approve: true },
    { targets: [hub("literature")], default: "gates", override: "auto", approve: false },
    { targets: [hub("literature")], default: "auto", override: "gates", approve: true },
  ];
  for (const scenario of cases) {
    const dir = await study(definition(scenario.targets, scenario.edges), scenario.default);
    await ops.autonomySet(dir, scenario.override, "literature", ctx);
    const { state } = await controller(dir);
    const approvals = readLedger(dir).filter(event => event.type === "gate.approve");
    expect(approvals).toHaveLength(scenario.approve ? 1 : 0);
    expect(state.nodes.find(node => node.id === "guard")!.gate!.state).toBe(scenario.approve ? "approved" : "pending");
    if (scenario.approve) expect(approvals[0]!.actor.kind).toBe("auto");
    else expect(state.nodes.filter(node => node.kind === "step").every(node => node.status === "pending")).toBe(true);
  }
});

test("running controller reloads policy before its autoapproval transaction", async () => {
  for (const [initial, changed] of [["auto", "gates"], ["gates", "auto"]] as const) {
    const dir = await study(definition([target("next", "literature")]), initial);
    const { state } = await controller(dir, () => ops.autonomySet(dir, changed, "literature", ctx));
    expect(state.nodes.find(node => node.id === "guard")!.gate!.state).toBe(changed === "auto" ? "approved" : "pending");
    expect(readLedger(dir).filter(event => event.type === "gate.approve")).toHaveLength(changed === "auto" ? 1 : 0);
  }
});

test("policy changes preserve past approvals, while phase changes participate in node staleness", async () => {
  const dir = await study(definition([target("next", "literature")]));
  await ops.gateDecide(dir, "plan:guard", "approve", undefined, ctx);
  const approval = readLedger(dir).find(event => event.type === "gate.approve")!;
  await ops.autonomySet(dir, "copilot", "literature", ctx);
  const first = await controller(dir);
  expect(first.state.nodes.find(node => node.id === "next")!.status).toBe("done");
  expect(readLedger(dir).filter(event => event.type === "gate.approve")).toEqual([approval]);
  await ops.planSet(dir, definition([target("next", "design")]), ctx);
  expect(ops.planShow(dir).nodes.find(node => node.id === "next")!.status).toBe("stale");
  expect(ops.planShow(dir).nodes.find(node => node.id === "guard")!.gate!.state).toBe("approved");
});
