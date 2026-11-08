import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { FORMAT_VERSIONS } from "../src/manifest.ts";
import { readBytesBounded, readTextBounded } from "../src/study.ts";
import { isolatedEnv, verifyStaged, type ReleaseManifest } from "./release.ts";

const OUTPUT_BYTES = 2 * 1024 * 1024, PACKAGE_BYTES = 65_536, ASSET_BYTES = 2 * 1024 * 1024;
type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`clean install smoke: ${message}; inspect the staged package and rebuild it`);
}
function json(text: string, label: string): ObjectValue {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`clean install smoke: invalid ${label} JSON; rebuild the staged package`); }
  requireValue(object(value), `${label} must be an object`); return value;
}
function contained(root: string, file: string): string {
  const actual = realpathSync(file), rel = relative(root, actual);
  requireValue(rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel), "installed path escapes the private prefix");
  return actual;
}
/** All output is bounded before accumulation; diagnostics never echo child output. */
function child(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeout: number, input = ""): Promise<string> {
  return new Promise((accept, reject) => {
    const proc = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let failure: Error | undefined, bytes = 0;
    const output: Buffer[] = [];
    const stop = (message: string) => { failure ??= new Error(`clean install smoke: ${message}; inspect the staged package and retry`); proc.kill("SIGKILL"); };
    const timer = setTimeout(() => stop("child timed out"), timeout);
    proc.stdout.on("data", (part: Buffer) => {
      bytes += part.length; if (bytes > OUTPUT_BYTES) { stop("child output exceeded its bound"); return; } output.push(part);
    });
    proc.stderr.on("data", (part: Buffer) => { bytes += part.length; if (bytes > OUTPUT_BYTES) stop("child output exceeded its bound"); });
    proc.on("error", () => { failure ??= new Error("clean install smoke: child spawn failed; check npm and Bun are on the isolated PATH"); });
    proc.stdin.on("error", () => stop("child stdin failed"));
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error("clean install smoke: child exited nonzero; inspect the staged package and retry"));
      else accept(Buffer.concat(output).toString("utf8"));
    });
    proc.stdin.end(input);
  });
}
export function manifestTools(manifest: ObjectValue, version: string): Map<string, boolean> {
  requireValue(manifest.v === 1 && manifest.name === "ares" && manifest.version === version, "installed manifest identity mismatch");
  requireValue(object(manifest.formats) && manifest.formats.manifest === 1 && isDeepStrictEqual(manifest.formats, FORMAT_VERSIONS), "installed manifest formats mismatch");
  requireValue(object(manifest.mcp) && manifest.mcp.server === "ares" && Array.isArray(manifest.mcp.tools) && manifest.mcp.tools.length > 0, "installed manifest MCP tools missing");
  const tools = new Map<string, boolean>();
  for (const tool of manifest.mcp.tools) {
    requireValue(object(tool) && typeof tool.name === "string" && typeof tool.readOnly === "boolean" && !tools.has(tool.name), "invalid manifest tool");
    tools.set(tool.name, tool.readOnly);
  }
  return tools;
}
function checkMcp(stdout: string, version: string, expected: Map<string, boolean>): void {
  const messages = stdout.split("\n").filter(line => line.trim()).map(line => json(line, "MCP response"));
  requireValue(messages.length === 2 && messages.every(message => message.jsonrpc === "2.0" && !Object.hasOwn(message, "error")), "unexpected MCP response");
  const init = messages.find(message => message.id === 1), listed = messages.find(message => message.id === 2);
  requireValue(init && object(init.result) && object(init.result.serverInfo) && init.result.serverInfo.name === "ares" && init.result.serverInfo.version === version, "MCP server identity mismatch");
  requireValue(listed && object(listed.result) && Array.isArray(listed.result.tools) && listed.result.tools.length > 0, "MCP tool definitions missing");
  const seen = new Set<string>();
  for (const tool of listed.result.tools) {
    requireValue(object(tool) && typeof tool.name === "string" && typeof tool.description === "string" && object(tool.inputSchema) && object(tool.annotations), "invalid MCP tool definition");
    requireValue(!seen.has(tool.name) && expected.has(tool.name), "unexpected or duplicate MCP tool");
    requireValue(typeof tool.annotations.readOnlyHint === "boolean" && typeof tool.annotations.openWorldHint === "boolean", "MCP tool annotations missing");
    requireValue(expected.get(tool.name) === (tool.annotations.readOnlyHint === true && tool.annotations.openWorldHint !== true), "MCP annotations disagree with manifest");
    seen.add(tool.name);
  }
  requireValue(seen.size === expected.size, "MCP tool list differs from manifest");
  for (const name of ["ares_manifest", "ares_watch_set", "ares_watch_run", "ares_watch_show", "ares_console_add", "ares_console_remove", "ares_console_list"]) requireValue(seen.has(name), `required MCP tool ${name} missing`);
}

/** Install and inspect only a verified tarball, with a private home and no mutating ares commands. */
export async function smokeStagedPackage(dir: string, root = process.cwd()): Promise<ReleaseManifest> {
  const metadata = await verifyStaged(dir, root);
  const work = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "ares-release-smoke-")));
  try {
    chmodSync(work, 0o700);
    const prefix = join(work, "prefix"), cwd = join(work, "cwd");
    mkdirSync(prefix, { mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
    const baseEnv = isolatedEnv(work), env = { ...baseEnv, PATH: `${join(prefix, "bin")}${delimiter}${baseEnv.PATH ?? ""}` };
    await child("npm", ["install", "-g", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", prefix, resolve(dir, "package.tgz")], cwd, env, 30_000);
    requireValue(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(metadata.name), "invalid installed package name");
    const privatePrefix = realpathSync(prefix), packageRoot = contained(privatePrefix, join(prefix, "lib", "node_modules", ...metadata.name.split("/")));
    const installed = json(readTextBounded(contained(privatePrefix, join(packageRoot, "package.json")), PACKAGE_BYTES), "package");
    requireValue(installed.name === metadata.name && installed.version === metadata.version, "installed package identity mismatch");
    for (const asset of ["src/ui/panel.js", "src/ui/panel.css", "src/ui/plugin.ts"]) requireValue(readBytesBounded(contained(privatePrefix, join(packageRoot, asset)), ASSET_BYTES).length > 0, `installed ${asset} missing`);
    const executable = join(prefix, "bin", "ares"); contained(privatePrefix, executable);
    requireValue((await child(executable, ["--version"], cwd, env, 10_000)).trim() === metadata.version, "installed CLI version mismatch");
    const tools = manifestTools(json(await child(executable, ["manifest", "--json"], cwd, env, 10_000), "manifest"), metadata.version);
    const input = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ares-release-smoke", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ].map(message => JSON.stringify(message)).join("\n") + "\n";
    checkMcp(await child(executable, ["mcp"], cwd, env, 10_000, input), metadata.version, tools);
    return metadata;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir || process.argv.length !== 3) { console.error("usage: bun scripts/release-smoke.ts DIR"); process.exitCode = 1; }
  else {
    try { await smokeStagedPackage(dir); console.log("clean install smoke: ok"); }
    catch (error) { console.error(error instanceof Error ? error.message : "clean install smoke: failed; rebuild the staged package"); process.exitCode = 1; }
  }
}
