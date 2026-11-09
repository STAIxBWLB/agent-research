import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init, protocol as setProtocol } from "../src/commands.ts";
import { designBinding, protocolHash, readProtocol, taskTreeHash, validateProtocol } from "../src/exp/protocol.ts";
import { stageDesignBinding, stageProtocolHash, validateStageProtocol } from "../src/exp/stages.ts";
import { readLedger } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
function fixture() {
  const execution = { image: `synthetic@sha256:${"a".repeat(64)}`, command: ["/bin/run", " spaced argv "], seed: true, code: "snapshot", needs: [] as string[], inputs: {}, outputs: {} };
  return {
    v: 2, method: "synthetic pipeline",
    candidate: { stages: [
      { ...execution, name: "prepare", inputs: { data: { task: "data/train.json" } }, outputs: { rows: "rows.json" } },
      { ...execution, name: "train", env: { MODE: "fixture" }, needs: ["prepare"], inputs: { rows: { stage: "prepare", output: "rows" } }, outputs: { model: "model.bin" } },
      { ...execution, name: "predict", seed: false, needs: ["train"], inputs: { model: { stage: "train", output: "model" } }, outputs: { predictions: "predictions.json" } },
    ] },
    evaluator: { image: `synthetic@sha256:${"b".repeat(64)}`, command: ["/bin/evaluate"] },
    metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [0, 1], network: "none",
    limits: { cpus: 1, memoryMb: 128, pidsLimit: 64, wallSeconds: 60, gpus: 0 },
    budget: { maxAttempts: 5, maxWallHours: 1, maxGpuHours: 0 },
  };
}
function changedStage(change: Record<string, unknown>, index = 1) {
  const p = fixture();
  return { ...p, candidate: { stages: p.candidate.stages.map((stage, i) => i === index ? { ...stage, ...change } : stage) } };
}

test("T1: three-stage dataflow retains explicit order, distinct edges, frozen code and argv bytes", () => {
  const p = validateStageProtocol(fixture());
  expect(p.candidate.stages.map(s => s.name)).toEqual(["prepare", "train", "predict"]);
  expect(p.candidate.stages[1]?.inputs.rows).toEqual({ stage: "prepare", output: "rows" });
  expect(p.candidate.stages[1]?.needs).toEqual(["prepare"]);
  expect(p.candidate.stages[2]?.seed).toBe(false);
  expect(p.candidate.stages[0]?.command[1]).toBe(" spaced argv ");
  expect(p.evaluator.command).toEqual(["/bin/evaluate"]);
  expect(p.limits.wallSeconds).toBe(60);
  // Data edges imply consumption; ordering-only edges do not manufacture inputs.
  expect(validateStageProtocol(changedStage({ needs: [] })).candidate.stages[1]?.needs).toEqual([]);
  expect(validateStageProtocol(changedStage({ inputs: {} })).candidate.stages[1]?.inputs).toEqual({});
});

test("T1: cycles, forward/unknown edges, duplicate names and undeclared outputs refuse", () => {
  for (const p of [
    changedStage({ name: "prepare" }), changedStage({ needs: ["train"] }), changedStage({ needs: ["predict"] }),
    changedStage({ needs: ["absent"] }), changedStage({ needs: ["prepare", "prepare"] }),
    changedStage({ inputs: { model: { stage: "predict", output: "predictions" } } }),
    changedStage({ inputs: { rows: { stage: "prepare", output: "missing" } } }),
    changedStage({ inputs: { rows: { stage: "train", output: "model" } } }),
    changedStage({ needs: ["predict"] }, 0),
  ]) expect(() => validateStageProtocol(p)).toThrow();
});

test("T1: unsafe paths, mixed/undeclared sources, reserved ports and overlapping outputs refuse", () => {
  for (const path of ["/etc/passwd", "../outside", "data/../file", "data//file", "data/", ".", "data/./file", "a,b", "a:b", "a\\b", "a\nfile"]) {
    expect(() => validateStageProtocol(changedStage({ inputs: { data: { task: path } } }))).toThrow("relative path");
    expect(() => validateStageProtocol(changedStage({ outputs: { data: path } }))).toThrow("relative path");
  }
  for (const change of [
    { inputs: { data: { task: "evaluator/run" } } },
    { inputs: { data: { task: "file", stage: "prepare", output: "rows" } } },
    { inputs: { data: { path: "/private/file" } } },
    { inputs: { data: { stage: "prepare", output: "rows", mount: "/out" } } },
    { outputs: { one: "dir", two: "dir/file" } }, { outputs: { one: "file", two: "file" } },
    { outputs: { constructor: "file" } }, { inputs: { evaluator: { task: "file" } } },
  ]) expect(() => validateStageProtocol(changedStage(change))).toThrow();
});

test("T1: execution isolation, env, schema, count and aggregate definition bounds reuse v1 constraints", () => {
  for (const change of [
    { image: "synthetic:latest" }, { env: { TOKEN: "synthetic" } }, { env: { ARES_SEED: "123" } },
    { env: { constructor: "synthetic" } }, { env: { "BAD-NAME": "synthetic" } },
    { command: [] }, { command: "sh -c run" }, { command: [""] },
    { code: "/mutable/repo" }, { seed: "yes" }, { needs: undefined }, { outputs: undefined },
    { privileged: true }, { inputs: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`input${i}`, { task: "data" }])) },
  ]) expect(() => validateStageProtocol(changedStage(change))).toThrow();
  const p = fixture();
  for (const change of [
    { v: 3 }, { inputs: {} }, { network: "host" }, { limits: { ...p.limits, wallSeconds: 0 } },
    { candidate: { stages: [] } }, { candidate: { stages: Array(17).fill(p.candidate.stages[0]) } },
    { evaluator: { ...p.evaluator, env: { MODE: "fixture" } } },
  ]) expect(() => validateStageProtocol({ ...p, ...change })).toThrow();
  const stages = Array.from({ length: 16 }, (_, i) => ({ ...p.candidate.stages[0], name: `stage${i}`, command: ["run", "x".repeat(4096)] }));
  expect(() => validateStageProtocol({ ...p, candidate: { stages } })).toThrow("too large");
});

test("T1: every stage field and data/order edge changes attempt identity; budget changes the seal only", () => {
  const p = validateStageProtocol(fixture()), tree = "c".repeat(64), hash = stageProtocolHash(p), seal = stageDesignBinding(p, tree);
  for (const change of [
    { name: "learn" }, { image: `synthetic@sha256:${"c".repeat(64)}` }, { command: ["run", "changed"] },
    { env: { MODE: "changed" } }, { seed: false }, { needs: [] }, { inputs: {} },
    { inputs: { rows: { task: "data/train.json" } } }, { outputs: { model: "changed.bin" } },
  ]) {
    // Rename train only when no downstream reference uses it.
    const raw = changedStage(change); raw.candidate.stages = raw.candidate.stages.slice(0, 2);
    const base = fixture(); base.candidate.stages = base.candidate.stages.slice(0, 2);
    expect(stageProtocolHash(validateStageProtocol(raw))).not.toBe(stageProtocolHash(validateStageProtocol(base)));
  }
  const budget = { ...p, budget: { ...p.budget, maxAttempts: 6 } };
  expect(stageProtocolHash(budget)).toBe(hash);
  expect(stageDesignBinding(budget, tree)).not.toBe(seal);
  expect(stageDesignBinding(p, "d".repeat(64))).not.toBe(seal);
  expect(() => stageDesignBinding(p, "invalid")).toThrow("SHA-256");
  const reordered = { ...p, candidate: { stages: p.candidate.stages.map(s => ({ ...s, env: { B: "b", A: "a" } })) } };
  const same = { ...reordered, candidate: { stages: reordered.candidate.stages.map(s => ({ ...s, env: { A: "a", B: "b" } })) } };
  expect(stageProtocolHash(reordered)).toBe(stageProtocolHash(same));
});

test("T1: v1 identity and files stay unchanged; command refuses unsupported future versions before mutation", async () => {
  const dir = tempDir(); init(dir, { question: "Synthetic?", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeFileSync(join(dir, "task", "task.md"), "synthetic task");
  const p = fixture(), legacy = validateProtocol({ ...p, v: 1, candidate: { image: p.candidate.stages[0]!.image, command: ["run"] } });
  await setProtocol(dir, legacy, ctx);
  const file = join(dir, "design", "protocol.json"), before = readFileSync(file), ledger = readLedger(dir), hash = protocolHash(legacy), binding = designBinding(dir);
  for (const v of [3, 4]) {
    await expect(setProtocol(dir, { ...p, v }, ctx)).rejects.toThrow("compatible ares release");
    expect(readFileSync(file)).toEqual(before);
    expect(readLedger(dir)).toEqual(ledger);
    expect(protocolHash(readProtocol(dir)!)).toBe(hash);
    expect(designBinding(dir)).toBe(binding);
    expect(existsSync(join(dir, "attempts"))).toBe(false);
  }
  // The existing bounded snapshot validator supplies link safety, not the pure graph validator.
  symlinkSync("task.md", join(dir, "task", "link"));
  expect(() => taskTreeHash(dir)).toThrow("symlink refused");
});

test("large evaluator bytes count once, while the actual v2 aggregate ceiling still applies", () => {
  const p = fixture();
  p.candidate.stages = p.candidate.stages.slice(0, 1);
  p.evaluator.command = ["evaluate", ...Array<string>(9).fill("x".repeat(4000))];
  const formattedBytes = Buffer.byteLength(JSON.stringify(p, null, 2) + "\n");
  expect(formattedBytes).toBeGreaterThan(36_000);
  expect(formattedBytes).toBeLessThan(65_536);
  const normalized = validateStageProtocol(p);
  expect(normalized.evaluator.command).toEqual(p.evaluator.command);
  expect(stageProtocolHash(normalized)).toMatch(/^[a-f0-9]{64}$/);
  // Neither the common validator nor per-stage validation may combine the real evaluator twice.
  const largeStage = { ...p.candidate.stages[0]!, command: ["run", ...Array<string>(6).fill("y".repeat(4000))] };
  const nearLimit = { ...p, candidate: { stages: [largeStage] } };
  expect(Buffer.byteLength(JSON.stringify(nearLimit, null, 2) + "\n")).toBeLessThan(65_536);
  expect(validateStageProtocol(nearLimit).candidate.stages[0]?.command).toEqual(largeStage.command);
  const overflow = { ...p, candidate: { stages: [{ ...largeStage, command: [...largeStage.command, ...Array<string>(2).fill("z".repeat(4000))] }] } };
  expect(Buffer.byteLength(JSON.stringify(overflow, null, 2) + "\n")).toBeGreaterThan(65_536);
  expect(() => validateStageProtocol(overflow)).toThrow("protocol: too large");
});

test("refusals identify the stage and offending input/output port", () => {
  const stageLabel = "candidate.stages[1](train)";
  expect(() => validateStageProtocol(changedStage({ inputs: { rows: { task: "../outside" } } }))).toThrow(`${stageLabel}.inputs.rows.task`);
  expect(() => validateStageProtocol(changedStage({ inputs: { rows: { stage: "prepare", output: "missing" } } }))).toThrow(`${stageLabel}.inputs.rows`);
  expect(() => validateStageProtocol(changedStage({ inputs: { rows: { task: "evaluator/run" } } }))).toThrow(`${stageLabel}.inputs.rows`);
  expect(() => validateStageProtocol(changedStage({ outputs: { one: "dir", two: "dir/file" } }))).toThrow(`${stageLabel}.outputs.two`);
  expect(() => validateStageProtocol(changedStage({ env: { TOKEN: "synthetic" } }))).toThrow(`${stageLabel}.env`);
});
