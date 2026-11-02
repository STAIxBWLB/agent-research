import { appendFileSync, existsSync } from "node:fs";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { createHttp } from "../src/http.ts";
import { readJsonFile } from "../src/study.ts";
import type { AttemptContext } from "../src/exp/attempts.ts";
import type { ProcessResult, ProcessRunner } from "../src/exp/executor.ts";

interface ControlFixture { dir: string; id: string; launches: string; release: string; candidate: unknown; evaluator: { Id: string }; time: number }
const fixture = readJsonFile(process.argv[2]!, 1_048_576) as ControlFixture;
const mode = process.argv[3];
const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const runner: ProcessRunner = async request => {
  if (request.command === "sh") return ok(); // The watchdog is scripted, never executed.
  if (request.command !== "docker") throw new Error("synthetic control worker refused an unexpected process");
  if (request.args[0] === "run") { appendFileSync(fixture.launches, "evaluator\n"); return ok(fixture.evaluator.Id); }
  if (request.args[0] === "inspect") {
    if (request.args.at(-1)!.endsWith("-candidate")) {
      if (mode === "cli") {
        console.log("control-ready"); const deadline = performance.now() + 3000;
        while (!existsSync(fixture.release)) { if (performance.now() >= deadline) throw new Error("synthetic release barrier timed out"); await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      return ok(JSON.stringify([fixture.candidate]));
    }
    return ok(JSON.stringify([fixture.evaluator]));
  }
  throw new Error("synthetic control worker refused an unexpected Docker operation");
};
const http = createHttp({}, async () => { throw new Error("synthetic control worker forbids network requests"); });
const runtime: Omit<AttemptContext, "actor"> = {
  runner, now: () => fixture.time,
  collectStageEvidence: async (_attempt, stage) => {
    const log = { path: `/synthetic/${stage}.log`, sha256: "0".repeat(64), bytes: 0, truncated: false };
    return { logs: { stdout: log, stderr: log }, outputs: [] };
  },
};
try {
  if (mode === "cli") {
    const result = await run(["attempt", "reconcile", fixture.dir, "--json"], { AGENTHUB_PEER_ID: "control-cli" }, { http, ...runtime });
    if (result.code !== 0) throw new Error("synthetic CLI reconcile failed");
  } else if (mode === "mcp") {
    const server = createAresMcp({ AGENTHUB_PEER_ID: "control-mcp" }, http, runtime);
    // Signal the real mutex retry, rather than rely on subprocess startup timing.
    const schedule = globalThis.setTimeout;
    Object.defineProperty(globalThis, "setTimeout", { value: (...args: unknown[]) => {
      if (args[1] === 50) console.log("control-waiting");
      return Reflect.apply(schedule, globalThis, args);
    } });
    await server.handlers.ares_attempt_reconcile!({ study: fixture.dir });
  } else throw new Error("synthetic worker mode must be cli or mcp");
  console.log(JSON.stringify({ ok: true, mode }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "synthetic reconcile failed");
  process.exitCode = 1;
}
