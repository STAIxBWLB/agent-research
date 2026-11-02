import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { run } from "../src/cli.ts";
import { COMMANDS } from "../src/commands-table.ts";
import { readLedger } from "../src/study.ts";
import { tempDir } from "./helpers.ts";
import { experimentFixture, experimentTree, fixtureCommit } from "./exp-fixture.ts";
import { join } from "node:path";

async function setup() {
  const dir = tempDir(), fake = experimentFixture(dir), io = { ...fake.runtime, http: fake.http, readStdin: async () => JSON.stringify(fake.protocol) }, env = { CODEX_THREAD_ID: "synthetic-cli" };
  await run(["init", dir, "--question", "Synthetic?", "--mode", "experiment"], env, io); experimentTree(dir);
  await run(["protocol", dir, "--file", "-"], env, io);
  await run(["executor", "set", dir, "--kind", "local", "--workdir", "/private/synthetic"], env, io);
  await run(["gate", "approve", dir, "design"], env, io);
  return { dir, fake, io, env };
}
test("CLI exposes implemented A2 commands and runs a foreground experiment through shared operations", async () => {
  for (const name of ["protocol", "executor set", "executor check", "attempt run", "attempt list", "attempt show", "attempt cancel", "attempt reconcile", "attempt logs"]) expect(COMMANDS.some(c => c.name === name)).toBe(true);
  const { dir, fake, io, env } = await setup();
  expect(JSON.parse((await run(["executor", "check", dir], env, io)).text).serverVersion).toBe("29.1.3");
  const output = await run(["attempt", "run", dir, "--repo", "/synthetic/repo", "--commit", fixtureCommit, "--seed", "-1"], env, io), attempt = JSON.parse(output.text);
  expect(output.code).toBe(0); expect(attempt.status).toBe("succeeded"); expect(attempt.seed).toBe(-1); expect(fake.sleeps()).toBe(2);
  expect(JSON.parse((await run(["attempt", "show", dir, attempt.id], env, io)).text).protocol).toBeDefined();
  expect(readLedger(dir).filter(e => e.actor.kind !== "auto").every(e => e.actor.kind === "agent" && e.actor.id === "codex")).toBe(true);
  expect(fake.httpCalls()).toBe(0); expect((await run(["playbook"], env, io)).text).toContain("sealed evaluator");
});
test("CLI list returns bounded summary pages and all-status totals regardless of filters", async () => {
  const { dir, fake, io, env } = await setup(), args = ["attempt", "run", dir, "--repo", "/synthetic/repo", "--commit", fixtureCommit];
  const one = JSON.parse((await run([...args, "--seed", "-1"], env, io)).text);
  const two = JSON.parse((await run([...args, "--seed", "0", "--detach"], env, io)).text);
  await run(["attempt", "cancel", dir, two.id], env, io);
  await run([...args, "--seed", "1", "--detach"], env, io); fake.containers.clear(); await run(["attempt", "reconcile", dir], env, io);
  const listed = JSON.parse((await run(["attempt", "list", dir, "--status", "cancelled", "--limit", "1", "--offset", "0"], env, io)).text);
  expect(listed.attempts).toHaveLength(1); expect(listed.total).toBe(1); expect(listed.totals).toEqual({ running: 0, succeeded: 1, failed: 0, cancelled: 1, unknown: 1 });
  expect(listed.attempts[0].protocol).toBeUndefined(); expect(listed.attempts[0].outputs).toBeUndefined();
  expect(JSON.parse((await run(["attempt", "show", dir, one.id], env, io)).text).metrics[0].value).toBe(7);
  await expect(run(["attempt", "list", dir, "--limit", "0"], env, io)).rejects.toThrow("--limit 1..200");
});
test("CLI logs return host content only to the caller and never change study files", async () => {
  const { dir, fake, io, env } = await setup(), attempt = JSON.parse((await run(["attempt", "run", dir, "--repo", "/synthetic/repo", "--commit", fixtureCommit], env, io)).text);
  const ledger = readFileSync(join(dir, "ledger.jsonl")), recordPath = join(dir, "runs", attempt.run, "attempts", `${attempt.id}.json`), record = readFileSync(recordPath);
  const output = await run(["attempt", "logs", dir, attempt.id, "--stage", "candidate", "--stream", "stdout", "--tail", "16", "--json"], env, io), logs = JSON.parse(output.text);
  expect(logs.logs).toHaveLength(1); expect(logs.logs[0].tailBytes).toBe(16); expect(logs.logs[0].text).toContain("test/private");
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger); expect(readFileSync(recordPath)).toEqual(record); expect(existsSync(join(dir, ".ares.control.lock"))).toBe(false);
  expect(fake.httpCalls()).toBe(0);
});
test("survey and malformed CLI experiment requests refuse before reaching the executor", async () => {
  const dir = tempDir(), fake = experimentFixture(dir), io = { ...fake.runtime, http: fake.http, readStdin: async () => JSON.stringify(fake.protocol) };
  await run(["init", dir, "--question", "Survey?"], {}, io);
  for (const args of [["protocol", dir, "--file", "-"], ["executor", "set", dir, "--kind", "local", "--workdir", "/private/synthetic"], ["executor", "check", dir], ["attempt", "run", dir, "--repo", "/synthetic/repo", "--commit", fixtureCommit], ["attempt", "list", dir], ["attempt", "show", dir, "0".repeat(16)], ["attempt", "cancel", dir, "0".repeat(16)], ["attempt", "reconcile", dir], ["attempt", "logs", dir, "0".repeat(16)]]) await expect(run(args, {}, io)).rejects.toThrow("mode must be experiment");
  await expect(run(["attempt", "run", dir, "--repo", "/synthetic/repo", "--commit", fixtureCommit, "--seed", "1.5"], {}, io)).rejects.toThrow("--seed: invalid integer");
  await expect(run(["protocol", dir, "--file", "-", "--file", "-"], {}, io)).rejects.toThrow("repeated option");
  expect(fake.requests).toHaveLength(0); expect(readLedger(dir)).toHaveLength(1); expect(fake.httpCalls()).toBe(0);
});
test("CLI startup failures name the blocked step and recovery without persisting backend diagnostics", async () => {
  const { dir, fake, io, env } = await setup();
  const runner: typeof fake.runner = async request => request.command === "sh" && request.args[1]?.includes("base=") ? { exitCode: 1, stdout: "", stderr: "synthetic-sensitive-backend-body" } : fake.runner(request);
  const output = await run(["attempt", "run", dir, "--repo", "/synthetic/repo", "--commit", fixtureCommit, "--detach"], env, { ...io, runner });
  const result = JSON.parse(output.text);
  expect(output.code).toBe(1); expect(result.status).toBe("failed"); expect(result.error).toContain("private workspace preparation failed");
  expect(result.error).toContain("owned physical directory with mode 0700"); expect(result.error).toContain("--retry ID");
  expect(output.text).not.toContain("synthetic-sensitive-backend-body");
});
