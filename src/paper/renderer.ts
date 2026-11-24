import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { openStudy, plain, readTextBounded, writeAtomic, type Actor } from "../study.ts";
import { spawnRunner, type ProcessRunner } from "../exp/executor.ts";
import { readCurrentBuild } from "./build.ts";
import { recordPaperRender, RENDER_RECEIPT_BYTES, validateRenderReceipt } from "./render.ts";

/**
 * Machine-local renderer for the `paper.render` plan step (#163). The command lives under the user's family home,
 * keyed by study id, and is never read from plan.json or any committed study file: a committed plan must not choose
 * a command the controller runs.
 */
export const RENDERER_CONFIG_VERSION = 1, RENDERER_CONFIG_BYTES = 64 * 1024, RENDERER_ARGS = 64, RENDERER_ARG_BYTES = 4096;
export const RENDERER_TIMEOUT_DEFAULT_S = 600, RENDERER_TIMEOUT_MAX_S = 86_400;
/** Placeholders a template may use: the study directory and a fresh output directory outside the manuscript sources. */
export const RENDERER_PLACEHOLDERS = ["{study}", "{out}"] as const;
export interface RendererConfig { v: 1; studyId: string; command: string[]; timeoutS: number }
const SET_HINT = "ares renderer set <dir> --command '[\"tool\",\"arg\",\"{study}\",\"{out}\"]'";

function fail(message: string): never { throw new Error(`renderer: ${message}`); }
function configPath(home: string, studyId: string) {
  if (!isAbsolute(home) || home.includes("\0")) fail("family home must be an absolute path; correct AGENTHUB_HOME or HOME");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(studyId)) fail("study id is not a plain token; restore study.json");
  const base = resolve(home), dir = join(base, "research", "renderers");
  return { base, dir, file: join(dir, `${studyId}.json`) };
}
/** The mutable home paths must be this user's real directories and file, never links. */
function guard(home: string, file: string): void {
  const uid = process.getuid!(), { base } = configPath(home, "x");
  for (let current = file; ; current = dirname(current)) {
    let info;
    try { info = lstatSync(current); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { if (current === dirname(current)) break; continue; } throw error; }
    if (info.isSymbolicLink()) fail("links are refused in renderer configuration paths; restore a real directory under the family home");
    if (current === file ? !info.isFile() : !info.isDirectory()) fail("renderer configuration path has the wrong file type; restore it under the family home");
    if (info.uid !== uid && (current.startsWith(base) || info.uid !== 0)) fail("renderer configuration path is owned by another user");
    if (current === dirname(current) || current === base) break;
  }
}
export function validateRendererConfig(raw: unknown, studyId: string): RendererConfig {
  if (!plain(raw)) fail("configuration must be an object");
  const extra = Object.keys(raw).find(key => !["v", "studyId", "command", "timeoutS"].includes(key));
  if (extra !== undefined) fail(`unknown field ${JSON.stringify(extra).slice(0, 40)}; use v, command and timeoutS`);
  if (raw.v !== RENDERER_CONFIG_VERSION) fail("unsupported configuration version; keep the file unchanged and use a compatible ares version");
  if (raw.studyId !== undefined && raw.studyId !== studyId) fail("configuration belongs to another study; run ares renderer set for this study");
  if (!Array.isArray(raw.command) || raw.command.length < 1 || raw.command.length > RENDERER_ARGS) fail(`command must be a JSON array of 1..${RENDERER_ARGS} arguments; run ${SET_HINT}`);
  const command = raw.command.map((arg: unknown, index: number) => {
    if (typeof arg !== "string" || !arg || arg.includes("\0") || Buffer.byteLength(arg) > RENDERER_ARG_BYTES) fail(`command[${index}] must be a nonempty string of at most ${RENDERER_ARG_BYTES} bytes without NUL`);
    return arg;
  });
  if (RENDERER_PLACEHOLDERS.some(placeholder => command[0]!.includes(placeholder))) fail("command[0] is the program and cannot contain a placeholder");
  const timeoutS = raw.timeoutS ?? RENDERER_TIMEOUT_DEFAULT_S;
  if (typeof timeoutS !== "number" || !Number.isSafeInteger(timeoutS) || timeoutS < 1 || timeoutS > RENDERER_TIMEOUT_MAX_S) fail(`timeoutS must be an integer from 1 to ${RENDERER_TIMEOUT_MAX_S}`);
  return { v: 1, studyId, command, timeoutS };
}
export function readRenderer(home: string, dirArg: string): RendererConfig | undefined {
  const { study } = openStudy(dirArg), { file } = configPath(home, study.id);
  guard(home, file);
  if (!existsSync(file)) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(readTextBounded(file, RENDERER_CONFIG_BYTES, { noFollow: true, uid: process.getuid!() })); }
  catch { fail(`configuration is unreadable, invalid JSON or larger than ${RENDERER_CONFIG_BYTES} bytes; run ${SET_HINT} again`); }
  return validateRendererConfig(raw, study.id);
}
/** Writes only the machine-local file under the family home; the study and its ledger are unchanged. */
export function setRenderer(home: string, dirArg: string, raw: { command: unknown; timeoutS?: unknown }) {
  const { study } = openStudy(dirArg), config = validateRendererConfig({ v: 1, ...raw }, study.id), { dir, file } = configPath(home, study.id);
  guard(home, file);
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); guard(home, file);
  const text = JSON.stringify(config, null, 2) + "\n";
  writeAtomic(file, text, RENDERER_CONFIG_BYTES, 0o600);
  return { ...config, path: file };
}
export function showRenderer(home: string, dirArg: string) {
  const config = readRenderer(home, dirArg);
  return config ? { configured: true, command: config.command, timeoutS: config.timeoutS } : { configured: false, reason: `no renderer configured on this machine; run ${SET_HINT}` };
}
function onPath(program: string, env: NodeJS.ProcessEnv): boolean {
  if (program.includes("/")) { try { return lstatSync(resolve(program)).isFile(); } catch { return false; } }
  return (env.PATH ?? "").split(delimiter).filter(Boolean).some(dir => { try { return lstatSync(join(dir, program)).isFile(); } catch { return false; } });
}
/** Read-only; runs nothing. */
export function checkRenderer(home: string, dirArg: string, env: NodeJS.ProcessEnv) {
  const checks: { name: string; state: "ok" | "failed" | "skipped"; detail: string }[] = [];
  let config: RendererConfig | undefined;
  try {
    config = readRenderer(home, dirArg);
    checks.push(config ? { name: "Renderer configuration", state: "ok", detail: `${config.command.length} arguments, ${config.timeoutS} s timeout` } : { name: "Renderer configuration", state: "failed", detail: `Configure the renderer with ${SET_HINT}` });
  } catch (error) { checks.push({ name: "Renderer configuration", state: "failed", detail: error instanceof Error ? error.message : "unreadable" }); }
  if (config) checks.push(onPath(config.command[0]!, env) ? { name: "Renderer program", state: "ok", detail: config.command[0]! } : { name: "Renderer program", state: "failed", detail: `${config.command[0]} was not found on PATH` });
  else checks.push({ name: "Renderer program", state: "skipped", detail: "Renderer unconfigured" });
  if (existsSync(join(openStudy(dirArg).dir, "renderer.json"))) checks.push({ name: "Committed renderer", state: "failed", detail: "renderer.json in the study is refused; remove it and use ares renderer set" });
  return { ok: checks.every(row => row.state === "ok"), checks };
}

export interface RenderStepOptions { home: string; actor: Actor; runner?: ProcessRunner; env?: NodeJS.ProcessEnv }
/**
 * The `paper.render` step: requires a current build, runs the machine-local renderer with a bounded wall time and
 * records its receipt through the render-record path. Every failure throws before a study write; the temporary output
 * directory is outside the study and is always removed.
 */
export async function runRenderStep(dirArg: string, options: RenderStepOptions, record: (file: string, receipt: string) => Promise<ReturnType<typeof recordPaperRender>>) {
  const { dir } = openStudy(dirArg);
  if (existsSync(join(dir, "renderer.json"))) fail("a committed renderer.json in the study is refused; remove it and configure the renderer with ares renderer set");
  const build = readCurrentBuild(dir), config = readRenderer(options.home, dir);
  if (!config) fail(`no renderer configured on this machine; run ${SET_HINT}`);
  const out = mkdtempSync(join(tmpdir(), "ares-render-"));
  try {
    const args = config.command.slice(1).map(arg => arg.replaceAll("{study}", dir).replaceAll("{out}", out));
    let result;
    try { result = await (options.runner ?? spawnRunner)({ command: config.command[0]!, args, cwd: dir, timeoutMs: config.timeoutS * 1000, ...(options.env ? { env: options.env } : {}) }); }
    catch { fail(`${config.command[0]} could not be started; run ares renderer check`); }
    if (result.timedOut) fail(`timed out after ${config.timeoutS} s; nothing was recorded; raise --timeout-s or fix the renderer`);
    if (result.exitCode !== 0) fail(`exited with status ${result.exitCode}; nothing was recorded; run the renderer by hand to see its output`);
    const receipt = join(out, "receipt.json");
    let parsed;
    try { parsed = validateRenderReceipt(JSON.parse(readTextBounded(receipt, RENDER_RECEIPT_BYTES, { noFollow: true }))); }
    catch (error) { fail(`receipt missing or invalid in the output directory (${error instanceof Error ? error.message.slice(0, 200) : "unreadable"}); nothing was recorded`); }
    if (parsed.evidenceSha256 !== build.evidenceSha256 || parsed.manuscriptSha256 !== build.manuscriptSha256) fail("receipt does not match the current build; nothing was recorded; rebuild and rerun the step");
    const output = parsed.outputs[0]!;
    const recorded = await record(join(out, output.name), receipt);
    return { sha256: recorded.outputSha256, evidenceSha256: recorded.evidenceSha256, changed: recorded.changed };
  } finally { rmSync(out, { recursive: true, force: true }); }
}
