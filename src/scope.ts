import { existsSync } from "node:fs";
import { join } from "node:path";
import { boundedText, commit, onlyKeys, plain, readBytesBounded, readJsonFile, sha256, type Actor } from "./study.ts";

export interface ExclusionCode { code: string; label: string }
export interface Scope { question: string; subquestions: string[]; include: string[]; exclude: string[]; yearFrom?: number; yearTo?: number; maxCandidates: number; exclusionCodes?: ExclusionCode[] }
const KEYS = ["question", "subquestions", "include", "exclude", "yearFrom", "yearTo", "maxCandidates", "exclusionCodes"] as const;
export const MAX_CANDIDATES = 5000, MAX_EXCLUSION_CODES = 30;
/** Lower-case slug; "uncoded" names the group of exclusions without a code and is reserved. */
export const EXCLUSION_CODE = /^[a-z][a-z0-9-]{0,31}$/;
function exclusionCodes(value: unknown): ExclusionCode[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_EXCLUSION_CODES) throw new Error(`scope.exclusionCodes: list of at most ${MAX_EXCLUSION_CODES} {code, label} objects`);
  const seen = new Set<string>();
  return value.map((item, i) => {
    const at = `scope.exclusionCodes[${i}]`;
    if (!plain(item)) throw new Error(`${at}: object {code, label} required`);
    onlyKeys(item, ["code", "label"], at);
    if (typeof item.code !== "string" || !EXCLUSION_CODE.test(item.code) || item.code === "uncoded") throw new Error(`${at}.code: lower-case slug of at most 32 characters (letters, digits, -), not "uncoded"`);
    if (seen.has(item.code)) throw new Error(`${at}.code: duplicate code ${item.code}`);
    seen.add(item.code);
    const label = boundedText(item.label, `${at}.label`, 200);
    if (/{{|}}|\||[\r\n]/.test(label)) throw new Error(`${at}.label: must not contain {{, }}, | or line breaks, so it can appear in the lit flow table; reword the label`);
    return { code: item.code, label };
  });
}

function list(value: unknown, what: string, maxItems: number, maxText: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${what}: list of at most ${maxItems}`);
  return value.map((item, i) => boundedText(item, `${what}[${i}]`, maxText));
}
function year(value: unknown, what: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1000 || (value as number) > 2100) throw new Error(`${what}: year 1000..2100`);
  return value as number;
}

export function validateScope(raw: unknown): Scope {
  if (!plain(raw)) throw new Error("scope: JSON object required");
  onlyKeys(raw, KEYS, "scope");
  const yearFrom = year(raw.yearFrom, "scope.yearFrom"), yearTo = year(raw.yearTo, "scope.yearTo");
  if (yearFrom !== undefined && yearTo !== undefined && yearFrom > yearTo) throw new Error("scope: yearFrom after yearTo");
  const max = raw.maxCandidates ?? 500;
  if (!Number.isSafeInteger(max) || (max as number) < 1 || (max as number) > MAX_CANDIDATES) throw new Error(`scope.maxCandidates: 1..${MAX_CANDIDATES}`);
  const codes = exclusionCodes(raw.exclusionCodes);
  return {
    question: boundedText(raw.question, "scope.question", 2000),
    subquestions: list(raw.subquestions, "scope.subquestions", 30, 1000),
    include: list(raw.include, "scope.include", 50, 500),
    exclude: list(raw.exclude, "scope.exclude", 50, 500),
    ...(yearFrom !== undefined ? { yearFrom } : {}), ...(yearTo !== undefined ? { yearTo } : {}),
    maxCandidates: max as number,
    ...(codes ? { exclusionCodes: codes } : {}),
  };
}

export function scopePath(dir: string): string { return join(dir, "scope.json"); }
const SCOPE_BYTES = 65_536;
export function scopeHash(dir: string): string | undefined {
  const path = scopePath(dir);
  return existsSync(path) ? sha256(readBytesBounded(path, SCOPE_BYTES)) : undefined;
}
export function readScope(dir: string): Scope | undefined {
  const path = scopePath(dir);
  return existsSync(path) ? validateScope(readJsonFile(path, SCOPE_BYTES)) : undefined;
}

export function setScope(dir: string, raw: unknown, actor: Actor): { scope: Scope; sha256: string; changed: boolean } {
  const scope = validateScope(raw), text = JSON.stringify(scope, null, 2) + "\n", hash = sha256(text);
  const changed = scopeHash(dir) !== hash;
  if (changed) commit(dir, [[scopePath(dir), text, SCOPE_BYTES]], [{ actor, type: "scope.set", data: { sha256: hash } }]);
  return { scope, sha256: hash, changed };
}
