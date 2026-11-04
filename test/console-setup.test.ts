import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { consoleManifest, runSetup } from "../src/setup.ts";
import { sha256 } from "../src/study.ts";
import { tempDir } from "./helpers.ts";
function fixture(version = "9.0.0") {
  const home = fs.realpathSync(tempDir()), root = fs.realpathSync(tempDir()), family = join(home, "family");
  fs.mkdirSync(join(root, "bin")); fs.mkdirSync(join(root, "src", "ui"), { recursive: true });
  fs.writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@staix/agent-research", version }));
  fs.writeFileSync(join(root, "bin", "ares.js"), "// synthetic bootstrap\n");
  const module = join(root, "src", "ui", "plugin.ts"); fs.writeFileSync(module, "export default { synthetic: true };\n");
  return { home, root, family, module, env: { HOME: home, AGENTHUB_HOME: family } };
}
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));

test("console preview is read-only and apply writes an exact private manifest and receipt", () => {
  const f = fixture(), preview = consoleManifest("dry-run", f.env, f.root);
  const action = preview.actions[0]!; expect(preview.applied).toBe(false); expect(action.file).toBe(join(f.family, "console", "plugins", "ares.json"));
  expect(action.target).toBe("console"); expect(action.change).toBe("add"); expect(fs.existsSync(f.family)).toBe(false);
  const applied = consoleManifest("apply", f.env, f.root); expect(applied.applied).toBe(true);
  const expected = { api: 1, tool: "ares", module: f.module, sha256: sha256(fs.readFileSync(f.module)) };
  expect(json(action.file)).toEqual(expected); expect(Object.keys(json(action.file)).sort()).toEqual(["api", "module", "sha256", "tool"]);
  expect(json(action.receipt).installed).toEqual(expected); expect(fs.statSync(action.file).mode & 0o777).toBe(0o600); expect(fs.statSync(dirname(action.file)).mode & 0o777).toBe(0o700);
  const bytes = fs.readFileSync(action.file), receipt = fs.readFileSync(action.receipt);
  expect(consoleManifest("apply", f.env, f.root).actions[0]!.change).toBe("unchanged"); expect(fs.readFileSync(action.file)).toEqual(bytes); expect(fs.readFileSync(action.receipt)).toEqual(receipt);
  expect(consoleManifest("undo", f.env, f.root).applied).toBe(true); expect(fs.existsSync(action.file)).toBe(false); expect(fs.existsSync(action.receipt)).toBe(false); expect(fs.existsSync(action.lock)).toBe(false);
});

test("explicit roots get versioned registrations and undo preserves an older independent registration", () => {
  const f = fixture(); const unversioned = consoleManifest("apply", f.env, f.root).actions[0]!;
  const report = runSetup("console", "apply", { env: f.env, root: f.root }); const action = report.actions[0]!;
  expect(action.file).toBe(join(f.family, "console", "plugins", "ares@9.0.0.json")); expect(json(action.file).module).toBe(f.module);
  expect(runSetup("console", "undo", { env: f.env, root: f.root }).applied).toBe(true); expect(fs.existsSync(action.file)).toBe(false); expect(fs.existsSync(unversioned.file)).toBe(true);
  expect(() => runSetup("console", "apply", { env: f.env, root: "relative" })).toThrow("absolute");
  const malicious = fixture("../escape"); expect(() => runSetup("console", "dry-run", { env: malicious.env, root: malicious.root })).toThrow("semantic package version"); expect(fs.existsSync(malicious.family)).toBe(false);
});

test("apply refreshes a changed module hash while undo restores the original manifest only unchanged", () => {
  const f = fixture(), file = join(f.family, "console", "plugins", "ares.json"), prior = { api: 1, tool: "ares", module: "/synthetic/prior.ts", sha256: "a".repeat(64) };
  fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(prior), { mode: 0o600 });
  expect(consoleManifest("apply", f.env, f.root).applied).toBe(true);
  fs.writeFileSync(f.module, "export default { synthetic: 'changed' };\n"); expect(consoleManifest("apply", f.env, f.root).applied).toBe(true); expect(json(file).sha256).toBe(sha256(fs.readFileSync(f.module)));
  const edited = { ...json(file), sha256: "b".repeat(64) }; fs.writeFileSync(file, JSON.stringify(edited));
  expect(consoleManifest("undo", f.env, f.root).actions[0]!.change).toBe("refused"); expect(json(file)).toEqual(edited);
  const action = consoleManifest("dry-run", f.env, f.root).actions[0]!, receipt = json(action.receipt); fs.writeFileSync(file, JSON.stringify(receipt.installed));
  expect(consoleManifest("undo", f.env, f.root).applied).toBe(true); expect(json(file)).toEqual(prior);
});

test("console registration normalizes its directory/file modes without modifying other manifests", () => {
  const f = fixture(), first = consoleManifest("apply", f.env, f.root), file = first.actions[0]!.file, other = join(dirname(file), "other.json");
  fs.writeFileSync(other, "synthetic other registration"); fs.chmodSync(dirname(file), 0o755); fs.chmodSync(file, 0o644);
  expect(consoleManifest("dry-run", f.env, f.root).actions[0]!.change).toBe("replace");
  expect(consoleManifest("apply", f.env, f.root).applied).toBe(true); expect(fs.statSync(dirname(file)).mode & 0o777).toBe(0o700); expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(other, "utf8")).toBe("synthetic other registration");
});

test("links and foreign-owned mutable registration paths are refused with no manifest writes", () => {
  for (const kind of ["file", "directory", "owner"]) {
    const f = fixture(), file = join(f.family, "console", "plugins", "ares.json"), target = join(f.home, "target");
    fs.mkdirSync(dirname(file), { recursive: true });
    if (kind === "file") { fs.writeFileSync(target, "{}"); fs.symlinkSync(target, file); }
    else if (kind === "directory") { fs.rmdirSync(dirname(file)); fs.mkdirSync(target); fs.symlinkSync(target, dirname(file)); }
    else fs.writeFileSync(file, "{}");
    const original = fs.lstatSync, uid = process.getuid!(), spy = kind !== "owner" ? undefined : spyOn(fs, "lstatSync").mockImplementation(((value: fs.PathLike, ...rest: unknown[]) => {
      const info = (original as any)(value, ...rest); return String(value) === file ? new Proxy(info, { get: (object, key) => key === "uid" ? uid + 1 : Reflect.get(object, key) }) : info;
    }) as typeof fs.lstatSync);
    try { const report = consoleManifest("apply", f.env, f.root); expect(report.applied).toBe(false); expect(report.actions[0]!.change).toBe("refused"); }
    finally { spy?.mockRestore(); }
    if (kind === "file") expect(fs.readFileSync(target, "utf8")).toBe("{}"); if (kind === "directory") expect(fs.readdirSync(target)).toEqual([]);
  }
});

test("console manifest receipt is written before publication and a failed publication rolls back", () => {
  const f = fixture(), action = consoleManifest("dry-run", f.env, f.root).actions[0]!, original = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === action.file) { expect(json(action.receipt).installed.tool).toBe("ares"); throw new Error("synthetic manifest publication failure"); }
    return original(from, to);
  }) as typeof fs.renameSync);
  try { expect(consoleManifest("apply", f.env, f.root).applied).toBe(false); } finally { spy.mockRestore(); }
  expect(fs.existsSync(action.file)).toBe(false); expect(fs.existsSync(action.receipt)).toBe(false); expect(fs.existsSync(action.lock)).toBe(false);
});

test("undo can remove unchanged registration after its plugin module is removed", () => {
  const f = fixture(), action = consoleManifest("apply", f.env, f.root).actions[0]!; fs.unlinkSync(f.module);
  expect(consoleManifest("undo", f.env, f.root).applied).toBe(true); expect(fs.existsSync(action.file)).toBe(false);
});

test("explicit root versions match the pinned console loader's VERSION and filename bounds", async () => {
  const base = "123456789.123456789.123456789", loader = fs.existsSync(new URL("../node_modules/@staix/agent-console/src/plugins.ts", import.meta.url))
    ? await import("../node_modules/@staix/agent-console/src/plugins.ts") : null;
  const valid = [base, `1.2.3+${"x".repeat(40)}`, `${base}-${"x".repeat(34)}`];
  expect(valid[2]!.length).toBe(64);
  for (const version of valid) {
    const f = fixture(version), report = runSetup("console", "apply", { env: f.env, root: f.root }), action = report.actions[0]!;
    expect(report.applied).toBe(true); expect(action.file).toBe(join(f.family, "console", "plugins", `ares@${version}.json`));
    if (loader) expect(loader.scanPlugins(f.family).entries[0]!.status).toBe("verified");
    expect(runSetup("console", "undo", { env: f.env, root: f.root }).applied).toBe(true);
  }
  const invalid = ["1234567890.0.0", `1.2.3-${"x".repeat(41)}`, `${base}-${"x".repeat(35)}`];
  expect(invalid[2]!.length).toBe(65);
  for (const version of invalid) {
    const f = fixture(version);
    for (const mode of ["dry-run", "apply", "undo"] as const) {
      expect(() => runSetup("console", mode, { env: f.env, root: f.root })).toThrow("release version cannot name a console registration");
      expect(() => runSetup("console", mode, { env: f.env, root: f.root })).toThrow("three 1..9-digit parts");
      expect(fs.existsSync(f.family)).toBe(false);
    }
  }
});
