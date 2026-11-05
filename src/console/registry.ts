import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assertWritable, openStudy, plain, readTextBounded, writeAtomic } from "../study.ts";

export interface StudyRegistry { v: 1; studies: string[] }
export const STUDY_REGISTRY_BYTES = 1024 * 1024, MAX_REGISTERED_STUDIES = 200;
function fail(message: string): never { throw new Error(`study registry: ${message}; restore the bounded v1 registry or correct AGENTHUB_HOME and retry ares console add/remove/list`); }
function absolute(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0")) fail(`${label} must be an absolute path`);
  return resolve(value);
}
function paths(home: string) {
  const base = absolute(home, "family home"), dir = join(base, "research"), file = join(dir, "studies.json");
  return { base, dir, file, lock: `${file}.lock` };
}
/** Root-owned system ancestors are allowed; the mutable family/registry paths must belong to this user. */
function guard(home: string, file: string): void {
  const uid = process.getuid!(), { base, dir } = paths(home), ancestors: string[] = [];
  for (let current = resolve(file); ; current = dirname(current)) { ancestors.unshift(current); if (current === dirname(current)) break; }
  for (const current of ancestors) {
    let info;
    try { info = lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    if (info.isSymbolicLink()) fail("links are refused in registry paths");
    if (current === file) {
      if (!info.isFile()) fail("registry or lock is not a regular file");
      if (info.uid !== uid) fail("registry or lock is owned by another user");
    } else {
      if (!info.isDirectory()) fail("registry parent is not a directory");
      if (info.uid !== uid && (current === base || current === dir || info.uid !== 0)) fail("registry parent is owned by another user");
    }
  }
}
function validate(raw: unknown): StudyRegistry {
  if (!plain(raw) || raw.v !== 1) fail("unsupported registry version or malformed object; keep studies.json unchanged and use a compatible ares version");
  if (!Array.isArray(raw.studies) || raw.studies.length > MAX_REGISTERED_STUDIES) fail("studies must be an array of at most 200 directories");
  if (raw.studies.some(value => typeof value !== "string" || !isAbsolute(value) || value.includes("\0") || value !== resolve(value))) fail("stored study directories must be absolute normalized paths");
  if (new Set(raw.studies).size !== raw.studies.length) fail("duplicate study directory in registry");
  return { ...raw, v: 1, studies: [...raw.studies] } as StudyRegistry;
}
export function readRegistry(home: string): StudyRegistry {
  const { file } = paths(home); guard(home, file);
  let content: string;
  try { content = readTextBounded(file, STUDY_REGISTRY_BYTES, { noFollow: true, uid: process.getuid!() }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, studies: [] }; fail("studies.json is unreadable, non-regular or over 1 MiB"); }
  let raw: unknown; try { raw = JSON.parse(content); } catch { fail("studies.json is not valid JSON"); }
  return validate(raw);
}
function update(home: string, change: (current: StudyRegistry) => StudyRegistry): StudyRegistry {
  const { dir, file, lock } = paths(home); guard(home, file); guard(home, lock);
  const busy = () => fail(`registry is locked at ${lock}; wait for the active registry command, or remove this stale lock only after confirming no registry command is running`);
  if (existsSync(lock)) busy();
  mkdirSync(dir, { recursive: true, mode: 0o700 }); guard(home, file); chmodSync(dir, 0o700);
  let fd: number;
  try { fd = openSync(lock, "wx", 0o600); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") busy(); throw error; }
  let owner: { dev: number; ino: number } | undefined;
  try {
    // Capture the created path before descriptor inspection so a failed fstat still has guarded cleanup.
    try { owner = lstatSync(lock); } catch (error) {
      try { owner = fstatSync(fd); } catch { /* Unknown identity must leave a stale lock for manual recovery. */ }
      throw error;
    }
    owner = fstatSync(fd);
    const current = readRegistry(home), next = change(current);
    if (next === current) return current;
    const content = JSON.stringify(next, null, 2) + "\n"; assertWritable(content, STUDY_REGISTRY_BYTES, "study registry");
    guard(home, file); writeAtomic(file, content, STUDY_REGISTRY_BYTES, 0o600); return next;
  } finally {
    try { closeSync(fd); } finally {
      if (owner) {
        try { const current = lstatSync(lock); if (current.dev === owner.dev && current.ino === owner.ino) unlinkSync(lock); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
  }
}
function canonical(dir: string, mustExist: boolean): string {
  if (dir.includes("\0")) fail("study directory contains NUL");
  const full = resolve(dir);
  try { return realpathSync(full); } catch (error) { if (!mustExist && (error as NodeJS.ErrnoException).code === "ENOENT") return full; fail("study directory is unreadable; select a readable study for add or use its listed absolute directory for remove"); }
}
export function addStudy(home: string, dir: string): StudyRegistry {
  const target = canonical(dir, true); openStudy(target);
  const current = readRegistry(home); if (current.studies.includes(target)) return current;
  if (current.studies.length >= MAX_REGISTERED_STUDIES) fail("200-study limit reached; remove an entry before adding another study");
  return update(home, current => {
    if (current.studies.includes(target)) return current;
    if (current.studies.length >= MAX_REGISTERED_STUDIES) fail("200-study limit reached; remove an entry before adding another study");
    return { ...current, studies: [...current.studies, target] };
  });
}
export function removeStudy(home: string, dir: string): StudyRegistry {
  const listed = resolve(dir), current = readRegistry(home);
  // A moved or unreadable registered directory remains removable by its exact listed path.
  const target = current.studies.includes(listed) ? listed : canonical(dir, false);
  if (!current.studies.includes(target)) return current;
  return update(home, current => current.studies.includes(target) ? { ...current, studies: current.studies.filter(value => value !== target) } : current);
}
