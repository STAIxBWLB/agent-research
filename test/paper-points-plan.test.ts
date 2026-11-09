import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { init } from "../src/commands.ts";
import { saveCandidates, verifySubject, type Candidate } from "../src/lit/candidates.ts";
import { PAPER_PLAN_BYTES, validatePaperPlan, readPaperPlanSnapshot, readPaperPlanCheckSnapshot, readPaperPlan, setPaperPlan, showPaperPlan, type PaperPlan, type PaperPoint } from "../src/paper/plan.ts";
import { readBytesBounded, readLedger, sha256, withLock, writeAtomic } from "../src/study.ts";
import { tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, KEY = "synthetic2026";
function reference(key = KEY): Candidate {
  const candidate: Candidate = { id: `doi:10.0000/synthetic-${key}`, doi: `10.0000/synthetic-${key}`, title: "Synthetic writing point reference", authors: ["Synthetic Author"], year: 2026, sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status: "included", citekey: key,
    verify: { syntax: "ok", exists: "yes", match: "yes", via: "crossref", checkedAt: "2030-01-01T00:00:00Z" } };
  candidate.verify!.subject = verifySubject(candidate); return candidate;
}
const point = (): PaperPoint => ({ id: "point-one", claim: "Declared claim only; its semantic support is not asserted.", requires: [KEY] });
const raw = () => ({ sections: [{ id: "intro", heading: "Introduction", cites: [KEY], points: [point()] }] });
function setup() { const dir = tempDir(), candidates = [reference()]; init(dir, { question: "Synthetic writing point survey?", mode: "survey" }, { actor }); saveCandidates(dir, candidates); return { dir, candidates, file: join(dir, "paper", "plan.json") }; }
const bytes = (file: string) => readBytesBounded(file, PAPER_PLAN_BYTES);
const ledger = (dir: string) => readBytesBounded(join(dir, "ledger.jsonl"), 64 * 1024 * 1024);

test("writing points auto-select v2, while absent/empty points normalize to byte-identical v1", () => {
  const candidates = [reference()], value = raw(), expected = { v: 2 as const, ...value };
  expect(validatePaperPlan(value, candidates)).toEqual(expected);
  expect(validatePaperPlan({ v: 2, ...value }, candidates)).toEqual(expected);
  expect(() => validatePaperPlan({ v: 1, ...value }, candidates)).toThrow("version-1 plan cannot contain");
  const legacy: PaperPlan = { v: 1, sections: [{ id: "intro", heading: "Introduction", cites: [KEY] }] };
  for (const version of [undefined, 1, 2]) {
    const normalized = validatePaperPlan({ ...(version === undefined ? {} : { v: version }), sections: [{ ...legacy.sections[0]!, points: [] }] }, candidates);
    expect(normalized).toEqual(legacy); expect(Object.hasOwn(normalized.sections[0]!, "points")).toBe(false);
    expect(JSON.stringify(normalized, null, 2) + "\n").toBe(JSON.stringify(legacy, null, 2) + "\n");
  }
  expect(() => validatePaperPlan({ v: 3, ...value }, candidates)).toThrow("unsupported plan version");
});

test("point ids are global, requires are unique section-scope subsets and points retain a closed shape", () => {
  const candidates = [reference(), reference("other2026")], value = raw();
  for (const changed of [
    { ...point(), requires: ["outside"] }, { ...point(), requires: [KEY, KEY] }, { ...point(), requires: [1] }, { ...point(), requires: null },
    { ...point(), id: "Upper" }, { ...point(), id: "a".repeat(65) }, { ...point(), extra: true },
  ]) expect(() => validatePaperPlan({ sections: [{ ...value.sections[0]!, points: [changed] }] }, candidates)).toThrow("paper plan:");
  expect(() => validatePaperPlan({ sections: [value.sections[0]!, { id: "methods", heading: "Methods", cites: [KEY], points: [point()] }] }, candidates)).toThrow("unique across the whole plan");
  expect(() => validatePaperPlan({ sections: [{ ...value.sections[0]!, cites: ["other2026"] }] }, candidates)).toThrow("outside its section");
  const noRequirements = { ...point(), requires: [] };
  expect(validatePaperPlan({ sections: [{ ...value.sections[0]!, points: [noRequirements] }] }, candidates).v).toBe(2);
});

test("claims count Unicode characters rather than UTF-16 units, preserve text and refuse multiline/blank/oversized text", () => {
  const value = raw(), candidates = [reference()];
  for (const claim of ["가".repeat(500), "😀".repeat(500), "  exact\tclaim  "]) expect(validatePaperPlan({ sections: [{ ...value.sections[0]!, points: [{ ...point(), claim }] }] }, candidates).sections[0]!.points![0]!.claim).toBe(claim);
  for (const claim of ["", "   ", "가".repeat(501), "😀".repeat(501), "first\nsecond", "first\rsecond", "bad\0claim"]) expect(() => validatePaperPlan({ sections: [{ ...value.sections[0]!, points: [{ ...point(), claim }] }] }, candidates)).toThrow("500 Unicode characters");
});

test("points are capped at forty per section and the complete formatted plan remains bounded", () => {
  const value = raw(), candidates = [reference()], points = Array.from({ length: 40 }, (_, index) => ({ ...point(), id: `point-${index}` }));
  expect(validatePaperPlan({ sections: [{ ...value.sections[0]!, points }] }, candidates).sections[0]!.points).toHaveLength(40);
  expect(() => validatePaperPlan({ sections: [{ ...value.sections[0]!, points: [...points, { ...point(), id: "extra" }] }] }, candidates)).toThrow("40 points");
  const large = points.map(entry => ({ ...entry, claim: "😀".repeat(500) }));
  expect(() => validatePaperPlan({ sections: [{ ...value.sections[0]!, points: large }] }, candidates)).toThrow("64 KiB");
});

test("evidence only accepts bounded card/attempt addresses and needs a source-owned resolution context", () => {
  const value = raw(), candidates = [reference()], refs = ["card:doi:10.0000/synthetic", `attempt:${"a".repeat(16)}`];
  const withEvidence = (evidence: unknown) => ({ sections: [{ ...value.sections[0]!, points: [{ ...point(), evidence }] }] });
  expect(() => validatePaperPlan(withEvidence(refs), candidates)).toThrow("resolver context");
  const calls: string[] = [];
  const valid = validatePaperPlan(withEvidence(refs), candidates, ref => { calls.push(ref); return { resolved: true }; });
  expect(valid.sections[0]!.points![0]!.evidence).toEqual(refs); expect(calls).toEqual(refs);
  expect(() => validatePaperPlan(withEvidence(refs), candidates, () => ({ resolved: false, reason: "synthetic-private-reason" }))).toThrow("does not resolve");
  try { validatePaperPlan(withEvidence(refs), candidates, () => ({ resolved: false, reason: "synthetic-private-reason" })); } catch (error) { expect(String(error)).not.toContain("synthetic-private-reason"); }
  for (const evidence of [["file:/private/unrelated"], ["card:"], ["attempt:bad"], ["card:bad\nvalue"], ["card:" + "x".repeat(4096)], Array.from({ length: 65 }, () => refs[0]!), "not-array"]) expect(() => validatePaperPlan(withEvidence(evidence), candidates, () => ({ resolved: true }))).toThrow("point evidence");
  const repeated = { sections: [{ ...value.sections[0]!, points: [{ ...point(), evidence: [refs[0]!] }, { ...point(), id: "second", evidence: [refs[0]!] }] }] };
  let count = 0; validatePaperPlan(repeated, candidates, () => { count++; return { resolved: true }; }); expect(count).toBe(1);
});

test("strict set/read/show resolve evidence while check snapshots bypass only resolution", async () => {
  const f = setup(); await withLock(f.dir, () => setPaperPlan(f.dir, raw(), actor));
  const saved = bytes(f.file), beforeLedger = ledger(f.dir);
  const value = { v: 2, sections: [{ ...raw().sections[0]!, points: [{ ...point(), evidence: ["card:missing-paper"] }] }] };
  await expect(withLock(f.dir, () => setPaperPlan(f.dir, value, actor))).rejects.toThrow("point evidence");
  expect(bytes(f.file)).toEqual(saved); expect(ledger(f.dir)).toEqual(beforeLedger);
  writeAtomic(f.file, JSON.stringify(value, null, 2) + "\n", PAPER_PLAN_BYTES);
  expect(() => readPaperPlanSnapshot(f.dir)).toThrow("point evidence"); expect(() => readPaperPlan(f.dir)).toThrow("point evidence"); expect(() => showPaperPlan(f.dir)).toThrow("point evidence");
  const snapshot = readPaperPlanCheckSnapshot(f.dir)!; expect(snapshot.plan.v).toBe(2); expect(snapshot.sha256).toBe(sha256(bytes(f.file)));
  value.sections[0]!.points[0]!.evidence = ["file:/private/unrelated"]; writeAtomic(f.file, JSON.stringify(value), PAPER_PLAN_BYTES);
  expect(() => readPaperPlanCheckSnapshot(f.dir)).toThrow("must use card:");
  value.sections[0]!.points[0]!.evidence = ["card:missing-paper"]; value.sections[0]!.points[0]!.requires = ["outside"]; writeAtomic(f.file, JSON.stringify(value), PAPER_PLAN_BYTES);
  expect(() => readPaperPlanCheckSnapshot(f.dir)).toThrow("outside its section");
  value.sections[0]!.points[0]!.requires = [KEY]; writeAtomic(f.file, JSON.stringify(value), PAPER_PLAN_BYTES); f.candidates[0]!.year = 2025; saveCandidates(f.dir, f.candidates);
  expect(() => readPaperPlanCheckSnapshot(f.dir)).toThrow("verification is stale");
});

test("stored versions remain consistent, known v2 can intentionally clear points and future bytes remain protected", async () => {
  const f = setup(); await withLock(f.dir, () => setPaperPlan(f.dir, raw(), actor));
  expect(readPaperPlanSnapshot(f.dir)!.plan.v).toBe(2);
  const event = readLedger(f.dir).at(-1)!; expect(event.type).toBe("paper.plan.set"); expect(event.data.sha256).toBe(sha256(bytes(f.file)));
  const legacy: PaperPlan = { v: 1, sections: [{ id: "intro", heading: "Introduction", cites: [KEY] }] };
  await withLock(f.dir, () => setPaperPlan(f.dir, { v: 2, sections: [{ ...legacy.sections[0]!, points: [] }] }, actor));
  expect(bytes(f.file).toString("utf8")).toBe(JSON.stringify(legacy, null, 2) + "\n");
  writeAtomic(f.file, JSON.stringify({ v: 2, sections: legacy.sections }), PAPER_PLAN_BYTES);
  expect(() => readPaperPlanSnapshot(f.dir)).toThrow("does not match its points");
  const future = JSON.stringify({ v: 3, sections: raw().sections }); writeAtomic(f.file, future, PAPER_PLAN_BYTES); const before = ledger(f.dir);
  expect(() => readPaperPlanCheckSnapshot(f.dir)).toThrow("supported v:");
  await expect(withLock(f.dir, () => setPaperPlan(f.dir, raw(), actor))).rejects.toThrow("unsupported stored plan version");
  expect(bytes(f.file).toString("utf8")).toBe(future); expect(ledger(f.dir)).toEqual(before);
});
