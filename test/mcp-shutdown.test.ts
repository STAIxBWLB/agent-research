import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ops from "../src/commands.ts";
import { readLedger, withLock } from "../src/study.ts";
import { deferred, fakeHttp, tempDir } from "./helpers.ts";

test("SIGTERM during an admitted MCP pass records termination and immediately unlocks only its study", async () => {
  const home = tempDir(), dir = join(home, "study"), foreign = join(home, ".ares.lock"), actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http };
  ops.init(dir, { question: "Synthetic shutdown", mode: "survey", autonomy: "gates" }, ctx);
  await ops.scope(dir, { question: "Synthetic shutdown", yearFrom: 2020, yearTo: 2025, maxCandidates: 50 }, ctx);
  await ops.gateDecide(dir, "scope", "approve", undefined, ctx);
  await ops.watchSet(dir, { v: 1, queries: [{ id: "first", query: "synthetic first", source: "openalex" }, { id: "pending", query: "synthetic pending", source: "openalex" }] }, ctx);
  writeFileSync(foreign, "unrelated lock\n");
  const script = join(home, "mcp-fixture.ts");
  writeFileSync(script, `import { runMcp } from ${JSON.stringify(fileURLToPath(new URL("../src/cli.ts", import.meta.url)))};
import { createHttp } from ${JSON.stringify(fileURLToPath(new URL("../src/http.ts", import.meta.url)))};
let calls = 0;
const http = createHttp(process.env, async () => {
  if (++calls === 1) return new Response('{"results":[]}');
  process.stderr.write("SYNTHETIC_WAIT\\n");
  return await new Promise<Response>(() => {});
});
await runMcp(process.env, http);
`);
  const child = spawn(process.execPath, [script], { cwd: home, env: { PATH: process.env.PATH, HOME: home, AGENTHUB_HOME: join(home, "family"), AGENTHUB_PEER_ID: "synthetic-shutdown" }, stdio: ["pipe", "pipe", "pipe"] });
  const admitted = deferred(), paused = deferred(), done = deferred<{ code: number | null; signal: NodeJS.Signals | null }>();
  let output = "", errors = "";
  child.on("error", error => { admitted.reject(error); paused.reject(error); done.reject(error); });
  child.stdout.on("data", chunk => { output += String(chunk); if (output.split("\n").some(line => { try { const row = JSON.parse(line); return row.id === 2 && row.result; } catch { return false; } })) admitted.resolve(); });
  child.stderr.on("data", chunk => { errors += String(chunk); if (errors.includes("SYNTHETIC_WAIT")) paused.resolve(); });
  child.on("exit", (code, signal) => { done.resolve({ code, signal }); admitted.reject(new Error("fixture exited before admission")); paused.reject(new Error("fixture exited before pause")); });
  const watchdog = setTimeout(() => { child.kill("SIGKILL"); }, 8000);
  try {
    child.stdin.write([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ares_watch_run", arguments: { study: dir } } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    await Promise.all([admitted.promise, paused.promise]);
    expect(existsSync(join(dir, ".ares.lock"))).toBe(true); child.kill("SIGTERM");
    expect(await done.promise).toEqual({ code: 143, signal: null });
    expect(existsSync(join(dir, ".ares.lock"))).toBe(false); expect(readFileSync(foreign, "utf8")).toBe("unrelated lock\n");
    const events = readLedger(dir); expect(events.filter(row => row.type === "lit.search")).toHaveLength(1);
    expect(events.filter(row => row.type === "watch.ran")).toHaveLength(1);
    expect(events.at(-1)!.data).toMatchObject({ ok: false, cause: "terminated", queries: [] });
    expect(events.at(-1)!.actor).toEqual({ kind: "agent", id: "synthetic-shutdown" });
    expect(errors).toContain("terminated; inspect ares watch show"); expect(output).not.toContain("terminated");
    expect(readdirSync(dir, { recursive: true }).some(file => String(file).endsWith(".tmp"))).toBe(false);
    await ops.watchSet(dir, { v: 1, queries: [{ id: "after", query: "synthetic after" }] }, ctx);
    expect((ops.watchShow(dir).runs[0]! as Record<string, unknown>).cause).toBe("terminated");
  } finally { clearTimeout(watchdog); if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await done.promise; } child.stdin.destroy(); }
}, 10_000);

test("study lock cleanup does not unlink a replacement lock", async () => {
  const dir = tempDir(), lock = join(dir, ".ares.lock");
  await withLock(dir, () => { unlinkSync(lock); writeFileSync(lock, "different owner\n"); });
  expect(readFileSync(lock, "utf8")).toBe("different owner\n");
});


test("failed lock-owner fstat removes its just-created lock before rethrowing", async () => {
  const dir = tempDir(), lock = join(dir, ".ares.lock"), failure = new Error("synthetic fstat failure");
  let entered = false;
  await expect(withLock(dir, () => { entered = true; }, () => { throw failure; })).rejects.toBe(failure);
  expect(entered).toBe(false); expect(existsSync(lock)).toBe(false);
  await withLock(dir, () => { entered = true; });
  expect(entered).toBe(true); expect(existsSync(lock)).toBe(false);
});
