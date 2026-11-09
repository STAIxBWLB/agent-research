import { expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import * as study from "../src/study.ts";
import { run } from "../src/cli.ts";
import { COMMANDS } from "../src/commands-table.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { executionView } from "../src/exp/pipeline.ts";
import { stageProtocolHash, validateStageProtocol } from "../src/exp/stages.ts";
import { REUSE_FACTS_OUTPUT_BYTES, REUSE_FACTS_TIMEOUT_MS, reuseSourceFacts } from "../src/exp/reuse-runtime.ts";
import type { Attempt, AttemptContext, AttemptOptions } from "../src/exp/attempts.ts";
import type { ProcessRequest, ProcessRunner } from "../src/exp/executor.ts";
import { metricAttempt, metricProtocol } from "./metric-fixtures.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const ctx = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
const platform = { v: 1, os: "linux", arch: "x86_64", kernel: "synthetic-kernel", libc: { name: "glibc", version: "synthetic-1" }, macVersion: "", cpuSha256: "f".repeat(64), uid: 1000, gid: 1000 };
const ok = (value: unknown = platform) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
async function fixture() {
  const dir = tempDir(), created = ops.init(dir, { question: "Synthetic reuse facts?", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic task");
  const p = metricProtocol(), definition = validateStageProtocol({ ...p, v: 2, seeds: [1, 2, 3, 4], candidate: { stages: [
    { name: "prepare", ...p.candidate, seed: true, code: "snapshot", needs: [], inputs: {}, outputs: { rows: "rows" } },
  ] } });
  await ops.protocol(dir, definition, ctx);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: "a".repeat(40) }, minSeeds: 1, minDelta: 0 }, ctx);
  const attempt = metricAttempt(); attempt.v = 2; attempt.studyId = created.study.id; attempt.run = "investigate"; attempt.stage = "candidate";
  attempt.protocol = executionView(definition); attempt.protocolHash = stageProtocolHash(definition);
  attempt.pipeline = { definition, index: 0, completed: [], inputHashes: {}, taskTreeHash: "a".repeat(64) };
  return { dir, attempt, selection: join(dir, "design", "selection.json"), final: join(dir, "design", "final.json") };
}


test("reuse controls have shared CLI/MCP option parity while default requests keep existing behavior", async () => {
  expect(COMMANDS.find(command => command.name === "attempt run")?.options["--reuse"]).toBe("value");
  expect(COMMANDS.find(command => command.name === "attempt run")?.options["--force-fresh"]).toBe("flag");
  const schema = ARES_TOOLS.find(tool => tool.name === "ares_attempt_run")!.inputSchema;
  const base = { study: "/synthetic/study", repo: "/synthetic/repo", commit: "a".repeat(40) };
  expect(validArguments({ ...base, reuse: "eligible", forceFresh: true }, schema)).toBe(true);
  expect(validArguments({ ...base, reuse: "automatic" }, schema)).toBe(false);
  expect(validArguments({ ...base, forceFresh: "yes" }, schema)).toBe(false);
  const mock = spyOn(ops, "attemptRun").mockResolvedValue(metricAttempt());
  try {
    const args = ["attempt", "run", base.study, "--repo", base.repo, "--commit", base.commit, "--detach", "--json"];
    await run([...args, "--reuse", "eligible", "--force-fresh"], {}, { http: ctx.http });
    const server = createAresMcp({}, ctx.http);
    await server.handlers.ares_attempt_run!({ ...base, reuse: "eligible", forceFresh: true });
    expect(mock.mock.calls[0]![1]).toEqual(mock.mock.calls[1]![1]);
    expect(mock.mock.calls[0]![1]).toMatchObject({ reuse: "eligible", forceFresh: true, detach: true });
    await run(args, {}, { http: ctx.http }); await server.handlers.ares_attempt_run!(base);
    for (const call of mock.mock.calls.slice(2)) {
      expect(call[1].reuse ?? "off").toBe("off"); expect(call[1].forceFresh ?? false).toBe(false);
    }
  } finally { mock.mockRestore(); }
  for (const options of [{ reuse: "automatic" }, { forceFresh: "yes" }]) {
    await expect(ops.attemptRun(base.study, { repo: base.repo, commit: base.commit, ...options } as AttemptOptions, ctx)).rejects.toThrow(options.reuse ? "off or eligible" : "boolean required");
  }
});

test("source-owned facts use isolated bounded executor probes and expose no executor locators", async () => {
  const f = await fixture(), requests: ProcessRequest[] = [], before = readFileSync(join(f.dir, "ledger.jsonl"));
  f.attempt.executor = { v: 1, kind: "ssh", host: "synthetic-private-alias", workdir: "/synthetic/private-executor" };
  const runner: ProcessRunner = async request => { requests.push(request); return ok(); };
  const result = await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner });
  expect("reason" in result).toBe(false);
  if ("reason" in result) throw new Error(result.reason);
  expect(result.populationSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(result.runtime.semantics).toMatch(/^ares-stage-v2\/reuse-1:[a-f0-9]{64}$/);
  expect(result.platform).toMatchObject({ os: "linux", arch: "x86_64" });
  expect(result.platform.abi).toMatch(/^cpu-v1:[a-f0-9]{64}$/);
  expect(JSON.stringify(result)).not.toContain("synthetic-private-alias"); expect(JSON.stringify(result)).not.toContain("/synthetic/private-executor");
  expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ command: "ssh", timeoutMs: REUSE_FACTS_TIMEOUT_MS, maxOutputBytes: REUSE_FACTS_OUTPUT_BYTES });
  expect(requests[0]!.args.slice(0, 3)).toEqual(["-o", "BatchMode=yes", "synthetic-private-alias"]);
  expect(requests[0]!.args).toContain("python3"); expect(requests[0]!.args).toContain("-I"); expect(requests[0]!.args).toContain("-S");
  expect(readFileSync(join(f.dir, "ledger.jsonl"))).toEqual(before);
});

test("population fingerprint is presence-aware and canonical and refuses changes during probing", async () => {
  const f = await fixture(), runner: ProcessRunner = async () => ok();
  const original = await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner });
  if ("reason" in original) throw new Error(original.reason);
  const selection = JSON.parse(readFileSync(f.selection, "utf8"));
  writeFileSync(f.selection, JSON.stringify(Object.fromEntries(Object.entries(selection).reverse())));
  const reordered = await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner });
  expect(reordered).toEqual(original);
  await ops.finalSeeds(f.dir, { v: 1, seeds: [3] }, ctx);
  const reserved = await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner });
  if ("reason" in reserved) throw new Error(reserved.reason);
  expect(reserved.populationSha256).not.toBe(original.populationSha256);
  unlinkSync(f.final);
  expect(await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner })).toEqual(original);
  const changed = await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner: async () => { writeFileSync(f.selection, JSON.stringify({ ...selection, minDelta: 1 })); return ok(); } });
  expect(changed).toEqual({ reason: "population-changed" });
});

test("runtime source and actual platform/executor changes invalidate identities without a version bump", async () => {
  const f = await fixture(), runner: ProcessRunner = async () => ok(), baseline = await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner });
  if ("reason" in baseline) throw new Error(baseline.reason);
  const originalReader = study.readBytesBounded;
  const mock = spyOn(study, "readBytesBounded").mockImplementation((file, bound, options) => String(file).endsWith("/attempts.ts") ? Buffer.from("synthetic changed producer implementation") : originalReader(file, bound, options));
  try {
    const sourceChanged = await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner });
    if ("reason" in sourceChanged) throw new Error(sourceChanged.reason);
    expect(sourceChanged.runtime.producerVersion).toBe(baseline.runtime.producerVersion);
    expect(sourceChanged.runtime.semantics).not.toBe(baseline.runtime.semantics);
  } finally { mock.mockRestore(); }
  const platformChanged = await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner: async () => ok({ ...platform, libc: { name: "glibc", version: "synthetic-2" } }) });
  if ("reason" in platformChanged) throw new Error(platformChanged.reason);
  expect(platformChanged.platform.abi).not.toBe(baseline.platform.abi);
  f.attempt.executor = { ...f.attempt.executor, workdir: "/synthetic/other-executor" };
  const executorChanged = await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner });
  if ("reason" in executorChanged) throw new Error(executorChanged.reason);
  expect(executorChanged.platform.abi).not.toBe(baseline.platform.abi);
});

test("forbidden phases, missing population and unsupported GPU never probe; missing platform facts stay misses", async () => {
  const f = await fixture(); let called = 0;
  const runner: ProcessRunner = async () => { called++; return ok(); };
  for (const runName of ["main", "ablate", "final", "posthoc"]) expect(await reuseSourceFacts(f.dir, { ...f.attempt, run: runName }, { ...ctx, runner })).toEqual({ reason: "outside-investigation" });
  expect(await reuseSourceFacts(f.dir, { ...f.attempt, stage: "evaluator" }, { ...ctx, runner })).toEqual({ reason: "outside-investigation" });
  f.attempt.pipeline!.definition.limits.gpus = 1;
  expect(await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner })).toEqual({ reason: "unsupported-gpu-abi" });
  f.attempt.pipeline!.definition.limits.gpus = 0;
  unlinkSync(f.selection); expect(await reuseSourceFacts(f.dir, f.attempt, { ...ctx, runner })).toEqual({ reason: "outside-investigation" });
  expect(called).toBe(0);
  const ready = await fixture();
  for (const value of [{ ...platform, arch: "mystery" }, { ...platform, libc: { name: "", version: "" } }, { ...platform, v: 2 }, { ...platform, extra: "private" }]) expect(await reuseSourceFacts(ready.dir, ready.attempt, { ...ctx, runner: async () => ok(value) })).toEqual({ reason: "unsupported-platform" });
  expect(await reuseSourceFacts(ready.dir, ready.attempt, { ...ctx, runner: async () => ({ exitCode: 255, stdout: "", stderr: "synthetic private error" }) })).toEqual({ reason: "platform-unavailable" });
});

test("plan attempt steps propagate reuse controls admitted by the shared command table", async () => {
  const f = await fixture();
  await ops.executorSet(f.dir, { v: 1, kind: "local", workdir: "/synthetic/executor" }, ctx);
  await ops.gateDecide(f.dir, "design", "approve", undefined, ctx);
  await ops.planSet(f.dir, { v: 1, revision: 1, nodes: [{ id: "run", kind: "step", command: "attempt.run", args: { repo: "/synthetic/repo", commit: "a".repeat(40), run: "investigate", reuse: "eligible", "force-fresh": true } }], edges: [] }, ctx);
  const runner: ProcessRunner = async request => {
    if (request.command === "git") return { exitCode: 0, stdout: request.args.includes("cat-file") ? "commit" : "b".repeat(40), stderr: "" };
    if (request.command === "python3" && request.stdin instanceof Uint8Array) return { exitCode: 0, stdout: JSON.stringify({ op: JSON.parse(new TextDecoder().decode(request.stdin)).op }), stderr: "" };
    if (request.command === "docker") return { exitCode: 1, stdout: "", stderr: "synthetic unavailable" };
    throw new Error("unexpected synthetic plan fixture operation");
  };
  let resumed = false;
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 4000);
  try {
    await ops.planRun(f.dir, {}, { ...ctx, runner, signal: controller.signal, sleep: async () => {
      if (!resumed) { resumed = true; await ops.planControl(f.dir, { action: "resume", expectedRevision: 1, commandId: "synthetic-resume" }, ctx); }
      if (resumed && ops.planShow(f.dir).nodes[0]?.status === "failed") controller.abort();
      await Bun.sleep(1);
    } });
  } finally { clearTimeout(timer); }
  const node = ops.planShow(f.dir).nodes[0]!;
  expect(node.status).toBe("failed");
  const attempts = ops.attemptList(f.dir, {});
  expect(attempts.attempts).toHaveLength(1);
  const attempt = ops.attemptShow(f.dir, attempts.attempts[0]!.id);
  expect(attempt.v).toBe(3); expect(attempt.reuse).toMatchObject({ mode: "eligible", forceFresh: true });
}, 10_000);


test("plan set refuses invalid reuse controls atomically through shared CLI handler and MCP", async () => {
  const f = await fixture(), server = createAresMcp({}, ctx.http);
  const definition = (args: Record<string, unknown>) => ({ v: 1, nodes: [{ id: "run", kind: "step", command: "attempt.run", args: { repo: "/synthetic/repo", commit: "a".repeat(40), ...args } }], edges: [] });
  await ops.planSet(f.dir, definition({ reuse: "off", "force-fresh": false }), ctx);
  const before = study.readBytesBounded(join(f.dir, "plan.json"), 65536), ledger = study.readLedger(f.dir);
  for (const args of [{ reuse: "automatic" }, { reuse: 0 }, { reuse: null }, { "force-fresh": "true" }, { "force-fresh": 1 }, { "force-fresh": null }]) {
    await expect(ops.planSet(f.dir, definition(args), ctx)).rejects.toThrow("run ares plan set again");
    await expect(server.handlers.ares_plan_set!({ study: f.dir, plan: definition(args) })).rejects.toThrow("run ares plan set again");
    expect(study.readBytesBounded(join(f.dir, "plan.json"), 65536)).toEqual(before);
    expect(study.readLedger(f.dir)).toEqual(ledger);
  }
  // A mode accepted before enum validation remains inspectable and can be corrected by plan set.
  const old = JSON.parse(new TextDecoder().decode(before)); old.nodes[0].args.reuse = "automatic";
  study.writeAtomic(join(f.dir, "plan.json"), JSON.stringify(old), 65536);
  for (const mode of ["off", "eligible"]) for (const force of [false, true]) {
    const result = await ops.planSet(f.dir, definition({ reuse: mode, "force-fresh": force }), ctx);
    expect(result.definition.nodes[0]).toMatchObject({ args: { reuse: mode, "force-fresh": force } });
  }
});
