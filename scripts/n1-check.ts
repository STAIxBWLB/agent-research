// Usage: bun scripts/n1-check.ts [--version X.Y.Z]
// Network job (CI "n1"): resolves N-1 from npm, installs it into a private temp prefix and checks CLI, MCP and
// study/ledger compatibility against this checkout. `bun run check` never runs it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readBytesBounded, readTextBounded, STUDY_BYTES } from "../src/study.ts";
import { compareManifests, resolveN1, studyFormatCheck, type ManifestLike } from "./n1-lib.ts";

const OUTPUT_BYTES = 4 * 1024 * 1024, LEDGER_BYTES = 16 * 1024 * 1024, PACKAGE = "@staix/agent-research";
const root = resolve(import.meta.dir, "..");

/** A child that cannot start: name the command and how to make it available. */
export function spawnFailure(command: string, error: Error): Error {
  const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || /not found/i.test(error.message);
  return new Error(missing
    ? `n1: ${command} could not be started (${error.message}); install ${command} or add it to PATH, then rerun bun scripts/n1-check.ts`
    : `n1: ${command} failed to start (${error.message}); check PATH and permissions for ${command}, then rerun bun scripts/n1-check.ts`);
}
interface Result { code: number; stdout: string; stderr: string }
/** Bounded child process; output beyond the bound kills the child. */
function run(command: string, args: string[], cwd: string, timeout = 120_000): Promise<Result> {
  return new Promise((accept, reject) => {
    let proc: ReturnType<typeof spawn>;
    try { proc = spawn(command, args, { cwd, env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(spawnFailure(command, error instanceof Error ? error : new Error(String(error)))); return; }
    const out: Buffer[] = [], err: Buffer[] = [];
    let bytes = 0, failure: Error | undefined;
    const take = (sink: Buffer[]) => (chunk: Buffer) => { bytes += chunk.length; if (bytes > OUTPUT_BYTES) { failure ??= new Error(`n1: ${command} output exceeded ${OUTPUT_BYTES} bytes; the child printed far more than a manifest or study command should, check that ${command} is the expected tool and rerun bun scripts/n1-check.ts`); proc.kill("SIGKILL"); } else sink.push(chunk); };
    proc.stdout!.on("data", take(out)); proc.stderr!.on("data", take(err));
    const timer = setTimeout(() => { failure ??= new Error(`n1: ${command} timed out after ${timeout} ms; check npm registry access or a hung child and rerun bun scripts/n1-check.ts`); proc.kill("SIGKILL"); }, timeout);
    proc.on("error", error => { clearTimeout(timer); reject(spawnFailure(command, error)); });
    proc.on("close", code => { clearTimeout(timer); if (failure) reject(failure); else accept({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") }); });
  });
}
const NETWORK = "check npm registry access and rerun bun scripts/n1-check.ts";
/** Next steps per child: only npm points at the registry; local N-1 and checkout commands name their own fix. */
export const STEPS = {
  npm: NETWORK,
  n1: "the installed N-1 package failed; check the install and rerun bun scripts/n1-check.ts",
  checkout: "fix the checkout command so it reads N-1 studies (or writes v2) and rerun bun scripts/n1-check.ts",
} as const;
export function json<T>(result: Result, what: string, step: string): T {
  if (result.code !== 0) throw new Error(`n1: ${what} exited ${result.code}: ${result.stderr.trim().slice(0, 500)}; ${step}`);
  try { return JSON.parse(result.stdout) as T; } catch { throw new Error(`n1: ${what} printed invalid JSON; ${step}`); }
}
const fail = (message: string): never => { throw new Error(`n1: ${message}`); };
/** Only `--version X.Y.Z` is accepted; anything else is refused. */
export { run };
export function parseArgs(args: readonly string[]): { version?: string } {
  if (args.length === 0) return {};
  if (args.length === 2 && args[0] === "--version" && /^\d+\.\d+\.\d+$/.test(args[1]!)) return { version: args[1]! };
  return fail("usage: bun scripts/n1-check.ts [--version X.Y.Z]; remove unknown arguments and pass --version with a stable version");
}

async function main(): Promise<void> {
  const pinned = parseArgs(process.argv.slice(2)).version;
  const current = (JSON.parse(readTextBounded(join(root, "package.json"), 65_536)) as { version: string }).version;
  let n1: string;
  if (pinned !== undefined) n1 = pinned;
  else {
    const published = json<unknown>(await run("npm", ["view", PACKAGE, "versions", "--json"], root), "npm view", STEPS.npm);
    if (!Array.isArray(published) || !published.every(v => typeof v === "string")) fail(`npm view ${PACKAGE} versions did not return a list of version strings; ${NETWORK}`);
    const resolved = resolveN1(current, published as string[]);
    if (resolved === undefined) {
      const core = /^(\d+)\.(\d+)/.exec(current)!;
      console.log(`n1: skipped; no published previous minor line below ${core[1]}.${core[2]}`);
      return;
    }
    n1 = resolved;
  }
  console.log(`n1: checkout ${current}, N-1 ${PACKAGE}@${n1}`);

  const work = mkdtempSync(join(tmpdir(), "ares-n1-"));
  try {
    const prefix = join(work, "prefix");
    const installed = await run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", `${PACKAGE}@${n1}`], work, 300_000);
    if (installed.code !== 0) fail(`npm install ${PACKAGE}@${n1} failed: ${installed.stderr.trim().slice(0, 500)}; ${NETWORK}`);
    const old = (...args: string[]) => run("bun", [join(prefix, "node_modules", PACKAGE, "bin", "ares.js"), ...args], work);
    const next = (...args: string[]) => run("bun", [join(root, "bin", "ares.js"), ...args], work);

    // CLI and MCP surface.
    const oldManifest = json<ManifestLike & { version: string; formats?: { study?: unknown } }>(await old("manifest", "--json"), "N-1 manifest", STEPS.n1);
    if (oldManifest.version !== n1) fail(`installed manifest reports ${oldManifest.version}, expected ${n1}; clear the npm cache, ${NETWORK}`);
    const nextManifest = json<ManifestLike & { formats?: { study?: unknown } }>(await next("manifest", "--json"), "checkout manifest", STEPS.checkout);
    const breaks = compareManifests(oldManifest, nextManifest);
    for (const line of breaks) console.error(line);
    if (breaks.length) fail(`${breaks.length} CLI/MCP break(s) against ${n1}; restore each listed N-1 command, usage or tool (readOnly included) and rerun bun scripts/n1-check.ts`);
    console.log(`n1: CLI ${oldManifest.commands.length} commands and MCP ${oldManifest.mcp.tools.length} tools kept`);

    // Formats: an N-1-written study and ledger are read by the checkout without rewriting bytes.
    for (const mode of ["survey", "experiment"]) {
      const study = join(work, `n1-${mode}`);
      json(await old("init", study, "--question", "synthetic n1 study", "--mode", mode, "--json"), `N-1 init ${mode}`, STEPS.n1);
      const before = { study: readBytesBounded(join(study, "study.json"), STUDY_BYTES), ledger: readBytesBounded(join(study, "ledger.jsonl"), LEDGER_BYTES) };
      const reads = [["status", study, "--json"], ["gate", "list", study, "--json"], ["autonomy", "show", study, "--json"], ...(mode === "experiment" ? [["attempt", "list", study, "--json"]] : [["lit", "list", study, "--json"]])];
      for (const args of reads) json(await next(...args), `checkout ${args.slice(0, 2).join(" ")} on N-1 ${mode} study`, STEPS.checkout);
      if (!before.study.equals(readBytesBounded(join(study, "study.json"), STUDY_BYTES)) || !before.ledger.equals(readBytesBounded(join(study, "ledger.jsonl"), LEDGER_BYTES))) fail(`checkout rewrote an N-1 ${mode} study or ledger during reads; status, gate list, autonomy show and lit/attempt list must stay read-only on N-1 studies, fix the reader and rerun bun scripts/n1-check.ts`);
    }
    console.log("n1: checkout reads N-1 survey and experiment studies and ledgers without rewriting bytes");

    // Formats: a checkout-written study at its newest version. N-1 refuses it unchanged when it lacks that version, else reads it unchanged.
    const format = studyFormatCheck(oldManifest, nextManifest), latest = join(work, "checkout-latest");
    json(await next("init", latest, "--question", "synthetic latest study", "--autonomy", "copilot", "--json"), "checkout init latest study", STEPS.checkout);
    const latestBytes = readBytesBounded(join(latest, "study.json"), STUDY_BYTES);
    if ((JSON.parse(latestBytes.toString("utf8")) as { v: unknown }).v !== format.version) fail(`checkout init --autonomy copilot did not write study v${format.version}; copilot policy must write the newest study format the manifest advertises, fix init or src/manifest.ts and rerun bun scripts/n1-check.ts`);
    const read = await old("status", latest, "--json");
    if (format.expect === "refuse") {
      if (read.code === 0 || !/unsupported schema version/.test(read.stderr + read.stdout)) fail(`N-1 did not refuse a study v${format.version} it does not support with its unsupported-version error (exit ${read.code}); N-1 must keep refusing it, so check that the checkout writes the advertised study version and rerun bun scripts/n1-check.ts`);
    } else if (read.code !== 0) fail(`N-1 advertises study v${format.version} but failed to read a checkout study (exit ${read.code}); the checkout must write studies N-1 can read, fix the study writer and rerun bun scripts/n1-check.ts`);
    if (!latestBytes.equals(readBytesBounded(join(latest, "study.json"), STUDY_BYTES))) fail(`N-1 changed study v${format.version} bytes while ${format.expect === "refuse" ? "refusing" : "reading"}; N-1 status must stay read-only, so investigate the N-1 reader and rerun bun scripts/n1-check.ts`);
    console.log(format.expect === "refuse" ? `n1: N-1 refuses checkout study v${format.version} with its unsupported-version error, bytes unchanged` : `n1: N-1 reads checkout study v${format.version} without rewriting bytes`);
    console.log("n1: ok");
  } finally { rmSync(work, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try { await main(); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
