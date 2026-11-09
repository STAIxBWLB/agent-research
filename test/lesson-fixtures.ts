import {join} from "node:path";
import * as ops from "../src/commands.ts";
import {readTextBounded, readBytesBounded} from "../src/study.ts";
import {parseProbeFixture} from "../src/harness/receipts.ts";
import {FIXTURE_LESSON_STRENGTH, type LessonInput} from "../src/harness/lesson-candidates.ts";
import type {ProcessRunner, ProcessRequest} from "../src/exp/executor.ts";
import {fakeHttp, fakeRunner, tempDir} from "./helpers.ts";
export const lessonIdentity = {model: "synthetic-model", runtime: "3".repeat(64), toolsetSha256: "2".repeat(64)};
export const lessonLedger = (dir: string) => readBytesBounded(join(dir, "ledger.jsonl"), 64 * 1024 * 1024);
export async function lessonFixture(stream = false) {
  const home = tempDir(), dir = join(home, "study"), transport = fakeRunner([]), ctx = {actor: {kind: "person" as const, id: "synthetic-reviewer"}, http: fakeHttp([]).http, runner: transport.runner};
  const env = {HOME: home, AGENTHUB_HOME: join(home, "family")};
  ops.init(dir, {mode: "experiment", autonomy: "auto", question: "Synthetic lesson workflow"}, ctx);
  let context: {streamSha256: string; improverContextHash: string} | undefined;
  if (stream) {
    await ops.harnessStreamSet(dir, {v: 1, id: "stream-one", revision: 1, tasks: ["synthetic-task", "task-later", "task-last"]}, ctx);
    const frozen = await ops.experienceFreeze(dir, {v: 1, round: "round-one", taskId: "synthetic-task", condition: "baseline", ...lessonIdentity, selected: []}, ctx, env);
    context = {streamSha256: frozen.streamSha256, improverContextHash: frozen.improverContextHash};
  }
  const probes = ["baseline", "candidate"].map(name => parseProbeFixture(JSON.parse(readTextBounded(join(import.meta.dir, "fixtures", "harness-rounds", `${name}.json`), 65_536))));
  const [baseline, candidate] = probes;
  const definition = {v: 1, id: "round-one", task: {id: baseline!.taskId, inputSha256: baseline!.taskInputHash}, baseline: {guidanceSha256: baseline!.guidanceHash}, candidates: [{id: "candidate", guidanceSha256: candidate!.guidanceHash}], hypothesis: {deficiency: "Synthetic omission", predictedChange: "Synthetic check"}, experience: [], authoring: "uncontrolled-authoring", ...(context ? {context} : {})};
  await ops.harnessSet(dir, definition, ctx);
  for (const projection of probes) await ops.harnessImport(dir, definition.id, projection, ctx);
  const current = () => ops.harnessShow(dir, definition.id).rounds[0]!;
  const evidence = current().probes.map(probe => ({probe: probe.projection.id, projectionSha256: probe.projectionSha256, outputManifestHash: probe.projection.outputManifestHash!}));
  await ops.harnessContrast(dir, definition.id, {v: 1, id: "contrast-one", fingerprint: current().transitions.fingerprint, arm: "candidate", outcome: "regressed", basis: "actor-claim", observations: "Synthetic missing check", uncertainty: "No real behavior measured", explanations: ["Synthetic input difference"], evidence}, ctx);
  const contrast = current().transitions.contrasts[0]!;
  await ops.harnessCompose(dir, definition.id, {v: 1, id: "composition-one", fingerprint: current().transitions.fingerprint, sections: [{section: "Synthetic check", decision: "revise", contrasts: [{id: contrast.form.id, sha256: contrast.sha256}], reason: "Synthetic limitation"}], successorSha256: null}, ctx);
  const close = {v: 1, id: "closure-one", fingerprint: current().transitions.fingerprint, outcome: "baseline-kept", reason: "No real correctness evidence"};
  const preview = await ops.harnessClose(dir, definition.id, close, undefined, ctx); if (!("fingerprint" in preview)) throw new Error("closure preview required");
  await ops.harnessClose(dir, definition.id, close, preview.fingerprint, ctx);
  const view = current(), proposal: LessonInput = {v: 1, name: "synthetic-lesson", round: definition.id, closureSha256: view.transitions.closure!.sha256, kind: "limitation", summary: "Synthetic check omission", procedure: ["Inspect the explicit input check"], applicability: "Synthetic procedural replay", limitations: ["No real behavior or transfer measured"], whenNotToUse: ["Live evaluation"], failure: "Synthetic omitted check", retryWhen: "Use a separately tested check", change: [{kind: "contrast", id: contrast.form.id, sha256: contrast.sha256}, {kind: "composition", id: view.transitions.composition!.form.id, sha256: view.transitions.composition!.sha256}], behavior: evidence, counterevidence: []};
  return {dir, home, ctx, transport, env, definition, proposal, current};
}
export async function acceptedLesson(f: Awaited<ReturnType<typeof lessonFixture>>, raw: LessonInput = f.proposal) {
  const proposed = await ops.lessonPropose(f.dir, raw, f.ctx, f.env);
  return ops.lessonDecide(f.dir, proposed.proposal.name, {decision: "accept", proposalSha256: proposed.sha256, evidenceFingerprint: proposed.evidenceFingerprint, acknowledgeStrength: FIXTURE_LESSON_STRENGTH, reason: "Reviewed synthetic limitation only"}, f.ctx, f.env);
}
export function screenedLessonRunner(show: (id: string) => unknown, version = "0.22.1") {
  const requests: ProcessRequest[] = [], ids: string[] = [];
  const runner: ProcessRunner = async request => {
    requests.push(request);
    if (request.args[0] === "search") return {exitCode: 0, stdout: "[]", stderr: ""};
    let buffer = "";
    for await (const chunk of request.stdin as AsyncIterable<Uint8Array>) {
      buffer += Buffer.from(chunk).toString();
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); if (!frame.id) continue;
        let result: unknown;
        if (frame.method === "initialize") result = {serverInfo: {name: "amem", version}};
        else if (frame.method === "tools/list") result = {tools: [{name: "amem_show", inputSchema: {type: "object", properties: {id: {type: "string"}}, required: ["id"], additionalProperties: false}}]};
        else {ids.push(frame.params.arguments.id); result = {content: [{type: "text", text: JSON.stringify(show(frame.params.arguments.id))}]};}
        await request.stdoutSink!(Buffer.from(JSON.stringify({jsonrpc: "2.0", id: frame.id, result}) + "\n"));
      }
    }
    return {exitCode: 0, stdout: "", stderr: ""};
  };
  return {runner, requests, ids};
}
