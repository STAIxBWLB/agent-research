import { run as runCli } from "../src/cli.ts";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../src/commands-table.ts";
import { executorSet, init, protocol, retentionInspect, retentionPrune } from "../src/commands.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { prepareCommit, readLedger, sha256 } from "../src/study.ts";
import type { ProcessRequest, ProcessRunner } from "../src/exp/executor.ts";
import type { RetainedRef } from "../src/exp/retention.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const fingerprint = "a".repeat(64), refs: RetainedRef[] = [{ attemptId: "b".repeat(16), stage: "prepare", sha256: "c".repeat(64) }];
const base = { actor: { kind: "person" as const }, http: fakeHttp([]).http };
function transport() {
  const requests: Record<string, unknown>[] = [];
  let failure: string | undefined, malformed = false;
  const runner: ProcessRunner = async (request: ProcessRequest) => {
    if (!(request.stdin instanceof Uint8Array) && typeof request.stdin !== "string") throw new Error("synthetic request requires bounded JSON stdin");
    const raw = JSON.parse(typeof request.stdin === "string" ? request.stdin : new TextDecoder().decode(request.stdin)) as Record<string, unknown>;
    requests.push(raw);
    if (failure) return { exitCode: 1, stdout: JSON.stringify({error: failure}), stderr: "synthetic private diagnostic" };
    const response = raw.op === "inspect" ? { op: "inspect", entries: [], usedBytes: 0, reservedBytes: 0, capBytes: 1024 * 1024 * 1024 }
      : { op: "prune", fingerprint, pruned: raw.fingerprint === undefined ? 0 : malformed ? 0 : 1 };
    return { exitCode: 0, stdout: JSON.stringify(response), stderr: "" };
  };
  return { runner, requests, fail: (reason: string | undefined) => {failure = reason;}, malformed: () => {malformed = true;} };
}
async function study(autonomy = "auto", withProtocol = true, mode = "experiment") {
  const dir = tempDir(); init(dir, { question: "Synthetic retained evidence?", mode, autonomy }, base);
  await executorSet(dir, {v: 1, kind: "local", workdir: "/synthetic/executor"}, base);
  if (withProtocol) {
    mkdirSync(join(dir, "task", "evaluator"), {recursive: true});
    writeFileSync(join(dir, "task", "task.md"), "synthetic task");
    await protocol(dir, {v: 1, method: "synthetic", candidate: {image: `synthetic@sha256:${"d".repeat(64)}`, command: ["run"]}, evaluator: {image: `synthetic@sha256:${"e".repeat(64)}`, command: ["evaluate"]}, metrics: [{name: "score", unit: "points", direction: "max"}], seeds: [0], limits: {cpus: 1, memoryMb: 128, pidsLimit: 64, wallSeconds: 60, gpus: 0}, network: "none", budget: {maxAttempts: 2, maxWallHours: 1, maxGpuHours: 0}}, base);
  }
  return dir;
}

test("retention commands and MCP expose bounded closed inspect/prune parity", async () => {
  expect(COMMANDS.find(c => c.name === "retention inspect")?.mutates).toBe("network");
  expect(COMMANDS.find(c => c.name === "retention prune")?.options["--confirm"]).toBe("value");
  const inspect = ARES_TOOLS.find(t => t.name === "ares_retention_inspect")!;
  expect(inspect.annotations.readOnlyHint).toBe(true);
  expect(inspect.annotations.openWorldHint).toBe(true);
  const prune = ARES_TOOLS.find(t => t.name === "ares_retention_prune")!;
  expect(prune.annotations.destructiveHint).toBe(true);
  expect(prune.inputSchema.additionalProperties).toBe(false);
  const dir = await study(), fake = transport(), ctx = {...base, runner: fake.runner}, before = readLedger(dir);
  const mcp = createAresMcp({}, base.http, {runner: fake.runner});
  expect(await mcp.handlers.ares_retention_inspect!({study: dir})).toEqual(await retentionInspect(dir, ctx));
  expect(await mcp.handlers.ares_retention_prune!({study: dir, refs})).toEqual(await retentionPrune(dir, {refs}, ctx));
  expect(readLedger(dir)).toEqual(before);
  expect(fake.requests.map(q => q.op)).toEqual(["inspect", "inspect", "prune", "prune"]);
});

test("confirmed prune rechecks current design policy before executor and commits one actor-attributed success", async () => {
  const dir = await study(), fake = transport(), before = readLedger(dir);
  expect(await retentionPrune(dir, {refs, fingerprint}, {...base, runner: fake.runner})).toEqual({op: "prune", fingerprint, pruned: 1});
  const added = readLedger(dir).slice(before.length);
  expect(added.map(e => e.type)).toEqual(["gate.approve", "retention.pruned"]);
  expect(added[1]?.actor.kind).toBe("person");
  expect(added[1]?.data).toEqual({fingerprint, refsSha256: expect.stringMatching(/^[a-f0-9]{64}$/), count: 1, refs: refs.map(ref => [ref.attemptId, ref.stage, ref.sha256])});
  const gated = await study("gates"), gatedBefore = readLedger(gated), count = fake.requests.length;
  await expect(retentionPrune(gated, {refs, fingerprint}, {...base, runner: fake.runner})).rejects.toThrow("gate design is pending");
  expect(fake.requests.length).toBe(count);
  expect(readLedger(gated)).toEqual(gatedBefore);
});

test("failed/stale/active and malformed prune receipts never commit success or automatic approval", async () => {
  for (const reason of ["stale prune fingerprint", "active producer or consumer prevents prune", "retained source missing"]) {
    const dir = await study(), fake = transport(), before = readLedger(dir); fake.fail(reason);
    await expect(retentionPrune(dir, {refs, fingerprint}, {...base, runner: fake.runner})).rejects.toThrow(reason);
    expect(readLedger(dir)).toEqual(before);
  }
  const dir = await study(), fake = transport(), before = readLedger(dir); fake.malformed();
  await expect(retentionPrune(dir, {refs, fingerprint}, {...base, runner: fake.runner})).rejects.toThrow("invalid executor receipt");
  expect(readLedger(dir)).toEqual(before);
});

test("invalid reference selection and unsupported study mode refuse before executor reads", async () => {
  const dir = await study(), fake = transport(), ctx = {...base, runner: fake.runner}, before = readLedger(dir);
  for (const bad of [[], [...refs, ...refs], [{...refs[0]!, stage: "../escape"}], [{...refs[0]!, sha256: "bad"}], [{...refs[0]!, extra: "not admitted"}]]) {
    await expect(retentionPrune(dir, {refs: bad}, ctx)).rejects.toThrow();
  }
  await expect(retentionPrune(dir, {refs, fingerprint: "bad"}, ctx)).rejects.toThrow("invalid fingerprint");
  expect(fake.requests).toEqual([]); expect(readLedger(dir)).toEqual(before);
  const survey = tempDir(); init(survey, {question: "Synthetic?", mode: "survey"}, base);
  await expect(retentionInspect(survey, ctx)).rejects.toThrow("mode must be experiment");
  expect(fake.requests).toEqual([]);
});


test("retention inventory pages are shared by CLI and MCP and reject unsafe bounds before transport", async () => {
  const dir = await study(), fake = transport(), ctx = { ...base, runner: fake.runner }, server = createAresMcp({}, base.http, { runner: fake.runner });
  expect(await server.handlers.ares_retention_inspect!({ study: dir, offset: 200, limit: 25 })).toEqual(await retentionInspect(dir, ctx, { offset: 200, limit: 25 }));
  const cli = await runCli(["retention", "inspect", dir, "--offset", "200", "--limit", "25", "--json"], {}, { http: base.http, runner: fake.runner });
  expect(JSON.parse(cli.text).op).toBe("inspect");
  expect(fake.requests.map(request => [request.offset, request.limit])).toEqual([[200, 25], [200, 25], [200, 25]]);
  const before = fake.requests.length;
  for (const options of [{ offset: -1 }, { offset: 16000001 }, { limit: 0 }, { limit: 501 }]) await expect(retentionInspect(dir, ctx, options)).rejects.toThrow("offset");
  expect(fake.requests).toHaveLength(before);
});


test("prune can retain exact witnesses for all 500 maximum-width references within one event", async () => {
  const dir = await study(), selected = Array.from({length: 500}, (_, index) => ({attemptId: (index + 1).toString(16).padStart(16, "0"), stage: "s".repeat(32), sha256: "a".repeat(64)}));
  const prepared = prepareCommit(dir, [], [{actor: base.actor, type: "retention.pruned", data: {fingerprint, refsSha256: sha256(JSON.stringify(selected)), count: selected.length, refs: selected.map(ref => [ref.attemptId, ref.stage, ref.sha256])}}]);
  expect(prepared.events).toHaveLength(1); expect(Buffer.byteLength(prepared.lines[0]!)).toBeLessThanOrEqual(65536);
});
