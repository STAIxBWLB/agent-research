import {expect, test} from "bun:test";
import {join} from "node:path";
import * as ops from "../src/commands.ts";
import {commit, readBytesBounded, readLedger, sha256} from "../src/study.ts";
import {skillMarkdownV2, validateSkillProposalV2} from "../src/memory/skill-format.ts";
import {foldSkills, SKILL_BYTES} from "../src/memory/skills.ts";
import {skillEvidenceReference, inspectSkillEvidence} from "../src/memory/evidence.ts";
import {fakeHttp, fakeRunner, tempDir} from "./helpers.ts";

const ctx = {actor: {kind: "person" as const}, http: fakeHttp([]).http};
const hash = "a".repeat(64);
function source(studyId = "synthetic-study") {return {v: 1 as const, tool: "ares" as const, projectKey: studyId, kind: "attempt" as const, id: "a".repeat(16), sha256: hash};}
function proposal(studyId = "synthetic-study") {
  const ref = source(studyId);
  return {name: "versioned-lesson", summary: "Synthetic lesson with explicit limits", steps: ["Inspect the recorded failure"], evidence: [ref], applicability: "Synthetic repeated procedure", limitations: ["Does not establish a scientific claim"], counterevidence: [ref], inspections: [{ref, state: "available", digest: hash, sourceVersion: {reference: 1, native: 1}, integrity: "record", outcome: {status: "failed", success: false}, support: "reviewer-judgment"}]};
}
function event(raw: ReturnType<typeof proposal>, v = 2) {
  const content = skillMarkdownV2(validateSkillProposalV2(raw));
  return {v: 1 as const, at: "2030-01-01T00:00:00.000Z", actor: ctx.actor, type: "skill.proposed", data: {skillProposal: v, proposal: raw, sha256: sha256(content)}};
}
test("v2 read/validate preserves negative evidence and bounded applicability without claiming support", () => {
  const raw = proposal(), parsed = validateSkillProposalV2(raw), record = foldSkills([event(raw)])[0]!;
  expect(parsed.evidence).toEqual(raw.evidence); expect(parsed.counterevidence).toEqual(raw.counterevidence);
  expect(record).toMatchObject({skillProposal: 2, state: "proposed", evidenceStatus: "inspection-required", applicability: raw.applicability});
  expect(record.skillProposal === 2 && record.inspections[0]?.outcome).toEqual({status: "failed", success: false});
  expect(skillMarkdownV2(parsed)).toStartWith("---\nskillProposal: 2\n");
});
test("v2 refuses private body fields, forged success, inconsistent hashes and unmatched inspections", () => {
  const raw = proposal(), receipt = raw.inspections[0]!;
  for (const value of [{...raw, body: "private"}, {...raw, applicability: "x".repeat(2001)}, {...raw, limitations: Array(17).fill("limit")}, {...raw, inspections: []}, {...raw, inspections: [receipt, receipt]}, {...raw, inspections: [{...receipt, text: "private body"}]}, {...raw, inspections: [{...receipt, metadata: {body: "private"}}]}, {...raw, inspections: [{...receipt, outcome: {status: "failed", success: true}}]}, {...raw, inspections: [{...receipt, digest: "b".repeat(64), outcome: {status: "succeeded", success: true}}]}, {...raw, inspections: [{...receipt, state: "unavailable", outcome: {status: "succeeded", success: true}}]}, {...raw, inspections: [{...receipt, ref: {...source(), id: "b".repeat(16)}}]}]) expect(() => validateSkillProposalV2(value)).toThrow("skill v2");
});
test("new writes remain v1 and legacy terminal decisions/bytes are never rewritten", async () => {
  const dir = tempDir(); ops.init(dir, {question: "Synthetic compatibility"}, ctx);
  const legacy = await ops.skillPropose(dir, {name: "legacy-lesson", summary: "Synthetic legacy", steps: ["Read evidence"], evidence: ["a".repeat(32)]}, ctx);
  await ops.skillDecide(dir, legacy.name, "reject", "Synthetic limit", undefined, ctx);
  const files = ["ledger.jsonl", "proposals/skills/legacy-lesson.md"], before = files.map(file => readBytesBounded(join(dir, file), 1024 * 1024));
  expect(ops.skillList(dir)[0]).toMatchObject({skillProposal: 1, state: "rejected", evidenceStatus: "legacy-unresolved"});
  files.forEach((file, i) => expect(readBytesBounded(join(dir, file), 1024 * 1024)).toEqual(before[i]!));
  expect(before[1]!.toString()).toStartWith("---\nskillProposal: 1\n");
  await expect(ops.skillPropose(dir, proposal(), ctx)).rejects.toThrow("unknown proposal field");
});
test("v2 files replay read-only but T1 never writes decisions without the future bound preflight", async () => {
  const dir = tempDir(), {study} = ops.init(dir, {question: "Synthetic v2 replay"}, ctx), raw = proposal(study.id), content = skillMarkdownV2(validateSkillProposalV2(raw));
  commit(dir, [[join(dir, "proposals", "skills", raw.name + ".md"), content, SKILL_BYTES]], [{actor: ctx.actor, type: "skill.proposed", data: event(raw).data}]);
  const before = readBytesBounded(join(dir, "ledger.jsonl"), 1024 * 1024);
  expect(ops.skillList(dir)[0]).toMatchObject({skillProposal: 2, evidenceStatus: "inspection-required"});
  await expect(ops.skillDecide(dir, raw.name, "accept", "Synthetic review", "https://example.test/pr/1", ctx)).rejects.toThrow("T2");
  expect(readBytesBounded(join(dir, "ledger.jsonl"), 1024 * 1024)).toEqual(before);
  const unknown = event(raw, 3); expect(() => foldSkills([unknown])).toThrow("unsupported version");
  expect(readLedger(dir)).toHaveLength(2);
});
test("v2 terminal decisions need matching versions and accepted evidence fingerprints", () => {
  const proposed = event(proposal()), decide = {v: 1 as const, at: proposed.at, actor: ctx.actor, type: "skill.decided", data: {skillProposal: 2, name: "versioned-lesson", decision: "accept", reason: "Synthetic review", pr: "https://example.test/pr/1", evidenceFingerprint: hash}};
  expect(foldSkills([proposed, decide])[0]).toMatchObject({state: "accepted", decision: {evidenceFingerprint: hash}});
  expect(() => foldSkills([proposed, {...decide, data: {...decide.data, evidenceFingerprint: undefined}}])).toThrow("fingerprint");
  expect(() => foldSkills([proposed, {...decide, data: {...decide.data, skillProposal: 1}}])).toThrow("mismatched-version");
});
test("compatibility addresses map only one-to-one typed kinds and never cross study or infer paths", async () => {
  const dir = tempDir(), {study} = ops.init(dir, {question: "Synthetic reference scope"}, ctx), display = `ares:${study.id}/attempt:${"a".repeat(16)}`;
  expect(skillEvidenceReference(display, study.id)).toEqual({...source(study.id), sha256: undefined});
  expect(skillEvidenceReference(`ares:${study.id}/run:investigate`, study.id)).toBeUndefined();
  expect(skillEvidenceReference("a".repeat(32), study.id)).toEqual({v: 1, tool: "amem", id: "a".repeat(32)});
  expect(skillEvidenceReference(`mem:${"a".repeat(32)}`, study.id)).toBeUndefined();
  const fake = fakeRunner([]);
  for (const raw of [source("other-study"), {v: 2, tool: "amem", id: "a".repeat(32)}, {v: 1, tool: "amem", id: "a".repeat(16)}, `ares:${study.id}/file:task/private`]) expect(await inspectSkillEvidence(dir, raw, {runner: fake.runner})).toMatchObject({state: "unsupported", digest: null, outcome: {success: false}});
  expect(fake.requests).toHaveLength(0);
});

test("compatibility strings normalize to typed v2 addresses and amem receipts require screened metadata", () => {
  const raw = proposal(), display = "ares:synthetic-study/attempt:" + "a".repeat(16), receipt = raw.inspections[0]!;
  const normalized = validateSkillProposalV2({...raw, evidence: [display], counterevidence: [], inspections: [{...receipt, ref: display}]}, "synthetic-study");
  expect(normalized.evidence[0]).toMatchObject({v: 1, tool: "ares", kind: "attempt", projectKey: "synthetic-study"});
  expect(typeof normalized.evidence[0]).toBe("object");
  const amem = {v: 1, tool: "amem", id: "b".repeat(32)}, observed = {ref: amem, state: "available", digest: hash, integrity: "screened", outcome: {status: "not-applicable", success: false}, support: "reviewer-judgment", sourceVersion: {reference: 1, amem: "0.22.1"}, observedAt: "2030-01-01T00:00:00.000Z"};
  const input = {...raw, evidence: [amem], counterevidence: [], inspections: [observed]};
  expect(validateSkillProposalV2(input).inspections[0]?.integrity).toBe("screened");
  for (const changed of [{...observed, sourceVersion: {reference: 1, amem: "0.22.0"}}, {...observed, observedAt: undefined}, {...observed, state: "unavailable"}, {...observed, body: "private note body"}, {...observed, integrity: "record", outcome: {status: "succeeded", success: true}}]) expect(() => validateSkillProposalV2({...input, inspections: [changed]})).toThrow("skill v2");
});
