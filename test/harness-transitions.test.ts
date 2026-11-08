import {expect, test} from "bun:test";
import {join} from "node:path";
import {existsSync} from "node:fs";
import * as ops from "../src/commands.ts";
import {run} from "../src/cli.ts";
import {createAresMcp} from "../src/mcp-tools.ts";
import {parseProbeFixture, type ProbeFixtureProjectionV1} from "../src/harness/receipts.ts";
import {harnessRoundBinding, validateHarnessRound, HARNESS_INDEX_BYTES, HARNESS_FORM_BYTES, type DeclaredProbe} from "../src/harness/rounds.ts";
import {transitionState, transitionBucket, transitionView, parseComposition, applyTransition, harnessEvidenceFingerprint, recordHash} from "../src/harness/transitions.ts";
import {readTextBounded, readBytesBounded, readLedger, commit, sha256, type PendingEvent} from "../src/study.ts";
import {canonical} from "../src/plan/state.ts";
import {fakeHttp, fakeRunner, tempDir} from "./helpers.ts";
const source = (name: string) => parseProbeFixture(JSON.parse(readTextBounded(join(import.meta.dir, "fixtures", "harness-rounds", `${name}.json`), 65_536)));
function definition() {const b = source("baseline"), c = source("candidate"); return {v: 1, id: "round-one", task: {id: b.taskId, inputSha256: b.taskInputHash}, baseline: {guidanceSha256: b.baselineHash}, candidates: [{id: c.arm, guidanceSha256: c.guidanceHash}], hypothesis: {deficiency: "Synthetic omission", predictedChange: "Synthetic check"}, experience: [], authoring: "uncontrolled-authoring"};}
async function fixture(autonomy = "gates", candidateState?: ProbeFixtureProjectionV1["state"]) {
  const home = tempDir(), dir = join(home, "study"), transport = fakeRunner([]), http = fakeHttp([]).http, ctx = {actor: {kind: "person" as const, id: "synthetic-owner"}, http, runner: transport.runner};
  ops.init(dir, {question: "Synthetic harness transitions", mode: "experiment", autonomy}, ctx); await ops.harnessSet(dir, definition(), ctx);
  if (autonomy !== "auto") await ops.gateDecide(dir, "harness:round-one", "approve", undefined, ctx);
  await ops.harnessImport(dir, "round-one", source("baseline"), ctx); await ops.harnessImport(dir, "round-one", {...source("candidate"), ...(candidateState ? {state: candidateState} : {})}, ctx);
  return {dir, home, ctx, transport, env: {HOME: home, AGENTHUB_HOME: join(home, "family")}};
}
const view = (dir: string) => ops.harnessShow(dir, "round-one").rounds[0]!;
const bytes = (dir: string) => readBytesBounded(join(dir, "ledger.jsonl"), 64 * 1024 * 1024);
const ref = (dir: string, arm: string) => {const p = view(dir).probes.find(p => p.projection.arm === arm)!; return {probe: p.projection.id, projectionSha256: p.projectionSha256, outputManifestHash: p.projection.outputManifestHash!};};
const contrast = (dir: string, id = "contrast-one") => ({v: 1, id, fingerprint: view(dir).transitions.fingerprint, arm: "candidate", outcome: "improved", basis: "actor-claim", observations: "Synthetic behavior changed", uncertainty: "No native producer proof", explanations: ["Synthetic task differences may explain it"], evidence: [ref(dir, "baseline"), ref(dir, "candidate")]});
function composition(dir: string, successorSha256: string | null = "9".repeat(64)) {const c = view(dir).transitions.contrasts[0]!; return {v: 1, id: "composition-one", fingerprint: view(dir).transitions.fingerprint, sections: [{section: "Synthetic checks", decision: "revise", contrasts: [{id: c.form.id, sha256: c.sha256}], reason: "Synthetic contrast-backed edit"}], successorSha256};}
const decision = (dir: string) => ({v: 1, id: "decision-one", fingerprint: view(dir).transitions.fingerprint, outcome: "baseline-kept", reason: "No independent real correctness evidence"});

async function close(dir: string, form: unknown, ctx: Parameters<typeof ops.harnessClose>[4]) {
  const preview = await ops.harnessClose(dir, "round-one", form, undefined, ctx); if (!("needsConfirm" in preview)) throw new Error("preview required");
  return ops.harnessClose(dir, "round-one", form, preview.fingerprint, ctx);
}

test("contrast, per-edit composition and separately executed successor keep experimental evidence separate", async () => {
  const f = await fixture(); const form = contrast(f.dir), c = await ops.harnessContrast(f.dir, "round-one", form, f.ctx);
  expect("record" in c && c.record.actor).toEqual(f.ctx.actor); expect("record" in c && c.record.at).not.toBe(new Date(0).toISOString());
  const before = bytes(f.dir), duplicate = await ops.harnessContrast(f.dir, "round-one", form, f.ctx);
  expect("duplicate" in duplicate && duplicate.duplicate).toBe(true); expect(bytes(f.dir)).toEqual(before);
  await ops.harnessCompose(f.dir, "round-one", composition(f.dir), f.ctx);
  expect(view(f.dir).transitions.successor).toMatchObject({guidanceSha256: "9".repeat(64), execution: "unexecuted"});
  const kept = await close(f.dir, decision(f.dir), f.ctx); expect("record" in kept).toBe(true);
  expect(view(f.dir).transitions.readiness).toEqual({state: "closed", experimental: true, correctness: "unavailable", transfer: "not-demonstrated"});
  const events = readLedger(f.dir); expect(events.at(-1)!.type).toBe("harness.round.closed"); expect(events.some(e => e.type === "harness.adoption.decided")).toBe(false);
  expect(view(f.dir).transitions.closure).toMatchObject({roundBinding: view(f.dir).binding, evidenceFingerprint: decision(f.dir).fingerprint, outcome: "baseline-kept", actor: f.ctx.actor});
  const successor = {...source("candidate"), id: "successor-probe", arm: "successor", guidanceHash: "9".repeat(64)};
  await ops.harnessImport(f.dir, "round-one", successor, f.ctx);
  expect(view(f.dir).transitions.successor).toMatchObject({execution: "fixture-declared", probeId: "successor-probe"});
  expect(view(f.dir).transitions.readiness.state).toBe("stale"); expect(view(f.dir).transitions.closure?.current).toBe(false);
  expect(ops.attemptList(f.dir).total).toBe(0); expect(existsSync(join(f.dir, "runs"))).toBe(false); expect(f.transport.requests).toHaveLength(0);
});

test("adoption preview and stale/incorrect confirmation write nothing, including auto approvals", async () => {
  const f = await fixture("auto"), form = decision(f.dir), before = bytes(f.dir), preview = await ops.harnessClose(f.dir, "round-one", form, undefined, f.ctx);
  expect("needsConfirm" in preview && preview.needsConfirm).toBe(true); expect(bytes(f.dir)).toEqual(before);
  await expect(ops.harnessClose(f.dir, "round-one", form, "f".repeat(64), f.ctx)).rejects.toThrow("confirmation differs"); expect(bytes(f.dir)).toEqual(before);
  await ops.harnessContrast(f.dir, "round-one", contrast(f.dir), f.ctx); const saved = bytes(f.dir);
  if (!("needsConfirm" in preview)) throw new Error();
  await expect(ops.harnessClose(f.dir, "round-one", form, preview.fingerprint, f.ctx)).rejects.toThrow("stale evidence fingerprint"); expect(bytes(f.dir)).toEqual(saved);
});

test("changed definitions reopen readiness without rewriting old closure, and duplicate decisions remain no-ops", async () => {
  const f = await fixture(), form = decision(f.dir); const first = await close(f.dir, form, f.ctx), before = bytes(f.dir);
  const repeated = await ops.harnessClose(f.dir, "round-one", form, undefined, f.ctx); expect("duplicate" in repeated && repeated.duplicate).toBe(true); expect(bytes(f.dir)).toEqual(before);
  if (!("record" in repeated) || !("record" in first)) throw new Error("record receipt required");
  expect(repeated.record).toEqual(first.record);
  await ops.harnessSet(f.dir, {...definition(), hypothesis: {deficiency: "Synthetic new observation", predictedChange: "Synthetic new prediction"}}, f.ctx);
  expect(view(f.dir).transitions.readiness.state).toBe("stale"); expect(view(f.dir).transitions.closure?.current).toBe(false); expect(view(f.dir).transitions.closures).toHaveLength(1); expect(view(f.dir).historicalImports).toBe(2);
  expect(readLedger(f.dir).filter(e => e.type === "harness.round.closed")).toHaveLength(1);
  const old = readLedger(f.dir).find(e => e.type === "harness.round.closed")!; expect((old.data.form as {fingerprint: string}).fingerprint).toBe(form.fingerprint);
});

test("untested or missing refs cannot become contrast evidence, forged metrics/assurance and duplicate ids refuse before writes", async () => {
  const f = await fixture(), before = bytes(f.dir), valid = contrast(f.dir);
  for (const raw of [{...valid, evidence: []}, {...valid, arm: "unknown-arm"}, {...valid, evidence: [{...valid.evidence[0], projectionSha256: "f".repeat(64)}]}, {...valid, evidence: [{...valid.evidence[0], outputManifestHash: "f".repeat(64)}]}, {...valid, metrics: {score: 1}}, {...valid, matched: true}, {...valid, observations: "https://example.invalid/private"}, {...valid, uncertainty: "credential=synthetic-secret"}]) {
    await expect(ops.harnessContrast(f.dir, "round-one", raw, f.ctx)).rejects.toThrow(); expect(bytes(f.dir)).toEqual(before);
  }
  await ops.harnessContrast(f.dir, "round-one", valid, f.ctx); const saved = bytes(f.dir);
  await expect(ops.harnessContrast(f.dir, "round-one", {...valid, observations: "Changed id reuse"}, f.ctx)).rejects.toThrow("id reused"); expect(bytes(f.dir)).toEqual(saved);
  await expect(ops.harnessCompose(f.dir, "round-one", {...composition(f.dir), sections: [{section: "Synthetic", decision: "keep", contrasts: [{id: valid.id, sha256: "f".repeat(64)}], reason: "Synthetic"}]}, f.ctx)).rejects.toThrow("missing or changed contrast"); expect(bytes(f.dir)).toEqual(saved);
});

test("keeping existing candidate bytes references its execution instead of counting a successor sample", async () => {
  const f = await fixture(); await ops.harnessContrast(f.dir, "round-one", contrast(f.dir), f.ctx);
  await ops.harnessCompose(f.dir, "round-one", composition(f.dir, source("candidate").guidanceHash), f.ctx);
  expect(view(f.dir).transitions.successor).toMatchObject({execution: "fixture-declared", probeId: source("candidate").id});
  const before = bytes(f.dir);
  await expect(ops.harnessImport(f.dir, "round-one", {...source("candidate"), id: "duplicated-sample", arm: "successor"}, f.ctx)).rejects.toThrow("reference it rather than count"); expect(bytes(f.dir)).toEqual(before);
  await expect(ops.harnessCompose(f.dir, "round-one", {...composition(f.dir), id: "second-successor"}, f.ctx)).rejects.toThrow("one successor"); expect(bytes(f.dir)).toEqual(before);
  await expect(ops.harnessContrast(f.dir, "round-one", {...contrast(f.dir, "successor-alias"), arm: "successor"}, f.ctx)).rejects.toThrow("baseline and arm execution refs"); expect(bytes(f.dir)).toEqual(before);
});

test("failed/unknown declarations remain visible and inconclusive/base preservation are normal closures", async () => {
  for (const [outcome, state] of [["inconclusive", "unknown"], ["unchanged", "failed"], ["regressed", "cancelled"]] as const) {
    const f = await fixture("gates", state);
    expect(view(f.dir).probes.find(p => p.projection.arm === "candidate")!.projection.state).toBe(state); await ops.harnessContrast(f.dir, "round-one", {...contrast(f.dir), outcome}, f.ctx);
    await ops.harnessCompose(f.dir, "round-one", composition(f.dir, null), f.ctx);
    await close(f.dir, {...decision(f.dir), outcome: "inconclusive"}, f.ctx);
    expect(view(f.dir).transitions.successor).toBeNull(); expect(view(f.dir).transitions.readiness.transfer).toBe("not-demonstrated");
  }
});

test("controlled authored forms need declared source execution and model identity; no runtime source is inferred", async () => {
  const f = await fixture(), raw = definition(), sourceExecution = {v: 1, tool: "ahub", projectKey: "synthetic-project", kind: "guidance-probe", id: "synthetic-selection", sha256: "a".repeat(64)};
  await ops.harnessSet(f.dir, {...raw, authoring: "controlled-lane", sourceExecutions: {proposal1: sourceExecution}}, f.ctx);
  await ops.gateDecide(f.dir, "harness:round-one", "approve", undefined, f.ctx);
  for (const name of ["baseline", "candidate"]) await ops.harnessImport(f.dir, raw.id, {...source(name), id: `controlled-${name}`}, f.ctx);
  const before = bytes(f.dir), c = {...contrast(f.dir), basis: "blinded-judgment", judge: "model", model: "synthetic-model"};
  await expect(ops.harnessContrast(f.dir, raw.id, c, f.ctx)).rejects.toThrow("declared source execution"); expect(bytes(f.dir)).toEqual(before);
  await ops.harnessContrast(f.dir, raw.id, {...c, sourceExecution}, f.ctx);
  expect(view(f.dir).comparisons[0]).toMatchObject({matched: false, endToEndEvaluation: "unavailable"}); expect(f.transport.requests).toHaveLength(0);
});

test("CLI and MCP share transition validation/previews; actor comes from the surface, never the form", async () => {
  const f = await fixture(), server = createAresMcp(f.env, f.ctx.http, f.ctx), form = contrast(f.dir);
  const cli = await run(["harness", "contrast", f.dir, "round-one", "--file", "-", "--json"], f.env, {...f.ctx, readStdin: async () => JSON.stringify(form)});
  const returned = JSON.parse(cli.text); expect(returned.record.actor.kind).toBe("person");
  expect(await server.handlers.ares_harness_contrast!({study: f.dir, round: "round-one", contrast: form})).toMatchObject({duplicate: true, record: returned.record});
  const comp = composition(f.dir); await server.handlers.ares_harness_compose!({study: f.dir, round: "round-one", composition: comp}); expect(view(f.dir).transitions.composition?.actor.kind).toBe("agent");
  const raw = decision(f.dir), before = bytes(f.dir);
  const a = JSON.parse((await run(["harness", "close", f.dir, "round-one", "--file", "-", "--json"], f.env, {...f.ctx, readStdin: async () => JSON.stringify(raw)})).text);
  const b = await server.handlers.ares_harness_close!({study: f.dir, round: "round-one", closure: raw}); expect(a).toEqual(b); expect(bytes(f.dir)).toEqual(before);
  await server.handlers.ares_harness_close!({study: f.dir, round: "round-one", closure: raw, confirm: a.fingerprint}); expect(view(f.dir).transitions.closure?.actor.kind).toBe("agent");
  await expect(ops.harnessContrast(f.dir, "round-one", {...contrast(f.dir, "forged-actor"), actor: {kind: "person"}}, f.ctx)).rejects.toThrow("unknown field");
});

test("showHarness encoded envelope reports truncation/remaining instead of dropping rows silently", async () => {
  const f = await fixture("auto"), state = transitionState(), pending: PendingEvent[] = [];
  for (const index of [1, 2]) {
    const raw = {...definition(), id: `round-${index}`, task: {...definition().task, id: `synthetic-task-${index}`}};
    await ops.harnessSet(f.dir, raw, f.ctx);
    const probes: DeclaredProbe[] = [];
    for (const name of ["baseline", "candidate"]) {
      const projection = {...source(name), id: `${name}-${index}`, taskId: raw.task.id}; await ops.harnessImport(f.dir, raw.id, projection, f.ctx);
      probes.push({round: raw.id, binding: harnessRoundBinding(raw as Parameters<typeof harnessRoundBinding>[0]), projectionSha256: sha256(canonical(projection)), sourceStrength: "synthetic-fixture", projection});
    }
    const binding = probes[0]!.binding, bucket = transitionBucket(state, raw.id, binding);
    for (let n = 0; n < 48; n++) {
      const form = {v: 1, id: `contrast-${index}-${n}`, fingerprint: harnessEvidenceFingerprint(binding, probes, bucket), arm: "candidate", outcome: "inconclusive", basis: "actor-claim", observations: "o".repeat(2000), uncertainty: "u".repeat(2000), explanations: Array(8).fill("e".repeat(1000)), evidence: probes.map(p => ({probe: p.projection.id, projectionSha256: p.projectionSha256}))};
      const data = {v: 1, round: raw.id, binding, form, sha256: recordHash(form, f.ctx.actor, binding), sourceStrength: "synthetic-fixture"}, type = "harness.contrast.recorded";
      applyTransition(state, {v: 1, actor: f.ctx.actor, at: new Date(0).toISOString(), type, data}, raw as Parameters<typeof applyTransition>[2], binding, probes); pending.push({actor: f.ctx.actor, type, data});
    }
  }
  commit(f.dir, [], pending);
  const shown = ops.harnessShow(f.dir); expect(shown.truncated).toBe(true); expect(shown.remaining).toBeGreaterThan(0); expect(shown.rounds.length + shown.remaining).toBe(3);
  expect(Buffer.byteLength(JSON.stringify(shown))).toBeLessThanOrEqual(HARNESS_INDEX_BYTES);
  const one = ops.harnessShow(f.dir, "round-2"); expect(one.truncated).toBe(false); expect(one.remaining).toBe(0); expect(one.rounds[0]!.transitions.contrasts).toHaveLength(48);
});

test("malformed/future transition receipts and unapproved writes refuse without false closure or partial approvals", async () => {
  const f = await fixture(), before = bytes(f.dir), base = contrast(f.dir);
  for (const raw of [{...base, v: 2}, {...base, evidence: null}, {...base, basis: "blinded-judgment", judge: "model"}, {...base, uncertainty: "x".repeat(2001)}]) {
    await expect(ops.harnessContrast(f.dir, "round-one", raw, f.ctx)).rejects.toThrow(); expect(bytes(f.dir)).toEqual(before);
  }
  await ops.harnessSet(f.dir, {...definition(), hypothesis: {...definition().hypothesis, predictedChange: "Explicit changed hypothesis"}}, f.ctx);
  const noApproval = bytes(f.dir), form = {...decision(f.dir), id: "changed-gate"};
  const preview = await ops.harnessClose(f.dir, "round-one", form, undefined, f.ctx); if (!("needsConfirm" in preview)) throw new Error();
  await expect(ops.harnessClose(f.dir, "round-one", form, preview.fingerprint, f.ctx)).rejects.toThrow("pending"); expect(bytes(f.dir)).toEqual(noApproval);
  const closed = {v: 1, id: "forged-adoption", fingerprint: form.fingerprint, outcome: "adopted-experimental", reason: "Synthetic missing link", adoptionSha256: "a".repeat(64)};
  const malformed = {v: 1, round: "round-one", binding: view(f.dir).binding, form: closed, sha256: recordHash(closed, f.ctx.actor, view(f.dir).binding), sourceStrength: "synthetic-fixture"};
  commit(f.dir, [], [{actor: f.ctx.actor, type: "harness.round.closed", data: malformed}]);
  expect(() => ops.harnessShow(f.dir)).toThrow("closure lacks its current adoption");
});

test("adoption records an unavailable independent check separately and atomically links immutable adopted-experimental closure", async () => {
  const f = await fixture(), raw = {v: 1, id: "adopt-one", fingerprint: view(f.dir).transitions.fingerprint, decision: "adopt", arm: "candidate", reason: "Synthetic experimental preference, no correctness authority", checks: [ref(f.dir, "candidate")], independentCheck: {state: "unavailable" as const, source: {kind: "unavailable" as const, refs: []}}};
  const before = bytes(f.dir);
  for (const independentCheck of [undefined, null, {state: "passed", source: {kind: "deterministic-executable", refs: [ref(f.dir, "candidate")]}}, {state: "failed", source: {kind: "deterministic-executable", refs: [ref(f.dir, "candidate")]}}, {state: "unavailable", source: {kind: "blinded-judgment", refs: []}}, {state: "unavailable", source: {kind: "actor-claim", refs: []}}]) {
    await expect(ops.harnessAdopt(f.dir, "round-one", {...raw, independentCheck}, undefined, f.ctx)).rejects.toThrow(); expect(bytes(f.dir)).toEqual(before);
  }
  const a = await ops.harnessAdopt(f.dir, "round-one", raw, undefined, f.ctx), server = createAresMcp(f.env, f.ctx.http, f.ctx);
  expect(await server.handlers.ares_harness_adopt!({study: f.dir, round: "round-one", decision: raw})).toEqual(a); expect(bytes(f.dir)).toEqual(before);
  if (!("needsConfirm" in a)) throw new Error();
  await server.handlers.ares_harness_adopt!({study: f.dir, round: "round-one", decision: raw, confirm: a.fingerprint});
  const current = view(f.dir).transitions, tail = readLedger(f.dir).slice(-2);
  expect(tail.map(event => event.type)).toEqual(["harness.adoption.decided", "harness.round.closed"]); expect(tail[0]!.at).toBe(tail[1]!.at);
  expect(current.adoption?.form.independentCheck).toEqual(raw.independentCheck);
  expect(current.closure).toMatchObject({outcome: "adopted-experimental", roundBinding: view(f.dir).binding, evidenceFingerprint: raw.fingerprint, actor: {kind: "agent"}, reason: raw.reason, current: true});
  expect(current.closure?.form.adoptionSha256).toBe(current.adoption?.sha256);
  expect(current.readiness).toMatchObject({experimental: true, correctness: "unavailable", transfer: "not-demonstrated"});
});

test("baseline-kept, inconclusive and withdrawn close without any adoption; current closure cannot be overwritten", async () => {
  for (const outcome of ["baseline-kept", "inconclusive", "withdrawn"] as const) {
    const f = await fixture(), form = {...decision(f.dir), outcome}; await close(f.dir, form, f.ctx);
    const current = view(f.dir).transitions, before = bytes(f.dir);
    expect(current.adoption).toBeNull(); expect(current.closure?.outcome).toBe(outcome); expect(current.closure?.current).toBe(true); expect(current.closure?.reason).toBe(form.reason);
    expect(readLedger(f.dir).some(event => event.type === "harness.adoption.decided")).toBe(false);
    await expect(ops.harnessClose(f.dir, "round-one", {...form, id: "rewrite-closure", outcome: outcome === "withdrawn" ? "inconclusive" : "withdrawn"}, undefined, f.ctx)).rejects.toThrow("immutable closure"); expect(bytes(f.dir)).toEqual(before);
    await expect(ops.harnessClose(f.dir, "round-one", {...form, id: "fake-adoption", outcome: "adopted-experimental"}, undefined, f.ctx)).rejects.toThrow("use ares harness adopt"); expect(bytes(f.dir)).toEqual(before);
  }
});

test("contrast provenance labels do not promote claims or blinded judgments into observed deterministic checks", async () => {
  const f = await fixture();
  for (const [index, provenance] of [{basis: "deterministic-check"}, {basis: "actor-claim", model: "synthetic-model"}, {basis: "blinded-judgment", judge: "human"}, {basis: "blinded-judgment", judge: "model", model: "synthetic-model"}].entries()) {
    await ops.harnessContrast(f.dir, "round-one", {...contrast(f.dir, `provenance-${index}`), ...provenance}, f.ctx);
    expect(view(f.dir).transitions.contrasts.at(-1)).toMatchObject({form: provenance, sourceStrength: "synthetic-fixture", matched: false});
  }
  const before = bytes(f.dir);
  for (const raw of [{...contrast(f.dir, "bad-judge"), basis: "blinded-judgment"}, {...contrast(f.dir, "bad-model"), basis: "blinded-judgment", judge: "model"}, {...contrast(f.dir, "mixed-provenance"), basis: "deterministic-check", judge: "human"}]) {
    await expect(ops.harnessContrast(f.dir, "round-one", raw, f.ctx)).rejects.toThrow(); expect(bytes(f.dir)).toEqual(before);
  }
});

test("hash collisions across candidates/baseline cannot stand in for the contrast arm's execution", async () => {
  for (const sharedWithBaseline of [false, true]) {
    const f = await fixture(), shared = sharedWithBaseline ? source("baseline").guidanceHash : source("candidate").guidanceHash;
    const raw = {...definition(), candidates: [{id: "one", guidanceSha256: shared}, {id: "two", guidanceSha256: shared}]};
    await ops.harnessSet(f.dir, raw, f.ctx); await ops.gateDecide(f.dir, "harness:round-one", "approve", undefined, f.ctx);
    await ops.harnessImport(f.dir, raw.id, {...source("baseline"), id: "collision-baseline"}, f.ctx);
    await ops.harnessImport(f.dir, raw.id, {...source("candidate"), id: "collision-one", arm: "one", guidanceHash: shared}, f.ctx);
    const current = view(f.dir), form = {v: 1, id: "collision", fingerprint: current.transitions.fingerprint, arm: "two", outcome: "improved", basis: "actor-claim", observations: "Synthetic collision", uncertainty: "No target-arm execution", explanations: [], evidence: current.probes.map(probe => ({probe: probe.projection.id, projectionSha256: probe.projectionSha256}))};
    const before = bytes(f.dir); await expect(ops.harnessContrast(f.dir, raw.id, form, f.ctx)).rejects.toThrow("baseline and arm execution refs"); expect(bytes(f.dir)).toEqual(before);
    await ops.harnessImport(f.dir, raw.id, {...source("candidate"), id: "collision-two", arm: "two", guidanceHash: shared}, f.ctx);
    const admitted = view(f.dir), evidence = admitted.probes.filter(probe => ["baseline", "two"].includes(probe.projection.arm)).map(probe => ({probe: probe.projection.id, projectionSha256: probe.projectionSha256}));
    await ops.harnessContrast(f.dir, raw.id, {...form, fingerprint: admitted.transitions.fingerprint, evidence}, f.ctx);
    expect(view(f.dir).transitions.contrasts.at(-1)?.form.arm).toBe("two");
  }
});

test("malformed transition source execution guidance targets the transition input, not the round definition", async () => {
  const f = await fixture(), malformed = {v: 1, tool: "wrong", projectKey: "synthetic", kind: "guidance-probe", id: "synthetic", sha256: "a".repeat(64)}, before = bytes(f.dir);
  const comp = {v: 1, id: "malformed-compose", fingerprint: view(f.dir).transitions.fingerprint, sections: [{section: "Synthetic", decision: "keep", contrasts: [{id: "synthetic-ref", sha256: "a".repeat(64)}], reason: "Synthetic"}], successorSha256: null, sourceExecution: malformed};
  const adopt = {v: 1, id: "malformed-adopt", fingerprint: view(f.dir).transitions.fingerprint, decision: "adopt", arm: "candidate", reason: "Synthetic", checks: [], independentCheck: {state: "unavailable", source: {kind: "unavailable", refs: []}}, sourceExecution: malformed};
  const operations = [
    ["contrast", () => ops.harnessContrast(f.dir, "round-one", {...contrast(f.dir), sourceExecution: malformed}, f.ctx)],
    ["compose", () => ops.harnessCompose(f.dir, "round-one", comp, f.ctx)],
    ["adopt", () => ops.harnessAdopt(f.dir, "round-one", adopt, undefined, f.ctx)],
    ["close", () => ops.harnessClose(f.dir, "round-one", {...decision(f.dir), sourceExecution: malformed}, undefined, f.ctx)],
  ] as const;
  for (const [name, operation] of operations) {
    let message = ""; try {await operation();} catch (cause) {message = (cause as Error).message;}
    expect(message).toContain(`correct sourceExecution in the ${name} input form`); expect(message).not.toContain("round definition"); expect(bytes(f.dir)).toEqual(before);
  }
});

test("a near-limit successor import refuses before any gate/ledger write and leaves the selected round readable", async () => {
  const f = await fixture("auto"); f.ctx.actor.id = "synthetic-actor-".padEnd(128, "a");
  const execution = {v: 1, tool: "ahub", projectKey: "p".repeat(256), kind: "k".repeat(128), id: "i".repeat(256), revision: "r".repeat(128), sha256: "a".repeat(64)};
  const raw = {...definition(), candidates: [{id: "one", guidanceSha256: source("candidate").guidanceHash}, {id: "two", guidanceSha256: "8".repeat(64)}], hypothesis: {deficiency: "d".repeat(2000), predictedChange: "p".repeat(2000)}, experience: Array.from({length: 16}, (_, i) => ({ref: {v: 1, tool: "amem", id: i.toString(16).padStart(32, "0")}, digest: "a".repeat(64)})), sourceExecutions: {proposal1: execution, proposal2: execution, composition: execution, selection: execution, reflection: execution}};
  await ops.harnessSet(f.dir, raw, f.ctx);
  for (const arm of ["baseline", "one", "two"]) {
    const projection = {...source(arm === "baseline" ? "baseline" : "candidate"), id: `${arm}-`.padEnd(256, "x"), arm, guidanceHash: arm === "two" ? "8".repeat(64) : source(arm === "baseline" ? "baseline" : "candidate").guidanceHash};
    await ops.harnessImport(f.dir, raw.id, projection, f.ctx);
  }
  const round = validateHarnessRound(raw), binding = harnessRoundBinding(round), probes = view(f.dir).probes, state = transitionState(), bucket = transitionBucket(state, round.id, binding), pending: PendingEvent[] = [];
  const limit = HARNESS_INDEX_BYTES - HARNESS_FORM_BYTES, goal = limit - 100;
  let found: ReturnType<typeof parseComposition> | undefined, largest = 0;
  const compositionFor = (length: number) => parseComposition({v: 1, id: "near-cap-composition", fingerprint: harnessEvidenceFingerprint(binding, probes, bucket), sections: Array.from({length: 32}, (_, i) => ({section: `section-${i}-`.padEnd(256, "s"), decision: "revise", contrasts: [...bucket.contrasts.values()].slice(0, 4).map(record => ({id: record.form.id, sha256: record.sha256})), reason: "r".repeat(length)})), successorSha256: "9".repeat(64)});
  const size = (form: ReturnType<typeof parseComposition>) => Buffer.byteLength(canonical({round, probes, transitions: transitionView(round, binding, probes, {...bucket, composition: {form, actor: f.ctx.actor, at: new Date(0).toISOString(), binding, sha256: recordHash(form, f.ctx.actor, binding), sourceStrength: "synthetic-fixture", matched: false}})}));
  for (let n = 0; n < 64; n++) {
    const form = {v: 1, id: `large-${n}-`.padEnd(64, "c"), fingerprint: harnessEvidenceFingerprint(binding, probes, bucket), arm: "one", outcome: "inconclusive", basis: "actor-claim", model: "m".repeat(256), sourceExecution: execution, observations: "o".repeat(2000), uncertainty: "u".repeat(2000), explanations: Array(8).fill("e".repeat(1000)), evidence: probes.filter(probe => ["baseline", "one"].includes(probe.projection.arm)).map(probe => ({probe: probe.projection.id, projectionSha256: probe.projectionSha256, outputManifestHash: probe.projection.outputManifestHash!}))};
    const type = "harness.contrast.recorded", data = {v: 1, round: round.id, binding, form, sha256: recordHash(form, f.ctx.actor, binding), sourceStrength: "synthetic-fixture"};
    applyTransition(state, {v: 1, actor: f.ctx.actor, at: new Date(0).toISOString(), type, data}, round, binding, probes); pending.push({actor: f.ctx.actor, type, data});
    if (bucket.contrasts.size < 4) continue;
    largest = size(compositionFor(1000));
    if (size(compositionFor(1)) <= goal && largest >= goal) {
      let lo = 1, hi = 1000;
      while (lo <= hi) {const mid = Math.floor((lo + hi) / 2), candidate = compositionFor(mid); if (size(candidate) <= goal) {found = candidate; lo = mid + 1;} else hi = mid - 1;}
      break;
    }
  }
  if (!found) throw new Error(`synthetic near-limit fixture could not reach ${goal}; largest ${largest}`);
  expect(size(found)).toBeGreaterThan(goal - 33); expect(size(found)).toBeLessThanOrEqual(goal);
  commit(f.dir, [], pending); await ops.harnessCompose(f.dir, raw.id, found, f.ctx);
  const before = bytes(f.dir), selected = ops.harnessShow(f.dir, raw.id); expect(selected.truncated).toBe(false); expect(selected.rounds).toHaveLength(1);
  await expect(ops.harnessImport(f.dir, raw.id, {...source("candidate"), id: "near-cap-successor".padEnd(256, "x"), arm: "successor", guidanceHash: "9".repeat(64)}, f.ctx)).rejects.toThrow("evidence view would exceed its 1 MiB bound");
  expect(bytes(f.dir)).toEqual(before); expect(ops.harnessShow(f.dir, raw.id)).toEqual(selected);
});

test("unexecuted successor adoption refuses before preview or writes, then accepts its exact imported execution", async () => {
  const f = await fixture(); await ops.harnessContrast(f.dir, "round-one", contrast(f.dir), f.ctx); await ops.harnessCompose(f.dir, "round-one", composition(f.dir), f.ctx);
  const make = () => ({v: 1, id: "adopt-successor", fingerprint: view(f.dir).transitions.fingerprint, decision: "adopt", arm: "successor", reason: "Synthetic experimental adoption", checks: [] as ReturnType<typeof ref>[], independentCheck: {state: "unavailable", source: {kind: "unavailable", refs: []}}});
  const before = bytes(f.dir); expect(view(f.dir).transitions.successor?.execution).toBe("unexecuted");
  for (const checks of [[], [ref(f.dir, "candidate")]]) for (const confirm of [undefined, "f".repeat(64)]) {
    await expect(ops.harnessAdopt(f.dir, "round-one", {...make(), checks}, confirm, f.ctx)).rejects.toThrow("import the exact successor fixture with ares harness import"); expect(bytes(f.dir)).toEqual(before);
  }
  expect(view(f.dir).transitions.closure).toBeNull();
  await ops.harnessImport(f.dir, "round-one", {...source("candidate"), id: "executed-successor", arm: "successor", guidanceHash: "9".repeat(64)}, f.ctx);
  const raw = {...make(), checks: [ref(f.dir, "successor")]}, preview = await ops.harnessAdopt(f.dir, "round-one", raw, undefined, f.ctx); if (!("needsConfirm" in preview)) throw new Error();
  await ops.harnessAdopt(f.dir, "round-one", raw, preview.fingerprint, f.ctx); expect(view(f.dir).transitions.closure?.outcome).toBe("adopted-experimental");
});

test("declared candidate with no current probe cannot be adopted and an existing candidate must be cited in checks", async () => {
  const f = await fixture("auto"); await ops.harnessSet(f.dir, {...definition(), candidates: [...definition().candidates, {id: "unexecuted-candidate", guidanceSha256: "8".repeat(64)}]}, f.ctx);
  const raw = {v: 1, id: "adopt-missing", fingerprint: view(f.dir).transitions.fingerprint, decision: "adopt", arm: "unexecuted-candidate", reason: "Synthetic experimental adoption", checks: [], independentCheck: {state: "unavailable", source: {kind: "unavailable", refs: []}}}, before = bytes(f.dir);
  expect(ops.gateList(f.dir).find(gate => gate.gate === "harness:round-one")?.state).toBe("pending");
  await expect(ops.harnessAdopt(f.dir, "round-one", raw, undefined, f.ctx)).rejects.toThrow("import the exact unexecuted-candidate fixture with ares harness import"); expect(bytes(f.dir)).toEqual(before);
  expect(ops.gateList(f.dir).find(gate => gate.gate === "harness:round-one")?.state).toBe("pending");
  const g = await fixture(), existing = {...raw, id: "uncited-candidate", fingerprint: view(g.dir).transitions.fingerprint, arm: "candidate", checks: [ref(g.dir, "baseline")]}, saved = bytes(g.dir);
  await expect(ops.harnessAdopt(g.dir, "round-one", existing, undefined, g.ctx)).rejects.toThrow("import the exact candidate fixture with ares harness import"); expect(bytes(g.dir)).toEqual(saved);
});

test("identical-byte successor adoption cites the reused candidate execution without creating another sample", async () => {
  const f = await fixture(); await ops.harnessContrast(f.dir, "round-one", contrast(f.dir), f.ctx); await ops.harnessCompose(f.dir, "round-one", composition(f.dir, source("candidate").guidanceHash), f.ctx);
  const before = view(f.dir), raw = {v: 1, id: "adopt-identical-successor", fingerprint: before.transitions.fingerprint, decision: "adopt", arm: "successor", reason: "Synthetic reuse of identical executed guidance", checks: [ref(f.dir, "candidate")], independentCheck: {state: "unavailable", source: {kind: "unavailable", refs: []}}};
  expect(before.transitions.successor).toMatchObject({execution: "fixture-declared", probeId: source("candidate").id});
  const preview = await ops.harnessAdopt(f.dir, "round-one", raw, undefined, f.ctx); if (!("needsConfirm" in preview)) throw new Error();
  await ops.harnessAdopt(f.dir, "round-one", raw, preview.fingerprint, f.ctx);
  const after = view(f.dir); expect(after.transitions.closure?.outcome).toBe("adopted-experimental"); expect(after.probes).toEqual(before.probes);
  expect(after.transitions.adoption?.form.checks[0]?.probe).toBe(source("candidate").id); expect(after.transitions.readiness).toMatchObject({correctness: "unavailable", transfer: "not-demonstrated"});
});

test("successor-first then identical candidate refuses a duplicate sample in write and replay", async () => {
  const f = await fixture(), raw = {...definition(), candidates: [...definition().candidates, {id: "later-candidate", guidanceSha256: "8".repeat(64)}]};
  await ops.harnessSet(f.dir, raw, f.ctx); await ops.gateDecide(f.dir, "harness:round-one", "approve", undefined, f.ctx);
  for (const name of ["baseline", "candidate"]) await ops.harnessImport(f.dir, raw.id, {...source(name), id: `reverse-${name}`}, f.ctx);
  await ops.harnessContrast(f.dir, raw.id, contrast(f.dir), f.ctx); await ops.harnessCompose(f.dir, raw.id, composition(f.dir, "8".repeat(64)), f.ctx);
  await ops.harnessImport(f.dir, raw.id, {...source("candidate"), id: "reverse-successor", arm: "successor", guidanceHash: "8".repeat(64)}, f.ctx);
  const late = {...source("candidate"), id: "reverse-late-candidate", arm: "later-candidate", guidanceHash: "8".repeat(64)}, before = bytes(f.dir), count = view(f.dir).probes.length;
  await expect(ops.harnessImport(f.dir, raw.id, late, f.ctx)).rejects.toThrow("reference it rather than count another sample"); expect(bytes(f.dir)).toEqual(before); expect(view(f.dir).probes).toHaveLength(count);
  commit(f.dir, [], [{actor: f.ctx.actor, type: "harness.probe.declared", data: {v: 1, round: raw.id, binding: view(f.dir).binding, projection: late, projectionSha256: sha256(canonical(late)), sourceStrength: "synthetic-fixture"}}]);
  expect(() => ops.harnessShow(f.dir)).toThrow("reference it rather than count another sample");
});

test("inconclusive contrasts may be incomplete but cannot cite another candidate's evidence", async () => {
  const f = await fixture(), raw = {...definition(), candidates: [...definition().candidates, {id: "other", guidanceSha256: "8".repeat(64)}]};
  await ops.harnessSet(f.dir, raw, f.ctx); await ops.gateDecide(f.dir, "harness:round-one", "approve", undefined, f.ctx);
  for (const name of ["baseline", "candidate"]) await ops.harnessImport(f.dir, raw.id, {...source(name), id: `incomplete-${name}`}, f.ctx);
  await ops.harnessImport(f.dir, raw.id, {...source("candidate"), id: "incomplete-other", arm: "other", guidanceHash: "8".repeat(64)}, f.ctx);
  const form = {...contrast(f.dir, "incomplete"), outcome: "inconclusive"}, before = bytes(f.dir);
  for (const evidence of [[ref(f.dir, "other")], [ref(f.dir, "baseline"), ref(f.dir, "other")], [ref(f.dir, "candidate"), ref(f.dir, "other")]]) {
    await expect(ops.harnessContrast(f.dir, raw.id, {...form, evidence}, f.ctx)).rejects.toThrow("unrelated arm"); expect(bytes(f.dir)).toEqual(before);
  }
  await ops.harnessContrast(f.dir, raw.id, {...form, evidence: [ref(f.dir, "baseline")]}, f.ctx);
  await ops.harnessContrast(f.dir, raw.id, {...contrast(f.dir, "incomplete-own"), outcome: "inconclusive", evidence: [ref(f.dir, "candidate")]}, f.ctx);
  expect(view(f.dir).transitions.contrasts.map(record => record.form.evidence.length)).toEqual([1, 1]);
});
