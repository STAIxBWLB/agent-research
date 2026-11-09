import {legacySkillFixture} from "./legacy-skill-fixture.ts";
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { PLAYBOOK } from "../src/playbook.ts";
import { appendEvent, readLedger, openStudy } from "../src/study.ts";
import type { ArchivePreview } from "../src/memory/archive.ts";
import type { SkillRecord } from "../src/memory/skills.ts";
import { fakeHttp, fakeRunner, tempDir } from "./helpers.ts";
const actor = { kind: "agent" as const, id: "synthetic" }, noteId = "a".repeat(32), now = Date.parse("2030-01-01T00:00:00Z");
const response = (data: unknown) => ({ exitCode: 0, stdout: JSON.stringify(data), stderr: "private amem diagnostic" });
const proposal = { name: "synthetic", summary: "Synthetic reusable lesson", steps: ["Inspect evidence"], evidence: [noteId] };
function study(mode: "survey" | "experiment" = "survey") { const dir = tempDir(); ops.init(dir, { question: "Synthetic question", mode }, { actor }); return dir; }
const tool = (name: string) => ARES_TOOLS.find(row => row.name === name)!;
function review(dir: string) {
  const hash = "b".repeat(64), report = { v: 1, reviewer: { id: "synthetic", modelFamily: "synthetic" }, buildSha256: hash,
    checklist: { negativeResults: true, denominators: true, limitations: true, reproducibility: true }, findings: [
      { id: "resolved", kind: "contradiction", location: "Synthetic section", text: "Synthetic contradiction", blocking: true },
      { id: "open", kind: "contradiction", location: "Synthetic section", text: "Unresolved private contradiction", blocking: true },
    ] };
  appendEvent(dir, actor, "review.added", { id: "synthetic-review", review: report });
  appendEvent(dir, actor, "review.resolved", { reviewId: "synthetic-review", findingId: "resolved", buildSha256: hash, reason: "Synthetic measured correction" });
}

test("MCP schemas expose all A5 commands, closed proposal inputs and safe annotations", () => {
  for (const name of ["ares_archive", "ares_lessons", "ares_skill_propose", "ares_skill_decide", "ares_skill_list", "ares_skill_check"]) expect(tool(name)).toBeDefined();
  expect(tool("ares_archive").annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  expect(tool("ares_lessons").annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  expect(tool("ares_skill_list").annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
  expect(tool("ares_skill_decide").annotations.openWorldHint).toBe(true);
  expect(tool("ares_skill_check").annotations).toMatchObject({readOnlyHint: true, openWorldHint: true});
  expect(validArguments({ study: "/synthetic", proposal }, tool("ares_skill_propose").inputSchema)).toBe(true);
  for (const invalid of [{ ...proposal, unknown: true }, { ...proposal, steps: [] }, { ...proposal, evidence: [] }, { ...proposal, evidence: Array(65).fill(noteId) }]) {
    expect(validArguments({ study: "/synthetic", proposal: invalid }, tool("ares_skill_propose").inputSchema)).toBe(false);
  }
  expect(validArguments({ study: "/synthetic", halfLife: 1.5, limit: 50, for: "phase" }, tool("ares_lessons").inputSchema)).toBe(true);
  expect(validArguments({ study: "/synthetic", halfLife: 0 }, tool("ares_lessons").inputSchema)).toBe(false);
  expect(validArguments({ study: "/synthetic", extra: true }, tool("ares_archive").inputSchema)).toBe(false);
});

test("survey MCP archive matches CLI preview, exports only resolved contradictions and keeps agent attribution", async () => {
  const dir = study(), memory = join(dir, "never-created-amem"), fake = fakeRunner([response({ id: noteId, kind: "finding", private: "private amem diagnostic" })]); review(dir);
  const env = { AMEM_HOME: memory, ANTHROPIC_API_KEY: "secret" }, server = createAresMcp(env, fakeHttp([]).http, { runner: fake.runner });
  const before = readFileSync(join(dir, "ledger.jsonl"));
  const preview = await server.handlers.ares_archive!({ study: dir }) as ArchivePreview;
  const cli = JSON.parse((await run(["archive", dir, "--json"], env, { runner: fake.runner })).text);
  expect(preview).toEqual(cli); expect(preview.notes).toHaveLength(1); expect(JSON.stringify(preview)).not.toContain("Unresolved private contradiction");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(fake.requests).toEqual([]);
  await server.handlers.ares_archive!({ study: dir, confirm: preview.fingerprint });
  expect(fake.requests[0]!.env).toEqual({ AMEM_HOME: memory, AGENTHUB_PEER_ID: "mcp" });
  expect(readLedger(dir).at(-1)).toMatchObject({ actor: { kind: "agent", id: "mcp" }, type: "archive.exported" });
  expect(readFileSync(join(dir, "ledger.jsonl"), "utf8")).not.toContain("private amem diagnostic"); expect(existsSync(memory)).toBe(false);
});

test("survey MCP lessons matches CLI ranking/brief and never writes the study", async () => {
  const dir = study(), hit = { id: noteId, kind: "fail", title: "Synthetic failure", at: new Date(now).toISOString(), about: [], scoreDetails: { finalScore: 0.5, recencyFactor: 0.5 } };
  const brief = { brief: "Synthetic context", bytes: 17, truncated: false, state: "known" };
  const fake = fakeRunner([response([hit]), response(brief), response([hit]), response(brief)]), env = { CODEX_THREAD_ID: "synthetic-thread" };
  const server = createAresMcp(env, fakeHttp([]).http, { runner: fake.runner, now: () => now }), before = readFileSync(join(dir, "ledger.jsonl")), files = readdirSync(dir);
  const result = await server.handlers.ares_lessons!({ study: dir, for: "phase intent", halfLife: 180, limit: 1 });
  const cli = await run(["lessons", dir, "--for", "phase intent", "--limit", "1", "--json"], env, { runner: fake.runner, now: () => now });
  expect(result).toEqual(JSON.parse(cli.text));
  expect(fake.requests[0]!.args[1]).toBe("phase intent"); expect(fake.requests[0]!.env).toMatchObject({ CODEX_THREAD_ID: "synthetic-thread", AGENTHUB_PEER_ID: "codex" });
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(readdirSync(dir)).toEqual(files); expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
});

test("survey MCP skill queue and CLI share validation, all states and local PR references", async () => {
  const dir = study(), fake = fakeRunner([]), env = { AGENTHUB_PEER_ID: "synthetic" }, server = createAresMcp(env, fakeHttp([]).http, { runner: fake.runner });
  const id = openStudy(dir).study.id, localProposal = {...proposal, evidence: [{v: 1, tool: "ares", projectKey: id, kind: "study", id}]};
  await server.handlers.ares_skill_propose!({ study: dir, proposal: localProposal });
  await expect(server.handlers.ares_skill_decide!({ study: dir, name: proposal.name, decision: "accept", reason: "reviewed" })).rejects.toThrow("--pr");
  await server.handlers.ares_skill_decide!({ study: dir, name: proposal.name, decision: "accept", reason: "reviewed", pr: "https://github.com/example/synthetic/pull/1" });
  const before = readFileSync(join(dir, "ledger.jsonl")), rows = await server.handlers.ares_skill_list!({ study: dir }) as SkillRecord[];
  expect(rows).toEqual(JSON.parse((await run(["skill", "list", dir, "--json"], env)).text)); expect(rows[0]!.state).toBe("accepted"); expect(rows[0]!.decision!.actor).toEqual(actor);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(fake.requests).toEqual([]);
  await expect(server.handlers.ares_idea_decide!({ study: dir, id: "x", decision: "pivot", reason: "why", cause: "cause", retryWhen: "retry" })).rejects.toThrow("experiment");
});

test("experiment MCP pivot preserves cause/retryWhen and refuses them on refine", async () => {
  const dir = study("experiment"), fake = fakeRunner([]), server = createAresMcp({}, fakeHttp([]).http, { runner: fake.runner });
  await server.handlers.ares_idea_add!({ study: dir, idea: { id: "pivot", title: "Synthetic", hypothesis: "Synthetic" } });
  await server.handlers.ares_idea_add!({ study: dir, idea: { id: "refine", title: "Synthetic", hypothesis: "Synthetic" } });
  await server.handlers.ares_idea_decide!({ study: dir, id: "pivot", decision: "pivot", reason: "why", cause: "cause", retryWhen: "retry" });
  expect(readLedger(dir).at(-1)!.data).toMatchObject({ cause: "cause", retryWhen: "retry" });
  const before = readFileSync(join(dir, "ledger.jsonl"));
  await expect(server.handlers.ares_idea_decide!({ study: dir, id: "refine", decision: "refine", reason: "why", commit: "c".repeat(40), cause: "cause" })).rejects.toThrow("pivot-only");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before); expect(fake.requests).toEqual([]);
});

test("manifest advertises A5 formats/events and unsupported versions refuse without rewriting bytes", async () => {
  expect(ops.manifest().formats.skillProposal).toBe(2);
  expect(ops.manifest().ledgerEvents).toEqual(["archive.exported", "skill.proposed", "skill.decided", "lesson.proposed", "lesson.decided", "watch.set", "watch.ran", "autonomy.set", "harness.round.set", "harness.probe.declared", "harness.contrast.recorded", "harness.composition.recorded", "harness.adoption.decided", "harness.round.closed", "experience.stream.set", "experience.frozen", "retention.pruned", "attempt.pipeline.code", "attempt.pipeline.inputs", "attempt.stage.terminated", "attempt.reuse.preflight", "attempt.reuse.fresh-intent", "attempt.reuse.materialized", "attempt.reuse.miss", "attempt.stage.reused"]);
  const snapshot = ops.manifest(); snapshot.ledgerEvents.pop(); expect(ops.manifest().ledgerEvents).toHaveLength(25);
  for (const kind of ["ledger", "proposal-event", "proposal-file"]) {
    const dir = study(); legacySkillFixture(dir, proposal, actor);
    const journal = join(dir, "ledger.jsonl"), proposalFile = join(dir, "proposals", "skills", `${proposal.name}.md`);
    if (kind === "proposal-file") writeFileSync(proposalFile, readFileSync(proposalFile, "utf8").replace("skillProposal: 1", "skillProposal: 3"));
    else {
      const events = readLedger(dir); if (kind === "ledger") events.at(-1)!.v = 2 as 1; else events.at(-1)!.data.skillProposal = 3;
      writeFileSync(journal, events.map(event => JSON.stringify(event)).join("\n") + "\n");
    }
    const bytes = readFileSync(journal), fileBytes = readFileSync(proposalFile), fake = fakeRunner([]), server = createAresMcp({}, fakeHttp([]).http, { runner: fake.runner });
    await expect(Promise.resolve().then(() => server.handlers.ares_skill_list!({ study: dir }))).rejects.toThrow("unsupported");
    await expect(server.handlers.ares_skill_decide!({ study: dir, name: proposal.name, decision: "reject", reason: "why" })).rejects.toThrow("unsupported");
    expect(readFileSync(journal)).toEqual(bytes); expect(readFileSync(proposalFile)).toEqual(fileBytes); expect(fake.requests).toEqual([]);
  }
});

test("every playbook workflow starts with intent lessons and archive is the final study step", () => {
  const sections = PLAYBOOK.split(/\n\n(?=[^\n]+ workflow\n)/).slice(1);
  expect(sections.length).toBeGreaterThanOrEqual(8);
  for (const section of sections) expect(section).toMatch(/^[^\n]+ workflow\n\nares lessons <dir> --for "/);
  expect(PLAYBOOK.trimEnd().endsWith("ares archive <dir> --confirm <fingerprint>")).toBe(true);
  expect(PLAYBOOK).not.toContain("Amem export remains later work");
});
