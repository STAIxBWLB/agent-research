import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readProvenance, compareLineage, attemptReuseView } from "../src/provenance.ts";
import { exportBundle } from "../src/study-export.ts";
import { addStudy } from "../src/console/registry.ts";
import { createPlugin } from "../src/ui/plugin.ts";
import { runAttempt, reconcileAttempts, showAttempt, type Attempt, type AttemptContext } from "../src/exp/attempts.ts";
import { writeAtomic } from "../src/study.ts";
import { cleanupPipelineFixtures, setup } from "./pipeline-fixture.ts";

afterEach(cleanupPipelineFixtures);
type Fixture = Awaited<ReturnType<typeof setup>>;
const options = (f: Fixture) => ({repo: f.repo, commit: f.commit, run: "investigate", detach: true});
async function finish(f: Fixture, initial: Attempt, ctx = f.fake.ctx): Promise<Attempt> {
  let value = initial;
  for (let step = 0; step < 32 && value.status === "running"; step++) {
    if ([...f.fake.containers.values()].some(container => container.running)) f.fake.finish();
    await reconcileAttempts(f.dir, ctx); value = showAttempt(f.dir, value.id);
  }
  expect(value.status).toBe("succeeded"); return value;
}

test("partially reused lineage attributes borrowed artifacts from reuse receipts and fresh candidate/evaluator artifacts as produced", async () => {
  const f = await setup({reuse: true});
  const source = await finish(f, await runAttempt(f.dir, {...options(f), reuse: "eligible"}, f.fake.ctx));
  const original = f.fake.ctx.runner!;
  const forceTrainMiss: AttemptContext = {...f.fake.ctx, runner: request => {
    const q = request.command === "python3" && request.stdin instanceof Uint8Array ? JSON.parse(new TextDecoder().decode(request.stdin)) : undefined;
    if (q?.op === "lookup" && q.stage === "train") return Promise.resolve({exitCode: 0, stdout: '{"op":"lookup","hit":false,"reason":"missing"}', stderr: ""});
    return original(request);
  }};
  const current = await finish(f, await runAttempt(f.dir, {...options(f), reuse: "eligible", retry: source.id}, forceTrainMiss), forceTrainMiss);
  expect(current.pipeline!.completed.map(parent => !!parent.reuse)).toEqual([true, false, false]);
  const graph = readProvenance(f.dir);
  expect(graph.status).toBe("ok");
  const artifactEdges = graph.edges.filter(edge => edge.from.kind === "attempt" && edge.from.id === current.id && edge.to.kind === "artifact");
  const borrowed = current.outputs.find(output => output.path.includes("/.retained/objects/"))!;
  const fresh = current.pipeline!.completed[1]!.record.evidence!.outputs[0]!;
  const evaluator = current.outputs.find(output => output.path.startsWith(current.paths.result + "/"))!;
  const borrowedEdge = artifactEdges.find(edge => edge.to.id === borrowed.sha256 && edge.relation === "reused-artifact")!;
  expect(borrowedEdge).toBeDefined(); expect(borrowedEdge.proof.file).toBe("ledger.jsonl");
  expect(borrowedEdge.proof.recordType).toBe("attempt.stage.reused"); expect(borrowedEdge.proof.ledgerIndex).toBeGreaterThanOrEqual(0);
  for (const output of [fresh, evaluator]) {
    const edge = artifactEdges.find(row => row.to.id === output.sha256 && row.relation === "produced")!;
    expect(edge).toBeDefined(); expect(edge.proof.file).toBe(`runs/${current.run}/attempts/${current.id}.json`);
    expect(edge.proof.recordType).toBeUndefined();
  }
  expect(artifactEdges.some(edge => edge.relation === "observed-output")).toBe(false);
  expect(graph.edges.some(edge => edge.from.id === current.id && edge.to.id === source.id && edge.relation === "reused-from" && edge.proof.recordType === "attempt.stage.reused")).toBe(true);
  // A same-hash inventory alias with no explicit stage/path witness gains no producer or reuse attribution.
  current.outputs.push({...borrowed, path: join(f.workdir, current.studyId, current.id, "unattributed", "copy.txt")});
  writeAtomic(join(f.dir, "runs", current.run, "attempts", `${current.id}.json`), JSON.stringify(current, null, 2) + "\n", 1024 * 1024);
  const forged = readProvenance(f.dir), currentEdges = forged.edges.filter(edge => edge.from.kind === "attempt" && edge.from.id === current.id && edge.to.kind === "artifact");
  expect(forged.issues.some(issue => issue.code === "unattributed-attempt-output")).toBe(true);
  expect(currentEdges.filter(edge => edge.relation === "reused-artifact")).toHaveLength(1);
  expect(currentEdges.some(edge => edge.relation === "contains" && edge.to.id === borrowed.sha256)).toBe(true);
}, 30_000);

test("default v2 plus force-fresh retry expose the same conservative independent count in comparison export and console", async () => {
  const f = await setup({reuse: true});
  const baseline = await finish(f, await runAttempt(f.dir, options(f), f.fake.ctx));
  expect(baseline.v).toBe(2); expect(attemptReuseView(baseline)).toBeUndefined();
  const retry = await finish(f, await runAttempt(f.dir, {...options(f), retry: baseline.id, reuse: "eligible", forceFresh: true}, f.fake.ctx));
  expect(retry.v).toBe(3); expect(retry.pipeline!.completed.every(parent => !parent.reuse)).toBe(true);
  const view = attemptReuseView(retry)!; expect(view.independentSamples).toBe(0);
  const comparison = compareLineage(f.dir, {attempts: [retry.id]}); expect(comparison.status).toBe("ok");
  expect(comparison.rows[0]!.attempts[0]!.reuse!.independentSamples).toBe(0);
  const out = join(dirname(f.dir), "reuse-view-bundle"); await exportBundle(f.dir, {bundle: out});
  const exported = readFileSync(join(out, "attempts.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(exported.find(row => row.id === baseline.id).reuse).toBeUndefined();
  expect(exported.find(row => row.id === retry.id).reuse.independentSamples).toBe(0);
  const home = join(dirname(f.dir), "reuse-view-family"); addStudy(home, f.dir);
  const plugin = createPlugin({env: {HOME: home, AGENTHUB_HOME: home}, runner: async () => { throw new Error("console must not reach the executor"); }});
  const provider = await plugin.open({home, log: () => {}});
  const snapshot = await provider.snapshot({panel: "studies", after: 0}) as {studies: {attempts: {reuse?: {independentSamples: number}}}[]};
  expect(snapshot.studies[0]!.attempts.reuse!.independentSamples).toBe(0);
  expect(snapshot.studies[0]!.attempts.reuse!.independentSamples).toBe(view.independentSamples);
}, 30_000);
