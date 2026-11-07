import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { copilotBinding } from "../src/copilot.ts";
import { readClosedInvestigation, investigateResultPath } from "../src/exp/investigate.ts";
import { resolvePlaceholders } from "../src/paper/placeholders.ts";
import { requireGate, openStudy, readLedger } from "../src/study.ts";
import { fakeHttp, fakeRunner, tempDir } from "./helpers.ts";
import { metricProtocol } from "./metric-fixtures.ts";
const actor = { kind: "agent" as const, id: "synthetic-copilot" }, base = "a".repeat(40), candidate = "b".repeat(40);
async function fixture(mode = "gates") {
  const home = tempDir(), dir = join(home, "study"), fake = fakeRunner([]), http = fakeHttp([]), ctx = { actor, http: http.http, runner: fake.runner }, protocol = metricProtocol(); protocol.seeds = [1, 2];
  ops.init(dir, { question: "Synthetic hypothesis acceptance", mode: "experiment", autonomy: mode }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "Synthetic task"); writeFileSync(join(dir, "task", "evaluator", "run"), "Synthetic evaluator");
  await ops.protocol(dir, protocol, ctx); await ops.executorSet(dir, { v: 1, kind: "local", workdir: "/synthetic-executor" }, ctx);
  await ops.selection(dir, { v: 1, run: "investigate", metric: "score", baseline: { commit: base }, minSeeds: 1, minDelta: 1 }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx);
  return { dir, home, fake, http, ctx, protocol };
}
const bytes = (dir: string) => ["study.json", "ledger.jsonl", "design/protocol.json", "design/selection.json"].map(file => readFileSync(join(dir, file), "utf8"));
const accept = (dir: string, artifact: "hypotheses" | "paper" | "reviews", ctx: Parameters<typeof ops.gateDecide>[4]) => ops.gateDecide(dir, `accept:${artifact}`, "approve", undefined, ctx);

test("hypotheses consumers refuse pending/stale drafts without writes or backend effects", async () => {
  const f = await fixture(); await ops.autonomySet(f.dir, "copilot", "hypotheses", f.ctx);
  writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic first hypothesis\n");
  await ops.ideaAdd(f.dir, { id: "draft", title: "Synthetic idea", hypothesis: "Synthetic effect" }, f.ctx);
  await ops.ideaDecide(f.dir, "draft", { decision: "refine", commit: candidate, reason: "Attach synthetic candidate" }, f.ctx);
  mkdirSync(join(f.dir, "paper")); writeFileSync(join(f.dir, "paper", "manuscript.md"), "Synthetic manuscript.\n");
  const consumers: (() => unknown | Promise<unknown>)[] = [
    () => ops.protocol(f.dir, { ...f.protocol, method: "must not commit" }, f.ctx),
    () => ops.attemptRun(f.dir, { repo: "/synthetic-repo", commit: candidate, detach: true }, f.ctx),
    () => ops.attemptRun(f.dir, { repo: "/synthetic-repo", commit: candidate, run: "posthoc", detach: true }, f.ctx),
    () => ops.investigateClose(f.dir, f.ctx), () => readClosedInvestigation(f.dir),
    () => ops.ablateAdd(f.dir, { id: "synthetic", commit: "c".repeat(40), removes: "Synthetic component" }, f.ctx),
    () => ops.finalClose(f.dir, f.ctx),
    () => ops.paperBuild(f.dir, f.ctx), () => ops.archive(f.dir, {}, f.ctx),
    () => ops.archive(f.dir, { confirm: "f".repeat(64) }, f.ctx),
  ];
  for (const consumer of consumers) {
    const before = bytes(f.dir);
    await expect(Promise.resolve().then(consumer)).rejects.toThrow("ares gate approve <dir> accept:hypotheses");
    expect(bytes(f.dir)).toEqual(before); expect(f.fake.requests).toEqual([]); expect(f.http.requested).toEqual([]);
  }
  expect(existsSync(investigateResultPath(f.dir, "investigate"))).toBe(false);
  await accept(f.dir, "hypotheses", f.ctx); await ops.investigateClose(f.dir, f.ctx);
  expect(readClosedInvestigation(f.dir).result.reason).toBe("no-baseline");
  expect(resolvePlaceholders(f.dir, "{{n:investigate.reason}}").rendered).toBe("no-baseline");
  const before = bytes(f.dir); writeFileSync(join(f.dir, "hypotheses.md"), "Changed synthetic hypothesis\n");
  await expect(ops.investigateClose(f.dir, f.ctx)).rejects.toThrow("accept:hypotheses");
  expect(() => readClosedInvestigation(f.dir)).toThrow("accept:hypotheses");
  expect(resolvePlaceholders(f.dir, "{{n:investigate.reason}}").findings[0]!.message).toContain("ares gate approve <dir> accept:hypotheses");
  expect(bytes(f.dir)).toEqual(before); expect(ops.gateList(f.dir).find(gate => gate.gate === "accept:hypotheses")!.state).toBe("pending");
});

test("ordinary accept gates use CLI/MCP handlers, actor/staleness rules and never autoapprove", async () => {
  const f = await fixture("auto"); await ops.autonomySet(f.dir, "copilot", "hypotheses", f.ctx);
  writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic draft\n");
  const env = { HOME: f.home, AGENTHUB_HOME: join(f.home, "family"), AGENTHUB_PEER_ID: "synthetic-copilot" }, server = createAresMcp(env, f.http.http, { runner: f.fake.runner });
  const gateTool = ARES_TOOLS.find(tool => tool.name === "ares_gate")!;
  expect(validArguments({ study: f.dir, action: "approve", gate: "accept:hypotheses" }, gateTool.inputSchema)).toBe(true);
  const list = await server.handlers.ares_gate!({ study: f.dir, action: "list" }); expect(list).toEqual(ops.gateList(f.dir));
  const before = bytes(f.dir);
  expect(() => requireGate(f.dir, openStudy(f.dir).study, "accept:hypotheses", ops.binder(f.dir))).toThrow("pending"); expect(bytes(f.dir)).toEqual(before);
  await server.handlers.ares_gate!({ study: f.dir, action: "approve", gate: "accept:hypotheses" });
  expect(readLedger(f.dir).at(-1)).toMatchObject({ type: "gate.approve", actor, data: { gate: "accept:hypotheses", binding: copilotBinding(f.dir, "hypotheses") } });
  await ops.ideaAdd(f.dir, { id: "new", title: "New synthetic idea", hypothesis: "Changed content" }, f.ctx);
  expect(ops.gateList(f.dir).find(gate => gate.gate === "accept:hypotheses")!.state).toBe("pending");
  await server.handlers.ares_gate!({ study: f.dir, action: "reject", gate: "accept:hypotheses", reason: "Synthetic draft rejection" });
  await expect(ops.investigateClose(f.dir, f.ctx)).rejects.toThrow("rejected acceptance");
  const result = await run(["gate", "approve", f.dir, "accept:hypotheses", "--json"], env, { http: f.http.http, runner: f.fake.runner });
  expect(JSON.parse(result.text).state).toBe("approved");
  expect(readLedger(f.dir).at(-1)!.actor).toEqual(actor);
});

test("archive requires each present producing phase only while it is copilot", async () => {
  for (const artifact of ["hypotheses", "paper", "reviews"] as const) {
    const f = await fixture();
    writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic unaccepted hypothesis\n");
    mkdirSync(join(f.dir, "paper")); writeFileSync(join(f.dir, "paper", "manuscript.md"), "Synthetic survey-free text.\n");
    // Valid review records are produced in a survey fixture to avoid unrelated experiment-paper prerequisites.
    if (artifact === "reviews") {
      const survey = join(f.home, "survey"); ops.init(survey, { question: "Synthetic reviews", autonomy: "gates" }, f.ctx);
      mkdirSync(join(survey, "paper")); writeFileSync(join(survey, "paper", "manuscript.md"), "Synthetic review manuscript.\n");
      const built = await ops.paperBuild(survey, f.ctx);
      await ops.reviewAdd(survey, { v: 1, reviewer: { id: "synthetic", modelFamily: "synthetic" }, buildSha256: built.evidenceSha256, checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings: [] }, f.ctx);
      await ops.autonomySet(survey, "copilot", "review", f.ctx);
      await expect(ops.archive(survey, {}, f.ctx)).rejects.toThrow("accept:reviews");
      await accept(survey, "reviews", f.ctx); expect((await ops.archive(survey, {}, f.ctx)).notes).toEqual([]);
      continue;
    }
    const phase = artifact === "hypotheses" ? "hypotheses" : "write";
    await ops.autonomySet(f.dir, "copilot", phase, f.ctx);
    const before = bytes(f.dir); await expect(ops.archive(f.dir, {}, f.ctx)).rejects.toThrow(`accept:${artifact}`); expect(bytes(f.dir)).toEqual(before);
    await accept(f.dir, artifact, f.ctx); expect((await ops.archive(f.dir, {}, f.ctx)).notes.length).toBeGreaterThanOrEqual(1);
    expect(f.fake.requests).toEqual([]);
  }
  for (const mode of ["auto", "gates", "step"] as const) {
    const f = await fixture(mode); writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic unaccepted non-copilot draft\n");
    await ops.protocol(f.dir, f.protocol, f.ctx); await ops.investigateClose(f.dir, f.ctx);
    expect(readClosedInvestigation(f.dir).result.reason).toBe("no-baseline"); expect((await ops.archive(f.dir, {}, f.ctx)).notes.length).toBeGreaterThanOrEqual(1);
    expect(ops.gateList(f.dir).some(gate => gate.gate.startsWith("accept:"))).toBe(false);
  }
});

test("paper rebuilds and derived output bytes do not stale accepted source drafts", async () => {
  const home = tempDir(), dir = join(home, "study"), http = fakeHttp([]), ctx = { actor, http: http.http };
  ops.init(dir, { question: "Synthetic rebuild", autonomy: "copilot" }, ctx); mkdirSync(join(dir, "paper")); writeFileSync(join(dir, "paper", "manuscript.md"), "Synthetic source manuscript.\n");
  await accept(dir, "paper", ctx); const binding = copilotBinding(dir, "paper");
  await ops.paperBuild(dir, ctx); expect(copilotBinding(dir, "paper")).toBe(binding);
  writeFileSync(join(dir, "paper", "build", "manuscript.md"), "Changed derived output\n");
  await ops.paperBuild(dir, ctx); expect(ops.gateList(dir).find(gate => gate.gate === "accept:paper")!.state).toBe("approved");
});

test("plan adapters keep accept guidance and perform no backend preparation for unaccepted hypotheses", async () => {
  const f = await fixture(); await ops.autonomySet(f.dir, "copilot", "hypotheses", f.ctx);
  writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic private content https://example.invalid/?key=secret\n");
  await ops.planSet(f.dir, { v: 1, nodes: [
    { id: "attempt", kind: "step", command: "attempt.run", args: { repo: "/synthetic-repo", commit: candidate } },
    { id: "paper", kind: "step", command: "paper.build", args: {} },
  ], edges: [] }, f.ctx);
  const stop = new AbortController(); let resumed = false, sleeps = 0;
  const result = await ops.planRun(f.dir, {}, { ...f.ctx, signal: stop.signal, sleep: async () => {
    if (++sleeps > 30) { stop.abort(); throw new Error("synthetic copilot plan did not stop"); }
    if (!resumed) { resumed = true; await ops.planControl(f.dir, { action: "resume", commandId: "start", expectedRevision: 1 }, f.ctx); }
    else if (ops.planShow(f.dir).nodes.every(node => node.status === "failed")) stop.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
  } });
  expect(result.nodes.every(node => node.status === "failed")).toBe(true);
  for (const node of result.nodes) expect(node.reason).toContain("ares gate approve <dir> accept:hypotheses");
  expect(f.fake.requests).toEqual([]); expect(f.http.requested).toEqual([]);
  expect(readFileSync(join(f.dir, "ledger.jsonl"), "utf8")).not.toMatch(/private content|https:\/\/example|secret/);
});

test("step admission pauses on a copilot refusal before the next effect or backend call", async () => {
  const f = await fixture("step"); await ops.autonomySet(f.dir, "copilot", "hypotheses", f.ctx);
  writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic step-mode draft\n");
  await ops.planSet(f.dir, { v: 1, nodes: [
    { id: "attempt", kind: "step", command: "attempt.run", args: { repo: "/synthetic-repo", commit: candidate } },
    { id: "paper", kind: "step", command: "paper.build", args: {} },
  ], edges: [] }, f.ctx);
  const stop = new AbortController(); let resumed = false, sleeps = 0;
  const result = await ops.planRun(f.dir, { parallel: 2 }, { ...f.ctx, signal: stop.signal, sleep: async () => {
    if (++sleeps > 30) { stop.abort(); throw new Error("synthetic copilot step did not pause"); }
    if (!resumed) { resumed = true; await ops.planControl(f.dir, { action: "resume", commandId: "start", expectedRevision: 1 }, f.ctx); }
    else if (ops.planShow(f.dir).pauseReason === "step") stop.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
  } });
  expect(result.state).toBe("paused"); expect(result.pauseReason).toBe("step");
  expect(result.nodes[0]).toMatchObject({ status: "failed" });
  expect(result.nodes[0]!.reason).toContain("ares gate approve <dir> accept:hypotheses");
  expect(result.nodes[1]!.status).toBe("ready");
  const events = readLedger(f.dir), index = events.findIndex(event => event.type === "node.observed" && event.data.node === "attempt");
  expect(events[index + 1]).toMatchObject({ type: "plan.paused", data: { reason: "step" } });
  expect(events.filter(event => event.type === "node.intent")).toHaveLength(1);
  expect(f.fake.requests).toEqual([]); expect(f.http.requested).toEqual([]);
});

test("copilot on the consuming archive phase alone does not activate producer acceptance", async () => {
  const f = await fixture(); writeFileSync(join(f.dir, "hypotheses.md"), "Unaccepted non-copilot hypotheses\n");
  mkdirSync(join(f.dir, "paper")); writeFileSync(join(f.dir, "paper", "manuscript.md"), "Unaccepted non-copilot paper\n");
  await ops.autonomySet(f.dir, "copilot", "archive", f.ctx);
  expect((await ops.archive(f.dir, {}, f.ctx)).notes.length).toBeGreaterThanOrEqual(1);
  expect(ops.gateList(f.dir).some(gate => gate.gate.startsWith("accept:"))).toBe(false);
});

test("accepted archive export and receipt replay stay stable across acceptance events", async () => {
  const f = await fixture(); await ops.autonomySet(f.dir, "copilot", "hypotheses", f.ctx);
  writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic accepted archive hypothesis\n");
  await accept(f.dir, "hypotheses", f.ctx); await ops.investigateClose(f.dir, f.ctx);
  const preview = await ops.archive(f.dir, {}, f.ctx), fake = fakeRunner(preview.notes.map((row, index) => ({ exitCode: 0, stdout: JSON.stringify({ id: (index + 1).toString(16).padStart(32, "0"), kind: row.note.kind }), stderr: "" })));
  const ctx = { ...f.ctx, runner: fake.runner }, env = { HOME: f.home, AGENTHUB_HOME: join(f.home, "family"), AGENTHUB_PEER_ID: actor.id };
  const exported = await ops.archive(f.dir, { confirm: preview.fingerprint }, ctx, env);
  expect("written" in exported && exported.written.length).toBe(preview.notes.length);
  expect(fake.requests).toHaveLength(preview.notes.length);
  const before = readFileSync(join(f.dir, "ledger.jsonl"));
  writeFileSync(join(f.dir, "hypotheses.md"), "Later synthetic archive hypothesis\n");
  await expect(ops.archive(f.dir, { confirm: preview.fingerprint }, ctx, env)).rejects.toThrow("accept:hypotheses");
  expect(readFileSync(join(f.dir, "ledger.jsonl"))).toEqual(before); expect(fake.requests).toHaveLength(preview.notes.length);
  await accept(f.dir, "hypotheses", f.ctx);
  const replay = await ops.archive(f.dir, { confirm: preview.fingerprint }, ctx, env);
  expect("written" in replay && replay.written).toEqual([]); expect(fake.requests).toHaveLength(preview.notes.length);
});


test("paper diagnostics remain usable and review approval keeps the gate guidance for blocked trusted refs", async () => {
  const f = await fixture(); await ops.autonomySet(f.dir, "copilot", "hypotheses", f.ctx);
  writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic accepted numeric-source hypothesis\n");
  await accept(f.dir, "hypotheses", f.ctx); await ops.investigateClose(f.dir, f.ctx);
  mkdirSync(join(f.dir, "paper")); writeFileSync(join(f.dir, "paper", "manuscript.md"), "Outcome: {{n:investigate.reason}}. Same outcome: {{n:investigate.reason}}.\n");
  const built = await ops.paperBuild(f.dir, f.ctx);
  for (const modelFamily of ["family-a", "family-b"]) await ops.reviewAdd(f.dir, { v: 1, reviewer: { id: modelFamily, modelFamily }, buildSha256: built.evidenceSha256, checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings: [] }, f.ctx);
  expect(ops.reviewShow(f.dir).ready).toBe(true);
  writeFileSync(join(f.dir, "hypotheses.md"), "Later synthetic hypothesis draft\n");
  const before = bytes(f.dir), check = ops.paperCheck(f.dir);
  expect(check.ok).toBe(false); expect(check.findings.some(finding => finding.code === "unaccepted-draft")).toBe(true);
  expect(ops.reviewShow(f.dir).ready).toBe(false);
  expect(ops.reviewShow(f.dir).unmet.filter(item => item.code === "accept-source")).toHaveLength(1);
  await expect(ops.gateDecide(f.dir, "review", "approve", undefined, f.ctx)).rejects.toThrow("ares gate approve <dir> accept:hypotheses");
  expect(bytes(f.dir)).toEqual(before);
});


test("negative-result diagnostics without placeholders preserve stale hypothesis acceptance guidance", async () => {
  const f = await fixture(); await ops.autonomySet(f.dir, "copilot", "hypotheses", f.ctx);
  writeFileSync(join(f.dir, "hypotheses.md"), "Synthetic accepted negative-result hypothesis\n");
  await accept(f.dir, "hypotheses", f.ctx); await ops.investigateClose(f.dir, f.ctx);
  expect(readClosedInvestigation(f.dir).result.winner).toBeNull();
  mkdirSync(join(f.dir, "paper")); writeFileSync(join(f.dir, "paper", "manuscript.md"), "Nothing to report.\n");
  writeFileSync(join(f.dir, "hypotheses.md"), "Changed synthetic negative-result hypothesis\n");
  const before = bytes(f.dir), check = ops.paperCheck(f.dir), nextStep = "ares gate approve <dir> accept:hypotheses";
  expect(check.placeholders).toEqual([]);
  expect(check.findings.find(finding => finding.code === "unaccepted-draft")?.message).toContain(nextStep);
  expect(check.findings.some(finding => finding.message.includes("run ares investigate close"))).toBe(false);
  expect(ops.reviewShow(f.dir).unmet.find(item => item.code === "accept-source")?.message).toContain(nextStep);
  await expect(ops.gateDecide(f.dir, "review", "approve", undefined, f.ctx)).rejects.toThrow(nextStep);
  expect(bytes(f.dir)).toEqual(before); expect(f.fake.requests).toEqual([]); expect(f.http.requested).toEqual([]);
});
