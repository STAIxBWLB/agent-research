import {expect, test} from "bun:test";
import {join} from "node:path";
import {existsSync, mkdirSync, symlinkSync} from "node:fs";
import * as ops from "../src/commands.ts";
import {run} from "../src/cli.ts";
import {createAresMcp} from "../src/mcp-tools.ts";
import {readHarnessProbeSource} from "../src/plan/hub.ts";
import {validateHarnessRound, HARNESS_INDEX_BYTES} from "../src/harness/rounds.ts";
import {parseProbeFixture} from "../src/harness/receipts.ts";
import {designBinding, protocolHash, readProtocol} from "../src/exp/protocol.ts";
import {budgetUsage} from "../src/exp/attempts.ts";
import {readTextBounded, readBytesBounded, readLedger, writeAtomic} from "../src/study.ts";
import {metricProtocol} from "./metric-fixtures.ts";
import {fakeHttp, fakeRunner, tempDir} from "./helpers.ts";

const source = (name: string) => parseProbeFixture(JSON.parse(readTextBounded(join(import.meta.dir, "fixtures", "harness-rounds", name + ".json"), 65536)));
function definition() {
  const baseline = source("baseline"), candidate = source("candidate");
  return {v: 1, id: "round-one", task: {id: baseline.taskId, inputSha256: baseline.taskInputHash}, baseline: {guidanceSha256: baseline.baselineHash}, candidates: [{id: candidate.arm, guidanceSha256: candidate.guidanceHash, category: "procedure"}], hypothesis: {deficiency: "Synthetic output omits a required check", predictedChange: "The synthetic candidate names that check"}, experience: [], authoring: "uncontrolled-authoring"};
}
function fixture(mode = "experiment", autonomy = "gates") {
  const home = tempDir(), dir = join(home, "study"), transport = fakeRunner([]), ctx = {actor: {kind: "person" as const}, http: fakeHttp([]).http, runner: transport.runner};
  ops.init(dir, {question: "Synthetic harness round", mode, autonomy}, ctx); return {home, dir, ctx, transport, env: {HOME: home, AGENTHUB_HOME: join(home, "family")}};
}
const bytes = (dir: string) => ["ledger.jsonl", "design/harness.json"].map(name => readBytesBounded(join(dir, name), HARNESS_INDEX_BYTES));
test("round definitions need no container protocol and duplicate sets are byte-identical no-ops", async () => {
  const f = fixture(), raw = definition(); await ops.harnessSet(f.dir, raw, f.ctx);
  expect(ops.gateList(f.dir).find(gate => gate.gate === "harness:round-one")?.state).toBe("pending");
  const before = bytes(f.dir); expect(await ops.harnessSet(f.dir, raw, f.ctx)).toEqual(validateHarnessRound(raw)); expect(bytes(f.dir)).toEqual(before);
  expect(ops.harnessShow(f.dir).rounds).toHaveLength(1); expect(ops.harnessShow(f.dir).endToEndEvaluation).toBe("unavailable");
  for (const name of ["runs", "executor.json", "design/protocol.json"]) expect(existsSync(join(f.dir, name))).toBe(false);
  expect(ops.attemptList(f.dir).total).toBe(0); expect(f.transport.requests).toHaveLength(0);
});
test("definition changes reopen only their gate, preserve events, and do not alter native design/attempt/final inputs", async () => {
  const f = fixture(), raw = definition(); mkdirSync(join(f.dir, "task", "evaluator"), {recursive: true});
  writeAtomic(join(f.dir, "task", "task.md"), "Synthetic task", 65536); writeAtomic(join(f.dir, "task", "evaluator", "run"), "Synthetic evaluator", 65536);
  await ops.protocol(f.dir, metricProtocol(), f.ctx); const native = {binding: designBinding(f.dir), hash: protocolHash(readProtocol(f.dir)!)};
  const protocol = readBytesBounded(join(f.dir, "design", "protocol.json"), 65536);
  await ops.harnessSet(f.dir, raw, f.ctx); await ops.gateDecide(f.dir, "harness:round-one", "approve", undefined, f.ctx);
  const old = ops.gateList(f.dir).find(gate => gate.gate === "harness:round-one")!.current;
  await ops.harnessSet(f.dir, {...raw, hypothesis: {...raw.hypothesis, predictedChange: "Explicit synthetic revision"}}, f.ctx);
  expect(ops.gateList(f.dir).find(gate => gate.gate === "harness:round-one")).toMatchObject({state: "pending", decided: {binding: old}});
  expect(readLedger(f.dir).filter(event => event.type === "harness.round.set")).toHaveLength(2);
  expect(designBinding(f.dir)).toBe(native.binding); expect(protocolHash(readProtocol(f.dir)!)).toBe(native.hash);
  expect(readBytesBounded(join(f.dir, "design", "protocol.json"), 65536)).toEqual(protocol);
  expect(ops.attemptList(f.dir).total).toBe(0); expect(budgetUsage([], 0)).toEqual({attempts: 0, wallHours: 0, gpuHours: 0});
  expect(existsSync(join(f.dir, "runs", "final"))).toBe(false);
});
test("fixture declarations require their gate, never become matched, and preserve stale history", async () => {
  const f = fixture(), raw = definition(); await ops.harnessSet(f.dir, raw, f.ctx); const before = bytes(f.dir);
  await expect(ops.harnessImport(f.dir, raw.id, source("baseline"), f.ctx)).rejects.toThrow("gate"); expect(bytes(f.dir)).toEqual(before);
  await ops.gateDecide(f.dir, "harness:round-one", "approve", undefined, f.ctx);
  const imported = await ops.harnessImport(f.dir, raw.id, source("baseline"), f.ctx), saved = bytes(f.dir);
  expect(imported).toMatchObject({sourceStrength: "synthetic-fixture", matched: false, endToEndEvaluation: "unavailable"});
  expect(await ops.harnessImport(f.dir, raw.id, source("baseline"), f.ctx)).toEqual(imported); expect(bytes(f.dir)).toEqual(saved);
  await ops.harnessImport(f.dir, raw.id, source("candidate"), f.ctx);
  const comparison = ops.harnessShow(f.dir).rounds[0]!.comparisons[0]!;
  expect(comparison).toMatchObject({compatible: true, matched: false, endToEndEvaluation: "unavailable"});
  await ops.harnessSet(f.dir, {...raw, baseline: {guidanceSha256: "e".repeat(64)}}, f.ctx);
  const view = ops.harnessShow(f.dir).rounds[0]!; expect(view.probes).toHaveLength(0); expect(view.historicalImports).toBe(2);
  expect(readLedger(f.dir).filter(event => event.type === "harness.probe.declared")).toHaveLength(2);
  await expect(ops.harnessImport(f.dir, raw.id, source("baseline"), f.ctx)).rejects.toThrow("reused");
  expect(f.transport.requests).toHaveLength(0); expect(ops.attemptList(f.dir).total).toBe(0);
});
test("strict bounds, immutable exact task identity and future versions refuse without writes", async () => {
  const f = fixture(), raw = definition(); await ops.harnessSet(f.dir, raw, f.ctx); const before = bytes(f.dir);
  for (const value of [{...raw, v: 2}, {...raw, transcript: "private"}, {...raw, experience: null}, {...raw, sourceExecutions: null}, {...raw, authoring: "controlled-lane"}, {...raw, hypothesis: {...raw.hypothesis, deficiency: "API_KEY=synthetic-secret"}}, {...raw, task: {...raw.task, inputSha256: "d".repeat(64)}}, {...raw, id: "another-round"}, {...raw, candidates: Array(3).fill(raw.candidates[0])}]) {await expect(ops.harnessSet(f.dir, value, f.ctx)).rejects.toThrow("harness"); expect(bytes(f.dir)).toEqual(before);}
  writeAtomic(join(f.dir, "design", "harness.json"), JSON.stringify({v: 2, rounds: []}), HARNESS_INDEX_BYTES); const future = bytes(f.dir);
  expect(() => ops.harnessShow(f.dir)).toThrow("unsupported"); await expect(ops.harnessSet(f.dir, raw, f.ctx)).rejects.toThrow("unsupported"); expect(bytes(f.dir)).toEqual(future);
});
test("at most sixteen exact task identities, and survey studies gain no harness namespace", async () => {
  const f = fixture(), raw = definition();
  for (let index = 0; index < 16; index++) await ops.harnessSet(f.dir, {...raw, id: `round-${index}`, task: {...raw.task, id: `synthetic-task-${index}`}}, f.ctx);
  const before = bytes(f.dir); await expect(ops.harnessSet(f.dir, {...raw, id: "round-17"}, f.ctx)).rejects.toThrow("16-round"); expect(bytes(f.dir)).toEqual(before);
  const survey = fixture("survey"); await expect(ops.harnessSet(survey.dir, raw, survey.ctx)).rejects.toThrow("experiment"); expect(() => ops.harnessShow(survey.dir)).toThrow("experiment"); expect(existsSync(join(survey.dir, "design"))).toBe(false);
});
test("controlled-lane source refs remain declared with end-to-end evaluation unavailable", async () => {
  const f = fixture(), raw = definition(), sourceRef = {v: 1, tool: "ahub", projectKey: "synthetic-hub-project", kind: "guidance-probe", id: "synthetic-authoring-receipt", revision: "1", sha256: "b".repeat(64)};
  await ops.harnessSet(f.dir, {...raw, authoring: "controlled-lane", sourceExecutions: {proposal1: sourceRef}}, f.ctx);
  expect(ops.harnessShow(f.dir)).toMatchObject({endToEndEvaluation: "unavailable", realImport: "unavailable"});
  expect(await readHarnessProbeSource("absent")).toEqual(await readHarnessProbeSource("denied")); expect(f.transport.requests).toHaveLength(0);
});
test("T1 CLI/MCP share only implemented local forms and read-only views without subprocesses", async () => {
  const f = fixture(), raw = definition(), server = createAresMcp(f.env, f.ctx.http, f.ctx);
  const set = await run(["harness", "set", f.dir, "--file", "-", "--json"], f.env, {...f.ctx, readStdin: async () => JSON.stringify(raw)});
  expect(JSON.parse(set.text)).toEqual(await server.handlers.ares_harness_set!({study: f.dir, round: raw}));
  await ops.gateDecide(f.dir, "harness:round-one", "approve", undefined, f.ctx);
  const imported = await run(["harness", "import", f.dir, raw.id, "--file", "-", "--json"], f.env, {...f.ctx, readStdin: async () => JSON.stringify(source("baseline"))});
  expect(JSON.parse(imported.text)).toEqual(await server.handlers.ares_harness_import!({study: f.dir, round: raw.id, fixture: source("baseline")}));
  const before = bytes(f.dir), cli = await run(["harness", "show", f.dir, "--round", raw.id, "--json"], f.env, f.ctx);
  expect(JSON.parse(cli.text)).toEqual(await server.handlers.ares_harness_show!({study: f.dir, round: raw.id})); expect(bytes(f.dir)).toEqual(before); expect(f.transport.requests).toHaveLength(0);
});

test("wrong arms/task hashes and duplicate arm executions refuse before auto approval or writes", async () => {
  const f = fixture("experiment", "auto"), raw = definition(); await ops.harnessSet(f.dir, raw, f.ctx);
  const original = source("baseline"), before = bytes(f.dir);
  for (const projection of [{...original, arm: "not-an-arm"}, {...original, taskInputHash: "d".repeat(64)}, {...original, guidanceHash: "d".repeat(64)}, {...original, transcript: "private"}, {...original, sourceStrength: "host-observed"}]) {
    await expect(ops.harnessImport(f.dir, raw.id, projection, f.ctx)).rejects.toThrow(); expect(bytes(f.dir)).toEqual(before);
    expect(readLedger(f.dir).some(event => event.type === "gate.approve")).toBe(false);
  }
  await ops.harnessImport(f.dir, raw.id, original, f.ctx);
  const saved = bytes(f.dir), events = readLedger(f.dir);
  expect(events.at(-2)?.type).toBe("gate.approve"); expect(events.at(-2)?.actor.kind).toBe("auto"); expect(events.at(-1)?.type).toBe("harness.probe.declared");
  expect(events.at(-2)?.at).toBe(events.at(-1)?.at);
  await expect(ops.harnessImport(f.dir, raw.id, {...original, id: "another-producer-claim"}, f.ctx)).rejects.toThrow("arm already"); expect(bytes(f.dir)).toEqual(saved);
});
test("missing mandatory file flag never reads stdin or changes a round", async () => {
  const f = fixture(); let reads = 0;
  for (const args of [["harness", "set", f.dir], ["harness", "import", f.dir, "round-one"]]) await expect(run(args, f.env, {...f.ctx, readStdin: async () => {reads++; return JSON.stringify(definition());}})).rejects.toThrow("usage:");
  expect(reads).toBe(0); expect(existsSync(join(f.dir, "design"))).toBe(false);
});

test("linked design/index paths refuse instead of reading or writing another location", async () => {
  for (const linkedParent of [false, true]) {
    const f = fixture(), target = tempDir(), file = join(target, "harness.json");
    writeAtomic(file, JSON.stringify({v: 1, rounds: []}), HARNESS_INDEX_BYTES);
    if (linkedParent) symlinkSync(target, join(f.dir, "design"));
    else {mkdirSync(join(f.dir, "design")); symlinkSync(file, join(f.dir, "design", "harness.json"));}
    const before = readBytesBounded(file, HARNESS_INDEX_BYTES);
    expect(() => ops.harnessShow(f.dir)).toThrow("harness");
    await expect(ops.harnessSet(f.dir, definition(), f.ctx)).rejects.toThrow("harness");
    expect(readBytesBounded(file, HARNESS_INDEX_BYTES)).toEqual(before);
    expect(readLedger(f.dir)).toHaveLength(1);
  }
});

test("credentials hidden in typed reference metadata refuse before a record is written", async () => {
  const f = fixture(), raw = definition(), sourceRef = {v: 1, tool: "ahub", projectKey: "synthetic-project", kind: "guidance-probe", id: "API_KEY=synthetic-secret", sha256: "b".repeat(64)};
  await expect(ops.harnessSet(f.dir, {...raw, authoring: "controlled-lane", sourceExecutions: {proposal1: sourceRef}}, f.ctx)).rejects.toThrow("credentials");
  expect(existsSync(join(f.dir, "design"))).toBe(false); expect(readLedger(f.dir)).toHaveLength(1);
});
