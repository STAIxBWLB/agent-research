import { expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { runSetup, SETUP_CONFIG_BYTES } from "../src/setup.ts";
import { run } from "../src/cli.ts";
import { readTextBounded } from "../src/study.ts";
import { tempDir } from "./helpers.ts";
function fixture() {
  const home = fs.realpathSync(tempDir()), family = join(home, "family"), cwd = join(home, "workspace"); fs.mkdirSync(cwd);
  const env = { HOME: home, AGENTHUB_HOME: family }, options = { env, cwd };
  return { home, family, cwd, env, options };
}
function root(version = "9.0.0") {
  const location = fs.realpathSync(tempDir()); fs.mkdirSync(join(location, "bin"));
  fs.writeFileSync(join(location, "package.json"), JSON.stringify({ name: "@staix/agent-research", version })); fs.writeFileSync(join(location, "bin", "ares.js"), "// synthetic bootstrap\n"); return location;
}
const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
function refuse(report: ReturnType<typeof runSetup>) { expect(report.actions.some(action => action.change === "refused")).toBe(true); expect(report.applied).toBe(false); }

test("dry run lists every config/receipt and MCP entry without creating anything", () => {
  const f = fixture(), before = fs.readdirSync(f.home), report = runSetup("all", "dry-run", f.options);
  expect(report.actions.map(action => action.target)).toEqual(["claude", "codex", "kimi", "pi", "qwen", "jcode"]);
  expect(report.entry.command).toBe("bun"); expect(report.entry.args[0]).toBe("--smol"); expect(report.entry.args.at(-1)).toBe("mcp");
  for (const action of report.actions) {
    expect(action.change).toBe("add"); expect(action.receiptChange).toBe("add"); expect(action.entry.endsWith(".ares")).toBe(true);
    expect(action.receipt.startsWith(join(f.family, "research", "setup"))).toBe(true); expect(fs.existsSync(action.file)).toBe(false); expect(fs.existsSync(action.receipt)).toBe(false);
  }
  expect(fs.readdirSync(f.home)).toEqual(before); expect(report.applied).toBe(false);
});

test("all client shapes match vmem, apply is private/idempotent and undo removes setup-created files", () => {
  const f = fixture(), report = runSetup("all", "apply", f.options); expect(report.applied).toBe(true);
  for (const action of report.actions) {
    const expected = action.target === "codex" ? (Bun.TOML.parse(fs.readFileSync(action.file, "utf8")) as any).mcp_servers.ares : json(action.file)[action.target === "jcode" ? "servers" : "mcpServers"].ares;
    expect(expected).toEqual(report.entry); expect(fs.statSync(action.file).mode & 0o777).toBe(0o600); expect(fs.statSync(action.receipt).mode & 0o777).toBe(0o600);
    expect(json(action.receipt).installed).toEqual(report.entry);
  }
  const snapshots = report.actions.map(action => [fs.readFileSync(action.file), fs.readFileSync(action.receipt)]);
  expect(runSetup("all", "apply", f.options).actions.every(action => action.change === "unchanged")).toBe(true);
  report.actions.forEach((action, index) => { expect(fs.readFileSync(action.file)).toEqual(snapshots[index]![0]!); expect(fs.readFileSync(action.receipt)).toEqual(snapshots[index]![1]!); });
  expect(runSetup("all", "undo", f.options).applied).toBe(true);
  for (const action of report.actions) { expect(fs.existsSync(action.file)).toBe(false); expect(fs.existsSync(action.receipt)).toBe(false); }
});

test("JSON replacement/undo preserves unrelated settings, empty parent and a prior null entry", () => {
  for (const prior of [{ command: "prior", args: ["old"], env: { PRIVATE_VALUE: "synthetic" } }, null]) {
    const f = fixture(), file = join(f.home, ".claude.json"), original = { keep: { enabled: true }, mcpServers: { other: { command: "other" }, ares: prior } }; fs.writeFileSync(file, JSON.stringify(original));
    const report = runSetup("claude", "apply", f.options); expect(report.applied).toBe(true); expect(json(file).mcpServers.other).toEqual(original.mcpServers.other);
    const current = json(file); current.keep.later = "user addition"; fs.writeFileSync(file, JSON.stringify(current));
    expect(runSetup("claude", "undo", f.options).applied).toBe(true); expect(json(file)).toEqual({ ...original, keep: { enabled: true, later: "user addition" } });
  }
  const f = fixture(), file = join(f.home, ".claude.json"); fs.writeFileSync(file, '{"mcpServers":{}}'); runSetup("claude", "apply", f.options); runSetup("claude", "undo", f.options); expect(json(file)).toEqual({ mcpServers: {} });
});

test("config directory overrides and workspace-local agy stay inside the fake home", () => {
  const f = fixture(), env = { ...f.env, CLAUDE_CONFIG_DIR: join(f.home, "claude-profile"), CODEX_HOME: join(f.home, "codex-profile"), KIMI_CODE_HOME: join(f.home, "kimi-profile"), PI_CODING_AGENT_DIR: join(f.home, "pi-profile"), QWEN_HOME: join(f.home, "qwen-profile"), JCODE_HOME: join(f.home, "jcode-profile") };
  const all = runSetup("all", "apply", { env, cwd: f.cwd }); expect(all.actions[0]!.file).toBe(join(env.CLAUDE_CONFIG_DIR, ".claude.json"));
  const agy = runSetup("agy", "apply", { env, cwd: f.cwd }); expect(agy.actions[0]!.file).toBe(join(f.cwd, ".agents", "mcp_config.json")); expect(json(agy.actions[0]!.file).mcpServers.ares).toEqual(agy.entry);
});

test("TOML quoted headers, env subtables, comments and unrelated bytes survive apply/undo", () => {
  const f = fixture(), file = join(f.home, ".codex", "config.toml"); fs.mkdirSync(join(f.home, ".codex"));
  const prior = '# owned\r\n["mcp_servers" . \'ares\'] # comment\r\ncommand = "old"\r\nargs = ["old"]\r\n[mcp_servers.ares.env]\r\nSYNTHETIC = "kept"\r\n';
  const unrelated = '# preserve these bytes\r\n[model]\r\nname = "synthetic"\r\n';
  fs.writeFileSync(file, prior + '\r\n' + unrelated);
  const applied = runSetup("codex", "apply", f.options); expect(applied.actions.filter(action => action.change === "refused")).toEqual([]); expect(applied.applied).toBe(true); expect(fs.readFileSync(file, "utf8")).toContain(unrelated);
  expect((Bun.TOML.parse(fs.readFileSync(file, "utf8")) as any).mcp_servers.ares).toEqual(applied.entry);
  expect(runSetup("codex", "undo", f.options).applied).toBe(true);
  const restored = fs.readFileSync(file, "utf8"); expect(restored).toContain(unrelated); expect((Bun.TOML.parse(restored) as any).mcp_servers.ares).toEqual({ command: "old", args: ["old"], env: { SYNTHETIC: "kept" } });
});

test("TOML multiline strings containing fake ares headers remain untouched", () => {
  const f = fixture(), file = join(f.home, ".codex", "config.toml"); fs.mkdirSync(join(f.home, ".codex"));
  const prefix = 'prompt = """\n[mcp_servers.ares]\ncommand = "not an entry"\n"""\n'; fs.writeFileSync(file, prefix);
  expect(runSetup("codex", "apply", f.options).applied).toBe(true); expect(fs.readFileSync(file, "utf8").startsWith(prefix)).toBe(true);
  expect((Bun.TOML.parse(fs.readFileSync(file, "utf8")) as any).prompt).toContain("not an entry");
});

test("inline TOML refusal and malformed/oversized configs leave no receipts or writes", () => {
  for (const content of ['mcp_servers = { ares = { command = "old" } }\n', "not valid TOML ]", "x".repeat(SETUP_CONFIG_BYTES + 1)]) {
    const f = fixture(), file = join(f.home, ".codex", "config.toml"); fs.mkdirSync(join(f.home, ".codex")); fs.writeFileSync(file, content);
    refuse(runSetup("codex", "apply", f.options)); expect(fs.readFileSync(file, "utf8")).toBe(content); expect(fs.existsSync(f.family)).toBe(false);
  }
});

test("changed or removed ares entries refuse undo and retain receipt, while unrelated edits are allowed", () => {
  for (const remove of [false, true]) {
    const f = fixture(), first = runSetup("claude", "apply", f.options), file = first.actions[0]!.file, receipt = first.actions[0]!.receipt;
    const edited = json(file); if (remove) delete edited.mcpServers.ares; else edited.mcpServers.ares.args.push("changed"); fs.writeFileSync(file, JSON.stringify(edited));
    const before = fs.readFileSync(file), saved = fs.readFileSync(receipt); refuse(runSetup("claude", "undo", f.options));
    expect(fs.readFileSync(file)).toEqual(before); expect(fs.readFileSync(receipt)).toEqual(saved);
  }
});

test("release roots pin the requested install and relocation keeps the original undo value", () => {
  const f = fixture(), one = root("1.0.0"), two = root("2.0.0"), file = join(f.home, ".claude.json"), original = { mcpServers: { ares: { command: "original" } } }; fs.writeFileSync(file, JSON.stringify(original));
  expect(runSetup("claude", "apply", { ...f.options, root: one }).entry.args[1]).toBe(join(one, "bin", "ares.js"));
  expect(runSetup("claude", "apply", { ...f.options, root: two }).applied).toBe(true); expect(json(file).mcpServers.ares.args[1]).toBe(join(two, "bin", "ares.js"));
  runSetup("claude", "undo", f.options); expect(json(file)).toEqual(original);
  expect(() => runSetup("claude", "apply", { ...f.options, root: "relative" })).toThrow("absolute");
  expect(() => runSetup("claude", "apply", { ...f.options, env: { ...f.env, CODEX_HOME: "relative" } })).toThrow("absolute");
});

test("config, ancestor and receipt links are refused without touching their targets", () => {
  for (const kind of ["config", "parent", "receipt"]) {
    const f = fixture(), target = join(f.home, "target");
    if (kind === "parent") { fs.mkdirSync(target); fs.symlinkSync(target, join(f.home, ".codex")); refuse(runSetup("codex", "apply", f.options)); expect(fs.readdirSync(target)).toEqual([]); }
    else if (kind === "config") { fs.writeFileSync(target, "{}"); fs.symlinkSync(target, join(f.home, ".claude.json")); refuse(runSetup("claude", "apply", f.options)); expect(fs.readFileSync(target, "utf8")).toBe("{}"); }
    else { const action = runSetup("claude", "dry-run", f.options).actions[0]!; fs.mkdirSync(dirname(action.receipt), { recursive: true }); fs.writeFileSync(target, "{}"); fs.symlinkSync(target, action.receipt); refuse(runSetup("claude", "apply", f.options)); expect(fs.existsSync(action.file)).toBe(false); expect(fs.readFileSync(target, "utf8")).toBe("{}"); }
  }
});

test("ownership is checked on config paths and bounded-reader descriptors", () => {
  const f = fixture(), file = join(f.home, ".claude.json"); fs.writeFileSync(file, "{}");
  expect(() => readTextBounded(file, 100, { noFollow: true, uid: process.getuid!() + 1 })).toThrow("owned by another user");
  const original = fs.lstatSync, uid = process.getuid!();
  const spy = spyOn(fs, "lstatSync").mockImplementation(((value: fs.PathLike, ...rest: unknown[]) => {
    const info = (original as any)(value, ...rest); return String(value) === file ? new Proxy(info, { get: (target, key) => key === "uid" ? uid + 1 : Reflect.get(target, key) }) : info;
  }) as typeof fs.lstatSync);
  try { refuse(runSetup("claude", "apply", f.options)); } finally { spy.mockRestore(); }
  expect(fs.readFileSync(file, "utf8")).toBe("{}"); expect(fs.existsSync(f.family)).toBe(false);
});

test("receipt is durable before config rename and a failed config write rolls it back", () => {
  const f = fixture(), action = runSetup("claude", "dry-run", f.options).actions[0]!, original = fs.renameSync;
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === action.file) { expect(json(action.receipt).installed.args.at(-1)).toBe("mcp"); throw new Error("synthetic config rename failure"); }
    return original(from, to);
  }) as typeof fs.renameSync);
  try { refuse(runSetup("claude", "apply", f.options)); } finally { spy.mockRestore(); }
  expect(fs.existsSync(action.file)).toBe(false); expect(fs.existsSync(action.receipt)).toBe(false);
});

test("CLI preview/apply/undo use only temp HOME and reject incompatible options or unsupported targets", async () => {
  const f = fixture(), location = root();
  const preview = await run(["setup", "claude", "--root", location, "--json"], f.env); expect(preview.code).toBe(0); expect(fs.existsSync(f.family)).toBe(false);
  expect((await run(["setup", "claude", "--root", location, "--apply", "--json"], f.env)).code).toBe(0);
  expect((await run(["setup", "claude", "--undo", "--json"], f.env)).code).toBe(0);
  await expect(run(["setup", "claude", "--apply", "--undo"], f.env)).rejects.toThrow("conflict");
  await expect(run(["setup", "console"], f.env)).rejects.toThrow("console setup is not available");
  await expect(run(["setup", "unknown"], f.env)).rejects.toThrow("unknown target");
});

test("preexisting matching entries are not adopted, and invalid receipts stay untouched", () => {
  const f = fixture(), preview = runSetup("claude", "dry-run", f.options), action = preview.actions[0]!;
  fs.writeFileSync(action.file, JSON.stringify({ mcpServers: { ares: preview.entry } }));
  expect(runSetup("claude", "apply", f.options).actions[0]!.change).toBe("unchanged"); expect(fs.existsSync(action.receipt)).toBe(false);
  expect(runSetup("claude", "undo", f.options).applied).toBe(false); expect(json(action.file).mcpServers.ares).toEqual(preview.entry);
  fs.mkdirSync(dirname(action.receipt), { recursive: true }); fs.writeFileSync(action.receipt, '{"v":2}');
  const before = fs.readFileSync(action.file), saved = fs.readFileSync(action.receipt); refuse(runSetup("claude", "undo", f.options));
  expect(fs.readFileSync(action.file)).toEqual(before); expect(fs.readFileSync(action.receipt)).toEqual(saved);
});

test("a client edit after receipt publication is preserved and the receipt rolled back", () => {
  const f = fixture(), action = runSetup("claude", "dry-run", f.options).actions[0]!, original = fs.renameSync;
  fs.writeFileSync(action.file, '{"keep":"original"}');
  const spy = spyOn(fs, "renameSync").mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
    original(from, to);
    if (String(to) === action.receipt) fs.writeFileSync(action.file, '{"keep":"concurrent client edit"}');
  }) as typeof fs.renameSync);
  try { refuse(runSetup("claude", "apply", f.options)); } finally { spy.mockRestore(); }
  expect(json(action.file)).toEqual({ keep: "concurrent client edit" }); expect(fs.existsSync(action.receipt)).toBe(false);
});

test("a multiline TOML closing line beginning with # belongs to the saved entry, not an outside comment", () => {
  const f = fixture(), file = join(f.home, ".codex", "config.toml"); fs.mkdirSync(join(f.home, ".codex"));
  const content = '[mcp_servers.ares]\ncommand = "old"\n[mcp_servers.ares.env]\nNOTE = """\nhello\n# closing"""\n\n# user comment\n[model]\nname = "synthetic"\n';
  fs.writeFileSync(file, content); const original = Bun.TOML.parse(content);
  expect(runSetup("codex", "apply", f.options).applied).toBe(true);
  expect(fs.readFileSync(file, "utf8")).not.toContain('# closing"""');
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('# closing"""\n', '').replace('# user comment\n', ''));
  expect(runSetup("codex", "undo", f.options).applied).toBe(true); expect(Bun.TOML.parse(fs.readFileSync(file, "utf8"))).toEqual(original);
});

test("argument refusals give the relevant next step and file refusals are not double-suffixed", () => {
  const f = fixture();
  for (const [target, mode, options, expected] of [
    ["console", "dry-run", f.options, "use an agent target"],
    ["unknown", "dry-run", f.options, "use claude|codex"],
    ["claude", "dry-run", { ...f.options, root: "relative" }, "pass --root ABS"],
    ["claude", "invalid", f.options, "choose dry-run, apply or undo"],
  ] as const) {
    try { runSetup(target, mode as "dry-run", options); throw new Error("expected refusal"); }
    catch (error) { const message = (error as Error).message; expect(message).toContain(expected); expect(message).not.toContain("restore its setup receipt"); }
  }
  fs.writeFileSync(join(f.home, ".claude.json"), "not JSON");
  const reason = runSetup("claude", "dry-run", f.options).actions[0]!.reason!;
  expect(reason).toContain("invalid JSON"); expect(reason.match(/restore its setup receipt/g)).toHaveLength(1); expect(reason).not.toContain("correct the file or receipt and retry");
});
