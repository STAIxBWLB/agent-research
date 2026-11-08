import {expect, spyOn, test} from "bun:test";
import * as fs from "node:fs";
import {dirname, join} from "node:path";
import {fileURLToPath} from "node:url";
import {freezeHarnessPreregistration, verifyHarnessPreregistration, verifyControlReceipt, HARNESS_PROTOCOL, HARNESS_METHOD, HARNESS_FROZEN} from "../scripts/harness-eval.ts";
import {readBytesBounded, readTextBounded, writeAtomic} from "../src/study.ts";
import {tempDir} from "./helpers.ts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url)), DOCUMENT_BYTES = 65_536, FIXTURE_BYTES = 16_384;
function fixture() {
  const root = tempDir(), seal = JSON.parse(readTextBounded(join(sourceRoot, HARNESS_FROZEN), DOCUMENT_BYTES)) as {files: {path: string}[]};
  for (const {path} of seal.files) {
    const target = join(root, path); fs.mkdirSync(dirname(target), {recursive: true});
    writeAtomic(target, readTextBounded(join(sourceRoot, path), DOCUMENT_BYTES), DOCUMENT_BYTES);
  }
  const protocol = JSON.parse(readTextBounded(join(root, HARNESS_PROTOCOL), DOCUMENT_BYTES));
  const indexPath = protocol.corpus.index as string, index = JSON.parse(readTextBounded(join(root, indexPath), DOCUMENT_BYTES));
  return {root, receipt: join(root, "synthetic-frozen.json"), indexPath, index};
}
function message(fn: () => unknown): string {
  try {fn();} catch (error) {return (error as Error).message;}
  throw new Error("expected guided source refusal");
}
function guided(error: string, path: string, cause: string) {
  expect(error).toContain("harness eval"); expect(error).toContain(path); expect(error).toContain(cause);
  expect(error).toContain("restore"); expect(error).toMatch(/registered.*bytes|re-register/);
}
type Shape = "missing" | "over-bound" | "non-regular" | "linked" | "invalid UTF-8" | "invalid JSON";
function damage(file: string, shape: Shape, bound: number, target: string) {
  if (shape === "missing") fs.unlinkSync(file);
  else if (shape === "over-bound") fs.truncateSync(file, bound + 1);
  else if (shape === "non-regular") {fs.unlinkSync(file); fs.mkdirSync(file);}
  else if (shape === "linked") {fs.unlinkSync(file); fs.symlinkSync(target, file);}
  else if (shape === "invalid UTF-8") fs.writeFileSync(file, Buffer.from([255])); // One deliberately invalid byte, bounded by construction.
  else writeAtomic(file, "{", bound);
}

for (const role of ["input", "expected", "control", "protocol", "index", "fault", "method"] as const) test(`guided failures cover ${role} source paths and read/encoding bounds`, () => {
  const f = fixture(), relative = role === "protocol" ? HARNESS_PROTOCOL : role === "index" ? f.indexPath : role === "fault" ? f.index.faults as string : role === "method" ? HARNESS_METHOD : f.index.cases[0][role] as string;
  const bound = ["protocol", "index", "method"].includes(role) ? DOCUMENT_BYTES : FIXTURE_BYTES;
  const file = join(f.root, relative), original = readTextBounded(file, bound), target = join(f.root, "synthetic-link-target.json");
  writeAtomic(target, "{}\n", DOCUMENT_BYTES);
  const shapes: Shape[] = ["missing", "over-bound", "non-regular", "linked", "invalid UTF-8", ...(role === "method" ? [] : ["invalid JSON" as const])];
  for (const shape of shapes) {
    damage(file, shape, bound, target);
    try {
      const error = message(() => freezeHarnessPreregistration(f.root, f.receipt)); guided(error, relative, shape);
      if (shape === "over-bound") expect(error).toContain(String(bound));
      expect(fs.existsSync(f.receipt)).toBe(false);
    } finally {
      fs.rmSync(file, {recursive: true, force: true}); writeAtomic(file, original, bound);
    }
  }
});

test("filePath traversal and linked ancestor refusals are wrapped with harness source recovery", () => {
  const f = fixture(), path = "test/fixtures/harness/../outside.json";
  f.index.cases[0].input = path; writeAtomic(join(f.root, f.indexPath), JSON.stringify(f.index), DOCUMENT_BYTES);
  guided(message(() => freezeHarnessPreregistration(f.root, f.receipt)), path, "unsafe");
  const linked = fixture(), directory = join(linked.root, "test", "fixtures", "harness"), moved = join(linked.root, "moved-fixture-source");
  fs.renameSync(directory, moved); fs.symlinkSync(moved, directory);
  guided(message(() => freezeHarnessPreregistration(linked.root, linked.receipt)), linked.indexPath, "linked");
});

test("late method document read failures name the method and its recovery step", () => {
  const f = fixture(), target = join(f.root, HARNESS_METHOD), open = fs.openSync;
  let failures = 0;
  const spy = spyOn(fs, "openSync").mockImplementation(((file, flags, mode) => {
    if (String(file) === target) {failures++; throw Object.assign(new Error("synthetic permission failure"), {code: "EACCES"});}
    return open(file, flags, mode);
  }) as typeof fs.openSync);
  try {guided(message(() => freezeHarnessPreregistration(f.root, f.receipt)), HARNESS_METHOD, "unreadable"); expect(failures).toBe(1);}
  finally {spy.mockRestore();}
  expect(fs.existsSync(f.receipt)).toBe(false);
});

for (const kind of ["frozen", "control"] as const) test(`guided ${kind} receipt failures cover bounds, regular-file and JSON requirements`, () => {
  const f = fixture(), file = join(f.root, `${kind}-receipt.json`), target = join(f.root, "receipt-link-target.json"), bound = kind === "frozen" ? DOCUMENT_BYTES : 8 * 1024 * 1024;
  writeAtomic(target, "{}\n", DOCUMENT_BYTES);
  const read = () => kind === "frozen" ? verifyHarnessPreregistration(f.root, file) : verifyControlReceipt(f.root, file);
  for (const shape of ["missing", "over-bound", "non-regular", "linked", "invalid UTF-8", "invalid JSON"] as const) {
    writeAtomic(file, "{}\n", bound); damage(file, shape, bound, target);
    try {const error = message(read); guided(error, file, shape); if (shape === "over-bound") expect(error).toContain(String(bound));}
    finally {fs.rmSync(file, {recursive: true, force: true});}
  }
});

test("valid source snapshots keep registered bytes untouched and valid method Markdown is not parsed as JSON", () => {
  const f = fixture(), method = join(f.root, HARNESS_METHOD), text = "# Synthetic non-JSON method\n\nRegistered source text.\n";
  writeAtomic(method, text, DOCUMENT_BYTES);
  const before = readBytesBounded(method, DOCUMENT_BYTES), seal = freezeHarnessPreregistration(f.root, f.receipt);
  expect(seal.files.find(file => file.path === HARNESS_METHOD)?.bytes).toBe(Buffer.byteLength(text));
  expect(verifyHarnessPreregistration(f.root, f.receipt)).toEqual(seal);
  expect(readBytesBounded(method, DOCUMENT_BYTES)).toEqual(before);
});
