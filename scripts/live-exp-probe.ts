import { posix } from "node:path";
import { runOnExecutor, shellQuote, spawnRunner, validateExecutor, type Executor, type ProcessResult, type ProcessRunner } from "../src/exp/executor.ts";
import { plain } from "../src/study.ts";

const STDERR_BYTES = 2048, SENTINEL = "ares-live-probe-sentinel", PAYLOAD = "ares synthetic traversal payload\n";
export interface SnapshotProbe { exitCode: number; refused: boolean; outsideUnchanged: boolean; stderr: string }

function privateRoot(value: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value === "/" || value.endsWith("/") || posix.normalize(value) !== value || Buffer.byteLength(value) > 3800 || /[\0\r\n,"]/.test(value)) throw new Error("snapshot probe root: invalid; pass a fresh owned private absolute non-root directory without traversal, NUL, newlines, commas or double quotes");
  return value;
}
function failed(executor: Executor, step: string): Error {
  return new Error(`executor ${executor.host ?? "local"}: snapshot probe ${step} failed; check the fresh private test root and host tar, then rerun the live probe`);
}
function regularResult(result: ProcessResult): boolean { return Number.isSafeInteger(result.exitCode) && result.exitCode >= 0 && !result.timedOut; }
function stderrTail(text: string): string {
  const bytes = Buffer.from(text), start = Math.max(0, bytes.length - STDERR_BYTES);
  for (let offset = start; offset <= Math.min(bytes.length, start + 3); offset++) {
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset)); }
    catch { /* skip the partial leading UTF-8 character in a bounded tail */ }
  }
  return "";
}
function header(name: string, type: "0" | "2", size: number, link = ""): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100); block.write("0000700", 100); block.write("0001000", 108); block.write("0001000", 116);
  block.write(size.toString(8).padStart(11, "0"), 124); block.write("00000000000", 136); block.fill(32, 148, 156);
  block.write(type, 156); block.write(link, 157, 100); block.write("ustar", 257); block.write("00", 263);
  block.write(block.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"), 148); block[154] = 0; block[155] = 32;
  return block;
}
/** The link reaches a sibling inside our private probe root, never an arbitrary host path. */
function adversarialArchive(): Buffer {
  const payload = Buffer.from(PAYLOAD);
  return Buffer.concat([header("escape", "2", 0, "../outside"), header("escape/payload", "0", payload.length), payload, Buffer.alloc((512 - payload.length % 512) % 512), Buffer.alloc(1024)]);
}

/** Observe production tar behavior without storing diagnostics or probe content in a study. */
export async function probeSnapshotExtraction(executorArg: Executor, rootArg: string, runner: ProcessRunner = spawnRunner): Promise<SnapshotProbe> {
  const executor = validateExecutor(executorArg), root = privateRoot(rootArg), probe = posix.join(root, "probe");
  const snapshot = posix.join(probe, "snapshot"), outside = posix.join(probe, "outside"), archive = adversarialArchive();
  const prepare = [
    "set -eu", "umask 077", `root=${shellQuote(root)}`,
    'test -d "$root"; test ! -L "$root"; test -O "$root"',
    'test "$(cd -P "$root" && pwd -P)" = "$root"',
    'mode=$(stat -c %a "$root" 2>/dev/null || stat -f %Lp "$root"); test "$mode" = 700',
    `mkdir -m 700 ${shellQuote(probe)}`, `mkdir -m 700 ${shellQuote(snapshot)} ${shellQuote(outside)}`,
    `printf '%s\\n' ${shellQuote(SENTINEL)} > ${shellQuote(posix.join(outside, "sentinel"))}`,
  ].join("\n");
  let prepared: ProcessResult;
  try { prepared = await runOnExecutor(executor, "sh", ["-c", prepare], runner, { maxOutputBytes: STDERR_BYTES, timeoutMs: 30_000 }); }
  catch { throw failed(executor, "prepare"); }
  if (!regularResult(prepared) || prepared.exitCode !== 0 || prepared.truncated) throw failed(executor, "prepare");

  let extracted: ProcessResult;
  try { extracted = await runOnExecutor(executor, "tar", ["--no-same-owner", "-xf", "-", "-C", snapshot], runner, { stdin: archive, maxOutputBytes: STDERR_BYTES, timeoutMs: 30_000 }); }
  catch { throw failed(executor, "extract"); }
  if (!regularResult(extracted)) throw failed(executor, "extract");

  const sentinel = posix.join(outside, "sentinel"), payload = posix.join(outside, "payload");
  const readback = [
    "set -eu", `outside=${shellQuote(outside)}; sentinel=${shellQuote(sentinel)}; payload=${shellQuote(payload)}`, "unchanged=false",
    'if test -d "$outside" && test ! -L "$outside" && test -O "$outside" && test -f "$sentinel" && test ! -L "$sentinel" && test ! -e "$payload" && test ! -L "$payload"; then',
    'mode=$(stat -c %a "$outside" 2>/dev/null || stat -f %Lp "$outside")',
    'bytes=$(stat -c %s "$sentinel" 2>/dev/null || stat -f %z "$sentinel")',
    `if test "$mode" = 700 && test "$bytes" -eq ${Buffer.byteLength(SENTINEL) + 1} && test "$(head -c ${Buffer.byteLength(SENTINEL) + 2} "$sentinel")" = ${shellQuote(SENTINEL)}; then unchanged=true; fi`,
    "fi", 'printf \'{"outsideUnchanged":%s}\\n\' "$unchanged"',
  ].join("\n");
  let checked: ProcessResult;
  try { checked = await runOnExecutor(executor, "sh", ["-c", readback], runner, { maxOutputBytes: STDERR_BYTES, timeoutMs: 30_000 }); }
  catch { throw failed(executor, "readback"); }
  if (!regularResult(checked) || checked.exitCode !== 0 || checked.truncated) throw failed(executor, "readback");
  let value: unknown;
  try { value = JSON.parse(checked.stdout); } catch { throw failed(executor, "readback"); }
  if (!plain(value) || Object.keys(value).length !== 1 || typeof value.outsideUnchanged !== "boolean") throw failed(executor, "readback");
  return { exitCode: extracted.exitCode, refused: extracted.exitCode !== 0, outsideUnchanged: value.outsideUnchanged, stderr: stderrTail(extracted.stderr) };
}
