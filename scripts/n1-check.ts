// Usage: bun scripts/n1-check.ts [--version X.Y.Z]
// Network job (CI "n1"): resolves N-1 from npm, installs it into a private temp prefix and checks CLI, MCP and
// study/ledger compatibility against this checkout. `bun run check` never runs it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readBytesBounded, readTextBounded, STUDY_BYTES } from "../src/study.ts";
import { compareManifests, resolveN1, type ManifestLike } from "./n1-lib.ts";

const OUTPUT_BYTES = 4 * 1024 * 1024, LEDGER_BYTES = 16 * 1024 * 1024, PACKAGE = "@staix/agent-research";
const root = resolve(import.meta.dir, "..");

interface Result { code: number; stdout: string; stderr: string }
/** Bounded child process; output beyond the bound kills the child. */
function run(command: string, args: string[], cwd: string, timeout = 120_000): Promise<Result> {
  return new Promise((accept, reject) => {
    const proc = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const take = (sink: Buffer[]) => (chunk: Buffer) => { bytes += chunk.length; if (bytes > OUTPUT_BYTES) { failure ??= new Error(`n1: ${command} output exceeded ${OUTPUT_BYTES} bytes`); proc.kill("SIGKILL"); } else sink.push(chunk); };
    proc.stdout.on("data", take(out)); proc.stderr.on("data", take(err));
    const timer = setTimeout(() => { failure ??= new Error(`n1: ${command} timed out`); proc.kill("SIGKILL"); }, timeout);
    proc.on("error", error => { clearTimeout(timer); reject(error); });
    proc.on("close", code => { clearTimeout(timer); if (failure) reject(failure); else accept({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
  });
}
function json<T>(result: Result, what: string): T {
  if (result.code !== 0) throw new Error(`n1: ${what} exited ${result.code}: ${result.stderr.trim().slice(0, 500)}`);
  try { return JSON.parse(result.stdout) as T; } catch { throw new Error(`n1: ${what} printed invalid JSON`); }
}
const fail = (message: string): never => { throw new Error(`n1: ${message}`); };

async function main(): Promise<void> {
  const pinned = process.argv.indexOf("--version");
  const current = (JSON.parse(readTextBounded(join(root, "package.json"), 65_536)) as { version: string }).version;
  let n1: string;
  if (pinned > 0) n1 = process.argv[pinned + 1] ?? fail("--version needs a value");
  else n1 = resolveN1(current, json<string[]>(await run("npm", ["view", PACKAGE, "versions", "--json"], root), "npm view"));
  console.log(`n1: checkout ${current}, N-1 ${PACKAGE}@${n1}`);

  const work = mkdtempSync(join(tmpdir(), "ares-n1-"));
  try {
    const prefix = join(work, "prefix");
    const installed = await run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", `${PACKAGE}@${n1}`], work, 300_000);
    if (installed.code !== 0) fail(`npm install ${PACKAGE}@${n1} failed: ${installed.stderr.trim().slice(0, 500)}`);
    const old = (...args: string[]) => run("bun", [join(prefix, "node_modules", PACKAGE, "bin", "ares.js"), ...args], work);
    const next = (...args: string[]) => run("bun", [join(root, "bin", "ares.js"), ...args], work);

    // CLI and MCP surface.
    const oldManifest = json<ManifestLike & { version: string }>(await old("manifest", "--json"), "N-1 manifest");
    if (oldManifest.version !== n1) fail(`installed manifest reports ${oldManifest.version}, expected ${n1}`);
    const breaks = compareManifests(oldManifest, json<ManifestLike>(await next("manifest", "--json"), "checkout manifest"));
    for (const line of breaks) console.error(line);
    if (breaks.length) fail(`${breaks.length} CLI/MCP break(s) against ${n1}`);
    console.log(`n1: CLI ${oldManifest.commands.length} commands and MCP ${oldManifest.mcp.tools.length} tools kept`);

    // Formats: an N-1-written study and ledger are read by the checkout without rewriting bytes.
    for (const mode of ["survey", "experiment"]) {
      const study = join(work, `n1-${mode}`);
      json(await old("init", study, "--question", "synthetic n1 study", "--mode", mode, "--json"), `N-1 init ${mode}`);
      const before = { study: readBytesBounded(join(study, "study.json"), STUDY_BYTES), ledger: readBytesBounded(join(study, "ledger.jsonl"), LEDGER_BYTES) };
      const reads = [["status", study, "--json"], ["gate", "list", study, "--json"], ["autonomy", "show", study, "--json"], ...(mode === "experiment" ? [["attempt", "list", study, "--json"]] : [["lit", "list", study, "--json"]])];
      for (const args of reads) json(await next(...args), `checkout ${args.slice(0, 2).join(" ")} on N-1 ${mode} study`);
      if (!before.study.equals(readBytesBounded(join(study, "study.json"), STUDY_BYTES)) || !before.ledger.equals(readBytesBounded(join(study, "ledger.jsonl"), LEDGER_BYTES))) fail(`checkout rewrote an N-1 ${mode} study or ledger during reads`);
    }
    console.log("n1: checkout reads N-1 survey and experiment studies and ledgers without rewriting bytes");

    // Formats: N-1 refuses a checkout-written v2 study with its unsupported-version error, bytes unchanged.
    const v2 = join(work, "checkout-v2");
    json(await next("init", v2, "--question", "synthetic v2 study", "--autonomy", "copilot", "--json"), "checkout init v2");
    const v2Bytes = readBytesBounded(join(v2, "study.json"), STUDY_BYTES);
    if ((JSON.parse(v2Bytes.toString("utf8")) as { v: unknown }).v !== 2) fail("checkout init --autonomy copilot did not write study v2");
    const refused = await old("status", v2, "--json");
    if (refused.code === 0 || !/unsupported schema version/.test(refused.stderr + refused.stdout)) fail(`N-1 did not refuse a v2 study with its unsupported-version error (exit ${refused.code})`);
    if (!v2Bytes.equals(readBytesBounded(join(v2, "study.json"), STUDY_BYTES))) fail("N-1 changed v2 study bytes while refusing");
    console.log("n1: N-1 refuses checkout study v2 with its unsupported-version error, bytes unchanged");
    console.log("n1: ok");
  } finally { rmSync(work, { recursive: true, force: true }); }
}

try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
