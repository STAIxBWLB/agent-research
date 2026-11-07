import { expect, test } from "bun:test";
import { requireCi, waitForCi, type ReleaseRunner } from "../scripts/release-ci.ts";
const sha = "a".repeat(40);
function run(overrides: Record<string, unknown> = {}) { return { id: 42, name: "Check", head_sha: sha, head_branch: "main", event: "push", run_attempt: 2, status: "completed", conclusion: "success", ...overrides }; }
function fake(runs: unknown[], jobs: unknown[] = [{ name: "ci-ok", status: "completed", conclusion: "success" }]) {
  const calls: string[][] = [];
  const runner: ReleaseRunner = async (program, args) => { expect(program).toBe("gh"); calls.push(args); return JSON.stringify(args[1]!.includes("/jobs?") ? { total_count: jobs.length, jobs } : { workflow_runs: runs }); };
  return { runner, calls };
}
test("CI requires exact main push Check workflow and its latest attempt aggregate", async () => {
  const f = fake([run()]); await requireCi(sha, f);
  expect(f.calls[0]![1]).toContain("workflows/check.yml/runs?head_sha=" + sha);
  expect(f.calls[0]![1]).toContain("event=push&branch=main");
  expect(f.calls[1]![1]).toContain("runs/42/attempts/2/jobs");
  for (const overrides of [{ head_sha: "b".repeat(40) }, { head_branch: "topic" }, { event: "pull_request" }, { name: "Other" }]) {
    await expect(requireCi(sha, fake([run(overrides)]))).rejects.toThrow("has not completed");
  }
});
test("latest failed/cancelled/skipped run or non-success aggregate fails closed", async () => {
  for (const conclusion of ["failure", "cancelled", "skipped", "neutral", null]) {
    await expect(requireCi(sha, fake([run(), run({ id: 43, conclusion })]))).rejects.toThrow("Check concluded");
    await expect(requireCi(sha, fake([run()], [{ name: "ci-ok", status: "completed", conclusion }]))).rejects.toThrow("ci-ok did not succeed");
  }
  await expect(requireCi(sha, fake([run()], []))).rejects.toThrow("missing or duplicated");
  await expect(requireCi(sha, fake([run()], [{ name: "ci-ok", status: "completed", conclusion: "success" }, { name: "ci-ok" }]))).rejects.toThrow("missing or duplicated");
});
test("pending CI waits within deadline, never sleeps after failure or accepts late success", async () => {
  let time = 0, polls = 0;
  const pending = fake([]), success = fake([run()]);
  const runner: ReleaseRunner = async (p, args) => (++polls === 1 ? pending.runner : success.runner)(p, args);
  await waitForCi(sha, { runner, now: () => time, sleep: async ms => { time += ms; }, timeoutMs: 100, pollMs: 30 });
  expect(time).toBe(30);
  time = 0; await expect(waitForCi(sha, { ...pending, now: () => time, sleep: async ms => { time += ms; }, timeoutMs: 100, pollMs: 30 })).rejects.toThrow("deadline exceeded");
  expect(time).toBe(100);
  await expect(waitForCi(sha, { ...fake([run({ conclusion: "failure" })]), sleep: async () => { throw new Error("must not sleep"); } })).rejects.toThrow("Check concluded");
  time = 0;
  await expect(waitForCi(sha, { runner: async (p, args) => { const result = await success.runner(p, args); time = 100; return result; }, now: () => time, timeoutMs: 100 })).rejects.toThrow("deadline exceeded");
});
test("invalid GitHub responses fail without waiting", async () => {
  for (const value of ["not JSON", "null", "{}", JSON.stringify({ workflow_runs: [run({ id: "42" })] })]) {
    await expect(requireCi(sha, { runner: async () => value })).rejects.toThrow("release CI:");
  }
});

test("CI lookup failures name the operation, class and permission next step without raw diagnostics", async () => {
  for (const error of [new Error("secret https://example.invalid/token (HTTP 403)"), Object.assign(new Error("secret https://example.invalid/token"), { code: "ENOENT" })]) {
    for (const failJobs of [false, true]) {
      const runner: ReleaseRunner = async (_p, args) => { if (failJobs && !args[1]!.includes("/jobs?")) return JSON.stringify({ workflow_runs: [run()] }); throw error; };
      for (const invoke of [requireCi, waitForCi]) {
        try { await invoke(sha, { runner }); throw new Error("expected refusal"); }
        catch (cause) {
          const message = String(cause); expect(message).toContain("release CI GitHub lookup");
          expect(message).toContain("code" in error ? "spawn failure (ENOENT)" : "HTTP 403");
          expect(message).toContain("GH_TOKEN actions:read"); expect(message).toContain("then rerun");
          expect(message).not.toContain("secret"); expect(message).not.toContain("https://");
        }
      }
    }
  }
});
