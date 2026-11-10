import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { createHttp } from "../src/http.ts";
import { sha256 } from "../src/study.ts";
import type { ExperimentRuntime } from "../src/commands.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/exp/executor.ts";
import { metricProtocol } from "./metric-fixtures.ts";
import { fakeTarSource, isTarRequest } from "./helpers.ts";

export const fixtureCommit = "a".repeat(40), fixtureTree = "b".repeat(40);
export function experimentTree(dir: string): void {
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic task"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic evaluator");
}
export function experimentFixture(dir: string) {
  const protocol = metricProtocol(); protocol.seeds = [-1, 0, 1];
  const requests: ProcessRequest[] = [], containers = new Map<string, { id: string; args: string[]; running: boolean; exitCode: number; startedAt: string; finishedAt?: string }>(), logBodies = new Map<string, Buffer>();
  let time = Date.parse("2030-01-01T00:00:00Z"), sleeps = 0, httpCalls = 0;
  const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1]!;
  const runner: ProcessRunner = async request => {
    if (existsSync(join(dir, ".ares.lock"))) throw new Error("synthetic backend called while study lock held");
    requests.push(request); const a = request.args;
    if (request.command === "git") {
      if (a.includes("cat-file")) return ok("commit"); if (a.includes("rev-parse")) return ok(fixtureTree);
      if (a.includes("archive")) { await request.stdoutSink!(Buffer.from([0, 255, 1])); return ok(); }
    }
    if (isTarRequest(request)) {
      if (request.stdoutSink) await fakeTarSource(request, Buffer.from([0, 128, 2]));
      else for await (const _chunk of request.stdin as AsyncIterable<Uint8Array>) { /* fake host consumes frozen archive */ }
      return ok();
    }
    if (request.command === "id") return ok("1001");
    if (request.command === "sh") {
      if (request.stdoutSink) {
        const body = [...logBodies].find(([path]) => a.join(" ").includes(path))?.[1];
        if (!body) throw new Error("unscripted synthetic log read"); await request.stdoutSink(body);
      }
      return ok();
    }
    if (request.command === "docker") {
      if (a[0] === "version") return ok("29.1.3"); if (a[0] === "image" || a[0] === "pull") return ok("sha256:synthetic");
      if (a[0] === "run") { const name = flag(a, "--name"), id = sha256(name); containers.set(name, { id, args: a, running: true, exitCode: 0, startedAt: new Date(time).toISOString() }); return ok(id); }
      if (a[0] === "kill") { const target = containers.get(a[1]!) ?? [...containers.values()].find(c => c.id === a[1]); if (!target) return { exitCode: 1, stdout: "", stderr: "missing" }; target.running = false; target.exitCode = 137; target.finishedAt = new Date(time).toISOString(); return ok(); }
      if (a[0] === "ps") return ok([...containers.entries()].filter(([name]) => a.includes(`name=^/${name}$`)).map(([, c]) => c.id).join("\n"));
      if (a[0] === "inspect") {
        const c = containers.get(a.at(-1)!); if (!c) return { exitCode: 1, stdout: "", stderr: "missing" };
        const argv = c.args, imageAt = argv.findIndex(v => v.includes("@sha256:"));
        const labels = Object.fromEntries(argv.flatMap((v, i) => v === "--label" ? [argv[i + 1]!.split("=")] : []));
        const mounts = argv.flatMap((v, i) => v === "--mount" ? [argv[i + 1]!] : []).map(v => { const parts = v.split(","); return { Type: "bind", Source: parts.find(p => p.startsWith("src="))!.slice(4), Destination: parts.find(p => p.startsWith("dst="))!.slice(4), RW: !parts.includes("readonly") }; });
        const seed = argv.flatMap((v, i) => v === "--env" ? [argv[i + 1]!] : []).find(v => v.startsWith("ARES_SEED="));
        return ok(JSON.stringify([{ Id: c.id, State: { Running: c.running, ExitCode: c.exitCode, StartedAt: c.startedAt, FinishedAt: c.finishedAt }, Config: { Image: argv[imageAt], User: flag(argv, "--user"), Cmd: argv.slice(imageAt + 1), Labels: labels, Seed: seed }, HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Tmpfs: { "/tmp": "" }, Memory: Number.parseInt(flag(argv, "--memory")) * 1024 * 1024, PidsLimit: Number(flag(argv, "--pids-limit")), NanoCpus: Number(flag(argv, "--cpus")) * 1e9, DeviceRequests: [] }, Mounts: mounts }]));
      }
    }
    throw new Error("unscripted synthetic process request");
  };
  const runtime: ExperimentRuntime = { runner, now: () => time, sleep: async ms => { sleeps++; time += ms; const active = [...containers.values()].find(c => c.running); if (active) { active.running = false; active.finishedAt = new Date(time).toISOString(); } }, collectEvaluation: async () => ({ metrics: [{ name: "score", unit: "points", value: 7, provenance: "ares-observed" }], outputs: [] }), collectStageEvidence: async (attempt, stage) => {
    const root = posix.dirname(attempt.paths.snapshot);
    const log = (stream: "stdout" | "stderr") => { const path = posix.join(root, "logs", `${stage}.${stream}.log`), body = Buffer.from(`${stage} ${stream}\nGET https://example.test/private\n`); logBodies.set(path, body); return { path, sha256: sha256(body), bytes: body.length, truncated: false }; };
    return { logs: { stdout: log("stdout"), stderr: log("stderr") }, outputs: [] };
  } };
  const http = createHttp({}, async () => { httpCalls++; throw new Error("HTTP must never be called by experiment fixtures"); });
  return { protocol, runtime, runner, http, requests, containers, logBodies, sleeps: () => sleeps, httpCalls: () => httpCalls };
}
