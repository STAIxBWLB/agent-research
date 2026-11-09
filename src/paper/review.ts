import { requireCopilotAccept, CopilotAcceptError } from "../copilot.ts";
import { boundedText, commit, onlyKeys, openStudy, plain, readLedger, sha256, type Actor, type LedgerEvent } from "../study.ts";
import { readCurrentBuild } from "./build.ts";
import { checkPaper } from "./check.ts";
import { DEFAULT_PAPER_SETTINGS, readPaperSettings, readReviewSettings, type SurveyChecklistMode } from "./hygiene.ts";
export const REVIEW_KINDS = ["contradiction", "unsupported-claim", "number", "citation", "method", "clarity", "other"] as const;
export const REPAIR_SCOPES = ["edit", "paragraph", "section"] as const;
export type RepairScope = typeof REPAIR_SCOPES[number];
export const OVER_BUDGET_ADVICE = "replan the section or ask a person";
/** Survey checklist questions, written for ares; answers are displayed and never gate. */
export const SURVEY_CHECKLIST = [
  { key: "taxonomyPrinciple", question: "Does the survey state how it classifies the work, with one primary partition that does not mix unrelated axes?" },
  { key: "noEnumeration", question: "Do the main sections relate neighbouring works to each other instead of summarizing one paper after another?" },
  { key: "specificGaps", question: "Do the stated gaps and future directions follow from named mechanisms, trade-offs or limitations, and appear outside the conclusion too?" },
  { key: "citationRelations", question: "When a claim cites several works together, does the text say how they relate (shared mechanism, contrast, lineage, boundary, trade-off, trend or limitation)?" },
  { key: "selectionReported", question: "Is every corpus-level or 'systematic' claim backed by reported sources, queries, cutoff date, screening counts and inclusion criteria?" },
  { key: "scopeControl", question: "Is adjacent material justified and kept subordinate to the stated topic?" },
] as const;
export type SurveyKey = typeof SURVEY_CHECKLIST[number]["key"];
export type SurveyAnswers = Record<SurveyKey, boolean>;
const SURVEY_KEYS: SurveyKey[] = SURVEY_CHECKLIST.map(item => item.key);
export function reviewChecklist() { return { survey: SURVEY_CHECKLIST.map(item => ({ ...item })) }; }
/** Unset means show for survey studies and off for experiment studies. */
export function surveyChecklistMode(dir: string, mode: string): SurveyChecklistMode { return readReviewSettings(dir).surveyChecklist ?? (mode === "survey" ? "show" : "off"); }
export interface ReviewFinding { id: string; kind: typeof REVIEW_KINDS[number]; location: string; text: string; blocking: boolean; repair?: RepairScope; section?: string }
export interface ReviewReport {
  v: 1; reviewer: { id: string; modelFamily: string }; buildSha256: string;
  checklist: { negativeResults: boolean; denominators: boolean; limitations: boolean; reproducibility: boolean; survey?: SurveyAnswers };
  findings: ReviewFinding[];
}
interface Resolution { reason: string; actor: Actor; at: string }
interface ReviewRecord { id: string; report: ReviewReport; actor: Actor; at: string; resolutions: Record<string, Resolution> }
function bad(message: string): never { throw new Error(`review: ${message}; inspect ares review show, correct the report or target, and retry`); }
function text(raw: unknown, field: string, max = 4000): string {
  let value: string;
  try { value = boundedText(raw, `review ${field}`, max); } catch { bad(`${field} must be nonblank text of at most ${max} bytes`); }
  if (Buffer.byteLength(value) > max) bad(`${field} exceeds ${max} bytes`);
  return value;
}
function identifier(raw: unknown, field: string): string { const value = text(raw, field, 128); if (value.includes("/")) bad(`${field} contains /; choose an id without slashes`); return value; }
function object(raw: unknown, keys: string[], field: string, strict: boolean): Record<string, unknown> {
  if (!plain(raw)) bad(`${field} must be an object`);
  if (strict) onlyKeys(raw, keys, `review ${field}`);
  return raw;
}
export function validateReview(raw: unknown, strict = true): ReviewReport {
  try {
    const value = object(raw, ["v", "reviewer", "buildSha256", "checklist", "findings"], "report", strict);
    if (value.v !== 1) throw new Error("review: unsupported report version; use an ares version that supports this report, keeping the original bytes unchanged");
    const reviewer = object(value.reviewer, ["id", "modelFamily"], "reviewer", strict), checklist = object(value.checklist, ["negativeResults", "denominators", "limitations", "reproducibility", "survey"], "checklist", strict);
    const buildSha256 = text(value.buildSha256, "buildSha256", 64);
    if (!/^[a-f0-9]{64}$/.test(buildSha256)) bad("buildSha256 must be the 64-hex current evidence hash; run ares paper build");
    for (const name of ["negativeResults", "denominators", "limitations", "reproducibility"]) if (typeof checklist[name] !== "boolean") bad(`checklist.${name} must be a boolean`);
    let survey: SurveyAnswers | undefined;
    if (checklist.survey !== undefined) {
      const block = object(checklist.survey, SURVEY_KEYS, "checklist.survey", strict);
      for (const key of SURVEY_KEYS) if (typeof block[key] !== "boolean") bad(`checklist.survey.${key} must be a boolean; run ares review checklist for the six questions`);
      survey = Object.fromEntries(SURVEY_KEYS.map(key => [key, block[key] as boolean])) as SurveyAnswers;
    }
    if (!Array.isArray(value.findings) || value.findings.length > 200) bad("findings must be an array of at most 200 entries");
    const ids = new Set<string>();
    const findings = value.findings.map((raw, index) => {
      const finding = object(raw, ["id", "kind", "location", "text", "blocking", "repair", "section"], `finding[${index}]`, strict), id = identifier(finding.id, `finding[${index}].id`);
      if (ids.has(id)) bad(`duplicate finding id ${id}`); ids.add(id);
      if (!REVIEW_KINDS.includes(finding.kind as typeof REVIEW_KINDS[number])) bad(`finding ${id} has unknown kind; use ${REVIEW_KINDS.join(", ")}`);
      if (typeof finding.blocking !== "boolean") bad(`finding ${id}.blocking must be a boolean`);
      if (finding.repair !== undefined && !REPAIR_SCOPES.includes(finding.repair as RepairScope)) bad(`finding ${id} has unknown repair scope; use ${REPAIR_SCOPES.join(", ")} or omit it for edit`);
      // Optional fields are stored only when given, so reports without them keep their existing bytes.
      return { id, kind: finding.kind as typeof REVIEW_KINDS[number], location: text(finding.location, `finding ${id}.location`), text: text(finding.text, `finding ${id}.text`), blocking: finding.kind === "contradiction" || finding.blocking,
        ...(finding.repair !== undefined ? { repair: finding.repair as RepairScope } : {}), ...(finding.section !== undefined ? { section: text(finding.section, `finding ${id}.section`, 256).trim() } : {}) };
    });
    return { v: 1, reviewer: { id: text(reviewer.id, "reviewer.id", 128), modelFamily: text(reviewer.modelFamily, "reviewer.modelFamily", 128).trim().toLowerCase() }, buildSha256, checklist: { negativeResults: checklist.negativeResults as boolean, denominators: checklist.denominators as boolean, limitations: checklist.limitations as boolean, reproducibility: checklist.reproducibility as boolean, ...(survey ? { survey } : {}) }, findings };
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid report";
    if (message.includes("; inspect ares review show") || message.includes("supports this report")) throw error;
    bad(`${message}; correct the input before ares review add --file PATH`);
  }
}
export function foldReviews(events: LedgerEvent[]): ReviewRecord[] {
  const rows: ReviewRecord[] = [], counts = new Map<string, number>();
  for (const event of events) {
    if (event.type === "review.added") {
      const id = identifier(event.data.id, "stored review id"), report = validateReview(event.data.review, false), count = (counts.get(report.buildSha256) ?? 0) + 1;
      if (count > 100 || rows.some(row => row.id === id)) bad("review journal has duplicate ids or more than 100 reviews for one build; restore its last valid version");
      counts.set(report.buildSha256, count); rows.push({ id, report, actor: event.actor, at: event.at, resolutions: Object.create(null) as Record<string, Resolution> });
    } else if (event.type === "review.resolved") {
      const row = rows.find(row => row.id === event.data.reviewId), finding = row?.report.findings.find(f => f.id === event.data.findingId);
      if (!row || !finding || event.data.buildSha256 !== row.report.buildSha256 || row.resolutions[finding.id]) bad("resolution journal references a missing or already resolved finding; restore its last valid version");
      row.resolutions[finding.id] = { reason: text(event.data.reason, "stored resolution reason"), actor: event.actor, at: event.at };
    }
  }
  return rows;
}
/** Caller holds the study lock; report ids are generated, findings never disappear by vote. */
export function addReview(dirArg: string, raw: unknown, actor: Actor) {
  const { dir, study } = openStudy(dirArg);
  requireCopilotAccept(dir, "paper");
  const report = validateReview(raw), current = readCurrentBuild(dir), events = readLedger(dir), rows = foldReviews(events);
  if (!report.checklist.survey && surveyChecklistMode(dir, study.mode) === "require") bad("checklist.survey is required by study.toml [review] surveyChecklist = \"require\"; add the six survey answers listed by ares review checklist (false answers are allowed)");
  if (report.buildSha256 !== current.evidenceSha256) bad("stale buildSha256; use the evidenceSha256 from the current ares paper build output");
  if (rows.filter(row => row.report.buildSha256 === report.buildSha256).length >= 100) bad("100 reviews already recorded for this build; resolve existing findings or build a revised manuscript");
  const id = sha256(JSON.stringify([report, events.length])).slice(0, 16);
  if (rows.some(row => row.id === id)) bad("review id collision; inspect the journal before retrying");
  // ponytail: the ledger's existing 64 KiB event limit is stricter than individual text/count limits combined.
  if (Buffer.byteLength(JSON.stringify(report)) > 60 * 1024) bad("combined report exceeds the 60 KiB review payload ceiling; shorten texts or submit fewer findings per report");
  commit(dir, [], [{ actor, type: "review.added", data: { id, review: report } }]); return { id, ...report };
}
export function resolveReview(dirArg: string, target: string, reason: string, actor: Actor) {
  const { dir } = openStudy(dirArg);
  requireCopilotAccept(dir, "paper");
  const parts = target.split("/");
  if (parts.length !== 2) bad("resolution target must be <review-id>/<finding-id>; use ids from ares review show");
  const reviewId = identifier(parts[0], "review id"), findingId = identifier(parts[1], "finding id"), why = text(reason, "resolution reason"), row = foldReviews(readLedger(dir)).find(row => row.id === reviewId);
  if (!row) bad(`unknown review ${reviewId}`);
  if (!row.report.findings.some(f => f.id === findingId)) bad(`unknown finding ${reviewId}/${findingId}`);
  if (row.resolutions[findingId]) bad(`finding ${reviewId}/${findingId} is already resolved`);
  commit(dir, [], [{ actor, type: "review.resolved", data: { reviewId, findingId, buildSha256: row.report.buildSha256, reason: why } }]);
  return { reviewId, findingId, reason: why, actor };
}
function canonical(raw: unknown): string {
  if (Array.isArray(raw)) return `[${raw.map(canonical).join(",")}]`;
  if (plain(raw)) return `{${Object.keys(raw).sort().map(key => `${JSON.stringify(key)}:${canonical(raw[key])}`).join(",")}}`;
  return JSON.stringify(raw) ?? "null";
}
function binding(current: { manuscriptSha256: string; evidenceSha256: string }, events: LedgerEvent[], rows: ReviewRecord[]): string {
  const selected = rows.filter(row => row.report.buildSha256 === current.evidenceSha256), ids = new Set(selected.map(row => row.id));
  const added = events.filter(e => e.type === "review.added" && ids.has(e.data.id as string)).map(e => sha256(canonical(e))).sort();
  const resolutions = events.filter(e => e.type === "review.resolved" && ids.has(e.data.reviewId as string)).map(e => sha256(canonical(e))).sort();
  return sha256(JSON.stringify([current.manuscriptSha256, current.evidenceSha256, added, resolutions]));
}
export function reviewBinding(dirArg: string): string | undefined {
  try { const { dir } = openStudy(dirArg), current = readCurrentBuild(dir), events = readLedger(dir); return binding(current, events, foldReviews(events)); } catch { return undefined; }
}
export function reviewReadiness(dirArg: string) {
  const { dir } = openStudy(dirArg), events = readLedger(dir), unmet: { code: string; message: string }[] = [];
  for (const artifact of ["paper", "reviews"] as const) {
    try { requireCopilotAccept(dir, artifact); }
    catch (error) { unmet.push({ code: `accept:${artifact}`, message: error instanceof Error ? error.message : `copilot ${artifact} acceptance unavailable; inspect ares gate list` }); }
  }
  let current: ReturnType<typeof readCurrentBuild> | undefined, check: ReturnType<typeof checkPaper> | undefined;
  try { current = readCurrentBuild(dir); check = current.check; } catch (error) { unmet.push({ code: "build", message: error instanceof Error ? error.message : "current build unavailable; run ares paper build" }); }
  if (!check) { try { check = checkPaper(dir); } catch (error) { unmet.push({ code: "paper-check", message: error instanceof Error ? error.message : "paper check unavailable; restore paper/manuscript.md" }); } }
  for (const finding of check?.findings ?? []) if (finding.code === "unaccepted-draft" && !unmet.some(item => item.code === "accept-source" && item.message === finding.message)) unmet.unshift({ code: "accept-source", message: finding.message });
  if (check && !check.ok) unmet.push({ code: "paper-check", message: `paper check has ${check.findings.length} finding(s); run ares paper check --json and fix every finding` });
  let rows: ReviewRecord[] = [];
  try { rows = foldReviews(events); } catch (error) { unmet.push({ code: "review-journal", message: error instanceof Error ? error.message : "review journal invalid; restore its valid events" }); }
  const buildSha256 = current?.evidenceSha256, reviews = rows.filter(row => row.report.buildSha256 === buildSha256), families = [...new Set(reviews.map(row => row.report.reviewer.modelFamily))].sort();
  if (families.length < 2) unmet.push({ code: "model-families", message: "fewer than two distinct model families reviewed the current evidence hash; add current-build reviews from two families" });
  const openBlocking = reviews.flatMap(row => row.report.findings.filter(f => f.blocking && !row.resolutions[f.id]).map(f => ({ reviewId: row.id, findingId: f.id, kind: f.kind, location: f.location, text: f.text })));
  if (openBlocking.length) unmet.push({ code: "blocking-findings", message: `open blocking findings: ${openBlocking.map(f => `${f.reviewId}/${f.findingId} (${f.kind})`).join(", ")}; resolve each with a reason using ares review resolve` });
  return { ready: unmet.length === 0, buildSha256: buildSha256 ?? null, ...(current ? { manuscriptSha256: current.manuscriptSha256 } : {}), check: check ?? null, reviews, families, openBlocking, checklists: reviews.map(row => ({ reviewId: row.id, ...row.report.checklist })), claims: "unavailable (STAIxBWLB/agent-hub#931)", unmet, ...roundsView(dir, rows, buildSha256), ...surveyView(dir, reviews) };
}
/** Display only: answers, including false ones, never enter unmet. Off hides the block; require is enforced at review add. */
function surveyView(dir: string, reviews: ReviewRecord[]) {
  const studyMode = openStudy(dir).study.mode;
  let mode: SurveyChecklistMode;
  try { mode = surveyChecklistMode(dir, studyMode); } catch { mode = studyMode === "survey" ? "show" : "off"; }
  if (mode === "off") return { surveyChecklist: mode, surveyAnswers: [] };
  return { surveyChecklist: mode, surveyAnswers: reviews.map(row => ({ reviewId: row.id, modelFamily: row.report.reviewer.modelFamily, survey: row.report.checklist.survey ?? null })) };
}
/** Informational only: rounds never enter unmet, so the gate conditions are unchanged. */
function roundsView(dir: string, rows: ReviewRecord[], buildSha256: string | undefined) {
  let budget = DEFAULT_PAPER_SETTINGS.reviewRounds, settingsError: string | undefined;
  try { budget = readPaperSettings(dir).reviewRounds; } catch (error) { settingsError = error instanceof Error ? error.message : "study.toml unreadable"; }
  const rounds = sectionRounds(rows, buildSha256, budget), info: { code: string; message: string }[] = [];
  if (settingsError) info.push({ code: "review-rounds-settings", message: `${settingsError}; the default budget ${budget} is shown` });
  for (const item of rounds.overBudget) info.push({ code: "review-rounds", message: `section "${item.section.slice(0, 80)}" used ${item.rounds} review rounds, over the budget of ${budget}; ${OVER_BUDGET_ADVICE}` });
  return { roundBudget: budget, sections: rounds.sections, openBySection: rounds.openBySection, overBudget: rounds.overBudget, info };
}
const scope = (finding: ReviewFinding): RepairScope => finding.repair ?? "edit";
/** Rounds: reports with at least one finding for a section, across all evidence hashes. Pass: no open finding for it at the current hash. */
export function sectionRounds(rows: ReviewRecord[], buildSha256: string | undefined, budget: number) {
  const rounds = new Map<string, number>(), open = new Map<string | null, { reviewId: string; findingId: string; kind: string; blocking: boolean; repair: RepairScope }[]>();
  for (const row of rows) {
    for (const section of new Set(row.report.findings.flatMap(f => f.section === undefined ? [] : [f.section]))) rounds.set(section, (rounds.get(section) ?? 0) + 1);
    if (row.report.buildSha256 !== buildSha256) continue;
    for (const f of row.report.findings) if (!row.resolutions[f.id]) {
      const key = f.section ?? null, list = open.get(key) ?? [];
      list.push({ reviewId: row.id, findingId: f.id, kind: f.kind, blocking: f.blocking, repair: scope(f) }); open.set(key, list);
    }
  }
  const sections = [...rounds].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([section, count]) => ({ section, rounds: count, pass: !(open.get(section)?.length), overBudget: count > budget }));
  const openBySection = [...open].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a < b ? -1 : 1).map(([section, findings]) => {
    const byRepair: Record<RepairScope, typeof findings> = { edit: [], paragraph: [], section: [] };
    for (const f of findings) byRepair[f.repair].push(f);
    return { section, rounds: section === null ? null : rounds.get(section) ?? 0, byRepair };
  });
  return { sections, openBySection, overBudget: sections.filter(s => s.overBudget).map(s => ({ section: s.section, rounds: s.rounds, advice: OVER_BUDGET_ADVICE })) };
}
export function requireReviewReady(dir: string): void {
  const report = reviewReadiness(dir), accept = report.unmet.find(item => item.code.startsWith("accept:") || item.code === "accept-source");
  if (accept) throw new CopilotAcceptError(accept.message);
  if (!report.ready) throw new Error(`gate review: ${report.unmet.map(item => `${item.code}: ${item.message}`).join("; ")}; inspect ares review show before approval`);
}
