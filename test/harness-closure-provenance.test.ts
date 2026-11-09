import {expect, spyOn, test} from "bun:test";
import * as fs from "node:fs";
import {join} from "node:path";
import * as ops from "../src/commands.ts";
import {inspectLocalEvidence} from "../src/memory/evidence-local.ts";
import {readProvenance, validateExecutionReference, type ExecutionReferenceV1} from "../src/provenance.ts";
import {appendEvent, openStudy, readBytesBounded, readLedger, writeAtomic} from "../src/study.ts";
import {fakeHttp, fakeRunner, tempDir} from "./helpers.ts";
const definition = () => ({v: 1, id: "round-one", task: {id: "synthetic-task", inputSha256: "a".repeat(64)}, baseline: {guidanceSha256: "b".repeat(64)}, candidates: [], hypothesis: {deficiency: "Synthetic omission", predictedChange: "Synthetic explicit check"}, experience: [], authoring: "uncontrolled-authoring"});
async function fixture() {
  const dir = join(tempDir(), "study"), transport = fakeRunner([]), ctx = {actor: {kind: "person" as const, id: "synthetic-owner"}, http: fakeHttp([]).http, runner: transport.runner};
  ops.init(dir, {question: "Synthetic closure provenance", mode: "experiment"}, ctx);
  await ops.harnessSet(dir, definition(), ctx); await ops.gateDecide(dir, "harness:round-one", "approve", undefined, ctx);
  const form = {v: 1, id: "closure-one", fingerprint: ops.harnessShow(dir).rounds[0]!.transitions.fingerprint, outcome: "baseline-kept", reason: "Synthetic baseline retained"};
  const preview = await ops.harnessClose(dir, "round-one", form, undefined, ctx);
  if (!("fingerprint" in preview)) throw new Error("expected native preview");
  await ops.harnessClose(dir, "round-one", form, preview.fingerprint, ctx);
  const closure = ops.harnessShow(dir).rounds[0]!.transitions.closure!;
  const ref: ExecutionReferenceV1 = {v: 1, tool: "ares", projectKey: openStudy(dir).study.id, kind: "harness-closure", id: "round-one", sha256: closure.sha256};
  return {dir, ctx, transport, closure, ref};
}
test("native closure is a separately typed current declaration with stable exact digest, never successful evidence", async () => {
  const f = await fixture(), page = readProvenance(f.dir), node = page.nodes.find(node => node.ref.kind === "harness-closure")!;
  expect(page.status).toBe("ok"); expect(node).toMatchObject({ref: f.ref, state: "current", availability: "available", data: {status: "closed", outcome: "baseline-kept", sourceStrength: "synthetic-fixture", actorKind: "person", actorId: "synthetic-owner"}});
  expect(readLedger(f.dir)[node.proof.ledgerIndex!]!.type).toBe("harness.round.closed");
  expect(inspectLocalEvidence(f.dir, f.ref)).toMatchObject({state: "available", digest: f.closure.sha256, integrity: "record", sourceVersion: {reference: 1, native: 1, ledger: 1}, outcome: {status: "closed", success: false}, support: "reviewer-judgment"});
  appendEvent(f.dir, f.ctx.actor, "synthetic.unrelated", {note: "Synthetic unrelated append"});
  expect(inspectLocalEvidence(f.dir, f.ref)).toMatchObject({state: "available", digest: f.closure.sha256, outcome: {success: false}});
  expect(f.transport.requests).toEqual([]);
});
test("changed round retains prior closure hash as historical unverified evidence", async () => {
  const f = await fixture(); await ops.harnessSet(f.dir, {...definition(), hypothesis: {deficiency: "Synthetic revised omission", predictedChange: "Synthetic revised check"}}, f.ctx);
  const node = readProvenance(f.dir).nodes.find(node => node.ref.sha256 === f.closure.sha256)!;
  expect(node).toMatchObject({ref: f.ref, state: "historical"});
  expect(inspectLocalEvidence(f.dir, f.ref)).toMatchObject({state: "available", digest: f.closure.sha256, integrity: "unverified", outcome: {status: "unverified", success: false}});
  expect(f.transport.requests).toEqual([]);
});
test("future and corrupt captured harness indexes refuse without rewriting source or ledger", async () => {
  for (const raw of [{v: 99, rounds: []}, {v: 1, rounds: []}]) {
    const f = await fixture(), path = join(f.dir, "design", "harness.json"); writeAtomic(path, JSON.stringify(raw), 1_048_576);
    const bytes = readBytesBounded(path, 1_048_576), ledger = readBytesBounded(join(f.dir, "ledger.jsonl"), 1_048_576);
    expect(readProvenance(f.dir).status).toBe("unavailable");
    expect(inspectLocalEvidence(f.dir, f.ref).state).toBe(raw.v === 99 ? "unsupported" : "unavailable");
    expect(readBytesBounded(path, 1_048_576)).toEqual(bytes); expect(readBytesBounded(join(f.dir, "ledger.jsonl"), 1_048_576)).toEqual(ledger); expect(f.transport.requests).toEqual([]);
  }
  expect(() => validateExecutionReference({v: 2, tool: "ares", projectKey: "synthetic", kind: "harness-closure", id: "round-one"})).toThrow("unsupported");
});

for (const name of ["harness.json", "harness-stream.json", "harness-experience.json"]) test(`executor exclusions protect captured ${name} before opening its bytes`, async () => {
  const f = await fixture(), target = join(fs.realpathSync(f.dir), "design", name);
  writeAtomic(join(f.dir, "executor.json"), JSON.stringify({v: 1, kind: "local", workdir: target}), 65_536);
  const original = fs.openSync, opened: string[] = [], guard = spyOn(fs, "openSync").mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file) === target) {opened.push(String(file)); throw new Error("private source read");}
    return Reflect.apply(original, fs, [file, ...args]);
  }) as typeof fs.openSync);
  try {const page = readProvenance(f.dir); expect(page.status).toBe("unavailable"); expect(page.issues[0]?.code).toBe("executor-overlaps-source"); expect(opened).toEqual([]);}
  finally {guard.mockRestore();}
});
