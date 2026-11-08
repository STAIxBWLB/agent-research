import {expect, test} from "bun:test";
import {join} from "node:path";
import {existsSync} from "node:fs";
import * as ops from "../src/commands.ts";
import {run} from "../src/cli.ts";
import {createAresMcp} from "../src/mcp-tools.ts";
import {parseProbeFixture, type ProbeFixtureProjectionV1} from "../src/harness/receipts.ts";
import {harnessRoundBinding, HARNESS_INDEX_BYTES, type DeclaredProbe} from "../src/harness/rounds.ts";
import {transitionState, transitionBucket, applyTransition, harnessEvidenceFingerprint, recordHash} from "../src/harness/transitions.ts";
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
const contrast = (dir: string, id = "contrast-one") => ({v: 1, id, fingerprint: view(dir).transitions.fingerprint, arm: "candidate", outcome: "improved", basis: "human-judgment", observations: "Synthetic behavior changed", uncertainty: "No native producer proof", explanations: ["Synthetic task differences may explain it"], evidence: [ref(dir, "baseline"), ref(dir, "candidate")]});
function composition(dir: string, successorSha256: string | null = "9".repeat(64)) {const c = view(dir).transitions.contrasts[0]!; return {v: 1, id: "composition-one", fingerprint: view(dir).transitions.fingerprint, sections: [{section: "Synthetic checks", decision: "revise", contrasts: [{id: c.form.id, sha256: c.sha256}], reason: "Synthetic contrast-backed edit"}], successorSha256};}
const decision = (dir: string) => ({v: 1, id: "decision-one", fingerprint: view(dir).transitions.fingerprint, decision: "keep-baseline", arm: "baseline", reason: "No independent real correctness evidence", checks: []});

async function close(dir: string, form: unknown, ctx: Parameters<typeof ops.harnessAdopt>[4]) {
  const preview = await ops.harnessAdopt(dir, "round-one", form, undefined, ctx); if (!("needsConfirm" in preview)) throw new Error("preview required");
  return ops.harnessAdopt(dir, "round-one", form, preview.fingerprint, ctx);
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
  const events = readLedger(f.dir); expect(events.slice(-2).map(e => e.type)).toEqual(["harness.adoption.decided", "harness.round.closed"]); expect(events.at(-1)!.at).toBe(events.at(-2)!.at);
  const successor = {...source("candidate"), id: "successor-probe", arm: "successor", guidanceHash: "9".repeat(64)};
  await ops.harnessImport(f.dir, "round-one", successor, f.ctx);
  expect(view(f.dir).transitions.successor).toMatchObject({execution: "fixture-declared", probeId: "successor-probe"});
  expect(view(f.dir).transitions.readiness.state).toBe("stale"); expect(view(f.dir).transitions.closure?.current).toBe(false);
  expect(ops.attemptList(f.dir).total).toBe(0); expect(existsSync(join(f.dir, "runs"))).toBe(false); expect(f.transport.requests).toHaveLength(0);
});

test("adoption preview and stale/incorrect confirmation write nothing, including auto approvals", async () => {
  const f = await fixture("auto"), form = decision(f.dir), before = bytes(f.dir), preview = await ops.harnessAdopt(f.dir, "round-one", form, undefined, f.ctx);
  expect("needsConfirm" in preview && preview.needsConfirm).toBe(true); expect(bytes(f.dir)).toEqual(before);
  await expect(ops.harnessAdopt(f.dir, "round-one", form, "f".repeat(64), f.ctx)).rejects.toThrow("confirmation differs"); expect(bytes(f.dir)).toEqual(before);
  await ops.harnessContrast(f.dir, "round-one", contrast(f.dir), f.ctx); const saved = bytes(f.dir);
  if (!("needsConfirm" in preview)) throw new Error();
  await expect(ops.harnessAdopt(f.dir, "round-one", form, preview.fingerprint, f.ctx)).rejects.toThrow("stale evidence fingerprint"); expect(bytes(f.dir)).toEqual(saved);
});

test("changed definitions reopen readiness without rewriting old closure, and duplicate decisions remain no-ops", async () => {
  const f = await fixture(), form = decision(f.dir); const first = await close(f.dir, form, f.ctx), before = bytes(f.dir);
  const repeated = await ops.harnessAdopt(f.dir, "round-one", form, undefined, f.ctx); expect("duplicate" in repeated && repeated.duplicate).toBe(true); expect(bytes(f.dir)).toEqual(before);
  if (!("record" in repeated) || !("record" in first)) throw new Error("record receipt required");
  expect(repeated.record).toEqual(first.record);
  await ops.harnessSet(f.dir, {...definition(), hypothesis: {deficiency: "Synthetic new observation", predictedChange: "Synthetic new prediction"}}, f.ctx);
  expect(view(f.dir).transitions.readiness.state).toBe("open"); expect(view(f.dir).historicalImports).toBe(2);
  expect(readLedger(f.dir).filter(e => e.type === "harness.round.closed")).toHaveLength(1);
  const old = readLedger(f.dir).find(e => e.type === "harness.round.closed")!; expect(old.data.fingerprint).toBe(form.fingerprint);
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
});

test("failed/unknown declarations remain visible and inconclusive/base preservation are normal closures", async () => {
  for (const [outcome, state] of [["inconclusive", "unknown"], ["unchanged", "failed"], ["regressed", "cancelled"]] as const) {
    const f = await fixture("gates", state);
    expect(view(f.dir).probes.find(p => p.projection.arm === "candidate")!.projection.state).toBe(state); await ops.harnessContrast(f.dir, "round-one", {...contrast(f.dir), outcome}, f.ctx);
    await ops.harnessCompose(f.dir, "round-one", composition(f.dir, null), f.ctx);
    await close(f.dir, {...decision(f.dir), decision: "inconclusive"}, f.ctx);
    expect(view(f.dir).transitions.successor).toBeNull(); expect(view(f.dir).transitions.readiness.transfer).toBe("not-demonstrated");
  }
});

test("controlled authored forms need declared source execution and model identity; no runtime source is inferred", async () => {
  const f = await fixture(), raw = definition(), sourceExecution = {v: 1, tool: "ahub", projectKey: "synthetic-project", kind: "guidance-probe", id: "synthetic-selection", sha256: "a".repeat(64)};
  await ops.harnessSet(f.dir, {...raw, authoring: "controlled-lane", sourceExecutions: {proposal1: sourceExecution}}, f.ctx);
  await ops.gateDecide(f.dir, "harness:round-one", "approve", undefined, f.ctx);
  for (const name of ["baseline", "candidate"]) await ops.harnessImport(f.dir, raw.id, {...source(name), id: `controlled-${name}`}, f.ctx);
  const before = bytes(f.dir), c = {...contrast(f.dir), basis: "model-judgment", model: "synthetic-model"};
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
  const a = JSON.parse((await run(["harness", "adopt", f.dir, "round-one", "--file", "-", "--json"], f.env, {...f.ctx, readStdin: async () => JSON.stringify(raw)})).text);
  const b = await server.handlers.ares_harness_adopt!({study: f.dir, round: "round-one", decision: raw}); expect(a).toEqual(b); expect(bytes(f.dir)).toEqual(before);
  await server.handlers.ares_harness_adopt!({study: f.dir, round: "round-one", decision: raw, confirm: a.fingerprint}); expect(view(f.dir).transitions.closure?.actor.kind).toBe("agent");
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
      const form = {v: 1, id: `contrast-${index}-${n}`, fingerprint: harnessEvidenceFingerprint(binding, probes, bucket), arm: "candidate", outcome: "inconclusive", basis: "human-judgment", observations: "o".repeat(2000), uncertainty: "u".repeat(2000), explanations: Array(8).fill("e".repeat(1000)), evidence: probes.map(p => ({probe: p.projection.id, projectionSha256: p.projectionSha256}))};
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
  for (const raw of [{...base, v: 2}, {...base, evidence: null}, {...base, basis: "model-judgment"}, {...base, uncertainty: "x".repeat(2001)}]) {
    await expect(ops.harnessContrast(f.dir, "round-one", raw, f.ctx)).rejects.toThrow(); expect(bytes(f.dir)).toEqual(before);
  }
  await ops.harnessSet(f.dir, {...definition(), hypothesis: {...definition().hypothesis, predictedChange: "Explicit changed hypothesis"}}, f.ctx);
  const noApproval = bytes(f.dir), form = {...decision(f.dir), id: "changed-gate"};
  const preview = await ops.harnessAdopt(f.dir, "round-one", form, undefined, f.ctx); if (!("needsConfirm" in preview)) throw new Error();
  await expect(ops.harnessAdopt(f.dir, "round-one", form, preview.fingerprint, f.ctx)).rejects.toThrow("pending"); expect(bytes(f.dir)).toEqual(noApproval);
  const malformed = {v: 1, round: "round-one", binding: view(f.dir).binding, fingerprint: form.fingerprint, adoptionSha256: "a".repeat(64), sourceStrength: "synthetic-fixture"};
  commit(f.dir, [], [{actor: f.ctx.actor, type: "harness.round.closed", data: malformed}]);
  expect(() => ops.harnessShow(f.dir)).toThrow("closure lacks its current adoption");
});
