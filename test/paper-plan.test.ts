import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { init } from "../src/commands.ts";
import { saveCandidates, verifySubject, type Candidate } from "../src/lit/candidates.ts";
import { PAPER_PLAN_BYTES, paperPlanCoverage, readPaperPlan, readPaperPlanSnapshot, setPaperPlan, showPaperPlan, validatePaperPlan, type PaperPlan } from "../src/paper/plan.ts";
import { readBytesBounded, readLedger, sha256, withLock, writeAtomic } from "../src/study.ts";
import { tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, LEDGER_BYTES = 64 * 1024 * 1024;
function reference(key = "known2026", status: Candidate["status"] = "included", suffix = key): Candidate {
  const candidate: Candidate = { id: `doi:10.0000/synthetic-${suffix}`, title: "Synthetic section scope reference", authors: ["Synthetic Author"], year: 2026, doi: `10.0000/synthetic-${suffix}`, sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status, citekey: key,
    verify: { syntax: "ok", exists: "yes", match: "yes", checkedAt: "2030-01-01T00:00:00Z", via: "crossref" } };
  candidate.verify!.subject = verifySubject(candidate); return candidate;
}
const plan = (): PaperPlan => ({ v: 1 as const, sections: [{ id: "intro", heading: "Introduction", cites: ["known2026"] }] });
function setup(candidates = [reference()]) { const dir = tempDir(); init(dir, { question: "Synthetic scoped survey?", mode: "survey" }, { actor }); saveCandidates(dir, candidates); return { dir, candidates, file: join(dir, "paper", "plan.json") }; }
const planBytes = (file: string) => readBytesBounded(file, PAPER_PLAN_BYTES);
const ledgerBytes = (dir: string) => readBytesBounded(join(dir, "ledger.jsonl"), LEDGER_BYTES);

test("paper plan versions stored data, preserves exact headings and allows empty scopes and shared keys across sections", () => {
  expect(validatePaperPlan({ v: 1 as const, sections: [] }, [])).toEqual({ v: 1 as const, sections: [] });
  expect(validatePaperPlan({ sections: [] }, [])).toEqual({ v: 1 as const, sections: [] });
  const raw = { v: 1 as const, sections: [{ id: "intro", heading: "한라  연구\t범위", cites: ["known2026"] }, { id: "methods", heading: "Café", cites: ["known2026"] }, { id: "results", heading: "Café", cites: [] }] };
  const result = validatePaperPlan(raw, [reference()]);
  expect(result).toEqual(raw); expect(result.sections[0]!.heading).toBe("한라  연구\t범위"); expect(result.sections[1]!.heading).not.toBe(result.sections[2]!.heading);
  expect(paperPlanCoverage(result, [reference()])).toEqual({ routed: 1, total: 1 });
  const multiline = { v: 1 as const, sections: [{ id: "setext", heading: "First line\r\nsecond\tline", cites: [] }] };
  expect(validatePaperPlan(multiline, []).sections[0]!.heading).toBe(multiline.sections[0]!.heading);
});

test("closed shape, slug ids, unique headings/ids/keys and exact heading grammar refuse", () => {
  const section = plan().sections[0]!;
  const invalid = [null, {}, [], { v: 1 as const, sections: {} }, { ...plan(), v: 3 }, { ...plan(), extra: true },
    { v: 1 as const, sections: [{ ...section, extra: true }] }, { v: 1 as const, sections: [{ ...section, id: "Upper" }] }, { v: 1 as const, sections: [{ ...section, id: "../outside" }] }, { v: 1 as const, sections: [{ ...section, id: "a".repeat(65) }] },
    ...["", " ", " Introduction", "Introduction ", "bad\0heading"].map(heading => ({ v: 1 as const, sections: [{ ...section, heading }] })),
    { v: 1 as const, sections: [section, { ...section, heading: "Other" }] }, { v: 1 as const, sections: [section, { ...section, id: "other" }] },
    { v: 1 as const, sections: [{ ...section, cites: ["known2026", "known2026"] }] }, { v: 1 as const, sections: [{ ...section, cites: [1] }] }, { v: 1 as const, sections: [{ ...section, cites: null }] },
  ];
  for (const raw of invalid) expect(() => validatePaperPlan(raw, [reference()])).toThrow("paper plan:");
});

test("scopes reject unknown, unverified, excluded, stale and ambiguous references using current verification subjects", () => {
  expect(() => validatePaperPlan(plan(), [])).toThrow("unknown");
  expect(() => validatePaperPlan(plan(), [reference("known2026", "excluded")])).toThrow("excluded");
  expect(() => validatePaperPlan(plan(), [reference("known2026", "new")])).toThrow("unscreened");
  for (const mutation of [
    (candidate: Candidate) => { candidate.verify!.exists = "unknown"; },
    (candidate: Candidate) => { candidate.verify!.match = "partial"; },
    (candidate: Candidate) => { candidate.verify!.syntax = "none"; },
    (candidate: Candidate) => { candidate.year = 2025; },
  ]) { const candidate = reference(); mutation(candidate); expect(() => validatePaperPlan(plan(), [candidate])).toThrow("identifier-verified"); }
  expect(() => validatePaperPlan(plan(), [reference(), reference("known2026", "excluded", "duplicate")])).toThrow("ambiguous");
  const longKey = "long-" + "x".repeat(5000);
  expect(validatePaperPlan({ v: 1 as const, sections: [{ id: "long", heading: "Long scope", cites: [longKey] }] }, [reference(longKey)]).sections[0]!.cites[0]).toBe(longKey);
});

test("section/citation count caps are inclusive and the whole plan is byte-bounded", () => {
  const candidates = Array.from({ length: 300 }, (_, i) => reference(`synthetic${i}`));
  const letters = "abcdefghijklmnopqrstuvwxyz", sections = Array.from({ length: 64 }, (_, i) => ({ id: `section-${letters[Math.floor(i / 26)]!}${letters[i % 26]!}`, heading: `Synthetic section ${i}`, cites: [candidates[0]!.citekey!] }));
  expect(validatePaperPlan({ sections }, candidates).sections).toHaveLength(64);
  expect(validatePaperPlan({ v: 1 as const, sections: [{ ...sections[0]!, id: "section-1", cites: candidates.map(candidate => candidate.citekey!) }] }, candidates).sections[0]!.cites).toHaveLength(300);
  expect(() => validatePaperPlan({ v: 1 as const, sections: sections.map(section => ({ ...section, cites: candidates.map(candidate => candidate.citekey!) })) }, candidates)).toThrow("64 KiB");
  expect(() => validatePaperPlan({ v: 1 as const, sections: [...sections, { id: "extra", heading: "Extra", cites: [] }] }, candidates)).toThrow("64");
  expect(() => validatePaperPlan({ v: 1 as const, sections: [{ ...sections[0]!, cites: [...candidates.map(candidate => candidate.citekey!), "extra"] }] }, candidates)).toThrow("300");
  expect(() => validatePaperPlan({ v: 1 as const, sections: [{ id: "large", heading: "가".repeat(Math.ceil(PAPER_PLAN_BYTES / 3)), cites: [] }] }, [])).toThrow("64 KiB");
});

test("snapshot absence reads no reference source; stored plans hash exact bounded bytes and revalidate references", async () => {
  const f = setup(), candidatesFile = join(f.dir, "literature", "candidates.json");
  writeAtomic(candidatesFile, "not JSON", 64 * 1024 * 1024);
  expect(readPaperPlanSnapshot(f.dir)).toBeUndefined();
  mkdirSync(join(f.dir, "paper")); expect(readPaperPlan(f.dir)).toBeUndefined();
  saveCandidates(f.dir, f.candidates);
  await withLock(f.dir, () => setPaperPlan(f.dir, plan(), actor));
  const raw = planBytes(f.file), first = readPaperPlanSnapshot(f.dir)!;
  expect(first.plan).toEqual(plan()); expect(first.sha256).toBe(sha256(raw));
  writeAtomic(f.file, raw.toString("utf8") + "\n", PAPER_PLAN_BYTES);
  expect(readPaperPlanSnapshot(f.dir)!.plan).toEqual(first.plan); expect(readPaperPlanSnapshot(f.dir)!.sha256).not.toBe(first.sha256);
  f.candidates[0]!.year = 2025; saveCandidates(f.dir, f.candidates);
  expect(() => readPaperPlanSnapshot(f.dir)).toThrow("verification is stale");
  expect(readPaperPlanSnapshot(f.dir, [reference()])!.plan).toEqual(plan());
});

test("set commits a bounded plan and metadata-only actor event; rejected inputs and failed receipt capacity change nothing", async () => {
  const f = setup(); await withLock(f.dir, () => setPaperPlan(f.dir, plan(), actor));
  const stored = planBytes(f.file), ledger = ledgerBytes(f.dir), event = readLedger(f.dir).at(-1)!;
  expect(event.type).toBe("paper.plan.set"); expect(event.actor).toEqual(actor);
  expect(event.data).toEqual({ sha256: sha256(stored), sectionCount: 1, citationCount: 1 }); expect(JSON.stringify(event.data)).not.toContain("Introduction");
  await expect(withLock(f.dir, () => setPaperPlan(f.dir, { v: 1 as const, sections: [{ ...plan().sections[0]!, cites: ["unknown"] }] }, actor))).rejects.toThrow("unknown");
  expect(planBytes(f.file)).toEqual(stored); expect(ledgerBytes(f.dir)).toEqual(ledger);
  await expect(withLock(f.dir, () => setPaperPlan(f.dir, { v: 1 as const, sections: [] }, { kind: "agent", id: "x".repeat(65_536) }))).rejects.toThrow("ledger event");
  expect(planBytes(f.file)).toEqual(stored); expect(ledgerBytes(f.dir)).toEqual(ledger);
});

test("readers reject non-UTF8, over-bound plans and linked paper/plan paths without following them", async () => {
  const f = setup(); await withLock(f.dir, () => setPaperPlan(f.dir, plan(), actor));
  writeFileSync(f.file, Buffer.from([255])); expect(() => readPaperPlanSnapshot(f.dir)).toThrow("UTF-8 JSON");
  writeAtomic(f.file, "x".repeat(PAPER_PLAN_BYTES), PAPER_PLAN_BYTES); writeFileSync(f.file, "x".repeat(PAPER_PLAN_BYTES + 1));
  expect(() => readPaperPlanSnapshot(f.dir)).toThrow("larger than 64 KiB");
  const outside = join(tempDir(), "external.json"), original = JSON.stringify(plan()); writeAtomic(outside, original, PAPER_PLAN_BYTES);
  unlinkSync(f.file); symlinkSync(outside, f.file);
  expect(() => readPaperPlanSnapshot(f.dir)).toThrow("regular physical file");
  await expect(withLock(f.dir, () => setPaperPlan(f.dir, plan(), actor))).rejects.toThrow("regular physical file");
  expect(readBytesBounded(outside, PAPER_PLAN_BYTES).toString("utf8")).toBe(original);
  const other = setup(), externalDir = tempDir(); symlinkSync(externalDir, join(other.dir, "paper"), "dir");
  expect(readPaperPlanSnapshot(other.dir)).toBeUndefined();
  await expect(withLock(other.dir, () => setPaperPlan(other.dir, plan(), actor))).rejects.toThrow("physical directory");
  writeAtomic(join(externalDir, "plan.json"), original, PAPER_PLAN_BYTES);
  expect(() => readPaperPlanSnapshot(other.dir)).toThrow("physical directory");
  await expect(withLock(other.dir, () => setPaperPlan(other.dir, plan(), actor))).rejects.toThrow("physical directory");
});

test("coverage counts included references once even when routed repeatedly, while absent plan shows zero routing", async () => {
  const included = reference("second"), unverified = reference("unverified"); unverified.verify!.match = "no";
  const f = setup([reference(), included, unverified, reference("excluded", "excluded")]);
  expect(showPaperPlan(f.dir)).toEqual({ plan: null, coverage: { routed: 0, total: 3 } });
  const value = { v: 1 as const, sections: [{ id: "intro", heading: "Introduction", cites: ["known2026"] }, { id: "methods", heading: "Methods", cites: ["known2026"] }] };
  await withLock(f.dir, () => setPaperPlan(f.dir, value, actor)); expect(showPaperPlan(f.dir)).toEqual({ plan: value, coverage: { routed: 1, total: 3 } });
});

test("the formatted byte boundary is shared by validator reader and atomic writer", async () => {
  const f = setup(), skeleton = { v: 1 as const, sections: [{ id: "large", heading: "x", cites: ["known2026"] }] };
  const overhead = Buffer.byteLength(JSON.stringify(skeleton, null, 2) + "\n") - 1;
  const value = { v: 1 as const, sections: [{ id: "large", heading: "x".repeat(PAPER_PLAN_BYTES - overhead), cites: ["known2026"] }] };
  const formatted = JSON.stringify(value, null, 2) + "\n"; expect(Buffer.byteLength(formatted)).toBe(PAPER_PLAN_BYTES);
  expect(validatePaperPlan(value, f.candidates)).toEqual(value);
  await withLock(f.dir, () => setPaperPlan(f.dir, value, actor));
  expect(planBytes(f.file).toString("utf8")).toBe(formatted);
  const compact = JSON.stringify(value); writeAtomic(f.file, compact, PAPER_PLAN_BYTES);
  expect(readPaperPlanSnapshot(f.dir)!.sha256).toBe(sha256(compact));
  const tooLarge = { ...value, sections: [{...value.sections[0]!, heading: value.sections[0]!.heading + "x"}] };
  const compactTooLarge = JSON.stringify(tooLarge); expect(Buffer.byteLength(compactTooLarge)).toBeLessThan(PAPER_PLAN_BYTES);
  const before = planBytes(f.file), ledger = ledgerBytes(f.dir);
  expect(() => validatePaperPlan(tooLarge, f.candidates)).toThrow("reduce sections");
  await expect(withLock(f.dir, () => setPaperPlan(f.dir, tooLarge, actor))).rejects.toThrow("formatted plan exceeds");
  expect(planBytes(f.file)).toEqual(before); expect(ledgerBytes(f.dir)).toEqual(ledger);
  writeAtomic(f.file, compactTooLarge, PAPER_PLAN_BYTES);
  expect(() => readPaperPlanSnapshot(f.dir)).toThrow("reduce sections");
});

test("stored version is mandatory and unsupported versions cannot be overwritten", async () => {
  const f = setup(); await withLock(f.dir, () => setPaperPlan(f.dir, {sections: plan().sections}, actor));
  expect(readPaperPlanSnapshot(f.dir)!.plan.v).toBe(1);
  writeAtomic(f.file, JSON.stringify({...plan(), v: 3}), PAPER_PLAN_BYTES);
  const before = planBytes(f.file), ledger = ledgerBytes(f.dir);
  expect(() => readPaperPlanSnapshot(f.dir)).toThrow("supported v: 1");
  await expect(withLock(f.dir, () => setPaperPlan(f.dir, plan(), actor))).rejects.toThrow("unsupported stored plan version");
  expect(planBytes(f.file)).toEqual(before); expect(ledgerBytes(f.dir)).toEqual(ledger);
  writeAtomic(f.file, JSON.stringify({sections: plan().sections}), PAPER_PLAN_BYTES);
  expect(() => readPaperPlanSnapshot(f.dir)).toThrow("supported v: 1");
  await withLock(f.dir, () => setPaperPlan(f.dir, {sections: plan().sections}, actor));
  expect(readPaperPlanSnapshot(f.dir)!.plan.v).toBe(1);
});
