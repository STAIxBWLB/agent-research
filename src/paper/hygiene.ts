import { existsSync } from "node:fs";
import { join } from "node:path";
import { readTextBounded } from "../study.ts";
import { citationOccurrences } from "../lit/cite.ts";

/** Deterministic citation hygiene codes (#99). Warnings unless listed in study.toml [paper] blocking. */
export const HYGIENE_CODES = ["adjacent-duplicate-citation", "citation-stack", "repeated-bundle", "bare-identifier", "duplicate-heading"] as const;
export type HygieneCode = typeof HYGIENE_CODES[number];
export interface PaperSettings { maxGroup: number; maxBundleRepeats: number; reviewRounds: number; blocking: HygieneCode[] }
export const DEFAULT_PAPER_SETTINGS: PaperSettings = { maxGroup: 6, maxBundleRepeats: 2, reviewRounds: 3, blocking: [] };
export const SETTINGS_BYTES = 64 * 1024;
export interface HygieneHit { code: HygieneCode; start: number; end: number; section: string[]; message: string }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
function refuse(detail: string): never { throw new Error(`study.toml: ${detail}; fix the [paper] or [review] settings (paper keys maxGroup, maxBundleRepeats, reviewRounds, blocking; review key surveyChecklist) or remove study.toml to use the defaults`); }
function count(value: unknown, name: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > 1000) refuse(`paper.${name} must be an integer from ${min} to 1000`);
  return value;
}

/** Optional study.toml; absence keeps the defaults so existing studies keep their blocking set. */
export function readPaperSettings(dir: string): PaperSettings { return readStudySettings(dir).paper; }
export const SURVEY_CHECKLIST_MODES = ["off", "show", "require"] as const;
export type SurveyChecklistMode = typeof SURVEY_CHECKLIST_MODES[number];
/** [review] settings; `surveyChecklist` is undefined when unset so the caller applies the study-mode default. */
export interface ReviewSettings { surveyChecklist?: SurveyChecklistMode }
export function readReviewSettings(dir: string): ReviewSettings { return readStudySettings(dir).review; }
/** One closed reader for both tables, so an unknown key in either refuses for every caller. */
function readStudySettings(dir: string): { paper: PaperSettings; review: ReviewSettings } {
  const file = join(dir, "study.toml");
  if (!existsSync(file)) return { paper: { ...DEFAULT_PAPER_SETTINGS, blocking: [] }, review: {} };
  let raw: unknown;
  try { raw = Bun.TOML.parse(readTextBounded(file, SETTINGS_BYTES)); }
  catch { refuse("unreadable, non-regular, larger than 64 KiB or invalid TOML"); }
  if (!isRecord(raw)) refuse("must be a TOML table");
  for (const key of Object.keys(raw)) if (key !== "paper" && key !== "review") refuse(`unknown setting ${JSON.stringify(key).slice(0, 80)}`);
  const review = raw.review ?? {};
  if (!isRecord(review)) refuse("review must be a table");
  for (const key of Object.keys(review)) if (key !== "surveyChecklist") refuse(`unknown setting review.${JSON.stringify(key).slice(0, 80)}`);
  const reviewSettings: ReviewSettings = {};
  if (review.surveyChecklist !== undefined) {
    if (typeof review.surveyChecklist !== "string" || !(SURVEY_CHECKLIST_MODES as readonly string[]).includes(review.surveyChecklist)) refuse(`review.surveyChecklist must be one of ${SURVEY_CHECKLIST_MODES.join(", ")}`);
    reviewSettings.surveyChecklist = review.surveyChecklist as SurveyChecklistMode;
  }
  const paper = raw.paper ?? {};
  if (!isRecord(paper)) refuse("paper must be a table");
  for (const key of Object.keys(paper)) if (!["maxGroup", "maxBundleRepeats", "reviewRounds", "blocking"].includes(key)) refuse(`unknown setting paper.${JSON.stringify(key).slice(0, 80)}`);
  const settings: PaperSettings = { ...DEFAULT_PAPER_SETTINGS, blocking: [] };
  if (paper.maxGroup !== undefined) settings.maxGroup = count(paper.maxGroup, "maxGroup", 1);
  if (paper.maxBundleRepeats !== undefined) settings.maxBundleRepeats = count(paper.maxBundleRepeats, "maxBundleRepeats", 1);
  if (paper.reviewRounds !== undefined) settings.reviewRounds = count(paper.reviewRounds, "reviewRounds", 1);
  if (paper.blocking !== undefined) {
    if (!Array.isArray(paper.blocking)) refuse("paper.blocking must be an array of finding codes");
    for (const code of paper.blocking) {
      if (typeof code !== "string" || !(HYGIENE_CODES as readonly string[]).includes(code)) refuse(`paper.blocking has unknown code ${JSON.stringify(code).slice(0, 80)}; allowed: ${HYGIENE_CODES.join(", ")}`);
      if (settings.blocking.includes(code as HygieneCode)) refuse(`paper.blocking lists ${code} twice`);
      settings.blocking.push(code as HygieneCode);
    }
  }
  return { paper: settings, review: reviewSettings };
}

/**
 * `manuscript` is the original text; `hiddenCode` marks fenced/indented code and comments, `proseMask` additionally marks
 * code spans, link/autolink targets and reference definition targets; `citationText` is the citation-eligible text.
 */
export function hygieneFindings(manuscript: string, hiddenCode: Uint8Array, proseMask: Uint8Array, citationText: string, settings: PaperSettings): HygieneHit[] {
  const hits: HygieneHit[] = [];
  // Headings (ATX and Setext) and their section paths, in source order.
  const headings: { start: number; end: number; level: number; text: string; parent: number; path: string[] }[] = [];
  const stack: number[] = [];
  const addHeading = (start: number, end: number, level: number, raw: string) => {
    const text = raw.trim().replace(/\s+/g, " ");
    while (stack.length && headings[stack.at(-1)!]!.level >= level) stack.pop();
    const parent = stack.at(-1) ?? -1;
    headings.push({ start, end, level, text, parent, path: [...(parent >= 0 ? headings[parent]!.path : []), text] }); stack.push(headings.length - 1);
  };
  let paragraph: { start: number; end: number; lines: string[] } | undefined;
  for (const match of manuscript.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!match[0]) break;
    const start = match.index, line = match[0].replace(/\r?\n$/, "");
    if (hiddenCode[start + /^[ \t]*/.exec(line)![0].length] || !line.trim()) { paragraph = undefined; continue; }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+([^\r\n]*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) { addHeading(start, start + line.length, atx[1]!.length, atx[2] ?? ""); paragraph = undefined; continue; }
    const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
    if (underline && paragraph) { addHeading(paragraph.start, start + line.length, underline[1]![0] === "=" ? 1 : 2, paragraph.lines.join(" ")); paragraph = undefined; continue; }
    // Block starts that cannot become Setext heading content.
    if (/^ {0,3}(?:[-+*]|[0-9]+[.)])(?:[ \t]|$)|^ {0,3}>|^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line) && !paragraph) { paragraph = undefined; continue; }
    if (paragraph) paragraph.lines.push(line); else paragraph = { start, end: start + line.length, lines: [line] };
  }
  /** Binary search over heading offsets; paths are precomputed per heading. */
  const section = (offset: number): string[] => {
    let lo = 0, hi = headings.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (headings[mid]!.start <= offset) lo = mid + 1; else hi = mid; }
    return lo ? headings[lo - 1]!.path : [];
  };
  const push = (code: HygieneCode, start: number, end: number, message: string) => hits.push({ code, start, end, section: section(start), message });
  const seen = new Map<string, number>();
  for (const [index, heading] of headings.entries()) {
    const key = `${heading.parent}\u0000${heading.level}\u0000${heading.text}`;
    if (seen.has(key)) push("duplicate-heading", heading.start, heading.end, `heading "${heading.text.slice(0, 80)}" repeats a sibling at level ${heading.level}; merge the two sections or rename one`);
    else seen.set(key, index);
  }
  // Citation groups in source order.
  const groups: { start: number; end: number; keys: { key: string; start: number; end: number }[] }[] = [];
  for (const hit of citationOccurrences(citationText)) {
    const last = groups.at(-1);
    if (last && last.start === hit.groupStart) last.keys.push(hit);
    else groups.push({ start: hit.groupStart, end: hit.groupEnd, keys: [hit] });
  }
  const bundles = new Map<string, { start: number; end: number }[]>();
  for (const [index, group] of groups.entries()) {
    const keys = new Set<string>();
    for (const entry of group.keys) {
      if (keys.has(entry.key)) push("adjacent-duplicate-citation", entry.start, entry.end, `citation @${entry.key} repeats within one bracket group; cite it once`);
      keys.add(entry.key);
    }
    const previous = groups[index - 1];
    if (previous && !citationText.slice(previous.end, group.start).trim()) {
      const before = new Set(previous.keys.map(entry => entry.key));
      for (const entry of group.keys) if (before.has(entry.key)) push("adjacent-duplicate-citation", entry.start, entry.end, `citation @${entry.key} repeats in the adjacent bracket group with no prose between; merge the groups and cite it once`);
    }
    if (keys.size > settings.maxGroup) push("citation-stack", group.start, group.end, `bracket group cites ${keys.size} keys, more than paper.maxGroup ${settings.maxGroup}; split the claim or cite the most relevant works`);
    if (keys.size >= 3) {
      const bundle = [...keys].sort().join("\u0000"), list = bundles.get(bundle) ?? [];
      list.push({ start: group.start, end: group.end }); bundles.set(bundle, list);
    }
  }
  for (const [bundle, places] of bundles) {
    if (places.length <= settings.maxBundleRepeats) continue;
    for (const place of places) push("repeated-bundle", place.start, place.end, `the same ${bundle.split("\u0000").length}-key citation group appears ${places.length} times, more than paper.maxBundleRepeats ${settings.maxBundleRepeats}; cite only the works each claim needs`);
  }
  // Bare identifiers: prose outside code, link targets, reference definitions and citation groups.
  const prose = proseMask.slice();
  for (const group of groups) prose.fill(1, group.start, group.end);
  for (const match of manuscript.matchAll(/^ {0,3}\[[^\]\n]+\]:[^\n]*/gm)) prose.fill(1, match.index, match.index + match[0].length);
  // A URL shown as its own link text ([https://x](https://x)) is a link, not a bare identifier.
  for (const match of manuscript.matchAll(/\[([^\[\]\n]+)\]\(\s*<?([^\s<>()]+)>?\s*\)/g)) if (match[1]!.trim() === match[2]) prose.fill(1, match.index, match.index + match[0].length);
  const text = manuscript.split("").map((char, index) => prose[index] && char !== "\n" ? " " : char).join("");
  const patterns: [RegExp, string][] = [
    [/\bhttps?:\/\/[^\s<>()\]]+/gi, "URL"],
    [/\barXiv:[ \t]*(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v\d+)?\b/gi, "arXiv id"],
    [/\b(?:doi:[ \t]*)?10\.\d{4,9}\/[^\s<>\]]+/gi, "DOI"],
  ];
  const taken = new Uint8Array(text.length);
  for (const [pattern, kind] of patterns) for (const match of text.matchAll(pattern)) {
    if (taken[match.index]) continue;
    const value = match[0].replace(/[.,;:]+$/, "");
    taken.fill(1, match.index, match.index + value.length);
    push("bare-identifier", match.index, match.index + value.length, `bare ${kind} in prose; cite the work with a verified [@key] or make it a link`);
  }
  return hits.sort((a, b) => a.start - b.start || a.code.localeCompare(b.code));
}
