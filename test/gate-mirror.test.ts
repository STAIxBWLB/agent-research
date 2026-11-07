import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { gateWaitingTimes, type GateInputs } from "../src/ui/plugin.ts";
import { appendEvent, commit, gateState, readLedger, sha256, type GateName } from "../src/study.ts";
import { readProtocol } from "../src/exp/protocol.ts";
import { readSelection } from "../src/exp/selection.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), WIN = "b".repeat(40);
function study(mode = "survey") {
  const dir = join(tempDir(), "study");
  ops.init(dir, { question: "Synthetic mirror regression", mode }, ctx);
  return dir;
}
/** Observe the production mirror and compare it with the actual public gate binder, not a second mirror. */
function state(dir: string, gate: GateName) {
  const events = readLedger(dir), protocol = gate === "final" ? readProtocol(dir) : undefined;
  const report = ops.reviewShow(dir), inputs: GateInputs = {
    ...(protocol ? { selectionRun: readSelection(dir, protocol)?.run } : {}),
    ...(report.buildSha256 && report.manuscriptSha256 ? { review: {
      manuscriptSha256: report.manuscriptSha256, evidenceSha256: report.buildSha256,
      ids: new Set(report.reviews.map(row => row.id)),
    } } : {}),
  };
  const signatures = new Map<string, string | undefined>();
  const waiting = gateWaitingTimes(events, inputs, (name, signature) => signatures.set(name, signature));
  return { current: gateState(gate, events, ops.binder(dir)).current, signature: signatures.get(gate), at: waiting.get(gate) };
}
function compare(dir: string, gate: GateName) {
  let previous = state(dir, gate);
  expect(previous.signature === undefined).toBe(previous.current === undefined);
  return async (label: string, changed: boolean, mutate: () => unknown | Promise<unknown>) => {
    await mutate();
    const next = state(dir, gate);
    const actualChanged = next.current !== previous.current, mirroredChanged = next.signature !== previous.signature;
    expect({ label, actualChanged, mirroredChanged }).toEqual({ label, actualChanged: changed, mirroredChanged: changed });
    expect(next.signature === undefined).toBe(next.current === undefined);
    if (!changed) expect(next.at).toBe(previous.at);
    previous = next;
  };
}
async function experiment() {
  const dir = study("experiment");
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true });
  writeFileSync(join(dir, "task", "task.md"), "Synthetic task\n");
  writeFileSync(join(dir, "task", "evaluator", "run"), "Synthetic evaluator\n");
  await ops.protocol(dir, {
    v: 1, method: "synthetic", candidate: { image: `fixture@sha256:${"a".repeat(64)}`, command: ["candidate"] },
    evaluator: { image: `fixture@sha256:${"b".repeat(64)}`, command: ["evaluator"] },
    metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1, 2, 3],
    limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none",
    budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 },
  }, ctx);
  return dir;
}
const selection = (run = "investigate", minDelta = 1) => ({ v: 1, run, metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta });
/** Minimal synthetic v1 result bytes exercise exactly the closed-source fields read by finalGateBinding. */
function result(dir: string, run: string, winner: string | null, revision = 1) {
  const text = JSON.stringify({ v: 1, winner: winner === null ? null : { commit: winner }, revision }) + "\n";
  commit(dir, [[join(dir, "runs", run, "investigate.json"), text, 1_048_576]], [{ actor, type: "investigate.closed", data: { run, sha256: sha256(text), winner } }]);
}

test("scope mirror follows actual content binding across additions, rewrites and unrelated events", async () => {
  const dir = study(), check = compare(dir, "scope");
  await check("first scope", true, () => ops.scope(dir, { question: "Synthetic scope" }, ctx));
  await check("identical rewrite", false, () => ops.scope(dir, { question: "Synthetic scope" }, ctx));
  await check("unrelated event", false, () => appendEvent(dir, actor, "synthetic.unrelated", {}));
  await check("duplicate receipt", false, () => appendEvent(dir, actor, "scope.set", { ...readLedger(dir).findLast(e => e.type === "scope.set")!.data }));
  for (const field of [{ include: ["Synthetic inclusion"] }, { exclude: ["Synthetic exclusion"] }, { yearFrom: 2020 }, { maxCandidates: 30 }])
    await check(`scope field ${Object.keys(field)[0]}`, true, () => ops.scope(dir, { question: "Synthetic scope", ...field }, ctx));
});

test("screen mirror follows the included set, ignoring candidate content and excluded additions", async () => {
  const dir = study(); await ops.scope(dir, { question: "Synthetic scope" }, ctx); await ops.gateDecide(dir, "scope", "approve", undefined, ctx);
  const file = join(dir, "literature", "candidates.json");
  const candidates = ["one", "two", "three"].map(id => ({ id: `doi:10.0000/${id}`, title: `Synthetic ${id}`, authors: [], sources: ["openalex"], status: "new", addedAt: "2030-01-01T00:00:00Z" }));
  writeFileSync(file, JSON.stringify(candidates));
  const check = compare(dir, "screen");
  await check("first include", true, () => ops.screen(dir, [candidates[0]!.id], "include", "Synthetic inclusion", ctx));
  await check("unrelated exclude", false, () => ops.screen(dir, [candidates[1]!.id], "exclude", "Synthetic exclusion", ctx));
  await check("same included id", false, () => ops.screen(dir, [candidates[0]!.id], "include", "Different reason", ctx));
  await check("second include", true, () => ops.screen(dir, [candidates[1]!.id], "include", "Synthetic inclusion", ctx));
  await check("included title edit", false, () => { const rows = JSON.parse(readFileSync(file, "utf8")); rows[0].title = "Revised synthetic title"; writeFileSync(file, JSON.stringify(rows)); });
  await check("remove first inclusion", true, () => ops.screen(dir, [candidates[0]!.id], "exclude", "Synthetic exclusion", ctx));
  await check("remove last inclusion", true, () => ops.screen(dir, [candidates[1]!.id], "exclude", "Synthetic exclusion", ctx));
});

test("design mirror tracks protocol, task tree, selection and reserved seed inputs", async () => {
  const dir = await experiment(), check = compare(dir, "design");
  await check("identical protocol", false, () => ops.protocol(dir, readProtocol(dir)!, ctx));
  await check("protocol change", true, () => ops.protocol(dir, { ...readProtocol(dir)!, method: "Revised synthetic method" }, ctx));
  await check("task tree change", true, () => { writeFileSync(join(dir, "task", "task.md"), "Revised synthetic task\n"); return ops.protocol(dir, readProtocol(dir)!, ctx); });
  await check("selection added", true, () => ops.selection(dir, selection(), ctx));
  await check("selection changed", true, () => ops.selection(dir, selection("investigate", 2), ctx));
  await check("reserved seeds added", true, () => ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx));
  await check("reserved seeds changed", true, () => ops.finalSeeds(dir, { v: 1, seeds: [3] }, ctx));
  await check("same seeds", false, () => ops.finalSeeds(dir, { v: 1, seeds: [3] }, ctx));
  await check("unrelated close", false, () => result(dir, "other", WIN));
});

test("final mirror follows selected results, no-winner closes and required ablations", async () => {
  const dir = await experiment(); await ops.selection(dir, selection(), ctx); await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx);
  const check = compare(dir, "final");
  await check("winner close", true, () => result(dir, "investigate", WIN));
  await check("identical close", false, () => result(dir, "investigate", WIN));
  await check("unselected run", false, () => result(dir, "other", WIN));
  await check("selected result changed", true, () => result(dir, "investigate", WIN, 2));
  await check("protocol changed", true, () => ops.protocol(dir, { ...readProtocol(dir)!, method: "Changed final method" }, ctx));
  await check("selection changed", true, () => ops.selection(dir, selection("investigate", 2), ctx));
  await check("reserved seeds changed", true, () => ops.finalSeeds(dir, { v: 1, seeds: [3] }, ctx));
  await check("winner removed", true, () => result(dir, "investigate", null));
  await check("winner restored", true, () => result(dir, "investigate", WIN, 3));
  await check("ablation now required", true, () => appendEvent(dir, actor, "ablation.added", { ablation: { id: "synthetic", commit: "c".repeat(40), removes: "Synthetic component" } }));
  const ablate = (revision: number) => { const text = JSON.stringify({ v: 1, revision }) + "\n"; return commit(dir, [[join(dir, "runs", "ablate", "ablate.json"), text, 1_048_576]], [{ actor, type: "ablate.closed", data: { sha256: sha256(text) } }]); };
  await check("ablation result added", true, () => ablate(1));
  await check("same ablation result", false, () => ablate(1));
  await check("ablation result changed", true, () => ablate(2));
  await check("switch selected run", true, () => ops.selection(dir, selection("other"), ctx));
});

async function build(dir: string, text: string) {
  mkdirSync(join(dir, "paper"), { recursive: true }); writeFileSync(join(dir, "paper", "manuscript.md"), text);
  return ops.paperBuild(dir, ctx);
}
function addReview(dir: string, hash: string, id: string) {
  return ops.reviewAdd(dir, { v: 1, reviewer: { id, modelFamily: id }, buildSha256: hash,
    checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true },
    findings: [{ id: "finding", kind: "contradiction", location: "Synthetic section", text: "Synthetic contradiction", blocking: true }] }, ctx);
}
test("review mirror tracks current builds and selected review/resolution events only", async () => {
  const dir = study(), check = compare(dir, "review");
  let built!: Awaited<ReturnType<typeof build>>;
  await check("first paper build", true, async () => { built = await build(dir, "Synthetic manuscript.\n"); });
  await check("identical paper build", false, () => ops.paperBuild(dir, ctx));
  await check("first current review", true, () => addReview(dir, built.evidenceSha256, "first"));
  const oldId = String(readLedger(dir).findLast(e => e.type === "review.added")!.data.id);
  await check("new build", true, async () => { built = await build(dir, "Revised synthetic manuscript.\n"); });
  await check("resolve previous build", false, () => ops.reviewResolve(dir, `${oldId}/finding`, "Synthetic resolution of previous build", ctx));
  await check("current review", true, () => addReview(dir, built.evidenceSha256, "current"));
  const id = String(readLedger(dir).findLast(e => e.type === "review.added")!.data.id);
  await check("resolve current build", true, () => ops.reviewResolve(dir, `${id}/finding`, "Synthetic current resolution", ctx));
  await check("unrelated event", false, () => appendEvent(dir, actor, "synthetic.unrelated", {}));
});

test("plan mirror matches actual bindings across observations, revisions and gate removal", async () => {
  const dir = study();
  const definition = (query = "source", includeGate = true) => ({ v: 1, nodes: [
    { id: "source", kind: "step", command: "lit.search", args: { query } },
    ...(includeGate ? [{ id: "approve", kind: "gate", needs: ["source"], binds: ["source"] }] : []),
    { id: "unrelated", kind: "step", command: "lit.search", args: { query: "unrelated" } },
  ], edges: [] });
  await ops.planSet(dir, definition(), ctx);
  const check = compare(dir, "plan:approve");
  await check("definition without completed source", false, () => ops.planSet(dir, definition(), ctx));
  const observe = (revision: number, node: string, dispatchId: string, hash: string) => {
    appendEvent(dir, actor, "node.intent", { revision, node, dispatchId });
    appendEvent(dir, actor, "node.observed", { revision, node, dispatchId, status: "done", output: { sha256: hash.repeat(64) } });
  };
  const firstRevision = ops.planShow(dir).revision;
  await check("upstream observation", true, () => observe(firstRevision, "source", "source-1", "a"));
  await check("unrelated observation", false, () => observe(firstRevision, "unrelated", "unrelated-1", "b"));
  await check("duplicate upstream observation", false, () => appendEvent(dir, actor, "node.observed", { revision: firstRevision, node: "source", dispatchId: "source-1", status: "done", output: { sha256: "a".repeat(64) } }));
  await check("unchanged definition", false, () => ops.planSet(dir, definition(), ctx));
  await check("changed upstream definition", true, () => ops.planSet(dir, definition("changed"), ctx));
  const revision = ops.planShow(dir).revision;
  await check("retry stale upstream", false, () => ops.planControl(dir, { action: "retry", node: "source", commandId: "mirror-retry", expectedRevision: revision }, ctx));
  await check("new upstream observation", true, () => observe(revision, "source", "source-new", "c"));
  await check("gate removed", true, () => ops.planSet(dir, definition("changed", false), ctx));
});
