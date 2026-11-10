import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import * as ops from "../src/commands.ts";
import { ARES_TOOLS, createAresMcp } from "../src/mcp-tools.ts";
import { serveMcp, validArguments } from "../src/mcp.ts";
import { PLAYBOOK } from "../src/playbook.ts";
import { openStudy, readLedger, sha256 } from "../src/study.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/exp/executor.ts";
import { fakeHttp, fakeTarSource, isTarRequest, tempDir } from "./helpers.ts";
import { metricAttempt, metricProtocol } from "./metric-fixtures.ts";

const actor = { kind: "person" as const }, commit = "a".repeat(40), treeId = "b".repeat(40);
const initialized = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "1" } } }, { jsonrpc: "2.0", method: "notifications/initialized" }];
const call = (id: number, name: string, args: Record<string, unknown>) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
async function session(frames: unknown[], runtime: ops.ExperimentRuntime = {}) {
  const input = new PassThrough(), output = new PassThrough(), chunks: string[] = [];
  output.on("data", chunk => chunks.push(String(chunk)));
  const server = createAresMcp({ CODEX_THREAD_ID: "synthetic-session" }, fakeHttp([]).http, runtime);
  const done = serveMcp({ tools: server.tools, handlers: server.handlers, input, output });
  for (const frame of [...initialized, ...frames]) input.write(JSON.stringify(frame) + "\n");
  input.end(); await done;
  return chunks.join("").split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>);
}
function study(dir = tempDir()) {
  ops.init(dir, { question: "Synthetic experiment?", mode: "experiment" }, { actor });
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic task"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic evaluator");
  return dir;
}
/** Script only the executor boundary; no real Git, Docker, SSH or network process is launched. */
function executorRuntime(dir: string) {
  const requests: ProcessRequest[] = [], containers = new Map<string, { cid: string; args: string[]; running: boolean; exitCode: number }>();
  const timestamp = "2030-01-01T00:00:00.000Z";
  const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
  const runner: ProcessRunner = async request => {
    expect(existsSync(join(dir, ".ares.lock"))).toBe(false); requests.push(request);
    const args = request.args;
    if (request.command === "git") {
      if (args.includes("cat-file")) return ok("commit");
      if (args.includes("rev-parse")) return ok(treeId);
      if (request.stdoutSink) { await request.stdoutSink(Buffer.from([0, 255, 1])); return ok(); }
    }
    if (isTarRequest(request)) {
      if (request.stdoutSink) await fakeTarSource(request, Buffer.from([0, 128, 2]));
      else for await (const _chunk of request.stdin as AsyncIterable<Uint8Array>) { /* synthetic extraction */ }
      return ok();
    }
    if (request.command === "sh") return ok();
    if (request.command === "id") return ok("1001");
    if (request.command === "docker") {
      if (args[0] === "version") return ok("29.1.3");
      if (args[0] === "image") return ok("sha256:synthetic");
      if (args[0] === "run") { const name = flag(args, "--name"), cid = sha256(name); containers.set(name, { cid, args, running: true, exitCode: 0 }); return ok(cid); }
      if (args[0] === "kill") { const container = [...containers.values()].find(value => value.cid === args[1]); if (!container) return { exitCode: 1, stdout: "", stderr: "missing" }; container.running = false; container.exitCode = 137; return ok(); }
      if (args[0] === "ps") return ok([...containers.entries()].filter(([name]) => args.includes(`name=^/${name}$`)).map(([, container]) => container.cid).join("\n"));
      if (args[0] === "inspect") {
        const container = containers.get(args.at(-1)!); if (!container) return { exitCode: 1, stdout: "", stderr: "missing" };
        const a = container.args, imageAt = a.findIndex(value => value.includes("@sha256:"));
        const labels = Object.fromEntries(a.flatMap((value, index) => value === "--label" ? [a[index + 1]!] : []).map(value => { const split = value.indexOf("="); return [value.slice(0, split), value.slice(split + 1)]; }));
        const mounts = a.flatMap((value, index) => value === "--mount" ? [a[index + 1]!] : []).map(value => { const parts = value.split(","); return { Type: "bind", Source: parts.find(part => part.startsWith("src="))!.slice(4), Destination: parts.find(part => part.startsWith("dst="))!.slice(4), RW: !parts.includes("readonly") }; });
        const seed = a.flatMap((value, index) => value === "--env" ? [a[index + 1]!] : []).find(value => value.startsWith("ARES_SEED="));
        return ok(JSON.stringify([{ Id: container.cid, State: { Running: container.running, ExitCode: container.exitCode, StartedAt: timestamp, ...(!container.running ? { FinishedAt: timestamp } : {}) }, Config: { Seed: seed, Image: a[imageAt], User: flag(a, "--user"), Cmd: a.slice(imageAt + 1), Labels: labels }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Tmpfs: { "/tmp": "" }, Memory: Number.parseInt(flag(a, "--memory")) * 1024 * 1024, PidsLimit: Number(flag(a, "--pids-limit")), NanoCpus: Number(flag(a, "--cpus")) * 1e9, DeviceRequests: [] }, Mounts: mounts }]));
      }
    }
    throw new Error("unscripted synthetic process request");
  };
  let sleeps = 0;
  const runtime: ops.ExperimentRuntime = { runner, now: () => Date.parse(timestamp), sleep: async () => { sleeps++; throw new Error("detached MCP must not sleep"); }, collectStageEvidence: async (_attempt, stage) => {
    const log = { path: `/synthetic/${stage}.log`, sha256: sha256(""), bytes: 0, truncated: false };
    return { logs: { stdout: log, stderr: log }, outputs: [] };
  } };
  return { runtime, requests, containers, sleeps: () => sleeps };
}

test("experiment MCP surface has strict schemas, design gate and executor open-world annotations", () => {
  const names = ["ares_protocol_set", "ares_executor_set", "ares_executor_check", "ares_attempt_run", "ares_attempt_list", "ares_attempt_show", "ares_attempt_cancel", "ares_attempt_reconcile", "ares_attempt_logs"];
  for (const name of names) expect(ARES_TOOLS.some(tool => tool.name === name)).toBe(true);
  const tool = (name: string) => ARES_TOOLS.find(item => item.name === name)!;
  for (const name of ["ares_executor_check", "ares_attempt_run", "ares_attempt_cancel", "ares_attempt_reconcile", "ares_attempt_logs"]) expect(tool(name).annotations.openWorldHint).toBe(true);
  expect(tool("ares_attempt_logs").annotations.readOnlyHint).toBe(true);
  expect(tool("ares_attempt_show").annotations.openWorldHint).toBe(false);
  expect(validArguments({ study: "/synthetic", action: "approve", gate: "design" }, tool("ares_gate").inputSchema)).toBe(true);
  const p = metricProtocol();
  expect(validArguments({ study: "/synthetic", protocol: p }, tool("ares_protocol_set").inputSchema)).toBe(true);
  for (const protocol of [{ ...p, extra: true }, { ...p, candidate: { ...p.candidate, command: "shell string" } }, { ...p, limits: { ...p.limits, unknown: 1 } }, { ...p, metrics: [{ name: "score", unit: "points", direction: "sideways" }] }]) expect(validArguments({ study: "/synthetic", protocol }, tool("ares_protocol_set").inputSchema)).toBe(false);
  expect(validArguments({ study: "/synthetic", kind: "local" }, tool("ares_executor_set").inputSchema)).toBe(false);
  expect(validArguments({ study: "/synthetic", repo: "/synthetic", commit, detach: false }, tool("ares_attempt_run").inputSchema)).toBe(false);
  expect(validArguments({ study: "/synthetic", id: "0".repeat(16), tailBytes: 65_537 }, tool("ares_attempt_logs").inputSchema)).toBe(false);
  expect(validArguments({ study: "/synthetic", id: "0".repeat(16), tailBytes: 0 }, tool("ares_attempt_logs").inputSchema)).toBe(true);
  expect(validArguments({ study: "/synthetic", limit: 200, offset: 0 }, tool("ares_attempt_list").inputSchema)).toBe(true);
  for (const options of [{ limit: 201 }, { limit: 0 }, { offset: -1 }, { offset: 1_000_001 }]) expect(validArguments({ study: "/synthetic", ...options }, tool("ares_attempt_list").inputSchema)).toBe(false);
});

test("AC9: protocol/executor/gate shared handlers record agent actor and MCP run returns running without waiting", async () => {
  const dir = study(), fake = executorRuntime(dir), p = metricProtocol();
  const injected = { ...fake.runtime, actor: { kind: "person", id: "spoofed" } } as unknown as ops.ExperimentRuntime;
  const replies = await session([{ jsonrpc: "2.0", id: 2, method: "tools/list" }, call(3, "ares_protocol_set", { study: dir, protocol: p }), call(4, "ares_executor_set", { study: dir, kind: "local", workdir: "/private/synthetic" }), call(5, "ares_gate", { study: dir, action: "approve", gate: "design" }), call(6, "ares_executor_check", { study: dir }), call(7, "ares_attempt_run", { study: dir, repo: "/synthetic/repo", commit }), call(8, "ares_attempt_list", { study: dir })], injected);
  const result = (id: number) => replies.find(reply => reply.id === id)!;
  expect(result(2).result.tools.map((tool: { name: string }) => tool.name)).toContain("ares_attempt_logs");
  for (const id of [3, 4, 5, 6, 7, 8]) { expect(result(id).error).toBeUndefined(); expect(result(id).result.isError).toBeUndefined(); }
  const running = JSON.parse(result(7).result.content[0].text);
  expect(running.status).toBe("running"); expect(running.stage).toBe("candidate"); expect(fake.sleeps()).toBe(0);
  expect(fake.requests.filter(request => request.command === "docker" && request.args[0] === "run")).toHaveLength(1);
  expect(JSON.parse(result(8).result.content[0].text).totals.running).toBe(1);
  for (const event of readLedger(dir).filter(event => ["protocol.set", "executor.set", "gate.approve", "attempt.started"].includes(event.type))) expect(event.actor).toEqual({ kind: "agent", id: "codex" });
  const server = createAresMcp({}, fakeHttp([]).http, fake.runtime);
  expect(await server.handlers.ares_attempt_show!({ study: dir, id: running.id })).toMatchObject({ id: running.id, status: "running" });
  const page = await server.handlers.ares_attempt_list!({ study: dir, limit: 1, offset: 0 }) as { attempts: Record<string, unknown>[]; totals: { running: number } };
  expect(page.attempts).toHaveLength(1); expect(page.attempts[0]).not.toHaveProperty("protocol"); expect(page.attempts[0]).not.toHaveProperty("outputs"); expect(page.totals.running).toBe(1);
  const emptyPage = await server.handlers.ares_attempt_list!({ study: dir, limit: 1, offset: 1 }) as { attempts: unknown[]; totals: { running: number } };
  expect(emptyPage.attempts).toEqual([]); expect(emptyPage.totals.running).toBe(1);
  expect(await server.handlers.ares_attempt_reconcile!({ study: dir })).toEqual([]);
  expect(await server.handlers.ares_attempt_cancel!({ study: dir, id: running.id, reason: "synthetic stop" })).toMatchObject({ id: running.id, status: "cancelled" });
});

test("MCP rejects malformed protocol before mutation and surveys refuse experiment calls", async () => {
  const dir = study(), before = readLedger(dir), p = metricProtocol();
  const replies = await session([call(2, "ares_protocol_set", { study: dir, protocol: { ...p, candidate: { ...p.candidate, command: "shell string" } } }), call(3, "ares_protocol_set", { study: dir, protocol: { ...p, candidate: { ...p.candidate, env: { ARES_SEED: "99" } } } })]);
  expect(replies.find(reply => reply.id === 2)!.error.code).toBe(-32602);
  expect(replies.find(reply => reply.id === 3)!.result.isError).toBe(true);
  expect(readLedger(dir)).toEqual(before); expect(existsSync(join(dir, "design", "protocol.json"))).toBe(false);
  const survey = tempDir(); ops.init(survey, { question: "Synthetic survey?" }, { actor });
  const refused = await session([call(2, "ares_executor_set", { study: survey, kind: "local", workdir: "/private/synthetic" })]);
  expect(refused.find(reply => reply.id === 2)!.result.isError).toBe(true);
});

test("playbook explains experiment gates, executor-only logs, evaluator-only numbers and observed sealing", () => {
  for (const part of ["--mode experiment", "ares protocol", "ares executor check", "ares gate approve <dir> design", "--label baseline", "--label variant", "ares attempt reconcile", "Totals include failed, cancelled and unknown", "ares attempt logs", "log content stays out of the study", "/result/metrics.json", "ares-observed", "never host-observed or runner-attested"]) expect(PLAYBOOK).toContain(part);
});

test("MCP protocol envelope accepts a valid protocol near the 64 KiB file bound", async () => {
  const dir = study(join(tempDir(), "p".repeat(200), "q".repeat(200), "r".repeat(200))), p = metricProtocol();
  p.candidate.env = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`ENV_${i}`, "x".repeat(4096)]));
  const before = Buffer.byteLength(JSON.stringify(p, null, 2) + "\n"), methodLength = 65_535 - before + p.method.length;
  expect(methodLength).toBeGreaterThan(0); expect(methodLength).toBeLessThanOrEqual(4000);
  p.method = "m".repeat(methodLength);
  expect(Buffer.byteLength(JSON.stringify(p, null, 2) + "\n")).toBe(65_535);
  const frame = call(2, "ares_protocol_set", { study: dir, protocol: p });
  expect(Buffer.byteLength(JSON.stringify(frame) + "\n")).toBeGreaterThan(65_536);
  expect(Buffer.byteLength(JSON.stringify(frame) + "\n")).toBeLessThan(128 * 1024);
  const reply = (await session([frame])).find(item => item.id === 2)!;
  expect(reply.error).toBeUndefined(); expect(reply.result.isError).toBeUndefined();
  expect(readLedger(dir).some(event => event.type === "protocol.set")).toBe(true);
});

test("MCP show returns a valid full attempt record larger than the former 256 KiB result cap", async () => {
  const dir = study(), record = metricAttempt(); record.studyId = openStudy(dir).study.id;
  const stdout = { path: "/private/synthetic/attempt/logs/candidate.stdout.log", sha256: sha256(""), bytes: 0, truncated: false }, stderr = { ...stdout, path: "/private/synthetic/attempt/logs/candidate.stderr.log" };
  const manifest = [{ path: stdout.path, sha256: stdout.sha256, bytes: stdout.bytes }, { path: stderr.path, sha256: stderr.sha256, bytes: stderr.bytes }, ...Array.from({ length: 298 }, (_, i) => ({ path: `/private/synthetic/attempt/output/artifact-${i}-${"x".repeat(400)}`, sha256: sha256("x"), bytes: 1 }))];
  expect(Buffer.byteLength(JSON.stringify(manifest))).toBeLessThan(262_144);
  record.outputs = manifest; record.stages.candidate!.evidence = { logs: { stdout, stderr }, outputs: manifest };
  delete record.stages.evaluator!.endedAt; delete record.stages.evaluator!.exitCode;
  const json = JSON.stringify(record, null, 2) + "\n";
  expect(Buffer.byteLength(json)).toBeGreaterThan(262_144); expect(Buffer.byteLength(json)).toBeLessThanOrEqual(1024 * 1024);
  const attempts = join(dir, "runs", record.run, "attempts"); mkdirSync(attempts, { recursive: true }); writeFileSync(join(attempts, `${record.id}.json`), json);
  const reply = (await session([call(2, "ares_attempt_show", { study: dir, id: record.id })])).find(item => item.id === 2)!;
  expect(reply.result.isError).toBeUndefined(); expect(JSON.parse(reply.result.content[0].text)).toEqual(record);
});
