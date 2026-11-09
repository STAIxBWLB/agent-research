import {expect, test} from "bun:test";
import * as ops from "../src/commands.ts";
import {inspectLocalEvidence} from "../src/memory/evidence-local.ts";
import {readProvenance, type ExecutionReferenceV1} from "../src/provenance.ts";
import {appendEvent, readLedger, sha256} from "../src/study.ts";
import {canonical} from "../src/plan/state.ts";
import {provenanceFixture} from "./provenance-fixtures.ts";
import {fakeHttp, tempDir} from "./helpers.ts";

function dispatchNode(dir: string, id: string) {
  const page = readProvenance(dir); expect(page.status).toBe("ok");
  const node = page.nodes.find(node => node.ref.kind === "dispatch" && node.ref.id === id); expect(node).toBeDefined(); return node!;
}

test("dispatch pins bind accepted source records rather than unrelated appends or fenced done observations", async () => {
  const f = await provenanceFixture(), ref: ExecutionReferenceV1 = {v: 1, tool: "ares", projectKey: f.studyId, kind: "dispatch", id: f.plan.dispatchId};
  const original = dispatchNode(f.dir, ref.id), inspected = inspectLocalEvidence(f.dir, ref);
  expect(inspected.state).toBe("available"); expect(inspected.digest).toBe(original.proof.sourceBindingSha256!);
  const beforeLedgerDigest = original.proof.sha256, pin = {...ref, sha256: inspected.digest!};
  appendEvent(f.dir, f.ctx.actor, "synthetic.unrelated", {label: "Synthetic unrelated ledger append"});
  const afterAppend = dispatchNode(f.dir, ref.id); expect(afterAppend.proof.sha256).not.toBe(beforeLedgerDigest); expect(afterAppend.proof.sourceBindingSha256).toBe(inspected.digest!);
  expect(inspectLocalEvidence(f.dir, pin)).toMatchObject({state: "available", digest: inspected.digest!});
  appendEvent(f.dir, f.ctx.actor, "node.observed", {revision: f.plan.completedRevision, node: f.ids.planStep, dispatchId: f.plan.dispatchId, status: "done", output: {sha256: "f".repeat(64)}});
  appendEvent(f.dir, f.ctx.actor, "node.observed", {revision: f.plan.currentRevision + 1, node: f.ids.planStep, dispatchId: f.plan.dispatchId, status: "failed", reason: "Synthetic future revision"});
  appendEvent(f.dir, f.ctx.actor, "node.observed", {revision: f.plan.currentRevision, node: f.ids.planStep, dispatchId: "synthetic-unrelated-dispatch", status: "failed", reason: "Synthetic wrong dispatch"});
  expect(ops.planShow(f.dir).nodes.find(node => node.id === f.ids.planStep)?.status).toBe("done");
  expect(dispatchNode(f.dir, ref.id).proof.sourceBindingSha256).toBe(inspected.digest!);
  expect(inspectLocalEvidence(f.dir, pin)).toMatchObject({state: "available", digest: inspected.digest!, outcome: {success: false}, support: "reviewer-judgment"});
});

test("accepted progress and terminal changes refine dispatch binding even with no new Attempt", async () => {
  const dir = tempDir(), ctx = {actor: {kind: "person" as const}, http: fakeHttp([]).http}, study = ops.init(dir, {question: "Synthetic native dispatch binding", mode: "experiment"}, ctx).study;
  await ops.planSet(dir, {v: 1, nodes: [{id: "inspect", kind: "step", command: "lit.bib", args: {}}], edges: []}, ctx);
  const id = "1:inspect:1", ref: ExecutionReferenceV1 = {v: 1, tool: "ares", projectKey: study.id, kind: "dispatch", id};
  appendEvent(dir, ctx.actor, "node.intent", {revision: 1, node: "inspect", dispatchId: id});
  appendEvent(dir, ctx.actor, "node.observed", {revision: 1, node: "inspect", dispatchId: id, status: "dispatched", reason: "Synthetic progress one"});
  const first = inspectLocalEvidence(dir, ref); expect(first.state).toBe("available");
  const firstStatus = ops.planShow(dir).nodes[0]!.status; expect(firstStatus).toBe("dispatched");
  appendEvent(dir, ctx.actor, "node.observed", {revision: 1, node: "inspect", dispatchId: id, status: "dispatched", reason: "Synthetic progress two"});
  expect(ops.planShow(dir).nodes[0]!.status).toBe(firstStatus);
  const refined = inspectLocalEvidence(dir, {...ref, sha256: first.digest!}); expect(refined.state).toBe("changed"); expect(refined.digest).not.toBe(first.digest);
  appendEvent(dir, ctx.actor, "node.observed", {revision: 1, node: "inspect", dispatchId: id, status: "failed", reason: "Synthetic terminal failure"});
  expect(ops.planShow(dir).nodes[0]!.status).toBe("failed");
  const terminal = inspectLocalEvidence(dir, ref); expect(terminal.state).toBe("available"); expect(terminal.digest).not.toBe(refined.digest); expect(terminal.outcome.success).toBe(false);
  const sources = readLedger(dir).filter(event => (event.type === "node.intent" || event.type === "node.observed") && event.data.dispatchId === id);
  expect(dispatchNode(dir, id).proof.sourceBindingSha256).toBe(sha256(canonical(sources))); expect(terminal.digest).toBe(sha256(canonical(sources)));
  expect(inspectLocalEvidence(dir, {...ref, sha256: refined.digest!}).state).toBe("changed");
});
