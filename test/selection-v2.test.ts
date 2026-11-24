import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { protocolHash, readProtocol } from "../src/exp/protocol.ts";
import { investigateResultPath } from "../src/exp/investigate.ts";
import { appendEvent, openStudy, readLedger, sha256 } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
const BASE = "a".repeat(40), WIN = "b".repeat(40), OTHER = "c".repeat(40), THIRD = "d".repeat(40), TREE = "e".repeat(40);
const metrics = [
  { name: "score", unit: "points", direction: "max" },
  { name: "valid", unit: "ratio", direction: "max" },
  { name: "tokens", unit: "tokens", direction: "min" },
];
const v1 = { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 2, minDelta: 0.5 };
const v2 = { ...v1, v: 2, guards: [{ metric: "valid", maxRegression: 0.05 }],
  cost: { metric: "tokens", free: 0.1, perUnit: 0.05 } };

async function study(rule: unknown = v2) {
  const dir = tempDir();
  ops.init(dir, { question: "Synthetic paired experiments", mode: "experiment" }, ctx);
  const studyFile = join(dir, "study.json");
  const record = JSON.parse(readFileSync(studyFile, "utf8"));
  writeFileSync(studyFile, JSON.stringify({ ...record, id: "00000000-0000-4000-8000-000000000001" }));
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeFileSync(join(dir, "task", "task.md"), "synthetic");
  writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, {
    v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] },
    evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluate"] }, metrics, seeds: [1, 2, 3, 4, 5],
    limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none",
    budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 },
  }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [4, 5] }, ctx);
  await ops.selection(dir, rule, ctx);
  return dir;
}

function attempt(dir: string, commit: string, seed: number, values: (number | undefined)[], runName = "investigate", treeId = TREE) {
  const id = (readLedger(dir).length + 1).toString(16).padStart(16, "0");
  const protocol = readProtocol(dir)!, folder = join(dir, "runs", runName, "attempts");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({
    v: 1, id, studyId: openStudy(dir).study.id, run: runName, commit, treeId, seed, protocolHash: protocolHash(protocol),
    protocol, executor: {}, stages: {}, stage: "evaluator", status: "succeeded", startedAt: "2030-01-01T00:00:00Z",
    metrics: values.flatMap((value, i) => value === undefined ? [] : [{
      name: metrics[i]!.name, unit: metrics[i]!.unit, value, provenance: "ares-observed",
    }]), outputs: [],
  }));
  appendEvent(dir, actor, "attempt.started", { id, run: runName, commit, seed });
  return id;
}

test("v1 keeps its result bytes and v2 without optional criteria makes the same decision", async () => {
  const original = await study(v1), extended = await study({ ...v1, v: 2 });
  for (const dir of [original, extended]) for (const seed of [1, 2]) {
    attempt(dir, BASE, seed, [10]);
    attempt(dir, WIN, seed, [12]);
  }
  const closed = await ops.investigateClose(original, ctx);
  const bytes = readFileSync(investigateResultPath(original, "investigate"), "utf8");
  expect(bytes).toBe(JSON.stringify(closed, null, 2) + "\n");
  // Generated from the identical synthetic study on the last pre-v2 main.
  expect(sha256(bytes)).toBe("2897e42c50167d909a5e0a81b6b69b5e649c0ff3904a50d7bf9ab31ac21f814e");
  expect(bytes).not.toMatch(/guardDeltas|calibration|allowedGrowth/);
  const { ruleSha256: _r1, inputsSha256: _i1, ...expected } = closed;
  const { ruleSha256: _r2, inputsSha256: _i2, ...actual } = ops.investigateShow(extended);
  expect(actual).toEqual(expected);
  expect(await ops.investigateClose(original, ctx)).toEqual(closed);
  expect(readFileSync(investigateResultPath(original, "investigate"), "utf8")).toBe(bytes);
});

test("guard regression, missing guards and expensive gains cannot win over the eligible paired candidate", async () => {
  const dir = await study();
  for (const seed of [1, 2]) {
    attempt(dir, BASE, seed, [10, 0.9, 100]);
    attempt(dir, OTHER, seed, [20, 0.7, 110]);
    attempt(dir, THIRD, seed, [15, 0.9, 150]);
    attempt(dir, WIN, seed, [12, 0.9, 90]);
    attempt(dir, TREE, seed, [30, undefined, 100]);
  }
  const result = ops.investigateShow(dir), row = (commit: string) => result.candidates.find(candidate => candidate.commit === commit)!;
  expect(row(OTHER).reason).toBe("guard:valid");
  expect(row(OTHER).guardDeltas?.valid).toBeCloseTo(-0.2);
  expect(row(TREE).reason).toBe("guard-missing:valid");
  expect(row(THIRD).reason).toBe("cost-rule");
  expect(row(THIRD).cost).toEqual({ growth: 0.5, allowedGrowth: 0.35 });
  expect(row(WIN).cost?.growth).toBe(-0.1);
  expect(result.winner?.commit).toBe(WIN);
});

test("cost must use a declared min metric and a positive paired baseline", async () => {
  const dir = await study();
  const before = readLedger(dir);
  await expect(ops.selection(dir, { ...v2, cost: { metric: "valid", free: 0, perUnit: 0 } }, ctx)).rejects.toThrow("declared min metric");
  expect(readLedger(dir)).toEqual(before);
  for (const seed of [1, 2]) {
    attempt(dir, BASE, seed, [10, 1, 0]);
    attempt(dir, WIN, seed, [12, 1, 1]);
  }
  expect(() => ops.investigateShow(dir)).toThrow("baseline mean must be positive");
});

test("calibration uses earliest non-reserved successes and binds an advisory receipt shared by CLI and MCP", async () => {
  const dir = await study(v1), ruleFile = join(dir, "design", "selection.json");
  const design = readFileSync(ruleFile), ledger = readLedger(dir);
  await expect(ops.selectionCalibrate(dir, { fromRun: "baseline" }, ctx)).rejects.toThrow("at least three");
  expect(readLedger(dir)).toEqual(ledger);
  expect(existsSync(join(dir, "runs", "baseline", "calibration.json"))).toBe(false);
  const ids = [1, 2, 3].map(seed => attempt(dir, BASE, seed, [seed], "baseline"));
  attempt(dir, BASE, 1, [1000], "baseline");
  attempt(dir, BASE, 4, [1000], "baseline");
  attempt(dir, OTHER, 1, [1000], "baseline");

  const args = { study: dir, fromRun: "baseline" };
  const tool = ARES_TOOLS.find(entry => entry.name === "ares_selection_calibrate")!;
  expect(validArguments(args, tool.inputSchema)).toBe(true);
  const server = createAresMcp({}, ctx.http);
  const cli = await run(["selection", "calibrate", dir, "--from-run", "baseline", "--json"], {}, ctx);
  const receipt = JSON.parse(cli.text);
  expect(receipt).toEqual(await server.handlers.ares_selection_calibrate!(args));
  expect(receipt).toMatchObject({ method: "seed-sd", n: 3, z: 2, seeds: [1, 2, 3], attempts: ids });
  expect(receipt.sd).toBeCloseTo(1);
  expect(receipt.recommendedMinDelta).toBeCloseTo(2);
  expect(readFileSync(ruleFile)).toEqual(design);
  const latest = readFileSync(join(dir, "runs", "baseline", "calibration.json"));
  expect(sha256(latest)).toBe(receipt.sha256);
  expect(readLedger(dir).filter(event => event.type === "selection.calibrated")).toHaveLength(1);

  const selected = { ...v2, calibration: { sha256: receipt.sha256 } };
  await expect(ops.selection(dir, { ...v2, calibration: { sha256: "0".repeat(64) } }, ctx)).rejects.toThrow("no recorded calibration");
  expect(readFileSync(ruleFile)).toEqual(design);
  const selection = await server.handlers.ares_selection_set!({ study: dir, selection: selected });
  expect(selection).toMatchObject({ selection: selected, changed: true });
  for (const seed of [1, 2]) {
    attempt(dir, BASE, seed, [10, 1, 100]);
    attempt(dir, WIN, seed, [12, 1, 100]);
  }
  await ops.selectionCalibrate(dir, { fromRun: "baseline", z: 3 }, ctx);
  const view = JSON.parse((await run(["investigate", "show", dir, "--json"], {}, ctx)).text);
  expect(view).toEqual(await server.handlers.ares_investigate_show!({ study: dir }));
  expect(view.calibration).toMatchObject({ minDelta: 0.5, belowNoise: true });
  expect(view.calibration.recommendedMinDelta).toBeCloseTo(2);
  expect(view.winner.commit).toBe(WIN);
  expect((await run(["investigate", "show", dir], {}, ctx)).text).toContain("The sealed minimum delta is below the calibration recommendation");
});

test("malformed calibration CLI arguments are usage errors before any study read", () => {
  const cli = join(import.meta.dir, "..", "bin", "ares.js");
  for (const options of [[], ["--from-run", "../invalid"], ["--from-run", "baseline", "--null", "short"], ["--from-run", "baseline", "--z", "0"]]) {
    const child = Bun.spawnSync([process.execPath, cli, "selection", "calibrate", "missing-study", ...options]);
    expect(child.exitCode).toBe(2);
    expect(child.stdout.toString()).toBe("");
    expect(child.stderr.toString()).toContain("Usage: ares selection calibrate");
  }
});

test("A/A uses paired deltas only for identical recorded trees", async () => {
  const dir = await study(v1);
  for (const seed of [1, 2, 3]) {
    attempt(dir, BASE, seed, [10 * seed], "baseline");
    attempt(dir, OTHER, seed, [11 * seed], "baseline");
    attempt(dir, WIN, seed, [11 * seed], "baseline", "f".repeat(40));
  }
  await expect(ops.selectionCalibrate(dir, { fromRun: "baseline", nullCommit: WIN }, ctx)).rejects.toThrow("same recorded task tree id");
  const result = await ops.selectionCalibrate(dir, { fromRun: "baseline", nullCommit: OTHER }, ctx);
  expect(result).toMatchObject({ method: "aa", null: OTHER, n: 3 });
  expect(result.sd).toBeCloseTo(1);
  expect(result.recommendedMinDelta).toBeCloseTo(Math.SQRT2);
  expect(result.attempts).toHaveLength(6);
});

test("reserved final pairs independently enforce guards and cost", async () => {
  for (const [valid, cost, reason] of [[0.7, 100, "guard:valid"], [1, 130, "cost-rule"], [1, 90, undefined]] as const) {
    const dir = await study();
    for (const seed of [1, 2]) {
      attempt(dir, BASE, seed, [10, 1, 100]);
      attempt(dir, WIN, seed, [12, 1, 100]);
    }
    await ops.investigateClose(dir, ctx);
    await ops.gateDecide(dir, "design", "approve", undefined, ctx);
    await ops.gateDecide(dir, "final", "approve", undefined, ctx);
    for (const seed of [4, 5]) {
      attempt(dir, BASE, seed, [10, 1, 100], "final");
      attempt(dir, WIN, seed, [12, valid, cost], "final");
    }
    const result = await ops.finalClose(dir, ctx);
    expect(result.reason).toBe(reason);
    expect(result.status).toBe(reason ? "not_qualified" : "qualified");
  }
});
