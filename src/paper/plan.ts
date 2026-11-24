import { figureCoverage, validateFigures, type PaperFigure } from "./figures.ts";
import { resolvePointEvidence, pointEvidenceAdvice, type PointEvidenceResolution } from "./point-evidence.ts";
import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { commit, openStudy, plain, readBytesBounded, sha256, type Actor } from "../study.ts";
import { isVerified, loadCandidates, type Candidate } from "../lit/candidates.ts";

export const PAPER_DEPENDENCY_KINDS = ["dataset", "metric", "baseline", "model", "method", "software"] as const;
export type PaperDependencyKind = typeof PAPER_DEPENDENCY_KINDS[number];
export interface PaperPoint { id: string; claim: string; requires: string[]; evidence?: string[] }
export interface PaperDependency { id: string; kind: PaperDependencyKind; name: string; cites?: string[]; waiver?: string }
export interface PaperSection { id: string; heading: string; cites: string[]; points?: PaperPoint[] }
export interface PaperPlan { v: 1 | 2 | 3; sections: PaperSection[]; dependencies?: PaperDependency[]; figures?: PaperFigure[] }
export interface PaperPlanSnapshot { plan: PaperPlan; sha256: string }
export interface PaperDependencyCoverage { cited: number; waived: number; total: number }
export interface PaperPlanView { plan: PaperPlan | null; coverage: { routed: number; total: number }; dependencyCoverage: PaperDependencyCoverage; figureCoverage?: ReturnType<typeof figureCoverage> }
export const PAPER_PLAN_BYTES = 65_536, PAPER_PLAN_SECTIONS = 64, PAPER_PLAN_CITES = 300;
export const PAPER_PLAN_POINTS = 40, PAPER_POINT_CLAIM_CHARACTERS = 500, PAPER_POINT_EVIDENCE = 64, PAPER_POINT_EVIDENCE_BYTES = 4096;
export const PAPER_PLAN_DEPENDENCIES = 200, PAPER_DEPENDENCY_WAIVER_BYTES = 500;
export type PaperPointEvidenceResolver = (ref: string) => PointEvidenceResolution;
const next = "inspect ares lit list, run ares lit verify and ares lit bib as needed, then retry ares paper plan set <dir> --file PATH|-";
function invalid(cause: string): never { throw new Error(`paper plan: ${cause}; ${next}`); }
function object(raw: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plain(raw)) invalid(`${label} must be an object`);
  if (Object.keys(raw).some(key => !keys.includes(key))) invalid(`${label} has an unknown field; use only ${keys.join(", ")}`);
  return raw;
}
function candidateKeys(candidates: Candidate[]): Map<string, Candidate[]> {
  const result = new Map<string, Candidate[]>();
  for (const candidate of candidates) if (typeof candidate.citekey === "string" && candidate.citekey.length) {
    const existing = result.get(candidate.citekey);
    if (!existing) result.set(candidate.citekey, [candidate]);
    else if (existing.length < 2) existing.push(candidate); // Two entries already establish ambiguity.
  }
  return result;
}
function pointReference(raw: unknown): string {
  if (typeof raw !== "string" || !raw.length || raw.trim() !== raw || /\p{Cc}/u.test(raw) || /\p{Zl}|\p{Zp}/u.test(raw) || Buffer.byteLength(raw) > PAPER_POINT_EVIDENCE_BYTES) invalid("point evidence must be a bounded card or attempt reference without whitespace controls");
  if (/^attempt:[a-f0-9]{16}$/.test(raw)) return raw;
  if (raw.startsWith("card:") && raw.length > 5 && raw.slice(5).trim() === raw.slice(5) && !/\s/u.test(raw.slice(5))) return raw;
  invalid("point evidence must use card:<paper-id> or attempt:<16 lowercase hex digits>");
}
function points(raw: unknown, scope: ReadonlySet<string>, ids: Set<string>, resolver: PaperPointEvidenceResolver | undefined, resolutions: Map<string, PointEvidenceResolution>): PaperPoint[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > PAPER_PLAN_POINTS) invalid("section points must be an array of at most 40 points");
  return raw.map((value): PaperPoint => {
    const point = object(value, ["id", "claim", "requires", "evidence"], "point");
    if (typeof point.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(point.id) || point.id.length > 64) invalid("point id must be a lowercase alphanumeric hyphenated slug of 1..64 characters");
    if (ids.has(point.id)) invalid("point ids must be unique across the whole plan"); ids.add(point.id);
    if (typeof point.claim !== "string" || !point.claim.trim() || Array.from(point.claim).length > PAPER_POINT_CLAIM_CHARACTERS || /[\r\n]|\p{Zl}|\p{Zp}/u.test(point.claim) || Array.from(point.claim).some(character => character !== "\t" && /\p{Cc}/u.test(character))) invalid("point claim must be nonempty single-line text of at most 500 Unicode characters");
    if (!Array.isArray(point.requires) || point.requires.length > PAPER_PLAN_CITES) invalid("point requires must be a bounded array of section citation keys");
    const seen = new Set<string>();
    const requires = point.requires.map((key): string => {
      if (typeof key !== "string" || !scope.has(key)) invalid("point requires contains a key outside its section citation scope");
      if (seen.has(key)) invalid("point requires keys must be unique"); seen.add(key); return key;
    });
    let evidence: string[] | undefined;
    if (point.evidence !== undefined) {
      if (!Array.isArray(point.evidence) || point.evidence.length > PAPER_POINT_EVIDENCE) invalid("point evidence must be an array of at most 64 references");
      evidence = point.evidence.map(value => {
        const ref = pointReference(value);
        if (!resolver) invalid("point evidence needs a source-owned resolver context; set or read the plan through the study");
        let resolution = resolutions.get(ref);
        if (!resolution) {
          try { resolution = resolver(ref); } catch { invalid("point evidence could not be resolved; restore its extraction card or attempt record"); }
          if (!resolution || typeof resolution.resolved !== "boolean") invalid("point evidence resolver returned an invalid source result");
          resolutions.set(ref, resolution);
        }
        if (!resolution.resolved) invalid(`point evidence does not resolve to an existing extraction card or attempt record; ${pointEvidenceAdvice(resolution)}`);
        return ref;
      });
    }
    return { id: point.id, claim: point.claim, requires, ...(evidence === undefined ? {} : { evidence }) };
  });
}
function citationKeys(raw: unknown, label: string, unique: string, byKey: Map<string, Candidate[]>, verifiedKeys: Set<string>, verify: boolean): { keys: string[]; seen: Set<string> } {
  if (!Array.isArray(raw) || raw.length > PAPER_PLAN_CITES) invalid(`${label} must be an array of at most 300 citation keys`);
  const seen = new Set<string>();
  const keys = raw.map((key): string => {
    if (typeof key !== "string" || !key.length) invalid("each citation key must be a nonempty exact bibliography key");
    if (seen.has(key)) invalid(unique); seen.add(key);
    if (!verify) return key;
    const matches = byKey.get(key);
    if (!matches?.length) invalid("scope contains an unknown or unassigned citation key");
    if (matches.length !== 1) invalid("scope contains an ambiguous citation key; restore unique bibliography keys");
    if (!verifiedKeys.has(key)) {
      const candidate = matches[0]!;
      if (candidate.status !== "included") invalid("scope reference is excluded or unscreened; include it through ares lit screen before routing it");
      if (!isVerified(candidate)) invalid("scope reference is not identifier-verified or its verification is stale");
      verifiedKeys.add(key);
    }
    return key;
  });
  return { keys, seen };
}
/** Dependency citations are verified when the plan is set; reads defer so later staleness is a check finding, not a read error. */
function dependencies(raw: unknown, byKey: Map<string, Candidate[]>, verifiedKeys: Set<string>, verify: boolean): PaperDependency[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > PAPER_PLAN_DEPENDENCIES) invalid("dependencies must be an array of at most 200 entries");
  const ids = new Set<string>();
  return raw.map((value): PaperDependency => {
    const dependency = object(value, ["id", "kind", "name", "cites", "waiver"], "dependency");
    if (typeof dependency.id !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(dependency.id) || dependency.id.length > 64) invalid("dependency id must be a lowercase alphanumeric hyphenated slug of 1..64 characters");
    if (ids.has(dependency.id)) invalid("dependency ids must be unique"); ids.add(dependency.id);
    if (typeof dependency.kind !== "string" || !PAPER_DEPENDENCY_KINDS.includes(dependency.kind as PaperDependencyKind)) invalid(`dependency kind must be one of ${PAPER_DEPENDENCY_KINDS.join(", ")}`);
    if (typeof dependency.name !== "string" || !dependency.name.trim() || /\p{Cc}/u.test(dependency.name) || /\p{Zl}|\p{Zp}/u.test(dependency.name)) invalid("dependency name must be nonempty single-line text");
    if ((dependency.cites === undefined) === (dependency.waiver === undefined)) invalid("dependency needs exactly one of cites or waiver; cite verified keys or write a waiver");
    const base = { id: dependency.id, kind: dependency.kind as PaperDependencyKind, name: dependency.name.trim() };
    if (dependency.cites !== undefined) {
      if (!Array.isArray(dependency.cites) || !dependency.cites.length) invalid("dependency cites must be a nonempty array of citation keys");
      const { keys } = citationKeys(dependency.cites, "dependency cites", "citation keys must be unique within each dependency", byKey, verifiedKeys, verify);
      return { ...base, cites: keys };
    }
    if (typeof dependency.waiver !== "string" || !dependency.waiver.trim() || dependency.waiver.includes("\0")) invalid("dependency waiver must be nonempty written text without NUL");
    if (Buffer.byteLength(dependency.waiver) > PAPER_DEPENDENCY_WAIVER_BYTES) invalid("dependency waiver must be at most 500 UTF-8 bytes; shorten the written waiver or cite verified keys instead");
    return { ...base, waiver: dependency.waiver };
  });
}
export function validatePaperPlan(raw: unknown, candidates: Candidate[], resolveEvidence?: PaperPointEvidenceResolver, deferDependencyCitations = false): PaperPlan {
  const value = object(raw, ["v", "sections", "dependencies", "figures"], "plan");
  if (value.v !== undefined && value.v !== 1 && value.v !== 2 && value.v !== 3) invalid("unsupported plan version; use a compatible version-1, version-2 or version-3 plan reader, keeping unsupported plan bytes unchanged");
  if (!Array.isArray(value.sections) || value.sections.length > PAPER_PLAN_SECTIONS) invalid("sections must be an array of at most 64 sections");
  if (value.v === 1 && value.sections.some(section => plain(section) && Array.isArray(section.points) && section.points.length)) invalid("version-1 plan cannot contain writing points; omit v or use v: 2 for a points plan");
  if ((value.v === 1 || value.v === 2) && Array.isArray(value.dependencies) && value.dependencies.length) invalid(`version-${value.v} plan cannot contain experiment dependencies; omit v or use v: 3 for a dependencies plan`);
  if ((value.v === 1 || value.v === 2) && value.figures !== undefined) invalid("figures require paper plan v: 3");
  const figures = value.figures === undefined ? undefined : validateFigures(value.figures, pointReference);
  const pointIds = new Set<string>(), resolutions = new Map<string, PointEvidenceResolution>();
  const byKey = candidateKeys(candidates), ids = new Set<string>(), headings = new Set<string>(), verifiedKeys = new Set<string>();
  const sections = value.sections.map((rawSection): PaperSection => {
    const section = object(rawSection, ["id", "heading", "cites", "points"], "section");
    if (typeof section.id !== "string" || (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(section.id) || section.id.length > 64)) invalid("section id must be a lowercase alphanumeric hyphenated slug of 1..64 characters");
    if (ids.has(section.id)) invalid("section ids must be unique"); ids.add(section.id);
    if (typeof section.heading !== "string" || !section.heading.length || section.heading.trim() !== section.heading || section.heading.includes("\0")) invalid("section heading must be nonempty exact text without outer whitespace or NUL");
    if (headings.has(section.heading)) invalid("section headings must be unique exact text"); headings.add(section.heading);
    const { keys: cites, seen } = citationKeys(section.cites, "section cites", "citation keys must be unique within each section", byKey, verifiedKeys, true);
    const pointList = points(section.points, seen, pointIds, resolveEvidence, resolutions);
    return { id: section.id, heading: section.heading, cites, ...(pointList.length ? { points: pointList } : {}) };
  });
  const dependencyList = dependencies(value.dependencies, byKey, verifiedKeys, !deferDependencyCitations);
  const plan: PaperPlan = { v: value.v === 3 || dependencyList.length || figures !== undefined ? 3 : pointIds.size ? 2 : 1, sections, ...(dependencyList.length ? { dependencies: dependencyList } : {}), ...(figures === undefined ? {} : { figures }) };
  if (Buffer.byteLength(JSON.stringify(plan, null, 2) + "\n") > PAPER_PLAN_BYTES) invalid("formatted plan exceeds the 64 KiB bound; reduce sections, dependencies, citation keys or heading lengths");
  return plan;
}
function metadata(file: string) {
  try { return lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; invalid("fixed paper directory or plan metadata is unreadable"); }
}
/** Resolve only the fixed paper/plan.json address, refusing links rather than following plan locators. */
function address(dirArg: string): { dir: string; file: string; present: boolean } {
  const dir = resolve(dirArg), paper = join(dir, "paper"), info = metadata(paper);
  if (!info) {
    let root: string;
    try { root = realpathSync(dir); } catch { invalid("study directory must be readable before accessing the fixed paper plan"); }
    return { dir: root, file: join(root, "paper", "plan.json"), present: false };
  }
  if (!info.isDirectory() || info.isSymbolicLink()) invalid("paper must be a physical directory, not a link or special file");
  let root: string;
  try { root = realpathSync(dir); if (realpathSync(paper) !== join(root, "paper")) invalid("paper directory escapes the study"); }
  catch { invalid("fixed paper directory must be readable and physically contained in the study"); }
  const file = join(root, "paper", "plan.json"), stat = metadata(file);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) invalid("paper/plan.json must be a regular physical file, not a link or special file");
  return { dir: root, file, present: !!stat };
}
function currentCandidates(dir: string): Candidate[] {
  try { return loadCandidates(dir); } catch { return invalid("current reference records are unreadable or malformed"); }
}
function snapshot(dir: string, candidates: Candidate[] | undefined, strictEvidence: boolean): PaperPlanSnapshot | undefined {
  // An absent optional plan must not impose new restrictions on a legacy manuscript location.
  if (!metadata(join(resolve(dir), "paper", "plan.json"))) return undefined;
  const target = address(dir);
  if (!target.present) return undefined;
  let bytes: Buffer, raw: unknown;
  try { bytes = readBytesBounded(target.file, PAPER_PLAN_BYTES, { noFollow: true }); }
  catch { invalid("paper/plan.json is unreadable, non-regular or larger than 64 KiB; restore a readable regular file or reduce sections, citation keys or heading lengths if oversized"); }
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { invalid("paper/plan.json is not valid UTF-8 JSON"); }
  if (!plain(raw) || (raw.v !== 1 && raw.v !== 2 && raw.v !== 3)) invalid("stored plan must carry supported v: 1, v: 2 or v: 3; use paper plan set to version an unversioned input, or a compatible ares reader while keeping unsupported version bytes unchanged");
  const resolver: PaperPointEvidenceResolver = strictEvidence ? ref => resolvePointEvidence(target.dir, ref) : () => ({ resolved: true });
  const plan = validatePaperPlan(raw, candidates ?? currentCandidates(target.dir), resolver, true);
  if (plan.v !== raw.v) invalid("stored plan version does not match its declared content; use paper plan set to normalize the known plan format");
  return { plan, sha256: sha256(bytes) };
}
export function readPaperPlanSnapshot(dir: string, candidates?: Candidate[]): PaperPlanSnapshot | undefined { return snapshot(dir, candidates, true); }
/** Paper check validates all plan syntax/references, then reports evidence disappearance as findings. */
export function readPaperPlanCheckSnapshot(dir: string, candidates?: Candidate[]): PaperPlanSnapshot | undefined { return snapshot(dir, candidates, false); }
export function readPaperPlan(dir: string, candidates?: Candidate[]): PaperPlan | undefined { return readPaperPlanSnapshot(dir, candidates)?.plan; }
export function paperPlanCoverage(plan: PaperPlan, candidates: Candidate[]): { routed: number; total: number } {
  const routed = new Set(plan.sections.flatMap(section => section.cites)), included = candidates.filter(candidate => candidate.status === "included");
  return { routed: included.filter(candidate => !!candidate.citekey && routed.has(candidate.citekey) && isVerified(candidate)).length, total: included.length };
}
export function paperDependencyCoverage(plan: PaperPlan): PaperDependencyCoverage {
  const dependencies = plan.dependencies ?? [];
  return { cited: dependencies.filter(dependency => dependency.cites !== undefined).length, waived: dependencies.filter(dependency => dependency.waiver !== undefined).length, total: dependencies.length };
}
/** Caller owns the study lock. All validation precedes the command's one file+event commit. */
export function setPaperPlan(dirArg: string, raw: unknown, actor: Actor): PaperPlan {
  const { dir } = openStudy(dirArg), plan = validatePaperPlan(raw, currentCandidates(dir), ref => resolvePointEvidence(dir, ref)), target = address(dir);
  if (target.present) {
    let previous: unknown;
    try { previous = JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(readBytesBounded(target.file, PAPER_PLAN_BYTES, {noFollow: true}))); }
    catch { invalid("previous paper/plan.json is unreadable, oversized or invalid JSON; restore the last valid bounded plan before replacing it"); }
    if (plain(previous) && previous.v !== undefined && previous.v !== 1 && previous.v !== 2 && previous.v !== 3) invalid("unsupported stored plan version; use a compatible ares reader, keeping paper/plan.json unchanged");
  }
  const text = JSON.stringify(plan, null, 2) + "\n";
  if (Buffer.byteLength(text) > PAPER_PLAN_BYTES) invalid("formatted plan exceeds the 64 KiB bound; reduce sections, dependencies, citation keys or heading lengths");
  commit(target.dir, [[target.file, text, PAPER_PLAN_BYTES]], [{ actor, type: "paper.plan.set", data: { sha256: sha256(text), sectionCount: plan.sections.length, citationCount: plan.sections.reduce((sum, section) => sum + section.cites.length, 0) } }]);
  return plan;
}
export function showPaperPlan(dirArg: string): PaperPlanView {
  const { dir } = openStudy(dirArg), candidates = currentCandidates(dir), plan = readPaperPlan(dir, candidates);
  return { plan: plan ?? null, coverage: paperPlanCoverage(plan ?? { v: 1, sections: [] }, candidates), dependencyCoverage: paperDependencyCoverage(plan ?? { v: 1, sections: [] }), ...(plan?.figures === undefined ? {} : { figureCoverage: figureCoverage(dir, plan.figures) }) };
}
