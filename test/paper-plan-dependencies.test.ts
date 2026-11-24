import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { validArguments } from "../src/mcp.ts";
import { saveCandidates, verifySubject, type Candidate } from "../src/lit/candidates.ts";
import { paperDependencyCoverage, readPaperPlanSnapshot, setPaperPlan, showPaperPlan, validatePaperPlan, type PaperPlan } from "../src/paper/plan.ts";
import { checkPaper } from "../src/paper/check.ts";
import { withLock } from "../src/study.ts";
import { fakeHttp, tempDir } from "./helpers.ts";

const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
function reference(key = "known2026", suffix = key): Candidate {
  const candidate: Candidate = { id: `doi:10.0000/synthetic-${suffix}`, title: "Synthetic dependency reference", authors: ["Synthetic Author"], year: 2026, doi: `10.0000/synthetic-${suffix}`, sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status: "included", citekey: key,
    verify: { syntax: "ok", exists: "yes", match: "yes", checkedAt: "2030-01-01T00:00:00Z", via: "crossref" } };
  candidate.verify!.subject = verifySubject(candidate); return candidate;
}
const sections = [{ id: "intro", heading: "Introduction", cites: [] as string[] }];
function study(mode = "survey", manuscript = "## Introduction\n\nSynthetic prose.\n", candidates = [reference()]) {
  const dir = tempDir(); ops.init(dir, { question: "Synthetic dependency survey?", mode }, ctx);
  mkdirSync(join(dir, "paper")); writeFileSync(join(dir, "paper", "manuscript.md"), manuscript); saveCandidates(dir, candidates);
  return { dir, file: join(dir, "paper", "plan.json"), candidates };
}
const dataset = (cites: string[] | undefined, waiver?: string) => ({ id: "ds-main", kind: "dataset", name: "synthetic benchmark", ...(cites === undefined ? {} : { cites }), ...(waiver === undefined ? {} : { waiver }) });

test("plan v3 parses dependencies and preserves explicit v3 while versions 1 and 2 stay byte-compatible", () => {
  const v1: PaperPlan = { v: 1, sections };
  expect(validatePaperPlan({ sections }, [])).toEqual(v1);
  expect(validatePaperPlan({ v: 1 as const, sections, dependencies: [] }, [])).toEqual(v1);
  expect(() => validatePaperPlan({ v: 1 as const, sections, dependencies: [dataset(undefined, "synthetic waiver")] }, [])).toThrow("version-1 plan cannot contain experiment dependencies");
  expect(() => validatePaperPlan({ v: 2 as const, sections, dependencies: [dataset(undefined, "synthetic waiver")] }, [])).toThrow("version-2 plan cannot contain experiment dependencies");
  const plan = validatePaperPlan({ sections, dependencies: [{ id: "ds-main", kind: "dataset", name: " synthetic benchmark ", cites: ["known2026"] }] }, [reference()]);
  expect(plan).toEqual({ v: 3, sections, dependencies: [{ id: "ds-main", kind: "dataset", name: "synthetic benchmark", cites: ["known2026"] }] });
  expect(validatePaperPlan({ v: 3 as const, sections }, []).v).toBe(3);
  expect(validatePaperPlan({ v: 3 as const, sections: [{ ...sections[0]!, cites: ["known2026"], points: [{ id: "point-one", claim: "Synthetic claim.", requires: ["known2026"] }] }] }, [reference()]).v).toBe(3);
  expect(paperDependencyCoverage(plan)).toEqual({ cited: 1, waived: 0, total: 1 });
  expect(paperDependencyCoverage(validatePaperPlan({ sections, dependencies: [dataset(undefined, "synthetic waiver")] }, []))).toEqual({ cited: 0, waived: 1, total: 1 });
});

test("dependency entries keep a closed shape, one of cites or waiver, bounded waivers and verified keys", () => {
  const referenceValue = reference();
  for (const bad of [
    { id: "Upper", kind: "dataset", name: "x", waiver: "w" }, { id: "d", kind: "unknown", name: "x", waiver: "w" },
    { id: "d", kind: "dataset", name: " ", waiver: "w" }, { id: "d", kind: "dataset", name: "two\nlines", waiver: "w" },
    { id: "d", kind: "dataset", name: "x" }, { id: "d", kind: "dataset", name: "x", cites: [], waiver: "w" },
    { id: "d", kind: "dataset", name: "x", cites: ["known2026"], waiver: "w" }, { id: "d", kind: "dataset", name: "x", cites: [] },
    { id: "d", kind: "dataset", name: "x", waiver: " " }, { id: "d", kind: "dataset", name: "x", waiver: "w".repeat(501) },
    { id: "d", kind: "dataset", name: "x", waiver: "가".repeat(200) }, { id: "d", kind: "dataset", name: "x", extra: true },
    { id: "d", kind: "dataset", name: "x", cites: ["known2026", "known2026"] },
  ]) expect(() => validatePaperPlan({ sections, dependencies: [bad] }, [referenceValue])).toThrow("paper plan:");
  expect(() => validatePaperPlan({ sections, dependencies: [dataset(undefined, "가".repeat(166)), dataset(undefined, "second")] }, [])).toThrow("dependency ids must be unique");
  expect(validatePaperPlan({ sections, dependencies: [dataset(undefined, "가".repeat(166))] }, []).dependencies).toHaveLength(1);
  expect(() => validatePaperPlan({ sections, dependencies: [dataset(undefined, "가".repeat(167))] }, [])).toThrow("500 UTF-8 bytes");
  for (const cites of [["missing2026"], ["excluded2026"], ["stale2026"]]) {
    const excluded = reference("excluded2026", "excluded"); excluded.status = "excluded";
    const stale = reference("stale2026"); stale.year = 2025;
    expect(() => validatePaperPlan({ sections, dependencies: [dataset(cites)] }, [referenceValue, excluded, stale])).toThrow("paper plan:");
  }
  const entries = Array.from({ length: 200 }, (_, index) => ({ id: `dep-${index}`, kind: "method", name: `method ${index}`, waiver: "synthetic" }));
  expect(validatePaperPlan({ sections, dependencies: entries }, []).dependencies).toHaveLength(200);
  expect(() => validatePaperPlan({ sections, dependencies: [...entries, { id: "dep-extra", kind: "method", name: "extra", waiver: "synthetic" }] }, [])).toThrow("at most 200");
});

test("set, show, CLI and MCP share v3 storage and cited/waived/total dependency coverage", async () => {
  const f = study("survey", "## Introduction\n\nKnown [@a2026].\n", [reference("a2026"), reference("b2026")]);
  const plan = { v: 3 as const, sections: [{ id: "intro", heading: "Introduction", cites: ["a2026"] }], dependencies: [
    { id: "ds-main", kind: "dataset" as const, name: " synthetic benchmark ", cites: ["a2026"] },
    { id: "m-acc", kind: "metric" as const, name: "accuracy", waiver: "standard definition" },
    { id: "base", kind: "baseline" as const, name: "synthetic baseline", cites: ["b2026"] },
  ] };
  const stored = await ops.paperPlanSet(f.dir, plan, ctx);
  expect(stored).toEqual({ ...plan, dependencies: [{ ...plan.dependencies[0]!, name: "synthetic benchmark" }, plan.dependencies[1]!, plan.dependencies[2]!] });
  expect(readPaperPlanSnapshot(f.dir)!.plan).toEqual(stored);
  const shown = showPaperPlan(f.dir);
  expect(shown).toEqual({ plan: stored, coverage: { routed: 1, total: 2 }, dependencyCoverage: { cited: 2, waived: 1, total: 3 } });
  const cli = await run(["paper", "plan", "show", f.dir, "--json"], {}, { http: ctx.http });
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toEqual(shown);
  const server = createAresMcp({}, ctx.http);
  expect(await server.handlers.ares_paper_plan_show!({ study: f.dir })).toEqual(shown);
  const schema = ARES_TOOLS.find(tool => tool.name === "ares_paper_plan_set")!.inputSchema;
  expect(validArguments({ study: f.dir, plan }, schema)).toBe(true);
  expect(validArguments({ study: f.dir, plan: { ...plan, v: 4 } }, schema)).toBe(false);
  expect(await server.handlers.ares_paper_plan_set!({ study: f.dir, plan })).toEqual(stored);
});

test("uncited-dependency clears by citing a declared key or by a waiver, and stale verification stays a finding", async () => {
  const candidates = [reference("a2026"), reference("b2026")];
  const f = study("survey", "## Introduction\n\nNo citation here.\n", candidates);
  const declared = (cites: string[] | undefined, waiver?: string) => ({ v: 3 as const, sections: [], dependencies: [dataset(cites, waiver)] });
  await withLock(f.dir, () => setPaperPlan(f.dir, declared(["b2026"]), actor));
  let report = checkPaper(f.dir);
  expect(report.findings.filter(hit => hit.code === "uncited-dependency")).toMatchObject([{ severity: "blocking", dependencyId: "ds-main" }]);
  expect(report.ok).toBe(false);
  writeFileSync(join(f.dir, "paper", "manuscript.md"), "## Introduction\n\nNow cited [@b2026].\n");
  report = checkPaper(f.dir);
  expect(report.findings.some(hit => hit.code === "uncited-dependency")).toBe(false);
  writeFileSync(join(f.dir, "paper", "manuscript.md"), "## Introduction\n\nNo citation here.\n");
  await withLock(f.dir, () => setPaperPlan(f.dir, declared(undefined, "the dataset is described in Section 3"), actor));
  report = checkPaper(f.dir);
  expect(report.findings.some(hit => hit.code === "uncited-dependency")).toBe(false);

  await withLock(f.dir, () => setPaperPlan(f.dir, declared(["a2026"]), actor));
  writeFileSync(join(f.dir, "paper", "manuscript.md"), "## Introduction\n\nStill cited [@a2026].\n");
  expect(checkPaper(f.dir).findings.some(hit => hit.code === "uncited-dependency")).toBe(false);
  f.candidates[0]!.verify!.exists = "no"; saveCandidates(f.dir, f.candidates);
  expect(showPaperPlan(f.dir).dependencyCoverage).toEqual({ cited: 1, waived: 0, total: 1 });
  report = checkPaper(f.dir);
  expect(report.findings.filter(hit => hit.code === "uncited-dependency")).toMatchObject([{ dependencyId: "ds-main" }]);
  expect(report.findings.some(hit => hit.code === "unverified-citation")).toBe(true);
  await expect(withLock(f.dir, () => setPaperPlan(f.dir, declared(["a2026"]), actor))).rejects.toThrow("identifier-verified");
});

test("a v3 plan without dependencies keeps the v1/v2 check result, and a protocol metric needs a metric dependency", async () => {
  const manuscript = "## Introduction\n\nKnown [@a2026].\n";
  const f = study("survey", manuscript, [reference("a2026"), reference("b2026")]);
  await withLock(f.dir, () => setPaperPlan(f.dir, { v: 1 as const, sections: [{ id: "intro", heading: "Introduction", cites: ["a2026"] }] }, actor));
  const before = checkPaper(f.dir).findings;
  await withLock(f.dir, () => setPaperPlan(f.dir, { v: 3 as const, sections: [{ id: "intro", heading: "Introduction", cites: ["a2026"] }] }, actor));
  expect(checkPaper(f.dir).findings).toEqual(before);

  const dir = tempDir(); ops.init(dir, { question: "Synthetic dependency experiment?", mode: "experiment" }, ctx);
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  mkdirSync(join(dir, "paper")); writeFileSync(join(dir, "paper", "manuscript.md"), manuscript); saveCandidates(dir, [reference("a2026")]);
  const image = `fixture@sha256:${"a".repeat(64)}`;
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image, command: ["candidate"] }, evaluator: { image, command: ["evaluator"] }, metrics: [{ name: "accuracy", unit: "points", direction: "max" }, { name: " latency ", unit: "ms", direction: "min" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 10, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  expect(checkPaper(dir).findings.some(hit => hit.code === "undeclared-metric")).toBe(false);

  const plan = (dependencies: unknown[]) => ({ v: 3 as const, sections: [], dependencies });
  await withLock(dir, () => setPaperPlan(dir, plan([{ id: "d-main", kind: "dataset", name: "synthetic data", waiver: "synthetic" }]), actor));
  expect(checkPaper(dir).findings.filter(hit => hit.code === "undeclared-metric")).toHaveLength(2);
  await withLock(dir, () => setPaperPlan(dir, plan([{ id: "m-acc", kind: "metric", name: "accuracy", waiver: "standard definition" }]), actor));
  let findings = checkPaper(dir).findings.filter(hit => hit.code === "undeclared-metric");
  expect(findings).toHaveLength(1); expect(findings[0]!.message).toContain("latency");
  await withLock(dir, () => setPaperPlan(dir, plan([{ id: "m-acc", kind: "metric", name: "accuracy", waiver: "standard definition" }, { id: "m-lat", kind: "metric", name: "latency", cites: ["a2026"] }]), actor));
  expect(checkPaper(dir).findings.some(hit => hit.code === "undeclared-metric")).toBe(false);
  await withLock(dir, () => setPaperPlan(dir, plan([{ id: "d-acc", kind: "dataset", name: "accuracy", waiver: "synthetic" }, { id: "m-lat", kind: "metric", name: "latency", waiver: "synthetic" }]), actor));
  findings = checkPaper(dir).findings.filter(hit => hit.code === "undeclared-metric");
  expect(findings).toHaveLength(1); expect(findings[0]!.message).toContain("accuracy");
  expect(paperDependencyCoverage(readPaperPlanSnapshot(dir)!.plan)).toEqual({ cited: 0, waived: 2, total: 2 });
});
