import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ops from "../src/commands.ts";
import { ATTEMPT_BYTES, listAttempts, type Attempt } from "../src/exp/attempts.ts";
import { designBinding, protocolHash, readProtocol, type Protocol } from "../src/exp/protocol.ts";
import { readClosedInvestigation } from "../src/exp/investigate.ts";
import { finalGateBinding, readClosedFinal, requireFinalInputs } from "../src/exp/final.ts";
import { readCurrentBuild } from "../src/paper/build.ts";
import { MANUSCRIPT_BYTES } from "../src/paper/placeholders.ts";
import { commit, openStudy, readLedger, readTextBounded, sha256, writeAtomic } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
import { metricAttempt, metricProtocol } from "./metric-fixtures.ts";

const BASE = "a".repeat(40), WIN = "b".repeat(40), SMALL_BYTES = 65_536;
/** Real native source records, with synthetic attempts only: no executor, Docker, hub or graph producer. */
export async function provenanceFixture(dir = tempDir()) {
  const actor = { kind: "person" as const, id: "synthetic-fixture" }, ctx = { actor, http: fakeHttp([]).http };
  const { study } = ops.init(dir, { question: "Does the synthetic refinement improve the paired score?", mode: "experiment", autonomy: "gates" }, ctx);
  const write = (relative: string, text: string, bound = SMALL_BYTES) => {
    const file = join(dir, relative); mkdirSync(dirname(file), { recursive: true }); writeAtomic(file, text, bound); return file;
  };
  write("task/task.md", "Synthetic paired-score task.\n"); write("task/evaluator/run", "Synthetic evaluator fixture, never executed.\n");
  const protocol: Protocol = { ...metricProtocol(), seeds: [1, 2], budget: { maxAttempts: 20, maxWallHours: 1, maxGpuHours: 0 } };
  await ops.protocol(dir, protocol, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  const parentIdea = "synthetic-parent", childIdea = "synthetic-child";
  await ops.ideaAdd(dir, { id: parentIdea, title: "Synthetic baseline", hypothesis: "The synthetic baseline establishes the paired score.", commit: BASE }, ctx);
  await ops.ideaAdd(dir, { id: childIdea, parent: parentIdea, title: "Synthetic refinement", hypothesis: "The synthetic refinement improves the paired score.", commit: WIN }, ctx);
  let serial = 0;
  const makeAttempt = (frozen: string, run: string, seed: number, value: number, status: "succeeded" | "failed" = "succeeded", retryOf?: string) => {
    const record: Attempt = metricAttempt(), id = (++serial).toString(16).padStart(16, "0"), current = readProtocol(dir)!;
    const folder = join(dir, "runs", run, "attempts"), outputFolder = join(dir, "runs", run, "output", id);
    Object.assign(record, { id, studyId: study.id, run, commit: frozen, treeId: sha256(`synthetic-tree:${frozen}`).slice(0, 40), snapshotSha256: sha256(`synthetic-snapshot:${frozen}`),
      protocol: current, protocolHash: protocolHash(current), sealBinding: designBinding(dir)!, seed, status, label: run === "final" ? "confirmatory" : "synthetic",
      endedAt: "2030-01-01T00:00:01Z", paths: { snapshot: join(dir, "runs", run, "snapshot", id), output: outputFolder, evaluator: join(dir, "task", "evaluator"), result: join(dir, "runs", run, "result", id) },
      metrics: status === "succeeded" ? [{ name: "score", unit: "points", value, provenance: "ares-observed" }] : [], outputs: [],
    });
    if (retryOf) record.retryOf = retryOf;
    if (status === "failed") { record.reason = "Synthetic evaluator interruption"; record.stages.evaluator!.exitCode = 1; }
    if (run === "final") { record.finalBinding = finalGateBinding(dir)!; record.finalWinner = requireFinalInputs(dir).winner; }
    let output: { path: string; sha256: string; bytes: number } | undefined;
    if (status === "succeeded") {
      const text = JSON.stringify({ synthetic: true, score: value, seed }) + "\n", file = write(`runs/${run}/output/${id}/score.json`, text);
      output = { path: file, sha256: sha256(text), bytes: Buffer.byteLength(text) }; record.outputs = [output];
    }
    commit(dir, [[join(folder, `${id}.json`), JSON.stringify(record, null, 2) + "\n", ATTEMPT_BYTES]], [
      { actor, type: "attempt.started", data: { id, run, commit: frozen, seed, treeId: record.treeId, ...(retryOf ? { retryOf } : {}) } },
      { actor, type: `attempt.${status}`, data: { id, run, stage: record.stage, status, ...(record.reason ? { reason: record.reason } : {}) } },
    ]);
    return { id, record, output };
  };
  const baseline = makeAttempt(BASE, "investigate", 1, 10);
  const interrupted = makeAttempt(WIN, "investigate", 1, 0, "failed");
  const retry = makeAttempt(WIN, "investigate", 1, 14, "succeeded", interrupted.id);
  await ops.ideaDecide(dir, childIdea, { decision: "refine", commit: WIN, reason: "Synthetic retry completed and improves the paired score.", attempts: [interrupted.id, retry.id] }, ctx);
  await ops.investigateClose(dir, ctx);
  const investigation = readClosedInvestigation(dir);
  if (investigation.result.winner?.commit !== WIN) throw new Error("synthetic provenance fixture: expected native investigation winner");
  await ops.gateDecide(dir, "design", "approve", undefined, ctx);
  await ops.gateDecide(dir, "final", "approve", undefined, ctx);
  const finalBaseline = makeAttempt(BASE, "final", 2, 11), finalWinner = makeAttempt(WIN, "final", 2, 15);
  await ops.finalClose(dir, ctx);
  const final = readClosedFinal(dir);
  if (final.result.status !== "qualified") throw new Error("synthetic provenance fixture: expected native qualified final");
  const manuscript = write("paper/manuscript.md", "# Synthetic paired result\n\nInvestigation winner: {{n:investigate.winner}}. Paired improvement: {{n:investigate.winner.delta}}.\n\nFinal outcome: {{n:final.status}}; paired improvement: {{n:final.delta}}.\n\nFailed investigation attempts: {{n:investigate.totals.failed}}. The failed synthetic evaluator attempt remains in the denominator.\n", MANUSCRIPT_BYTES);
  const built = await ops.paperBuild(dir, ctx), reviews = [];
  for (const family of ["synthetic-family-a", "synthetic-family-b"]) reviews.push(await ops.reviewAdd(dir, {
    v: 1, reviewer: { id: family, modelFamily: family }, buildSha256: built.evidenceSha256,
    checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings: [],
  }, ctx));
  const skillName = "synthetic-evidence-check";
  await ops.skillPropose(dir, { name: skillName, summary: "Check paired synthetic results and retain failed attempts.", steps: ["Read the closed investigation.", "Read the fresh final and its paired attempts."],
    evidence: [`ares:${study.id}/attempt:${retry.id}`, `ares:${study.id}/run:investigate`, `ares:${study.id}/run:final`] }, ctx);
  await ops.planSet(dir, { v: 1, nodes: [{ id: "build", kind: "step", command: "paper.build", args: {} }], edges: [] }, ctx);
  let resumed = false, sleeps = 0;
  const completedPlan = await ops.planRun(dir, {}, { ...ctx, runner: async () => { throw new Error("synthetic provenance fixture must not invoke a process runner"); }, sleep: async () => {
    if (++sleeps > 20) throw new Error("synthetic provenance fixture: controller did not complete");
    if (!resumed) { resumed = true; await ops.planControl(dir, { action: "resume", commandId: "synthetic-resume", expectedRevision: 1 }, ctx); }
  } });
  if (completedPlan.state !== "done") throw new Error("synthetic provenance fixture: native controller did not complete");
  const observation = readLedger(dir).find(event => event.type === "node.observed" && event.data.node === "build");
  if (!observation || observation.data.status !== "done") throw new Error("synthetic provenance fixture: missing native plan observation");
  await ops.planSet(dir, { v: 1, nodes: [
    { id: "build", kind: "step", command: "paper.build", args: {} }, { id: "publication", kind: "gate", needs: ["build"], binds: ["build"] },
  ], edges: [] }, ctx);
  // Validate final native sources after every additional journal entry, without repairing them.
  readClosedInvestigation(dir); readClosedFinal(dir); const paper = readCurrentBuild(dir);
  const attempts = listAttempts(dir).attempts, events = readLedger(dir);
  if (attempts.length !== 5 || events.length >= 100) throw new Error("synthetic provenance fixture: source size contract violated");
  return {
    dir, ctx, studyId: openStudy(dir).study.id, commits: { baseline: BASE, winner: WIN },
    ids: { parentIdea, childIdea, baselineAttempt: baseline.id, interruptedAttempt: interrupted.id, retryAttempt: retry.id, finalBaselineAttempt: finalBaseline.id, finalWinnerAttempt: finalWinner.id, reviews: reviews.map(review => review.id), skill: skillName, planStep: "build", planGate: "publication" },
    attempts, outputs: { baseline: baseline.output!, retry: retry.output!, finalBaseline: finalBaseline.output!, finalWinner: finalWinner.output! }, outputSHA: retry.output!.sha256,
    closed: { investigation, final }, paper: { ...paper, sourceSha256: sha256(readTextBounded(manuscript, MANUSCRIPT_BYTES)) },
    plan: { completedRevision: completedPlan.revision, currentRevision: ops.planShow(dir).revision, dispatchId: observation.data.dispatchId as string, observation },
  };
}
export type ProvenanceFixture = Awaited<ReturnType<typeof provenanceFixture>>;

