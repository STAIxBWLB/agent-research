import {legacySkillFixture} from "./legacy-skill-fixture.ts";
import {expect, spyOn, test} from "bun:test";
import * as fs from "node:fs";
import * as child from "node:child_process";
import {dirname, join} from "node:path";
import * as ops from "../src/commands.ts";
import {inspectLocalEvidence} from "../src/memory/evidence-local.ts";
import {ATTEMPT_BYTES} from "../src/exp/attempts.ts";
import {readProtocol, protocolHash, designBinding} from "../src/exp/protocol.ts";
import {appendEvent, commit, readBytesBounded, readTextBounded, sha256, writeAtomic} from "../src/study.ts";
import {type ExecutionReferenceV1} from "../src/provenance.ts";
import {provenanceFixture, type ProvenanceFixture} from "./provenance-fixtures.ts";
import {metricAttempt, metricProtocol} from "./metric-fixtures.ts";
import {fakeHttp, tempDir} from "./helpers.ts";

const reference = (f: ProvenanceFixture, kind: ExecutionReferenceV1["kind"], id: string, sha?: string): ExecutionReferenceV1 => ({v: 1, tool: "ares", projectKey: f.studyId, kind, id, ...(sha ? {sha256: sha} : {})});
const inspect = (f: ProvenanceFixture, kind: ExecutionReferenceV1["kind"], id: string, sha?: string) => inspectLocalEvidence(f.dir, reference(f, kind, id, sha));

test("current native records expose filtered metadata and recorded outcome, never scientific support", async () => {
  const f = await provenanceFixture(), file = join(f.dir, "runs", "investigate", "attempts", `${f.ids.retryAttempt}.json`);
  const result = inspect(f, "attempt", f.ids.retryAttempt);
  expect(result).toMatchObject({state: "available", digest: sha256(readBytesBounded(file, ATTEMPT_BYTES)), integrity: "record", sourceVersion: {reference: 1, native: 1}, outcome: {status: "succeeded", success: true}, support: "reviewer-judgment"});
  expect(result.metadata).toEqual({status: "succeeded"});
  expect(inspect(f, "attempt", f.ids.interruptedAttempt)).toMatchObject({state: "available", outcome: {status: "failed", success: false}});
  expect(inspect(f, "closed-result", "final", f.closed.final.sha256)).toMatchObject({state: "available", digest: f.closed.final.sha256, outcome: {status: "qualified", success: true}, metadata: {family: "final", qualification: "qualified"}, support: "reviewer-judgment"});
  const serialized = JSON.stringify(result); expect(serialized).not.toContain(f.dir); expect(serialized).not.toContain("Synthetic"); expect(serialized).not.toContain("proof");
});

test("expected digest drift is changed after lookup by base identity, while absent refs stay missing", async () => {
  const f = await provenanceFixture();
  expect(inspect(f, "attempt", f.ids.retryAttempt, "f".repeat(64))).toMatchObject({state: "changed", integrity: "unverified", outcome: {success: false}});
  expect(inspect(f, "closed-result", "final", "f".repeat(64))).toMatchObject({state: "changed", digest: f.closed.final.sha256, outcome: {success: false}});
  expect(inspect(f, "attempt", "e".repeat(16))).toMatchObject({state: "missing", digest: null, outcome: {success: false}});
});

test("wrong-study addresses read only current study metadata and malformed/future refs are unsupported", async () => {
  const f = await provenanceFixture(), ref = reference(f, "attempt", f.ids.retryAttempt), open = fs.openSync, paths: string[] = [];
  const spy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {paths.push(String(file)); return open(file, flags, mode);}) as typeof fs.openSync);
  try {expect(inspectLocalEvidence(f.dir, {...ref, projectKey: "unregistered-other-study"})).toMatchObject({state: "unsupported", digest: null, outcome: {success: false}});}
  finally {spy.mockRestore();}
  expect(paths.length).toBeGreaterThan(0); expect(paths.every(path => path.endsWith("/study.json"))).toBe(true);
  for (const raw of ["ares:synthetic/attempt:unsupported-string", null, {}, {...ref, v: 2}, {...ref, tool: "amem"}, {...ref, extra: true}]) expect(inspectLocalEvidence(f.dir, raw)).toMatchObject({state: "unsupported", digest: null, integrity: "unverified", outcome: {success: false}, support: "reviewer-judgment"});
});

test("unfinished and unknown native attempts remain available records with no successful outcome", async () => {
  const f = await provenanceFixture(), current = readProtocol(f.dir)!, record = metricAttempt();
  Object.assign(record, {id: "d".repeat(16), studyId: f.studyId, run: "pending", protocol: current, protocolHash: protocolHash(current), sealBinding: designBinding(f.dir), metrics: [], outputs: [], label: "Synthetic pending execution"});
  const file = join(f.dir, "runs", record.run, "attempts", `${record.id}.json`); fs.mkdirSync(dirname(file), {recursive: true});
  commit(f.dir, [[file, JSON.stringify(record), ATTEMPT_BYTES]], [{actor: f.ctx.actor, type: "attempt.started", data: {id: record.id, run: record.run, commit: record.commit, seed: record.seed, status: "running"}}]);
  expect(inspect(f, "attempt", record.id)).toMatchObject({state: "available", integrity: "record", outcome: {status: "unfinished", success: false}});
  record.status = "unknown"; writeAtomic(file, JSON.stringify(record), ATTEMPT_BYTES);
  appendEvent(f.dir, f.ctx.actor, "attempt.unknown", {id: record.id, status: "unknown"});
  expect(inspect(f, "attempt", record.id)).toMatchObject({state: "available", outcome: {status: "unknown", success: false}});
});

test("valid closed no-winner and negative final results remain evidence, not validated success", async () => {
  const dir = tempDir(), ctx = {actor: {kind: "person" as const}, http: fakeHttp([]).http};
  const {study} = ops.init(dir, {question: "Synthetic empty investigation", mode: "experiment"}, ctx);
  fs.mkdirSync(join(dir, "task", "evaluator"), {recursive: true}); writeAtomic(join(dir, "task", "task.md"), "Synthetic task", 65_536); writeAtomic(join(dir, "task", "evaluator", "run"), "Synthetic evaluator", 65_536);
  await ops.protocol(dir, metricProtocol(), ctx); await ops.selection(dir, {v: 1, run: "investigate", metric: "score", baseline: {commit: "a".repeat(40)}, minSeeds: 1, minDelta: 1}, ctx); await ops.investigateClose(dir, ctx);
  expect(inspectLocalEvidence(dir, {v: 1, tool: "ares", projectKey: study.id, kind: "closed-result", id: "investigate"})).toMatchObject({state: "available", integrity: "record", outcome: {status: "no-winner", success: false}, metadata: {family: "investigate", winner: false}, support: "reviewer-judgment"});
  const f = await provenanceFixture(), file = join(f.dir, "runs", "final", "attempts", `${f.ids.finalWinnerAttempt}.json`), record = JSON.parse(readTextBounded(file, ATTEMPT_BYTES));
  record.metrics[0].value = 0; writeAtomic(file, JSON.stringify(record), ATTEMPT_BYTES); await ops.finalClose(f.dir, f.ctx); await ops.paperBuild(f.dir, f.ctx);
  expect(inspect(f, "closed-result", "final")).toMatchObject({state: "available", integrity: "record", outcome: {status: "not_qualified", success: false}, metadata: {qualification: "not_qualified"}});
});

test("artifact inventory and historical receipts never validate executor bytes or successful outcomes", async () => {
  const f = await provenanceFixture();
  expect(inspect(f, "artifact", f.outputSHA)).toMatchObject({state: "available", digest: f.outputSHA, integrity: "receipt-only", outcome: {success: false}, support: "reviewer-judgment"});
  expect(inspectLocalEvidence(f.dir, {...reference(f, "plan-revision", "1"), revision: "1"})).toMatchObject({state: "available", integrity: "unverified", outcome: {status: "unverified", success: false}});
});

test("missing, corrupt and future source records cannot become successful evidence", async () => {
  for (const kind of ["missing", "mismatch", "future", "ledger"] as const) {
    const f = await provenanceFixture(), file = kind === "ledger" ? join(f.dir, "ledger.jsonl") : kind === "future" ? join(f.dir, "runs", "investigate", "attempts", `${f.ids.retryAttempt}.json`) : join(f.dir, "runs", "final", "final.json");
    if (kind === "missing") fs.unlinkSync(file);
    else if (kind === "mismatch") writeAtomic(file, readTextBounded(file, ATTEMPT_BYTES) + " ", ATTEMPT_BYTES);
    else if (kind === "future") writeAtomic(file, JSON.stringify({...JSON.parse(readTextBounded(file, ATTEMPT_BYTES)), v: 99}), ATTEMPT_BYTES);
    else writeAtomic(file, "not JSON\n", 65_536);
    const ref = kind === "future" ? reference(f, "attempt", f.ids.retryAttempt) : reference(f, "closed-result", "final");
    const result = inspectLocalEvidence(f.dir, ref); expect(result.state).toBe(kind === "missing" ? "missing" : kind === "mismatch" ? "changed" : kind === "future" ? "unsupported" : "unavailable");
    expect(result.outcome.success).toBe(false); expect(result.integrity).toBe("unverified");
  }
});

test("capped source traversal is unavailable, not an empty or successful evidence result", async () => {
  const f = await provenanceFixture();
  commit(f.dir, [], Array.from({length: 990}, (_, i) => ({actor: f.ctx.actor, type: "idea.added", data: {idea: {id: `synthetic-cap-${i}`, title: "Synthetic cap", hypothesis: "Synthetic untested hypothesis"}}})));
  expect(inspect(f, "attempt", f.ids.retryAttempt)).toMatchObject({state: "unavailable", integrity: "unverified", outcome: {success: false}});
});

test("inspection writes nothing, reads no output body, and never starts network/process/hub work", async () => {
  const f = await provenanceFixture(), outputs = new Set(Object.values(f.outputs).map(output => fs.realpathSync(output.path))), journal = readBytesBounded(join(f.dir, "ledger.jsonl"), 1024 * 1024), open = fs.openSync;
  const openSpy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
    if (outputs.has(String(file)) || String(file).endsWith("/.ares.lock") || String(file).endsWith("/.ares.plan.lock")) throw new Error("forbidden output/control access");
    return open(file, flags, mode);
  }) as typeof fs.openSync);
  const forbidden = (): never => {throw new Error("forbidden side effect");};
  const writes = [spyOn(fs, "writeSync").mockImplementation(forbidden), spyOn(fs, "appendFileSync").mockImplementation(forbidden), spyOn(fs, "mkdirSync").mockImplementation(forbidden), spyOn(fs, "renameSync").mockImplementation(forbidden)];
  const preconnect = spyOn(globalThis.fetch, "preconnect").mockImplementation(forbidden), spawn = spyOn(child, "spawn").mockImplementation(forbidden), sync = spyOn(child, "spawnSync").mockImplementation(forbidden), fetch = spyOn(globalThis, "fetch").mockImplementation(Object.assign(forbidden, {preconnect}));
  try {expect(inspect(f, "artifact", f.outputSHA).state).toBe("available"); for (const write of writes) expect(write).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(sync).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(preconnect).not.toHaveBeenCalled();}
  finally {openSpy.mockRestore(); writes.forEach(write => write.mockRestore()); spawn.mockRestore(); sync.mockRestore(); fetch.mockRestore(); preconnect.mockRestore();}
  expect(readBytesBounded(join(f.dir, "ledger.jsonl"), 1024 * 1024)).toEqual(journal);
});

test("ledger-backed evidence digests bind the record rather than unrelated later appends", async () => {
  const f = await provenanceFixture(), before = inspect(f, "idea", f.ids.parentIdea);
  expect(before.state).toBe("available"); expect(before.digest).toMatch(/^[a-f0-9]{64}$/);
  legacySkillFixture(f.dir, {name: "unrelated-evidence-proposal", summary: "Synthetic later proposal", steps: ["Inspect synthetic evidence"], evidence: ["a".repeat(32)]}, f.ctx.actor);
  const after = inspect(f, "idea", f.ids.parentIdea, before.digest!);
  expect(after.state).toBe("available"); expect(after.digest).toBe(before.digest);
});

test("a native idea refinement changes its folded-source binding even if its open status is unchanged", async () => {
  const f = await provenanceFixture(), before = inspect(f, "idea", f.ids.childIdea);
  expect(before.state).toBe("available");
  await ops.ideaDecide(f.dir, f.ids.childIdea, {decision: "refine", reason: "Synthetic follow-up evidence", attempts: [f.ids.retryAttempt], commit: "f".repeat(40)}, f.ctx);
  const after = inspect(f, "idea", f.ids.childIdea, before.digest!);
  expect(after.state).toBe("changed"); expect(after.digest).not.toBe(before.digest);
  expect(after.outcome.success).toBe(false);
});
