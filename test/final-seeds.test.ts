import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { designBinding, protocolHash, readProtocol, taskTreeHash } from "../src/exp/protocol.ts";
import { FINAL_SEEDS_BYTES, finalSeedsPath, finalSeedsHash, readFinalSeeds, validateFinalSeeds } from "../src/exp/final.ts";
import { runAttempt } from "../src/exp/attempts.ts";
import { appendEvent, openStudy, readLedger, sha256 } from "../src/study.ts";
import { fakeDocker, fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), CANDIDATE = "b".repeat(40);
const protocol = (seeds = [1, 2, 3, 4]) => ({ v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] }, evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds, limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 10, maxWallHours: 1, maxGpuHours: 0 } });
async function study(seeds = [1, 2, 3, 4], autonomy = "gates") {
  const dir = tempDir(); ops.init(dir, { question: "synthetic", mode: "experiment", autonomy }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, protocol(seeds), ctx); return dir;
}

test("absent final seeds preserve protocol-only and selection-inclusive seal bytes and approval", async () => {
  const dir = await study(), pfile = join(dir, "design", "protocol.json");
  const original = sha256(JSON.stringify([sha256(readFileSync(pfile)), taskTreeHash(dir)])); expect(designBinding(dir)).toBe(original);
  await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  expect(readFinalSeeds(dir, readProtocol(dir)!)).toBeUndefined(); expect(finalSeedsHash(dir, readProtocol(dir)!)).toBeUndefined();
  expect(ops.gateList(dir).find(g => g.gate === "design")!.state).toBe("approved");
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  const selected = sha256(JSON.stringify([sha256(readFileSync(pfile)), taskTreeHash(dir), sha256(readFileSync(join(dir, "design", "selection.json")))]));
  expect(designBinding(dir)).toBe(selected); expect(existsSync(finalSeedsPath(dir))).toBe(false);
});

test("new/changed reservations join the seal; identical bytes preserve approval and event count", async () => {
  const dir = await study(); await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  const identity = protocolHash(readProtocol(dir)!), before = designBinding(dir), result = await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx);
  expect(result.changed).toBe(true); expect(result.gate.state).toBe("pending"); expect(designBinding(dir)).not.toBe(before);
  expect(designBinding(dir)).toBe(sha256(JSON.stringify([sha256(readFileSync(join(dir, "design", "protocol.json"))), taskTreeHash(dir), result.sha256])));
  expect(readFinalSeeds(dir, readProtocol(dir)!)).toEqual({ v: 1, seeds: [4] });
  await ops.gateDecide(dir, "design", "approve", undefined, ctx); const ledger = readFileSync(join(dir, "ledger.jsonl"));
  expect((await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx)).changed).toBe(false); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  expect(ops.gateList(dir).find(g => g.gate === "design")!.state).toBe("approved");
  expect((await ops.finalSeeds(dir, { v: 1, seeds: [3] }, ctx)).gate.state).toBe("pending"); expect(protocolHash(readProtocol(dir)!)).toBe(identity);
});

test("seed validation enforces declared integers, uniqueness, nonempty half limit and closed fields without writes", async () => {
  const dir = await study(); await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx);
  const bytes = readFileSync(finalSeedsPath(dir)), ledger = readFileSync(join(dir, "ledger.jsonl"));
  for (const [raw, message] of [
    [{ v: 1, seeds: [] }, "nonempty"], [{ v: 1, seeds: [99] }, "undeclared"], [{ v: 1, seeds: [1.5] }, "undeclared"],
    [{ v: 1, seeds: [4, 4] }, "duplicate"], [{ v: 1, seeds: [1, 2, 3] }, "half"], [{ v: 1, seeds: [4], extra: true }, "unknown field"],
  ] as [unknown, string][]) {
    await expect(ops.finalSeeds(dir, raw, ctx)).rejects.toThrow(message); expect(readFileSync(finalSeedsPath(dir))).toEqual(bytes); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  }
  expect(validateFinalSeeds({ v: 1, seeds: [3, 4] }, readProtocol(dir)!)).toEqual({ v: 1, seeds: [3, 4] });
  const odd = await study([1, 2, 3]); await expect(ops.finalSeeds(odd, { v: 1, seeds: [2, 3] }, ctx)).rejects.toThrow("at most 1");
  const one = await study([1]); await expect(ops.finalSeeds(one, { v: 1, seeds: [1] }, ctx)).rejects.toThrow("at least two");
});

test("protocol edits cannot drop reserved seeds or shrink below the half limit", async () => {
  const dir = await study(); await ops.finalSeeds(dir, { v: 1, seeds: [3, 4] }, ctx);
  const file = join(dir, "design", "protocol.json"), bytes = readFileSync(file), ledger = readFileSync(join(dir, "ledger.jsonl"));
  await expect(ops.protocol(dir, protocol([1, 2, 3, 5]), ctx)).rejects.toThrow("undeclared seed");
  await expect(ops.protocol(dir, protocol([3, 4]), ctx)).rejects.toThrow("half");
  expect(readFileSync(file)).toEqual(bytes); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
});

test("unsupported final versions and oversized files refuse replacement without data loss", async () => {
  const dir = await study(); await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx);
  const ledger = readFileSync(join(dir, "ledger.jsonl"));
  for (const value of ['{"v":99,"seeds":[4]}', "x".repeat(FINAL_SEEDS_BYTES + 1), "{malformed"]) {
    writeFileSync(finalSeedsPath(dir), value);
    expect(() => designBinding(dir)).toThrow(); await expect(ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx)).rejects.toThrow();
    await expect(ops.protocol(dir, protocol(), ctx)).rejects.toThrow();
    expect(readFileSync(finalSeedsPath(dir), "utf8")).toBe(value); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  }
});

test("reserved attempts refuse before Git, records, containers or auto approval; nonreserved attempts reach normal design gating", async () => {
  const dir = await study(undefined, "auto"); await ops.finalSeeds(dir, { v: 1, seeds: [1] }, ctx);
  await ops.executorSet(dir, { v: 1, kind: "local", workdir: "/private/synthetic" }, ctx);
  const ledger = readFileSync(join(dir, "ledger.jsonl")); let calls = 0;
  for (const run of ["main", "investigate", "ablate", "posthoc", "final"]) await expect(runAttempt(dir, { repo: "/synthetic", commit: BASE, seed: 1, run, detach: true }, { actor, runner: async () => { calls++; throw new Error("must not run"); } })).rejects.toThrow(run === "final" ? "selection missing" : "reserved");
  await expect(runAttempt(dir, { repo: "/synthetic", commit: BASE, detach: true }, { actor, runner: async () => { calls++; throw new Error("must not run"); } })).rejects.toThrow("reserved");
  expect(calls).toBe(0); expect(existsSync(join(dir, "runs"))).toBe(false); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  const other = await study(); await ops.finalSeeds(other, { v: 1, seeds: [4] }, ctx); await ops.executorSet(other, { v: 1, kind: "local", workdir: "/private/synthetic" }, ctx);
  const fake = fakeDocker([{ exitCode: 0, stdout: "commit", stderr: "" }, { exitCode: 0, stdout: "b".repeat(40), stderr: "" }]);
  await expect(runAttempt(other, { repo: "/synthetic", commit: BASE, seed: 1, detach: true }, { actor, runner: fake.runner })).rejects.toThrow("design is pending"); expect(fake.requests.every(r => r.command === "git")).toBe(true);
});

let serial = 0;
function evidence(dir: string, frozen: string, seed: number, value: number, options: {run?: string; status?: "running" | "succeeded" | "failed" | "cancelled" | "unknown"} = {}) {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, run = options.run ?? "investigate", folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit: frozen, seed, protocolHash: protocolHash(protocol), protocol, executor: {}, stages: {}, stage: "evaluator", status: options.status ?? "succeeded", startedAt: "2030-01-01T00:00:00Z", metrics: [{ name: "score", value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run, commit: frozen, seed }); return id;
}
test("investigation lists reserved seeds as excluded, preserves totals and changes the reservation input fingerprint", async () => {
  const dir = await study(); await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  evidence(dir, BASE, 1, 10); evidence(dir, CANDIDATE, 1, 12);
  const before = ops.investigateShow(dir); await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx);
  // Imported/synthetic exploratory records must still be excluded if they use a reservation.
  const a = evidence(dir, BASE, 4, 1000), b = evidence(dir, CANDIDATE, 4, 10000); const result = ops.investigateShow(dir);
  expect(result.winner?.delta).toBe(2); expect(result.totals.attempts).toBe(4); expect(result.totals.byStatus.succeeded).toBe(4);
  expect(result.totals.countedSuccesses).toBe(2); expect(result.excluded.filter(e => e.reasons.includes("reserved-seed")).map(e => e.id)).toEqual([a, b]);
  expect(result.inputsSha256).not.toBe(before.inputsSha256);
});

test("CLI and MCP share final-seed validation and survey refuses without writes", async () => {
  const a = await study(), b = await study(), payload = { v: 1, seeds: [4] };
  const cli = await run(["final", "seeds", a, "--file", "-", "--json"], { CODEX_THREAD_ID: "synthetic" }, { http: ctx.http, readStdin: async () => JSON.stringify(payload) });
  const server = createAresMcp({}, ctx.http), tool = ARES_TOOLS.find(t => t.name === "ares_final_seeds")!;
  expect(validArguments({ study: b, final: payload }, tool.inputSchema)).toBe(true);
  const mcp = await server.handlers.ares_final_seeds!({ study: b, final: payload }); expect((mcp as {final:unknown}).final).toEqual(JSON.parse(cli.text).final);
  expect(ops.manifest().formats.experimentFinalSeeds).toBe(1);
  const survey = tempDir(); ops.init(survey, { question: "synthetic" }, ctx); const before = readFileSync(join(survey, "ledger.jsonl"));
  await expect(ops.finalSeeds(survey, payload, ctx)).rejects.toThrow("experiment"); expect(readFileSync(join(survey, "ledger.jsonl"))).toEqual(before);
});

test("selection and final seed hashes occupy independent seal components, including raw formatting", async () => {
  const dir = await study(); await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx);
  const components = [sha256(readFileSync(join(dir, "design", "protocol.json"))), taskTreeHash(dir), sha256(readFileSync(join(dir, "design", "selection.json"))), sha256(readFileSync(finalSeedsPath(dir)))];
  expect(designBinding(dir)).toBe(sha256(JSON.stringify(components)));
  await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  writeFileSync(finalSeedsPath(dir), '{"v":1,"seeds":[4]}');
  expect(designBinding(dir)).not.toBe(sha256(JSON.stringify(components)));
  expect(ops.gateList(dir).find(g => g.gate === "design")!.state).toBe("pending");
});

test("a reservation added during snapshot resolution fences the attempt before creating a record", async () => {
  const dir = await study(); await ops.executorSet(dir, { v: 1, kind: "local", workdir: "/private/synthetic" }, ctx);
  let calls = 0;
  await expect(runAttempt(dir, { repo: "/synthetic", commit: BASE, seed: 4, detach: true }, { actor, runner: async request => {
    expect(request.command).toBe("git"); calls++;
    if (request.args.includes("cat-file")) { await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx); return { exitCode: 0, stdout: "commit", stderr: "" }; }
    return { exitCode: 0, stdout: "b".repeat(40), stderr: "" };
  } })).rejects.toThrow("design: changed");
  expect(calls).toBe(2); expect(readLedger(dir).filter(e => e.type === "attempt.started")).toHaveLength(0);
  expect(existsSync(join(dir, "runs"))).toBe(false);
});


test("new reservations refuse seeds seen in any run and status on API, CLI and MCP before writes", async () => {
  for (const [runName, status] of [["main", "running"], ["investigate", "succeeded"], ["ablate", "failed"], ["final", "cancelled"], ["posthoc", "unknown"]] as const) {
    const dir = await study(); evidence(dir, BASE, 4, 10, { run: runName, status });
    const before = readFileSync(join(dir, "ledger.jsonl")), rule = { v: 1, seeds: [4] };
    await expect(ops.finalSeeds(dir, rule, ctx)).rejects.toThrow("seed 4 was already used");
    await expect(run(["final", "seeds", dir, "--file", "-"], {}, { http: ctx.http, readStdin: async () => JSON.stringify(rule) })).rejects.toThrow("choose an unused declared seed");
    const server = createAresMcp({}, ctx.http);
    await expect(server.handlers.ares_final_seeds!({ study: dir, final: rule })).rejects.toThrow("seed 4 was already used");
    expect(existsSync(finalSeedsPath(dir))).toBe(false); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
  }
});

test("identical reserved bytes remain a no-op after use, but a changed value containing a used seed refuses", async () => {
  const dir = await study(); await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx);
  await ops.gateDecide(dir, "design", "approve", undefined, ctx); evidence(dir, BASE, 4, 10, { run: "final" });
  const before = readFileSync(join(dir, "ledger.jsonl")), bytes = readFileSync(finalSeedsPath(dir));
  expect((await ops.finalSeeds(dir, { v: 1, seeds: [4] }, ctx)).changed).toBe(false);
  expect(ops.gateList(dir).find(g => g.gate === "design")!.state).toBe("approved");
  await expect(ops.finalSeeds(dir, { v: 1, seeds: [3, 4] }, ctx)).rejects.toThrow("seed 4 was already used");
  expect(readFileSync(finalSeedsPath(dir))).toEqual(bytes); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});
