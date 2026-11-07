import { expect, test } from "bun:test";
import { AUTONOMY_MODES, PHASES, GATE_PHASES, validateAutonomy, validateAutonomyMode, validatePhase, resolveAutonomy, type Autonomy, type Phase } from "../src/autonomy.ts";

test("all four string policies preserve their mode for every direct and plan gate", () => {
  expect(AUTONOMY_MODES).toEqual(["auto", "gates", "copilot", "step"]);
  for (const mode of AUTONOMY_MODES) {
    expect(validateAutonomyMode(mode)).toBe(mode);
    expect(validateAutonomy(mode)).toBe(mode);
    for (const gate of [...Object.keys(GATE_PHASES), "plan:guard", "unknown"])
      for (const phase of [undefined, ...PHASES]) expect(resolveAutonomy(mode, gate, phase)).toBe(mode);
  }
});

test("direct gates use the one declared phase mapping, and ignore guarded plan phase", () => {
  expect(GATE_PHASES).toEqual({ scope: "scope", screen: "literature", design: "design", final: "final", review: "review" });
  for (const mode of AUTONOMY_MODES) for (const [gate, phase] of Object.entries(GATE_PHASES)) {
    const policy = validateAutonomy({ default: "gates", phases: { [phase]: mode } });
    expect(resolveAutonomy(policy, gate)).toBe(mode);
    expect(resolveAutonomy(policy, gate, "archive")).toBe(mode);
    for (const other of Object.keys(GATE_PHASES).filter(other => other !== gate)) expect(resolveAutonomy(policy, other)).toBe("gates");
  }
});

test("every phase can override plan gates, while absent or ambiguous phases use default", () => {
  expect(PHASES).toEqual(["scope", "literature", "hypotheses", "design", "investigate", "ablate", "final", "posthoc", "write", "review", "archive"]);
  for (const phase of PHASES) for (const mode of AUTONOMY_MODES) {
    expect(validatePhase(phase)).toBe(phase);
    const policy = validateAutonomy({ default: "step", phases: { [phase]: mode } });
    expect(resolveAutonomy(policy, "plan:guard", phase)).toBe(mode);
    expect(resolveAutonomy(policy, "plan:guard")).toBe("step");
    expect(resolveAutonomy(policy, "unknown", phase)).toBe("step");
    const other = PHASES.find(candidate => candidate !== phase)!;
    expect(resolveAutonomy(policy, "plan:guard", other)).toBe("step");
  }
  expect(resolveAutonomy({ default: "copilot", phases: {} }, "scope")).toBe("copilot");
  expect(resolveAutonomy({ default: "auto", phases: {} }, "toString")).toBe("auto");
});

test("unknown modes, phases, fields and malformed policy shapes are refused with recovery guidance", () => {
  const bad: unknown[] = [undefined, null, 1, true, [], new Date(), "", "AUTO", " auto ", "unknown",
    {}, { default: "gates" }, { phases: {} }, { default: "gates", phases: null }, { default: "gates", phases: [] },
    { default: "gates", phases: "auto" }, { default: "gates", phases: {}, extra: true },
    { default: "unknown", phases: {} }, { default: "gates", phases: { unknown: "auto" } },
    { default: "gates", phases: { scope: "unknown" } }, { default: "gates", phases: { scope: undefined } },
    { default: "gates", phases: { Scope: "auto" } }, { default: "gates", phases: { scope: { mode: "auto" } } },
    JSON.parse('{"default":"gates","phases":{"__proto__":"auto"}}'),
    { default: "gates", phases: {}, [Symbol("extra")]: true },
  ];
  for (const raw of bad) {
    expect(() => validateAutonomy(raw)).toThrow(/autonomy.*; correct the policy and retry ares autonomy set/);
  }
  for (const raw of [null, 1, "unknown", "Auto", "auto "]) expect(() => validateAutonomyMode(raw)).toThrow("autonomy.mode");
  for (const raw of [null, 1, "unknown", "screen", "Scope", "scope "]) expect(() => validatePhase(raw)).toThrow("autonomy.phase");
});

test("validation and resolution never mutate the caller's policy or return shared nested state", () => {
  const phases = Object.freeze({ scope: "auto" as const, write: "copilot" as const });
  const input = Object.freeze({ default: "gates" as const, phases });
  const original = JSON.stringify(input), validated = validateAutonomy(input);
  expect(validated).toEqual(input);
  expect(validated).not.toBe(input);
  for (const phase of PHASES) resolveAutonomy(validated, "plan:guard", phase);
  expect(JSON.stringify(input)).toBe(original);
  if (typeof validated === "string") throw new Error("expected policy object");
  expect(validated.phases).not.toBe(input.phases);
  validated.phases.scope = "step";
  expect(input.phases.scope).toBe("auto");
  const all: Partial<Record<Phase, "auto">> = Object.fromEntries(PHASES.map(phase => [phase, "auto"]));
  const objectPolicy: Autonomy = { default: "gates", phases: all };
  expect(validateAutonomy(objectPolicy)).toEqual(objectPolicy);
});
