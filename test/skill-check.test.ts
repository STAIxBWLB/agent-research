import * as studyModule from "../src/study.ts";
import * as amemShow from "../src/memory/amem-show.ts";
import {validateSkillProposalV2, skillMarkdownV2} from "../src/memory/skill-format.ts";
import {legacySkillFixture} from "./legacy-skill-fixture.ts";
import {mkdirSync} from "node:fs";
import {metricProtocol, metricAttempt} from "./metric-fixtures.ts";
import {readProtocol, protocolHash, designBinding} from "../src/exp/protocol.ts";
import {ATTEMPT_BYTES} from "../src/exp/attempts.ts";
import {expect, spyOn, test} from "bun:test";
import {join} from "node:path";
import * as ops from "../src/commands.ts";
import * as provenance from "../src/provenance.ts";
import {createAresMcp, ARES_TOOLS} from "../src/mcp-tools.ts";
import {run} from "../src/cli.ts";
import {validArguments} from "../src/mcp.ts";
import {inspectSkillEvidenceSet} from "../src/memory/skill-check.ts";
import {foldSkills, SKILL_BYTES} from "../src/memory/skills.ts";
import {inspectSkillEvidence} from "../src/memory/evidence.ts";
import {openStudy, withLock, assertStudyReadLock, readLedger, readBytesBounded, readTextBounded, writeAtomic, appendEvent, commit, type StudyReadLock} from "../src/study.ts";
import type {ProcessRunner, ProcessRequest} from "../src/exp/executor.ts";
import {provenanceFixture} from "./provenance-fixtures.ts";
import {fakeHttp, tempDir} from "./helpers.ts";
const A = "a".repeat(32), B = "b".repeat(32), C = "c".repeat(32), time = Date.parse("2030-01-01T00:00:00Z"), pr = "https://example.test/review/1";
const view = (id: string) => ({id, kind: "finding", text: "Synthetic screened body never retained", project: "synthetic-private", at: "2029-12-01T00:00:00Z"});
function transport(show: (id: string) => unknown = view, onShow?: (id: string) => void, version = "0.22.1") {
  const requests: ProcessRequest[] = [], ids: string[] = [];
  const runner: ProcessRunner = async req => {
    requests.push(req); let buffered = "";
    for await (const chunk of req.stdin as AsyncIterable<Uint8Array>) {
      buffered += Buffer.from(chunk).toString("utf8");
      for (let end = buffered.indexOf("\n"); end >= 0; end = buffered.indexOf("\n")) {
        const frame = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1); if (!frame.id) continue;
        let result: unknown;
        if (frame.method === "initialize") result = {serverInfo: {name: "amem", version}};
        else if (frame.method === "tools/list") result = {tools: [{name: "amem_show", inputSchema: {type: "object", properties: {id: {type: "string"}}, required: ["id"], additionalProperties: false}}]};
        else {ids.push(frame.params.arguments.id); onShow?.(frame.params.arguments.id); result = {content: [{type: "text", text: JSON.stringify(show(frame.params.arguments.id))}]};}
        await req.stdoutSink!(Buffer.from(JSON.stringify({jsonrpc: "2.0", id: frame.id, result}) + "\n"));
      }
    }
    return {exitCode: 0, stdout: "", stderr: ""};
  };
  return {runner, requests, ids};
}
function fixture() {
  const home = tempDir(), dir = join(home, "study"), ctx = {actor: {kind: "person" as const}, http: fakeHttp([]).http};
  ops.init(dir, {question: "Synthetic source-backed skill", mode: "experiment"}, ctx);
  const id = openStudy(dir).study.id, local = {v: 1 as const, tool: "ares" as const, projectKey: id, kind: "study" as const, id};
  return {dir, home, ctx, local, env: {HOME: home, AGENTHUB_HOME: join(home, "family")}};
}
const input = (evidence: unknown[], counterevidence: unknown[] = []) => ({name: "checked-procedure", summary: "Synthetic bounded procedure", steps: ["Inspect current evidence"], evidence, applicability: "Synthetic procedures", limitations: ["Not scientific entailment"], counterevidence});
const bytes = (dir: string) => readBytesBounded(join(dir, "ledger.jsonl"), 64 * 1024 * 1024);

test("default v2 receipts are source-owned, check parity is read-only, and acceptance records its actual fingerprint atomically", async () => {
  const f = fixture(), row = await ops.skillPropose(f.dir, input([f.local]), f.ctx, f.env); expect(row.skillProposal).toBe(2);
  if (row.skillProposal !== 2) throw new Error(); expect(row.inspections[0]).toMatchObject({state: "available", outcome: {success: false}, support: "reviewer-judgment"});
  const before = bytes(f.dir), server = createAresMcp(f.env, f.ctx.http), args = {study: f.dir, name: row.name};
  expect(validArguments(args, ARES_TOOLS.find(tool => tool.name === "ares_skill_check")!.inputSchema)).toBe(true);
  const result = await server.handlers.ares_skill_check!(args);
  expect(JSON.parse((await run(["skill", "check", f.dir, row.name, "--json"], f.env, f.ctx)).text)).toEqual(result); expect(bytes(f.dir)).toEqual(before);
  const accepted = await ops.skillDecide(f.dir, row.name, "accept", "Reviewed limitations", pr, f.ctx, undefined, f.env);
  expect(accepted.state).toBe("accepted"); expect(accepted.decision?.evidenceFingerprint).toMatch(/^[a-f0-9]{64}$/); expect(accepted.decision?.inspections?.[0]?.state).toBe("available");
  expect(readLedger(f.dir).filter(event => event.type === "skill.decided")).toHaveLength(1); expect(readLedger(f.dir).some(event => event.type === "archive.exported")).toBe(false);
  const saved = bytes(f.dir); await expect(ops.skillDecide(f.dir, row.name, "accept", "Duplicate", pr, f.ctx)).rejects.toThrow("already decided"); expect(bytes(f.dir)).toEqual(saved);
  const original = readLedger(f.dir), last = original.at(-1)!;
  expect(() => foldSkills([...original.slice(0, -1), {...last, data: {...last.data, evidenceFingerprint: "f".repeat(64)}}])).toThrow("fingerprint");
});

test("caller inspections, wrong-study/forged refs and changed sources cannot manufacture validated success", async () => {
  const f = fixture(), before = bytes(f.dir);
  for (const raw of [{...input([f.local]), inspections: []}, input([{...f.local, projectKey: "another-study"}]), input(["not-an-exact-id"]), input(["a".repeat(32) + "\n"]), {...input([f.local]), limitations: null}]) {
    await expect(ops.skillPropose(f.dir, raw, f.ctx)).rejects.toThrow(); expect(bytes(f.dir)).toEqual(before);
  }
  const row = await ops.skillPropose(f.dir, input([{...f.local, sha256: "f".repeat(64)}]), f.ctx); if (row.skillProposal !== 2) throw new Error();
  expect(row.inspections[0]).toMatchObject({state: "changed", outcome: {success: false}}); const saved = bytes(f.dir);
  await expect(ops.skillDecide(f.dir, row.name, "accept", "Cannot manufacture support", pr, f.ctx)).rejects.toThrow("revised proposal"); expect(bytes(f.dir)).toEqual(saved);
});

test("one local snapshot serves multiple refs and an owned permit is checked and revoked", async () => {
  const f = fixture(); await ops.ideaAdd(f.dir, {id: "synthetic-idea", title: "Synthetic", hypothesis: "Synthetic"}, f.ctx);
  const ref = {...f.local, kind: "idea" as const, id: "synthetic-idea"}, spy = spyOn(provenance, "localEvidenceSnapshot"), before = bytes(f.dir); let permit!: StudyReadLock;
  try {await withLock(f.dir, async lock => {permit = lock; assertStudyReadLock(f.dir, lock); const result = await inspectSkillEvidenceSet(f.dir, [f.local, ref], {lock}); expect(result.inspections.every(row => row.state === "available")).toBe(true); expect(result.recheck()).toBe(true); expect(spy).toHaveBeenCalledTimes(1); expect((await inspectSkillEvidence(f.dir, f.local)).state).not.toBe("available");}); expect(spy).toHaveBeenCalledTimes(2);} finally {spy.mockRestore();}
  expect(() => assertStudyReadLock(f.dir, permit)).toThrow("not owned"); expect(() => assertStudyReadLock(f.dir, {scope: "owned-study-read"})).toThrow("not owned"); expect(bytes(f.dir)).toEqual(before);
});

test("pinned local changes between check and accept refuse without a decision or proposal rewrite", async () => {
  const f = fixture(), row = await ops.skillPropose(f.dir, input([f.local]), f.ctx); expect((await ops.skillCheck(f.dir, row.name)).acceptReady).toBe(true);
  const file = join(f.dir, "study.json"), study = JSON.parse(readTextBounded(file, 65_536)); writeAtomic(file, JSON.stringify({...study, question: "Changed synthetic question"}), 65_536);
  const before = bytes(f.dir), md = readBytesBounded(join(f.dir, "proposals", "skills", row.name + ".md"), SKILL_BYTES);
  expect((await ops.skillCheck(f.dir, row.name)).state).toBe("changed");
  await expect(ops.skillDecide(f.dir, row.name, "accept", "Stale", pr, f.ctx)).rejects.toThrow("honest limitations"); expect(bytes(f.dir)).toEqual(before); expect(readBytesBounded(join(f.dir, "proposals", "skills", row.name + ".md"), SKILL_BYTES)).toEqual(md);
});

test("counterevidence disappearance/change blocks acceptance exactly like required evidence and never drops silently", async () => {
  for (const changed of [false, true]) {
    const f = fixture(), initial = transport(), ctx = {...f.ctx, runner: initial.runner, now: () => time};
    const row = await ops.skillPropose(f.dir, input([A], [B]), ctx, f.env), before = bytes(f.dir);
    const fresh = transport(id => id === B ? changed ? {...view(id), text: "Changed synthetic counterevidence"} : null : view(id));
    await expect(ops.skillDecide(f.dir, row.name, "accept", "Source vanished", pr, {...ctx, runner: fresh.runner}, undefined, f.env)).rejects.toThrow("revised proposal with current evidence/counterevidence and honest limitations");
    expect(fresh.ids).toEqual([A, B]); expect(bytes(f.dir)).toEqual(before); expect(ops.skillList(f.dir)[0]?.state).toBe("proposed");
  }
});

test("same screened content can be accepted with fresh observation time; returned receipts contain no private body", async () => {
  const f = fixture(), fake = transport(), ctx = {...f.ctx, runner: fake.runner, now: () => time};
  const row = await ops.skillPropose(f.dir, input([A], [B]), ctx, f.env), fresh = transport();
  const accepted = await ops.skillDecide(f.dir, row.name, "accept", "Reviewed bounded limits", pr, {...ctx, runner: fresh.runner, now: () => time + 1000}, undefined, f.env);
  expect(accepted.decision?.inspections?.map(row => row.observedAt)).toEqual([new Date(time + 1000).toISOString(), new Date(time + 1000).toISOString()]);
  const serialized = JSON.stringify(accepted) + bytes(f.dir).toString(); expect(serialized).not.toContain(view(A).text); expect(serialized).not.toContain(view(A).project); expect(serialized).not.toContain(f.home);
  expect(accepted.decision?.inspections?.every(row => !row.outcome.success && row.support === "reviewer-judgment")).toBe(true);
});

test("aggregate byte and time budgets cover all sources, not 25 seconds/256 KiB per reference", async () => {
  const f = fixture(), big = transport(id => ({...view(id), text: "x".repeat(150_000)}));
  const result = await inspectSkillEvidenceSet(f.dir, [A, B, C].map(id => ({v: 1, tool: "amem", id})), {runner: big.runner, env: f.env, now: () => time});
  expect(result.inspections.map(row => row.state)).toEqual(["available", "unavailable", "unavailable"]); expect(big.requests).toHaveLength(2); expect(big.requests[1]!.maxOutputBytes).toBeLessThan(150_000); expect(result.bytes).toBeLessThanOrEqual(262_144);
  let now = time; const slow = transport(view, () => {now += 26_000;});
  const timed = await inspectSkillEvidenceSet(f.dir, [A, B].map(id => ({v: 1, tool: "amem", id})), {runner: slow.runner, env: f.env, now: () => now});
  expect(slow.requests).toHaveLength(1); expect(timed.inspections.every(row => row.state === "unavailable")).toBe(true); expect(timed.recheck()).toBe(false);
});

test("mixed local/amem inspection fences local generation after external observation under the lock", async () => {
  const f = fixture(), initial = transport(), ctx = {...f.ctx, runner: initial.runner, now: () => time};
  const row = await ops.skillPropose(f.dir, input([f.local, A]), ctx, f.env); let afterExternal!: Buffer;
  const drift = transport(view, () => {appendEvent(f.dir, f.ctx.actor, "synthetic.external-edit", {}); afterExternal = bytes(f.dir);});
  await expect(ops.skillDecide(f.dir, row.name, "accept", "Raced source", pr, {...ctx, runner: drift.runner}, undefined, f.env)).rejects.toThrow("revised proposal");
  expect(bytes(f.dir)).toEqual(afterExternal); expect(readLedger(f.dir).some(event => event.type === "skill.decided")).toBe(false);
});

test("negative native evidence remains available with its non-success meaning on acceptance", async () => {
  const f = await provenanceFixture(), ref = {v: 1, tool: "ares", projectKey: f.studyId, kind: "attempt", id: f.ids.interruptedAttempt};
  const row = await ops.skillPropose(f.dir, {...input([ref]), name: "negative-procedure"}, f.ctx);
  if (row.skillProposal !== 2) throw new Error(); expect(row.inspections[0]?.outcome).toEqual({status: "failed", success: false});
  const accepted = await ops.skillDecide(f.dir, row.name, "accept", "Review of failure limits", pr, f.ctx); expect(accepted.decision?.inspections?.[0]?.outcome).toEqual({status: "failed", success: false});
});


test("no-winner and unfinished native sources retain non-success meanings in v2 proposals and decisions", async () => {
  const f = fixture(); mkdirSync(join(f.dir, "task", "evaluator"), {recursive: true}); writeAtomic(join(f.dir, "task", "task.md"), "Synthetic task", 65_536); writeAtomic(join(f.dir, "task", "evaluator", "run"), "Synthetic evaluator", 65_536);
  await ops.protocol(f.dir, metricProtocol(), f.ctx); await ops.selection(f.dir, {v: 1, run: "investigate", metric: "score", baseline: {commit: "a".repeat(40)}, minSeeds: 1, minDelta: 1}, f.ctx); await ops.investigateClose(f.dir, f.ctx);
  const row = await ops.skillPropose(f.dir, input([{...f.local, kind: "closed-result", id: "investigate"}]), f.ctx);
  const accepted = await ops.skillDecide(f.dir, row.name, "accept", "Reviewed no-winner limitations", pr, f.ctx); expect(accepted.decision?.inspections?.[0]?.outcome).toEqual({status: "no-winner", success: false});
  const g = await provenanceFixture(), protocol = readProtocol(g.dir)!, pending = metricAttempt();
  Object.assign(pending, {id: "d".repeat(16), studyId: g.studyId, run: "pending", protocol, protocolHash: protocolHash(protocol), sealBinding: designBinding(g.dir), metrics: [], outputs: [], label: "Synthetic pending execution"});
  commit(g.dir, [[join(g.dir, "runs", "pending", "attempts", pending.id + ".json"), JSON.stringify(pending), ATTEMPT_BYTES]], [{actor: g.ctx.actor, type: "attempt.started", data: {id: pending.id, run: pending.run, commit: pending.commit, seed: pending.seed, status: "running"}}]);
  const proposed = await ops.skillPropose(g.dir, {...input([{v: 1, tool: "ares", projectKey: g.studyId, kind: "attempt", id: pending.id}]), name: "unfinished-limits"}, g.ctx);
  expect(proposed.skillProposal === 2 && proposed.inspections[0]?.outcome).toEqual({status: "unfinished", success: false});
});

test("MCP exact-id source reads forward only actual environment and never invent agent markers", async () => {
  const f = fixture(), fake = transport(), server = createAresMcp(f.env, f.ctx.http, {runner: fake.runner, now: () => time});
  await server.handlers.ares_skill_propose!({study: f.dir, proposal: input([A])});
  await server.handlers.ares_skill_check!({study: f.dir, name: "checked-procedure"});
  for (const request of fake.requests) {expect(request.env?.HOME).toBe(f.home); expect(request.env?.AGENTHUB_PEER_ID).toBeUndefined(); expect(request.env?.CODEX_THREAD_ID).toBeUndefined(); expect(request.args).toEqual(["mcp"]);}
});

test("explicit check detects proposal drift during an amem-only observation without serving a false ready result", async () => {
  const f = fixture(), initial = transport(), row = await ops.skillPropose(f.dir, input([A]), {...f.ctx, runner: initial.runner, now: () => time}, f.env);
  const file = join(f.dir, "proposals", "skills", row.name + ".md"), original = readTextBounded(file, SKILL_BYTES);
  const drift = transport(view, () => writeAtomic(file, original + "Synthetic manual edit", SKILL_BYTES));
  const result = await ops.skillCheck(f.dir, row.name, {...f.ctx, runner: drift.runner, now: () => time}, f.env);
  expect(result).toMatchObject({state: "changed", acceptReady: false}); if (!("reasons" in result)) throw new Error(); expect(result.reasons).toContain("proposal-changed");
  expect(readLedger(f.dir).some(event => event.type === "skill.decided")).toBe(false);
});


test("accepted, rejected and withdrawn proposals never report acceptReady even when sources remain available", async () => {
  for (const action of ["accept", "reject", "withdraw"] as const) {
    const f = fixture(), row = await ops.skillPropose(f.dir, input([f.local]), f.ctx);
    expect((await ops.skillCheck(f.dir, row.name)).acceptReady).toBe(true);
    await ops.skillDecide(f.dir, row.name, action, "Synthetic final decision", action === "accept" ? pr : undefined, f.ctx);
    const before = bytes(f.dir), checked = await ops.skillCheck(f.dir, row.name);
    expect(checked).toMatchObject({state: "available", acceptReady: false}); expect(checked.nextStep).toContain("Decision is final"); expect(checked.nextStep).toContain("revised proposal for new evidence");
    expect(checked.inspections[0]?.state).toBe("available"); expect(bytes(f.dir)).toEqual(before);
  }
});


function expireAtFinalRecheck() {
  let now = time, expire = false; const states: string[] = [], originalRead = amemShow.readScreenedAmem, originalOpen = studyModule.openStudy;
  const read = spyOn(amemShow, "readScreenedAmem").mockImplementation(async (cwd, id, options) => {const result = await originalRead(cwd, id, options); states.push(result.state); expire = true; return result;});
  const open = spyOn(studyModule, "openStudy").mockImplementation(dir => {const result = originalOpen(dir); if (expire) {now = time + 26_000; expire = false;} return result;});
  return {states, now: () => now, restore() {open.mockRestore(); read.mockRestore();}};
}

test("expiry during final recheck clears an already available amem digest and returns valid unavailable receipts", async () => {
  const f = fixture(), initial = transport(), row = await ops.skillPropose(f.dir, input([A]), {...f.ctx, runner: initial.runner, now: () => time}, f.env), fake = transport(), expired = expireAtFinalRecheck(), before = bytes(f.dir);
  try {
    const checked = await ops.skillCheck(f.dir, row.name, {runner: fake.runner, now: expired.now}, f.env);
    expect(expired.states).toEqual(["available"]); expect(checked).toMatchObject({state: "unavailable", acceptReady: false});
    expect(checked.inspections[0]).toMatchObject({state: "unavailable", digest: null, integrity: "unverified", outcome: {status: "unverified", success: false}});
    expect(() => validateSkillProposalV2({...input([{v: 1, tool: "amem", id: A}]), inspections: checked.inspections})).not.toThrow(); expect(bytes(f.dir)).toEqual(before);
  } finally {expired.restore();}
});

test("proposal expiry after an available amem response reports its real budget cause and proposal-specific retry guidance", async () => {
  const f = fixture(), fake = transport(), expired = expireAtFinalRecheck(), before = bytes(f.dir); let message = "";
  try {await ops.skillPropose(f.dir, input([A]), {...f.ctx, runner: fake.runner, now: expired.now}, f.env);} catch (cause) {message = (cause as Error).message;} finally {expired.restore();}
  expect(expired.states).toEqual(["available"]); expect(message).toStartWith("skill propose:"); expect(message).toContain("aggregate source budget exhausted"); expect(message).toContain("retry ares skill propose"); expect(message).toContain("revise the proposal input"); expect(message).not.toContain("invalid or over-bound"); expect(message).not.toContain("before deciding"); expect(bytes(f.dir)).toEqual(before);
});

test("proposal journal drift uses proposal guidance while preserving the other writer's committed record", async () => {
  const f = fixture(); let afterExternal!: Buffer;
  const fake = transport(view, () => {legacySkillFixture(f.dir, {name: "other-writer", summary: "Synthetic other proposal", steps: ["Inspect"], evidence: [B]}, f.ctx.actor); afterExternal = bytes(f.dir);});
  let message = ""; try {await ops.skillPropose(f.dir, input([A]), {...f.ctx, runner: fake.runner, now: () => time}, f.env);} catch (cause) {message = (cause as Error).message;}
  expect(message).toStartWith("skill propose:"); expect(message).toContain("journal changed"); expect(message).toContain("revise the proposal input"); expect(message).not.toContain("before deciding"); expect(bytes(f.dir)).toEqual(afterExternal); expect(ops.skillList(f.dir).map(row => row.name)).toEqual(["other-writer"]);
});


test("near-limit proposal accepts a longer fresh timestamp and remains readable without rewriting proposal bytes", async () => {
  const f = fixture(), fake = transport(); let now = time; const ctx = {...f.ctx, runner: fake.runner, now: () => now};
  const baseline = await ops.skillPropose(f.dir, input([A]), ctx, f.env); if (baseline.skillProposal !== 2) throw new Error();
  const template = {...baseline, name: "boundary-procedure", summary: "s", steps: Array(12).fill("x".repeat(1000))}, summaryBytes = SKILL_BYTES - (Buffer.byteLength(skillMarkdownV2(template)) - 1);
  expect(summaryBytes).toBeGreaterThan(0); expect(summaryBytes).toBeLessThanOrEqual(4000);
  const proposed = await ops.skillPropose(f.dir, {...input([A]), name: template.name, steps: template.steps, summary: "s".repeat(summaryBytes)}, ctx, f.env); if (proposed.skillProposal !== 2) throw new Error();
  const file = join(f.dir, "proposals", "skills", proposed.name + ".md"), original = readBytesBounded(file, SKILL_BYTES); expect(original).toHaveLength(SKILL_BYTES);
  now = Date.parse("+010000-01-01T00:00:00Z");
  const accepted = await ops.skillDecide(f.dir, proposed.name, "accept", "Reviewed boundary case", pr, ctx, undefined, f.env), inspections = accepted.decision?.inspections; if (!inspections) throw new Error();
  expect(inspections[0]!.observedAt!.length).toBeGreaterThan(proposed.inspections[0]!.observedAt!.length);
  expect(Buffer.byteLength(skillMarkdownV2({...proposed, inspections}))).toBeGreaterThan(SKILL_BYTES);
  expect(accepted.state).toBe("accepted"); expect(ops.skillList(f.dir).find(row => row.name === proposed.name)?.state).toBe("accepted"); expect(provenance.readProvenance(f.dir).status).toBe("ok");
  expect(readBytesBounded(file, SKILL_BYTES)).toEqual(original); expect(readLedger(f.dir).filter(event => event.type === "skill.decided")).toHaveLength(1);
});

test("unsupported local source exception is preserved and gives ares-specific check/accept guidance without changing bytes", async () => {
  const f = fixture(), row = await ops.skillPropose(f.dir, input([f.local]), f.ctx), file = join(f.dir, "executor.json");
  writeAtomic(file, JSON.stringify({v: 99, kind: "local", workdir: "/synthetic-private-work"}), 8192);
  const before = bytes(f.dir), source = readBytesBounded(file, 8192), checked = await ops.skillCheck(f.dir, row.name);
  expect(checked).toMatchObject({state: "unsupported", acceptReady: false}); expect(checked.inspections[0]?.state).toBe("unsupported");
  expect(checked.nextStep).toContain("compatible ares version"); expect(checked.nextStep).toContain("restore the local record, keeping bytes unchanged"); expect(checked.nextStep).not.toContain("amem");
  let message = ""; try {await ops.skillDecide(f.dir, row.name, "accept", "Cannot interpret future source", pr, f.ctx);} catch (cause) {message = (cause as Error).message;}
  expect(message).toContain("unsupported"); expect(message).toContain("compatible ares version"); expect(message).not.toContain("amem"); expect(bytes(f.dir)).toEqual(before); expect(readBytesBounded(file, 8192)).toEqual(source);
});

test("unsupported amem source guidance names the screened owner contract instead of a local-record repair", async () => {
  const f = fixture(), initial = transport(), ctx = {...f.ctx, runner: initial.runner, now: () => time}, row = await ops.skillPropose(f.dir, input([A]), ctx, f.env), unsupported = transport(view, undefined, "0.22.0");
  const checked = await ops.skillCheck(f.dir, row.name, {...ctx, runner: unsupported.runner}, f.env);
  expect(checked.state).toBe("unsupported"); expect(checked.nextStep).toContain("amem >=0.22.1 with screened exact-id amem_show"); expect(checked.nextStep).not.toContain("restore the local record");
  const before = bytes(f.dir); let message = ""; try {await ops.skillDecide(f.dir, row.name, "accept", "Reader unsupported", pr, {...ctx, runner: unsupported.runner}, undefined, f.env);} catch (cause) {message = (cause as Error).message;}
  expect(message).toContain("amem >=0.22.1 with screened exact-id amem_show"); expect(message).not.toContain("compatible ares version"); expect(bytes(f.dir)).toEqual(before);
});
