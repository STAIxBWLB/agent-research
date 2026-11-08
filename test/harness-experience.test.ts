import {expect, test} from "bun:test";
import {existsSync, symlinkSync} from "node:fs";
import {join} from "node:path";
import * as ops from "../src/commands.ts";
import {run} from "../src/cli.ts";
import {createAresMcp} from "../src/mcp-tools.ts";
import {harnessRoundBinding, validateHarnessRound} from "../src/harness/rounds.ts";
import {validateHarnessStream, validateExperienceRequest, experienceSourceEligibility, EXPERIENCE_INDEX_BYTES} from "../src/harness/experience.ts";
import {readTextBounded, readBytesBounded, readLedger, writeAtomic, sha256, gateState} from "../src/study.ts";
import {canonical} from "../src/plan/state.ts";
import {fakeHttp, fakeRunner, tempDir} from "./helpers.ts";
import type {ProcessRunner} from "../src/exp/executor.ts";
const stream = () => ({v: 1, id: "stream-one", revision: 1, tasks: ["task-a", "task-b", "task-c"]});
const request = () => ({v: 1, round: "round-one", taskId: "task-b", condition: "no-library", model: "synthetic-model", runtime: "synthetic-runtime", selected: []});
const identity = {model: "synthetic-model", runtime: "synthetic-runtime"};
function fixture(mode = "experiment") {
  const home = tempDir(), dir = join(home, "study"), transport = fakeRunner([]), http = fakeHttp([]).http;
  const ctx = {actor: {kind: "person" as const}, http, runner: transport.runner};
  ops.init(dir, {question: "Synthetic bounded prior experience", mode}, ctx);
  return {dir, home, ctx, transport, env: {HOME: home, AGENTHUB_HOME: join(home, "family")}};
}
const ledger = (dir: string) => readBytesBounded(join(dir, "ledger.jsonl"), EXPERIENCE_INDEX_BYTES);
const round = () => ({v: 1, id: "round-one", task: {id: "task-b", inputSha256: "b".repeat(64)}, baseline: {guidanceSha256: "c".repeat(64)}, candidates: [], hypothesis: {deficiency: "Synthetic omission", predictedChange: "Synthetic explicit check"}, experience: [], authoring: "uncontrolled-authoring"});

test("stream is bounded, immutable and fixed before any round, with identical-set no-op", async () => {
  const f = fixture(); expect(ops.harnessStreamShow(f.dir).stream).toBeNull();
  const a = await ops.harnessStreamSet(f.dir, stream(), f.ctx), before = ledger(f.dir);
  expect(a.streamSha256).toBe(sha256(canonical(stream())));
  expect(await ops.harnessStreamSet(f.dir, stream(), f.ctx)).toEqual(a); expect(ledger(f.dir)).toEqual(before);
  for (const value of [{...stream(), tasks: ["task-b", "task-a"]}, {...stream(), revision: 2}, {...stream(), id: "new-stream"}]) {
    await expect(ops.harnessStreamSet(f.dir, value, f.ctx)).rejects.toThrow("immutable"); expect(ledger(f.dir)).toEqual(before);
  }
  const old = fixture(); await ops.harnessSet(old.dir, round(), old.ctx); const oldBytes = ledger(old.dir);
  await expect(ops.harnessStreamSet(old.dir, stream(), old.ctx)).rejects.toThrow("before the first round"); expect(ledger(old.dir)).toEqual(oldBytes);
});

test("empty controls freeze once before the round and each handoff returns its identical hash without effects", async () => {
  const f = fixture(); await ops.harnessStreamSet(f.dir, stream(), f.ctx);
  const value = await ops.experienceFreeze(f.dir, request(), f.ctx), before = ledger(f.dir);
  const {improverContextHash, ...snapshot} = value;
  expect(value.entries).toEqual([]); expect(improverContextHash).toBe(sha256(canonical(snapshot)));
  expect(await ops.experienceFreeze(f.dir, request(), f.ctx)).toEqual(value); expect(ledger(f.dir)).toEqual(before);
  const context = {streamSha256: value.streamSha256, improverContextHash};
  await ops.harnessSet(f.dir, {...round(), context}, f.ctx); const saved = ledger(f.dir);
  const a = await ops.experienceCheck(f.dir, request().round, identity, f.ctx, f.env), b = await ops.experienceCheck(f.dir, request().round, identity, f.ctx, f.env);
  expect(a).toEqual(b); expect(a).toMatchObject({state: "available", context: "", bytes: 0, workerContext: "baseline-only", improverContextHash});
  expect(await ops.experienceFreeze(f.dir, request(), f.ctx)).toEqual(value); expect(ledger(f.dir)).toEqual(saved);
  expect(f.transport.requests).toHaveLength(0); expect(existsSync(join(f.dir, "runs"))).toBe(false);
  expect(readLedger(f.dir).filter(event => event.type === "experience.frozen")).toHaveLength(1);
});

test("nonempty, retrieval-only and undeclared transfer claims cannot freeze or bypass baseline/no-library separation", async () => {
  const f = fixture(); await ops.harnessStreamSet(f.dir, stream(), f.ctx); const before = ledger(f.dir);
  for (const value of [{...request(), condition: "prior-experience", selected: [{id: "a".repeat(32), reason: "Synthetic procedural relevance"}]}, {...request(), condition: "retrieval-only"}, {...request(), taskId: "outside-stream"}]) {
    await expect(ops.experienceFreeze(f.dir, value, f.ctx)).rejects.toThrow("experience"); expect(ledger(f.dir)).toEqual(before); expect(existsSync(join(f.dir, "design", "harness-experience.json"))).toBe(false);
  }
  expect(() => validateExperienceRequest({...request(), condition: "baseline", selected: [{id: "a".repeat(32), reason: "Synthetic"}]})).toThrow("cannot receive experience");
});

test("temporal checks exclude current/future, cross-study, missing and incompatible sources without treating a synthetic close as proof", () => {
  const s = validateHarnessStream(stream()), source = {studyId: "study-one", taskId: "task-a", ...identity};
  const check = (change: Partial<typeof source>) => experienceSourceEligibility(s, "study-one", "task-b", {...source, ...change}, identity);
  expect(check({})).toMatchObject({state: "unavailable", reason: "completed-round-lesson-receipts-unavailable"});
  expect(check({taskId: "task-b"}).reason).toBe("current-or-future-task"); expect(check({taskId: "task-c"}).reason).toBe("current-or-future-task");
  expect(check({studyId: "other-study"}).reason).toBe("cross-study-source"); expect(check({taskId: "unrecorded"}).reason).toBe("unregistered-task");
  for (const change of [{model: "another-model"}, {runtime: "another-runtime"}]) expect(check(change).reason).toBe("model-runtime-incompatible");
});

test("context binds only the frozen improver identity; legacy round and worker baseline bindings remain distinct", async () => {
  const f = fixture(), legacy = validateHarnessRound(round()), old = harnessRoundBinding(legacy);
  expect(old).toBe(sha256(canonical(legacy))); expect(legacy.context).toBeUndefined();
  await ops.harnessStreamSet(f.dir, stream(), f.ctx);
  const value = await ops.experienceFreeze(f.dir, request(), f.ctx), context = {streamSha256: value.streamSha256, improverContextHash: value.improverContextHash};
  await expect(ops.harnessSet(f.dir, round(), f.ctx)).rejects.toThrow("requires a frozen context");
  await ops.harnessSet(f.dir, {...round(), context}, f.ctx); const current = ops.harnessShow(f.dir).rounds[0]!.definition;
  expect(current.context).toEqual(context); expect(current.baseline).toEqual(legacy.baseline); expect(harnessRoundBinding(current)).not.toBe(old);
  await ops.gateDecide(f.dir, "harness:round-one", "approve", undefined, f.ctx);
  const changed = validateHarnessRound({...current, context: {...context, improverContextHash: "f".repeat(64)}});
  expect(gateState("harness:round-one", readLedger(f.dir), () => harnessRoundBinding(changed)).state).toBe("pending");
  const saved = ledger(f.dir);
  for (const raw of [{...round(), context: {...context, improverContextHash: "f".repeat(64)}}, {...round(), context, experience: [{ref: {v: 1, tool: "amem", id: "a".repeat(32)}, digest: "a".repeat(64)}]}]) {
    await expect(ops.harnessSet(f.dir, raw, f.ctx)).rejects.toThrow("differs"); expect(ledger(f.dir)).toEqual(saved);
  }
});

test("frozen selection cannot change or start after a round; model/runtime mismatch blocks handoff", async () => {
  const f = fixture(); await ops.harnessStreamSet(f.dir, stream(), f.ctx);
  const value = await ops.experienceFreeze(f.dir, request(), f.ctx), before = ledger(f.dir);
  for (const raw of [{...request(), model: "changed-model"}, {...request(), condition: "baseline"}, {...request(), round: "another-round"}]) {
    await expect(ops.experienceFreeze(f.dir, raw, f.ctx)).rejects.toThrow("experience"); expect(ledger(f.dir)).toEqual(before);
  }
  for (const changed of [{...identity, model: "changed-model"}, {...identity, runtime: "changed-runtime"}]) {
    expect(await ops.experienceCheck(f.dir, request().round, changed, f.ctx)).toMatchObject({state: "unavailable", context: null, cause: "model-runtime-incompatible"}); expect(ledger(f.dir)).toEqual(before);
  }
  expect(value.entries).toEqual([]);
  const old = fixture(); await ops.harnessSet(old.dir, round(), old.ctx);
  await expect(ops.experienceFreeze(old.dir, request(), old.ctx)).rejects.toThrow("recorded stream");
});

test("strict bounds, privacy and unsupported fields refuse before any write or subprocess", async () => {
  const f = fixture(), before = ledger(f.dir);
  for (const raw of [{...stream(), tasks: []}, {...stream(), tasks: Array(17).fill("task")}, {...stream(), tasks: ["task-a", "task-a"]}, {...stream(), v: 2}, {...stream(), tasks: ["https://example.invalid/task"]}, {...stream(), id: "credential=synthetic"}, {...stream(), unknown: 1}]) {
    await expect(ops.harnessStreamSet(f.dir, raw, f.ctx)).rejects.toThrow("experience"); expect(ledger(f.dir)).toEqual(before);
  }
  await ops.harnessStreamSet(f.dir, stream(), f.ctx); const saved = ledger(f.dir);
  const markers = ["ghp_" + "a".repeat(16), "xoxb-" + "a".repeat(12), "AKIA" + "A".repeat(16), "eyJ" + "a".repeat(20), "pk-" + "a".repeat(16), "https://example.invalid/request", "credential=synthetic"];
  for (const marker of markers) await expect(ops.experienceFreeze(f.dir, {...request(), model: marker}, f.ctx)).rejects.toThrow("URL/credential");
  for (const raw of [{...request(), selected: null}, {...request(), selected: Array(17).fill({id: "a".repeat(32), reason: "Synthetic"})}, {...request(), model: "x".repeat(129)}, {...request(), taskId: "x".repeat(257)}, {...request(), selected: [], body: "forbidden"}]) {
    await expect(ops.experienceFreeze(f.dir, raw, f.ctx)).rejects.toThrow("experience");
  }
  const selected = Array.from({length: 16}, (_, index) => ({id: index.toString(16).padStart(32, "0"), reason: "x".repeat(1000)}));
  expect(() => validateExperienceRequest({...request(), condition: "prior-experience", selected})).toThrow("16 KiB");
  expect(ledger(f.dir)).toEqual(saved); expect(f.transport.requests).toHaveLength(0);
});

test("future/missing/corrupt/linked stream and context files are preserved and fail closed", async () => {
  for (const name of ["harness-stream.json", "harness-experience.json"]) {
    const f = fixture(); await ops.harnessStreamSet(f.dir, stream(), f.ctx); await ops.experienceFreeze(f.dir, request(), f.ctx);
    const file = join(f.dir, "design", name); writeAtomic(file, JSON.stringify({v: 99}), EXPERIENCE_INDEX_BYTES); const before = ledger(f.dir), raw = readBytesBounded(file, EXPERIENCE_INDEX_BYTES);
    expect(() => ops.harnessStreamShow(f.dir)).toThrow("experience"); await expect(ops.experienceFreeze(f.dir, request(), f.ctx)).rejects.toThrow("experience");
    expect(ledger(f.dir)).toEqual(before); expect(readBytesBounded(file, EXPERIENCE_INDEX_BYTES)).toEqual(raw);
  }
  const f = fixture(), target = tempDir(); symlinkSync(target, join(f.dir, "design")); const before = ledger(f.dir);
  await expect(ops.harnessStreamSet(f.dir, stream(), f.ctx)).rejects.toThrow("linked"); expect(ledger(f.dir)).toEqual(before); expect(existsSync(join(target, "harness-stream.json"))).toBe(false);
});

test("CLI/MCP stream, freeze and pre-handoff check share handlers and leave source bodies absent", async () => {
  const f = fixture(), server = createAresMcp(f.env, f.ctx.http, f.ctx), io = {...f.ctx, readStdin: async () => JSON.stringify(stream())};
  const set = await run(["harness", "stream", "set", f.dir, "--file", "-", "--json"], f.env, io);
  expect(JSON.parse(set.text)).toEqual(await server.handlers.ares_harness_stream_set!({study: f.dir, stream: stream()}));
  expect(JSON.parse((await run(["harness", "stream", "show", f.dir, "--json"], f.env, f.ctx)).text)).toEqual(await server.handlers.ares_harness_stream_show!({study: f.dir}));
  const frozen = await run(["experience", "freeze", f.dir, "--file", "-", "--json"], f.env, {...io, readStdin: async () => JSON.stringify(request())});
  expect(JSON.parse(frozen.text)).toEqual(await server.handlers.ares_experience_freeze!({study: f.dir, context: request()})); const before = ledger(f.dir);
  const checked = await run(["experience", "check", f.dir, "round-one", "--model", identity.model, "--runtime", identity.runtime, "--json"], f.env, f.ctx);
  expect(JSON.parse(checked.text)).toEqual(await server.handlers.ares_experience_check!({study: f.dir, round: "round-one", ...identity}));
  expect(ledger(f.dir)).toEqual(before); expect(f.transport.requests).toHaveLength(0);
  const persisted = ["ledger.jsonl", "design/harness-stream.json", "design/harness-experience.json"].map(name => readTextBounded(join(f.dir, name), EXPERIENCE_INDEX_BYTES)).join("");
  expect(persisted).not.toContain("text\":"); expect(persisted).not.toContain("context\":"); expect(persisted).not.toContain("workerEffectiveInputHash");
});

test("select ranks existing lessons but screens only explicit exact ids and never promotes them to prior experience", async () => {
  const f = fixture(); await ops.harnessStreamSet(f.dir, stream(), f.ctx); const before = ledger(f.dir), fullId = "a".repeat(32), otherId = "b".repeat(32), shown: string[] = [];
  const hits = [fullId, otherId].map((id, index) => ({id, kind: "finding", title: "Synthetic lesson", at: "2030-01-01T00:00:00Z", about: [], scoreDetails: {finalScore: 2 - index, recencyFactor: 1}}));
  const calls: string[] = [];
  const runner: ProcessRunner = async req => {
    calls.push(req.args[0]!); expect(req.cwd).toBe(f.dir); expect(req.command).toBe("amem");
    if (req.args[0] === "search") return {exitCode: 0, stdout: JSON.stringify(hits), stderr: ""};
    for await (const chunk of req.stdin as AsyncIterable<Uint8Array>) {
      const msg = JSON.parse(Buffer.from(chunk).toString("utf8")); if (!msg.id) continue;
      let result: unknown;
      if (msg.method === "initialize") result = {serverInfo: {name: "amem", version: "0.22.1"}};
      else if (msg.method === "tools/list") result = {tools: [{name: "amem_show", inputSchema: {type: "object", properties: {id: {type: "string"}}, required: ["id"], additionalProperties: false}}]};
      else {shown.push(msg.params.arguments.id); result = {content: [{type: "text", text: JSON.stringify({id: fullId, kind: "finding", text: "Synthetic screened body never persisted", at: "2030-01-01T00:00:00Z", project: "synthetic"})}]};}
      await req.stdoutSink!(Buffer.from(JSON.stringify({jsonrpc: "2.0", id: msg.id, result}) + "\n"));
    }
    return {exitCode: 0, stdout: "", stderr: ""};
  };
  const ctx = {...f.ctx, runner, now: () => Date.parse("2030-01-02T00:00:00Z")}, raw = {...request(), condition: "prior-experience", selected: [{id: fullId, reason: "Synthetic procedural relevance"}]};
  const result = await ops.experienceSelect(f.dir, raw, ctx, f.env);
  expect(result.ranked.map(value => value.id)).toEqual([fullId, otherId]); expect(shown).toEqual([fullId]); expect(calls).toEqual(["search", "mcp"]);
  expect(result).toMatchObject({state: "unavailable", eligible: false, selected: [{sourceState: "available", state: "unavailable"}]});
  const server = createAresMcp(f.env, f.ctx.http, ctx);
  const cli = await run(["experience", "select", f.dir, "--file", "-", "--json"], f.env, {...ctx, readStdin: async () => JSON.stringify(raw)});
  expect(JSON.parse(cli.text)).toEqual(await server.handlers.ares_experience_select!({study: f.dir, selection: raw}));
  expect(JSON.stringify(result)).not.toContain("Synthetic screened body"); expect(ledger(f.dir)).toEqual(before); expect(existsSync(join(f.dir, "design", "harness-experience.json"))).toBe(false);
});

test("survey and incomplete CLI forms fail before processes or writes", async () => {
  const f = fixture("survey"), before = ledger(f.dir); await expect(ops.harnessStreamSet(f.dir, stream(), f.ctx)).rejects.toThrow("experiment"); expect(ledger(f.dir)).toEqual(before);
  const g = fixture(); let inputs = 0;
  for (const argv of [["harness", "stream", "set", g.dir], ["experience", "select", g.dir], ["experience", "freeze", g.dir], ["experience", "check", g.dir, "round-one"]]) {
    await expect(run(argv, g.env, {...g.ctx, readStdin: async () => {inputs++; return "{}";}})).rejects.toThrow("usage:");
  }
  expect(inputs).toBe(0); expect(g.transport.requests).toHaveLength(0); expect(existsSync(join(g.dir, "design"))).toBe(false);
});
