import { existsSync } from "node:fs";
import { join } from "node:path";
import { openStudy, readTextBounded, sha256 } from "../study.ts";
import { loadCandidates } from "../lit/candidates.ts";
import { checkCitations, citationOccurrences } from "../lit/cite.ts";
import { readProtocol } from "../exp/protocol.ts";
import { readSelection } from "../exp/selection.ts";
import { investigateResultPath, readClosedInvestigation } from "../exp/investigate.ts";
import { finalResultPath } from "../exp/final.ts";
import { MANUSCRIPT_BYTES, parsePlaceholders, resolvePlaceholders } from "./placeholders.ts";

export interface PaperFinding { code: "bare-number" | "unresolved-ref" | "bad-format" | "unknown-citation" | "unverified-citation" | "missing-negative-result"; start: number; end: number; line: number; column: number; message: string }
function blank(text: string, mask: Uint8Array): string { return text.split("").map((char, index) => mask[index] && char !== "\n" && char !== "\r" ? " " : char).join(""); }
function mark(mask: Uint8Array, start: number, end: number) { mask.fill(1, start, end); }
function escaped(text: string, index: number): boolean { let slashes = 0; while (index > 0 && text[--index] === "\\") slashes++; return slashes % 2 === 1; }
/** Masks syntax-only destinations and code while retaining original offsets. Visible link labels remain prose. */
function markdownMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length), protectedText = new Uint8Array(text.length), tokens = parsePlaceholders(text);
  for (const token of [...tokens.placeholders, ...tokens.findings]) mark(protectedText, token.start, token.end);
  let fence: { char: string; length: number } | undefined;
  for (const match of text.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0], start = match.index;
    if (!line) continue;
    if (fence) {
      mark(mask, start, start + line.length);
      const close = /^ {0,3}(`+|~+)[ \t]*\r?\n?$/.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = undefined;
    } else if (!protectedText[start]) {
      const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
      if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) { fence = { char: open[1]![0]!, length: open[1]!.length }; mark(mask, start, start + line.length); }
      else if (/^(?: {4}|\t)/.test(line)) mark(mask, start, start + line.length);
    }
  }
  // Backtick runs must have an exactly matching closer; unmatched delimiters remain prose.
  const runs = [...text.matchAll(/`+/g)].filter(hit => !mask[hit.index] && !protectedText[hit.index]);
  const regions: number[] = []; let region = 0, previous = 0;
  for (const hit of runs) {
    if (/\n[ \t]*\r?\n/.test(text.slice(previous, hit.index)) || mask.subarray(previous, hit.index).includes(1)) region++;
    regions.push(region); previous = hit.index + hit[0].length;
  }
  const next = new Map<number, number>(), closers = new Map<string, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const hit = runs[i]!, key = `${regions[i]}:${hit[0].length}`;
    if (closers.has(key)) next.set(i, closers.get(key)!); closers.set(key, i);
  }
  for (let i = 0; i < runs.length; i++) {
    if (escaped(text, runs[i]!.index)) continue;
    const close = next.get(i);
    if (close !== undefined) { mark(mask, runs[i]!.index, runs[close]!.index + runs[close]![0].length); i = close; }
  }
  for (let i = 0; i < text.length; i++) {
    if (mask[i] || protectedText[i] || (text[i] !== "<" && text[i] !== "]") || escaped(text, i)) continue;
    if (text[i] === "<") {
      const end = text.indexOf(">", i + 1), target = text.slice(i + 1, end < 0 ? i + 1 : end);
      if (end >= 0 && /^(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)$/.test(target)) { mark(mask, i, end + 1); i = end; }
    }
    if (text[i] !== "]" || text[i + 1] !== "(") continue;
    let start = i + 2; while (/\s/.test(text[start] ?? "") && start < text.length) start++;
    let end = start, depth = 0;
    if (text[start] === "<") { end = text.indexOf(">", start + 1); if (end < 0) continue; end++; }
    else {
      while (end < text.length) {
        const char = text[end]!;
        if (char === "\\") { end += 2; continue; }
        if (/\s/.test(char) || (char === ")" && depth === 0)) break;
        if (char === "(") depth++;
        if (char === ")") depth--;
        end++;
      }
      if (depth) continue;
    }
    let tail = end; while (/\s/.test(text[tail] ?? "") && tail < text.length) tail++;
    if (["\"", "'"].includes(text[tail] ?? "")) {
      const quote = text[tail++]!; while (tail < text.length && (text[tail] !== quote || escaped(text, tail))) tail++;
      if (tail >= text.length) continue; tail++; while (/\s/.test(text[tail] ?? "") && tail < text.length) tail++;
    }
    if (text[tail] === ")") mark(mask, start, end);
  }
  // Reference-style link destinations are also targets; reference labels/titles are not hidden.
  for (const match of text.matchAll(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|[^\s]+)(?:[ \t]|$)/gm)) {
    const target = match[1]!, start = match.index + match[0].lastIndexOf(target);
    if (!mask[start] && !protectedText[start]) mark(mask, start, start + target.length);
  }
  return mask;
}
export function manuscriptPath(dir: string): string { return join(dir, "paper", "manuscript.md"); }
export function checkPaper(dirArg: string) {
  const { dir, study } = openStudy(dirArg), file = manuscriptPath(dir);
  let manuscript: string;
  try { manuscript = readTextBounded(file, MANUSCRIPT_BYTES); }
  catch { throw new Error("paper manuscript: missing, unreadable, invalid UTF-8, non-regular or larger than 2 MiB; restore paper/manuscript.md as a bounded UTF-8 regular file before paper check"); }
  const codeMask = markdownMask(manuscript), prose = blank(manuscript, codeMask), parsed = parsePlaceholders(prose), resolution = resolvePlaceholders(dir, prose);
  const lines = [0]; for (let i = 0; i < manuscript.length; i++) if (manuscript[i] === "\n") lines.push(i + 1);
  const finding = (code: PaperFinding["code"], start: number, end: number, message: string): PaperFinding => {
    let lo = 0, hi = lines.length; while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (lines[mid]! <= start) lo = mid; else hi = mid; }
    return { code, start, end, line: lo + 1, column: start - lines[lo]! + 1, message };
  };
  const findings: PaperFinding[] = resolution.findings.map(f => finding(f.code, f.start, f.end, f.message));
  const numberMask = codeMask.slice(), citationMask = codeMask.slice();
  for (const placeholder of parsed.placeholders) {
    mark(numberMask, placeholder.start, placeholder.end);
    if (placeholder.kind === "number") mark(citationMask, placeholder.start, placeholder.end);
  }
  for (const problem of parsed.findings) { mark(numberMask, problem.start, problem.end); mark(citationMask, problem.start, problem.end); }
  const citationText = blank(manuscript, citationMask), citations = checkCitations(citationText, loadCandidates(dir));
  for (const hit of citationOccurrences(citationText)) {
    mark(numberMask, hit.groupStart, hit.groupEnd);
    if (citations.unknown.includes(hit.key)) findings.push(finding("unknown-citation", hit.start, hit.end, `citation ${hit.key}: unknown key; add and verify the reference, then regenerate the bibliography`));
    else if (citations.notVerified.includes(hit.key)) findings.push(finding("unverified-citation", hit.start, hit.end, `citation ${hit.key}: not included and identifier-verified; inspect ares lit list, verify the reference or exclude this citation`));
  }
  if (study.mode === "experiment") {
    for (const match of manuscript.matchAll(/^ {0,3}[0-9]+[.)](?=[ \t])/gm)) mark(numberMask, match.index, match.index + match[0].length);
    for (const match of blank(manuscript, numberMask).matchAll(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu)) findings.push(finding("bare-number", match.index, match.index + match[0].length, "prose number has no evidence ref; use {{n:REF}} for a measured value or {{lit:TEXT}} for a reviewer-visible literal"));
    const requireRef = (ref: string) => {
      if (!parsed.placeholders.some(p => p.kind === "number" && p.ref === ref && p.format === undefined)) findings.push(finding("missing-negative-result", 0, 0, `paper omits ${ref}; include {{n:${ref}}} in prose so the result cannot be hidden`));
    };
    if (existsSync(finalResultPath(dir))) requireRef("final.status");
    try {
      const protocol = readProtocol(dir), rule = protocol ? readSelection(dir, protocol) : undefined;
      if (rule && existsSync(investigateResultPath(dir, rule.run))) {
        try { if (readClosedInvestigation(dir).result.winner === null) requireRef("investigate.reason"); }
        catch { findings.push(finding("unresolved-ref", 0, 0, "investigate result is not current and closed; run ares investigate close before checking the paper")); }
      }
    } catch { findings.push(finding("unresolved-ref", 0, 0, "experiment design or selection is invalid; restore the current validated inputs before paper check")); }
  }
  let rendered = "", cursor = 0;
  for (const entry of resolution.placeholders) { rendered += manuscript.slice(cursor, entry.placeholder.start) + entry.rendered; cursor = entry.placeholder.end; }
  rendered += manuscript.slice(cursor);
  return { ok: findings.length === 0, manuscriptSha256: sha256(manuscript), rendered, placeholders: resolution.placeholders, findings: findings.sort((a, b) => a.start - b.start || a.code.localeCompare(b.code)), literals: resolution.literals, citations };
}
