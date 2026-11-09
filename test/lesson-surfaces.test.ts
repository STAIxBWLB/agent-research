import {expect, test} from "bun:test";
import {join} from "node:path";
import * as ops from "../src/commands.ts";
import {run} from "../src/cli.ts";
import {ARES_TOOLS, createAresMcp} from "../src/mcp-tools.ts";
import {readBytesBounded, readLedger, writeAtomic} from "../src/study.ts";
import {FIXTURE_LESSON_STRENGTH} from "../src/harness/lesson-candidates.ts";
import {fakeHttp, fakeRunner, tempDir} from "./helpers.ts";
async function fixture() {
  const home = tempDir(), dir = join(home, "study"), transport = fakeRunner([]), ctx = {actor: {kind: "person" as const}, http: fakeHttp([]).http, runner: transport.runner}, env = {HOME: home, AGENTHUB_HOME: join(home, "family")};
  ops.init(dir, {question: "Synthetic lesson surfaces", mode: "experiment"}, ctx);
  await ops.harnessSet(dir, {v: 1, id: "round-one", task: {id: "task-one", inputSha256: "a".repeat(64)}, baseline: {guidanceSha256: "b".repeat(64)}, candidates: [], hypothesis: {deficiency: "Synthetic omitted check", predictedChange: "Synthetic declared check"}, experience: [], authoring: "uncontrolled-authoring"}, ctx);
  await ops.gateDecide(dir, "harness:round-one", "approve", undefined, ctx);
  const raw = {v: 1, id: "closed-one", fingerprint: ops.harnessShow(dir).rounds[0]!.transitions.fingerprint, outcome: "inconclusive", reason: "Synthetic incomplete evidence"};
  const preview = await ops.harnessClose(dir, "round-one", raw, undefined, ctx); if (!("fingerprint" in preview)) throw new Error("expected native preview");
  await ops.harnessClose(dir, "round-one", raw, preview.fingerprint, ctx);
  const proposal = {v: 1, name: "lesson-one", round: "round-one", closureSha256: ops.harnessShow(dir).rounds[0]!.transitions.closure!.sha256, kind: "no-lesson", summary: "Synthetic no lesson", procedure: [], applicability: "Synthetic task only", limitations: ["No independent source"], whenNotToUse: ["Any transfer"], failure: "Insufficient observations", retryWhen: "New independent evidence", change: [], behavior: [], counterevidence: []};
  return {home, dir, ctx, env, transport, proposal, server: createAresMcp(env, ctx.http, ctx)};
}
const ledger = (dir: string) => readBytesBounded(join(dir, "ledger.jsonl"), 1_048_576);
test("lesson CLI file/stdin and MCP share native proposal/list/check/disposition handlers without source processes", async () => {
  const f = await fixture(), path = join(f.home, "proposal.json"); writeAtomic(path, JSON.stringify(f.proposal), 65_536);
  const first = JSON.parse((await run(["lesson", "propose", f.dir, "--file", path, "--json"], f.env, f.ctx)).text);
  expect(first).toMatchObject({state: "proposed", proposal: {name: "lesson-one", sourceStrength: "synthetic-fixture"}});
  expect(JSON.parse((await run(["lesson", "list", f.dir, "--json"], f.env, f.ctx)).text)).toEqual(await f.server.handlers.ares_lesson_list!({study: f.dir}));
  const checked = JSON.parse((await run(["lesson", "check", f.dir, "lesson-one", "--json"], f.env, f.ctx)).text);
  expect(checked).toEqual(await f.server.handlers.ares_lesson_check!({study: f.dir, name: "lesson-one"})); expect(checked.acceptReady).toBe(true);
  const decision = {decision: "accept", proposalSha256: first.sha256, evidenceFingerprint: checked.evidenceFingerprint, reason: "Synthetic owner review", acknowledgeStrength: FIXTURE_LESSON_STRENGTH};
  const accepted = JSON.parse((await run(["lesson", "decide", f.dir, "lesson-one", "--file", "-", "--json"], f.env, {...f.ctx, readStdin: async () => JSON.stringify(decision)})).text);
  expect(accepted).toMatchObject({state: "accepted", exportable: false});
  const second = await f.server.handlers.ares_lesson_propose!({study: f.dir, proposal: {...f.proposal, name: "lesson-two"}}) as typeof first;
  const secondCheck = await f.server.handlers.ares_lesson_check!({study: f.dir, name: "lesson-two"}) as typeof checked;
  const rejected = await f.server.handlers.ares_lesson_decide!({study: f.dir, name: "lesson-two", decision: {decision: "reject", proposalSha256: second.sha256, evidenceFingerprint: secondCheck.evidenceFingerprint, reason: "Synthetic explicit limit"}});
  expect(rejected).toMatchObject({state: "rejected"});
  expect(readLedger(f.dir).filter(row => row.type.startsWith("lesson.")).map(row => row.type)).toEqual(["lesson.proposed", "lesson.decided", "lesson.proposed", "lesson.decided"]);
  expect(f.transport.requests).toEqual([]);
});
test("lesson missing forms and invalid source-owned fields refuse without writes or process calls", async () => {
  const f = await fixture(), before = ledger(f.dir);
  for (const argv of [["lesson", "propose", f.dir], ["lesson", "decide", f.dir, "lesson-one"], ["lesson", "check", f.dir], ["lesson", "list", f.dir, "extra"]]) await expect(run(argv, f.env, f.ctx)).rejects.toThrow();
  await expect(run(["lesson", "propose", f.dir, "--file", "-"], f.env, {...f.ctx, readStdin: async () => JSON.stringify({...f.proposal, inspections: []})})).rejects.toThrow("lesson");
  expect(ledger(f.dir)).toEqual(before); expect(f.transport.requests).toEqual([]);
});
test("manifest declares lesson formats/events and confines read-only grant to stored list", () => {
  const manifest = ops.manifest(); expect(manifest.formats.lessonProposal).toBe(1);
  expect(manifest.ledgerEvents).toContain("lesson.proposed"); expect(manifest.ledgerEvents).toContain("lesson.decided");
  for (const name of ["ares_lesson_propose", "ares_lesson_check", "ares_lesson_decide"]) {
    expect(ARES_TOOLS.find(tool => tool.name === name)?.annotations.openWorldHint).toBe(true);
    expect(manifest.mcp.tools.find(tool => tool.name === name)?.readOnly).toBe(false);
  }
  expect(manifest.mcp.tools.find(tool => tool.name === "ares_lesson_list")?.readOnly).toBe(true);
});
