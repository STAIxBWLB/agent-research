import type {SourceBudget} from "./source-budget.ts";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {isAbsolute} from "node:path";
import {PROCESS_CONTEXT_ENV_KEYS, type ProcessRunner, type ProcessRequest, type ProcessResult} from "../exp/executor.ts";
import {plain, sha256} from "../study.ts";
import {canonical} from "../plan/state.ts";

export const AMEM_SHOW_MS = 25_000, AMEM_SHOW_BYTES = 262_144;
export interface ScreenedAmemInspection {
  state: "available" | "changed" | "unavailable" | "unsupported";
  digest: string | null;
  observedAt: string;
  sourceVersion?: string;
  kind?: "decision" | "finding" | "contract" | "fail" | "other";
}
const ENV = ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE", ...PROCESS_CONTEXT_ENV_KEYS];
/** Unlike spawnRunner, this transport passes exactly the screened environment and retains no diagnostics. */
interface ScreenedProcessResult extends ProcessResult {screenedOutputBytes: number}
const exactRunner = (request: ProcessRequest): Promise<ScreenedProcessResult> => new Promise((accept, reject) => {
  const child = spawn(request.command, request.args, {cwd: request.cwd, env: request.env ?? {}, detached: true, stdio: ["pipe", "pipe", "pipe"]});
  let bytes = 0, truncated = false, closed = false;
  const kill = () => {
    if (closed) return;
    if (child.pid !== undefined) {try {process.kill(-child.pid, "SIGKILL"); return;} catch { /* fall back only to this owned child */ }}
    child.kill("SIGKILL");
  };
  request.signal?.addEventListener("abort", kill, {once: true});
  if (request.signal?.aborted) kill();
  child.stdin.on("error", () => {});
  const count = (chunk: Buffer) => {bytes += chunk.length; if (bytes > (request.maxOutputBytes ?? AMEM_SHOW_BYTES)) {truncated = true; kill(); return false;} return true;};
  child.stdout.on("data", (chunk: Buffer) => {
    if (!count(chunk)) return;
    try {void Promise.resolve(request.stdoutSink?.(chunk)).catch(kill);} catch {kill();}
  });
  child.stderr.on("data", (chunk: Buffer) => {count(chunk);});
  child.on("exit", kill);
  child.on("error", reject);
  child.on("close", code => {closed = true; request.signal?.removeEventListener("abort", kill); accept({screenedOutputBytes: bytes, exitCode: code ?? 1, stdout: "", stderr: "", ...(truncated ? {truncated: true} : {})});});
  void (async () => {
    try {
      if (request.stdin && Symbol.asyncIterator in request.stdin) for await (const chunk of request.stdin) {if (!child.stdin.write(chunk)) await once(child.stdin, "drain");}
      else if (request.stdin) child.stdin.write(request.stdin);
      child.stdin.end();
    } catch {kill();}
  })();
});
function queue() {
  const chunks: Uint8Array[] = []; let closed = false, wake: (() => void) | undefined;
  return {
    push(value: unknown) {chunks.push(Buffer.from(JSON.stringify(value) + "\n")); wake?.(); wake = undefined;},
    close() {closed = true; wake?.(); wake = undefined;},
    async *stream() {for (;;) {if (chunks.length) yield chunks.shift()!; else if (closed) return; else await new Promise<void>(resolve => {wake = resolve;});}},
  };
}
export function supportsScreenedAmem(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  return [major, minor, patch].every(Number.isSafeInteger) && (major! > 0 || minor! > 22 || minor === 22 && (patch! > 1 || patch === 1 && !match[4]));
}
function showAdvertised(value: unknown): boolean {
  if (!plain(value) || !Array.isArray(value.tools) || value.tools.length > 256 || value.nextCursor != null) return false;
  const matches = value.tools.filter(tool => plain(tool) && tool.name === "amem_show");
  if (matches.length !== 1) return false;
  const schema = matches[0]!.inputSchema;
  if (!plain(schema) || schema.type !== "object" || !plain(schema.properties) || Object.keys(schema.properties).length !== 1 || !plain(schema.properties.id) || schema.properties.id.type !== "string" || !Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== "id" || schema.additionalProperties !== false) return false;
  const id = schema.properties.id;
  return (id.minLength === undefined || Number.isSafeInteger(id.minLength) && Number(id.minLength) >= 0 && Number(id.minLength) <= 32) && (id.maxLength === undefined || Number.isSafeInteger(id.maxLength) && Number(id.maxLength) >= 32);
}
/** Source contract: agent-mem 0.22.1 src/mcp.ts:14 and src/mcp-memory.ts:55,103ff,244ff: startup-scoped, screened curated amem_show. */
export async function readScreenedAmem(cwd: string, id: string, options: {runner?: ProcessRunner; env?: NodeJS.ProcessEnv; now?: () => number; timeoutMs?: number; maxOutputBytes?: number; budget?: SourceBudget} = {}): Promise<ScreenedAmemInspection> {
  const now = options.now ?? Date.now;
  const observedAt = () => {const value = now(); return Number.isFinite(value) && Math.abs(value) <= 8.64e15 ? new Date(value).toISOString() : new Date().toISOString();};
  let version: string | undefined, responseObservedAt: string | undefined;
  const result = (state: ScreenedAmemInspection["state"], digest: string | null = null): ScreenedAmemInspection => ({state, digest, observedAt: responseObservedAt ?? observedAt(), ...(version ? {sourceVersion: version} : {})});
  const timeoutMs = Math.min(options.timeoutMs ?? AMEM_SHOW_MS, options.budget?.remainingMs() ?? AMEM_SHOW_MS), maxOutputBytes = Math.min(options.maxOutputBytes ?? AMEM_SHOW_BYTES, options.budget?.remainingBytes ?? AMEM_SHOW_BYTES);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > AMEM_SHOW_MS || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0 || maxOutputBytes > AMEM_SHOW_BYTES) return result("unavailable");
  if (id.length !== 32 || !/^[a-f0-9]{32}$/.test(id) || !isAbsolute(cwd)) return result("unsupported");
  const started = now(), input = queue(), stop = new AbortController(), pending = new Map<number, {resolve: (value: unknown) => void; reject: () => void}>();
  let bytes = 0, buffer = "", broken = false, ended = false, accounted = false;
  const refuse = () => {broken = true; for (const item of pending.values()) item.reject(); pending.clear(); stop.abort(); input.close();};
  let deadline!: () => void;
  const expired = new Promise<never>((_resolve, reject) => {deadline = () => {refuse(); reject(new Error("amem unavailable"));};});
  void expired.catch(() => {});
  const timer = setTimeout(deadline, timeoutMs), decoder = new TextDecoder("utf-8", {fatal: true});
  const env = options.env ?? process.env, context = Object.fromEntries(ENV.flatMap(key => env[key] === undefined ? [] : [[key, env[key]!]]));
  const child = Promise.resolve().then(() => (options.runner ?? exactRunner)({command: "amem", args: ["mcp"], cwd, env: context, stdin: input.stream(), signal: stop.signal, timeoutMs, maxOutputBytes,
    stdoutSink(chunk) {
      try {
        bytes += chunk.byteLength; if (bytes > maxOutputBytes) throw new Error();
        buffer += decoder.decode(chunk, {stream: true});
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
          const message: unknown = JSON.parse(line);
          if (!plain(message) || message.jsonrpc !== "2.0") throw new Error();
          if (!Object.hasOwn(message, "id") && typeof message.method === "string") continue;
          const waiter = pending.get(message.id as number); if (!waiter || message.error !== undefined || !Object.hasOwn(message, "result")) throw new Error();
          if (message.id === 3) responseObservedAt = observedAt();
          pending.delete(message.id as number); waiter.resolve(message.result);
        }
      } catch {refuse();}
    },
  })).then(value => {
    ended = true;
    const observedBytes = options.runner === undefined && "screenedOutputBytes" in value ? Number(value.screenedOutputBytes) : bytes + Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr);
    accounted = true;
    const withinBudget = options.budget?.consume(observedBytes) ?? true;
    if (!withinBudget || observedBytes > maxOutputBytes || value.exitCode !== 0 || value.timedOut || value.truncated || bytes + Buffer.byteLength(value.stdout) + Buffer.byteLength(value.stderr) > maxOutputBytes || buffer.length || decoder.decode().length || pending.size) {refuse(); throw new Error("amem unavailable");}
  }, () => {ended = true; refuse(); throw new Error("amem unavailable");});
  void child.catch(() => {});
  const call = async (requestId: number, method: string, params: unknown) => {
    if (broken || ended || now() - started >= timeoutMs) throw new Error("amem unavailable");
    const response = new Promise<unknown>((resolve, reject) => pending.set(requestId, {resolve, reject: () => reject(new Error("amem unavailable"))}));
    input.push({jsonrpc: "2.0", id: requestId, method, params});
    return Promise.race([response, expired, child.then(() => {throw new Error("amem unavailable");})]);
  };
  try {
    const initialized = await call(1, "initialize", {protocolVersion: "2025-03-26", capabilities: {}, clientInfo: {name: "ares-evidence-reader", version: "1"}});
    const info = plain(initialized) && plain(initialized.serverInfo) ? initialized.serverInfo : undefined;
    if (!info || info.name !== "amem" || !supportsScreenedAmem(info.version)) {input.close(); await Promise.race([child, expired]); return result("unsupported");}
    version = info.version;
    input.push({jsonrpc: "2.0", method: "notifications/initialized"});
    if (!showAdvertised(await call(2, "tools/list", {}))) {input.close(); await Promise.race([child, expired]); return result("unsupported");}
    const response = await call(3, "tools/call", {name: "amem_show", arguments: {id}});
    input.close(); await Promise.race([child, expired]);
    if (broken || !plain(response) || response.isError === true || !Array.isArray(response.content) || response.content.length !== 1 || !plain(response.content[0]) || response.content[0].type !== "text" || typeof response.content[0].text !== "string") return result("unavailable");
    let view: unknown; try {view = JSON.parse(response.content[0].text);} catch {return result("unavailable");}
    if (!plain(view) || view.id !== id || typeof view.text !== "string" || typeof view.at !== "string" || !Number.isFinite(Date.parse(view.at)) || typeof view.project !== "string" || !["decision", "finding", "contract", "fail"].includes(String(view.kind)) || Object.hasOwn(view, "view") || Object.hasOwn(view, "capture") || view.evidence === false || view.stale !== undefined && typeof view.stale !== "boolean") return result("unavailable");
    return {...result(view.stale === true ? "changed" : "available", sha256(canonical(view))), kind: view.kind as NonNullable<ScreenedAmemInspection["kind"]>};
  } catch {return result("unavailable");}
  finally {clearTimeout(timer); input.close(); stop.abort(); if (!accounted) options.budget?.exhaust();}
}
