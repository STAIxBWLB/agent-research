import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendEvent, assertWritable, boundedText, onlyKeys, plain, readBytesBounded, readJsonFile, sha256, writeAtomic, type Actor } from "./study.ts";

export interface Scope { question: string; subquestions: string[]; include: string[]; exclude: string[]; yearFrom?: number; yearTo?: number; maxCandidates: number }
const KEYS = ["question", "subquestions", "include", "exclude", "yearFrom", "yearTo", "maxCandidates"] as const;
export const MAX_CANDIDATES = 5000;

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
  return {
    question: boundedText(raw.question, "scope.question", 2000),
    subquestions: list(raw.subquestions, "scope.subquestions", 30, 1000),
    include: list(raw.include, "scope.include", 50, 500),
    exclude: list(raw.exclude, "scope.exclude", 50, 500),
    ...(yearFrom !== undefined ? { yearFrom } : {}), ...(yearTo !== undefined ? { yearTo } : {}),
    maxCandidates: max as number,
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
  assertWritable(text, SCOPE_BYTES, "scope.json");
  const changed = scopeHash(dir) !== hash;
  if (changed) { writeAtomic(scopePath(dir), text); appendEvent(dir, actor, "scope.set", { sha256: hash }); }
  return { scope, sha256: hash, changed };
}
