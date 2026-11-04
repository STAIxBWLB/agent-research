import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { addStudy, MAX_REGISTERED_STUDIES, readRegistry, removeStudy, STUDY_REGISTRY_BYTES } from "../src/console/registry.ts";
import { initStudy } from "../src/study.ts";
import { tempDir } from "./helpers.ts";
function fixture() { const home = fs.realpathSync(tempDir()), family = join(home, "family"), dir = join(home, "study"); initStudy(dir, { question: "Synthetic registry study" }, { kind: "person" }); return { home, family, dir, file: join(family, "research", "studies.json") }; }

test("empty read is write-free; add stores canonical study directories privately and idempotently", () => {
  const f = fixture(), before = fs.readdirSync(f.home);
  expect(readRegistry(f.family)).toEqual({ v: 1, studies: [] }); expect(fs.readdirSync(f.home)).toEqual(before);
  const alias = join(f.home, "alias"); fs.symlinkSync(f.dir, alias);
  expect(addStudy(f.family, alias)).toEqual({ v: 1, studies: [f.dir] });
  expect(fs.statSync(dirname(f.file)).mode & 0o777).toBe(0o700); expect(fs.statSync(f.file).mode & 0o777).toBe(0o600);
  const bytes = fs.readFileSync(f.file), stat = fs.statSync(f.file);
  expect(addStudy(f.family, f.dir).studies).toEqual([f.dir]); expect(fs.readFileSync(f.file)).toEqual(bytes); expect(fs.statSync(f.file).mtimeMs).toBe(stat.mtimeMs);
  expect(fs.existsSync(`${f.file}.lock`)).toBe(false);
});

test("add requires a readable study while remove handles moved or malformed studies without scanning", () => {
  const f = fixture(); expect(() => addStudy(f.family, join(f.home, "missing"))).toThrow("study directory"); expect(fs.existsSync(f.family)).toBe(false);
  addStudy(f.family, f.dir); const moved = join(f.home, "moved"); fs.renameSync(f.dir, moved);
  expect(readRegistry(f.family).studies).toEqual([f.dir]); expect(removeStudy(f.family, f.dir).studies).toEqual([]);
  addStudy(f.family, moved); fs.writeFileSync(join(moved, "study.json"), "not valid JSON");
  expect(() => addStudy(f.family, moved)).toThrow(); expect(removeStudy(f.family, moved).studies).toEqual([]);
  const bytes = fs.readFileSync(f.file); expect(removeStudy(f.family, moved).studies).toEqual([]); expect(fs.readFileSync(f.file)).toEqual(bytes);
});

test("200-study cap is inclusive and refused add preserves the existing registry", () => {
  const f = fixture(), studies = Array.from({ length: MAX_REGISTERED_STUDIES }, (_, i) => join(f.home, `unavailable-${i}`));
  fs.mkdirSync(dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, JSON.stringify({ v: 1, studies })); const before = fs.readFileSync(f.file), mode = fs.statSync(dirname(f.file)).mode;
  expect(readRegistry(f.family).studies).toHaveLength(200); expect(() => addStudy(f.family, f.dir)).toThrow("200-study limit");
  expect(fs.readFileSync(f.file)).toEqual(before); expect(fs.statSync(dirname(f.file)).mode).toBe(mode); expect(fs.existsSync(`${f.file}.lock`)).toBe(false);
});

test("unsupported versions and malformed/oversized registries remain byte-identical", () => {
  for (const raw of [JSON.stringify({ v: 2, studies: [] }), "not JSON", JSON.stringify({ v: 1, studies: ["relative"] }), JSON.stringify({ v: 1, studies: ["/same", "/same"] }), "x".repeat(STUDY_REGISTRY_BYTES + 1)]) {
    const f = fixture(); fs.mkdirSync(dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, raw);
    expect(() => readRegistry(f.family)).toThrow("registry"); expect(() => addStudy(f.family, f.dir)).toThrow("registry"); expect(() => removeStudy(f.family, f.dir)).toThrow("registry");
    expect(fs.readFileSync(f.file, "utf8")).toBe(raw); expect(fs.existsSync(`${f.file}.lock`)).toBe(false);
  }
});

test("v1 additive fields survive mutation and existing loose directory permissions become private", () => {
  const f = fixture(); fs.mkdirSync(dirname(f.file), { recursive: true, mode: 0o755 }); fs.chmodSync(dirname(f.file), 0o755);
  fs.writeFileSync(f.file, JSON.stringify({ v: 1, studies: [], future: { preserve: true } }));
  addStudy(f.family, f.dir); expect(JSON.parse(fs.readFileSync(f.file, "utf8")).future).toEqual({ preserve: true });
  expect(fs.statSync(dirname(f.file)).mode & 0o777).toBe(0o700);
});

test("registry, ancestor and lock symlinks refuse without touching their targets", () => {
  for (const kind of ["file", "parent", "lock"]) {
    const f = fixture(), target = join(f.home, "target");
    if (kind === "parent") { fs.mkdirSync(target); fs.mkdirSync(f.family); fs.symlinkSync(target, dirname(f.file)); }
    else { fs.mkdirSync(dirname(f.file), { recursive: true }); fs.writeFileSync(target, '{}'); fs.symlinkSync(target, kind === "file" ? f.file : `${f.file}.lock`); }
    expect(() => addStudy(f.family, f.dir)).toThrow("links");
    if (kind === "parent") expect(fs.readdirSync(target)).toEqual([]); else expect(fs.readFileSync(target, "utf8")).toBe("{}");
  }
});

test("foreign registry ownership refuses before any write", () => {
  const f = fixture(); fs.mkdirSync(dirname(f.file), { recursive: true }); fs.writeFileSync(f.file, JSON.stringify({ v: 1, studies: [] })); const before = fs.readFileSync(f.file);
  const original = fs.lstatSync, uid = process.getuid!(), spy = spyOn(fs, "lstatSync").mockImplementation(((value: fs.PathLike, ...rest: unknown[]) => {
    const info = (original as any)(value, ...rest); return String(value) === f.file ? new Proxy(info, { get: (target, key) => key === "uid" ? uid + 1 : Reflect.get(target, key) }) : info;
  }) as typeof fs.lstatSync);
  try { expect(() => addStudy(f.family, f.dir)).toThrow("owned by another user"); } finally { spy.mockRestore(); }
  expect(fs.readFileSync(f.file)).toEqual(before);
});

test("exclusive registry lock rejects overlapping writes and names stale cleanup", () => {
  const f = fixture(), other = join(f.home, "other-study"); initStudy(other, { question: "Other synthetic study" }, { kind: "person" });
  const original = fs.renameSync; let blocked = false;
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === f.file) { expect(() => addStudy(f.family, other)).toThrow("locked"); blocked = true; }
    return original(from, to);
  }) as typeof fs.renameSync);
  try { addStudy(f.family, f.dir); } finally { spy.mockRestore(); }
  expect(blocked).toBe(true); expect(readRegistry(f.family).studies).toEqual([f.dir]); expect(fs.existsSync(`${f.file}.lock`)).toBe(false);
  fs.writeFileSync(`${f.file}.lock`, ""); expect(() => addStudy(f.family, other)).toThrow("remove this stale lock only after confirming");
});

test("failed registry rename releases its lock and preserves prior bytes", () => {
  const f = fixture(); addStudy(f.family, f.dir); const other = join(f.home, "other-study"); initStudy(other, { question: "Other" }, { kind: "person" }); const before = fs.readFileSync(f.file), original = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => { if (String(to) === f.file) throw new Error("Synthetic rename failure"); return original(from, to); }) as typeof fs.renameSync);
  try { expect(() => addStudy(f.family, other)).toThrow("Synthetic rename failure"); } finally { spy.mockRestore(); }
  expect(fs.readFileSync(f.file)).toEqual(before); expect(fs.existsSync(`${f.file}.lock`)).toBe(false);
});
