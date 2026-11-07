import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { plain } from "../src/study.ts";

export type ReleaseRunner = (program: "git" | "gh", args: string[]) => Promise<string>;
export function defaultReleaseRunner(root: string): ReleaseRunner {
  return async (program, args) => (await promisify(execFile)(program, args, { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 })).stdout;
}
export interface CiOptions { runner: ReleaseRunner; repo?: string }
interface WaitOptions extends CiOptions { now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; pollMs?: number }
export const CI_TIMEOUT_MS = 30 * 60_000, CI_POLL_MS = 30_000;
function fail(reason: string): never { throw new Error(`release CI: ${reason}; inspect the Check workflow on main for this commit before retrying`); }
function parsed(value: string): Record<string, unknown> {
  let data: unknown; try { data = JSON.parse(value); } catch { fail("invalid GitHub response"); }
  if (!plain(data)) fail("invalid GitHub response"); return data;
}
async function ciState(commit: string, { runner, repo = "STAIxBWLB/agent-research" }: CiOptions): Promise<"pending" | "success"> {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) fail("invalid commit or repository");
  const base = `repos/${repo}/actions`, result = parsed(await runner("gh", ["api", `${base}/workflows/check.yml/runs?head_sha=${commit}&event=push&branch=main&per_page=100`]));
  if (!Array.isArray(result.workflow_runs)) fail("missing workflow run list");
  const runs = result.workflow_runs.filter((run): run is Record<string, unknown> => plain(run) && run.head_sha === commit && run.head_branch === "main" && run.event === "push" && run.name === "Check");
  if (!runs.length) return "pending";
  if (runs.some(run => !Number.isSafeInteger(run.id) || Number(run.id) <= 0)) fail("invalid run identity");
  const run = runs.sort((a, b) => Number(b.id) - Number(a.id))[0]!;
  if (run.status !== "completed") return "pending";
  if (run.conclusion !== "success") fail(`Check concluded ${String(run.conclusion)}`);
  if (!Number.isSafeInteger(run.run_attempt) || Number(run.run_attempt) <= 0) fail("invalid run attempt");
  const jobs = parsed(await runner("gh", ["api", `${base}/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`]));
  if (!Array.isArray(jobs.jobs) || !Number.isSafeInteger(jobs.total_count) || Number(jobs.total_count) > 100) fail("invalid or oversized job list");
  const checks = jobs.jobs.filter((job): job is Record<string, unknown> => plain(job) && job.name === "ci-ok");
  if (checks.length !== 1) fail("ci-ok aggregate is missing or duplicated");
  if (checks[0]!.status !== "completed" || checks[0]!.conclusion !== "success") fail("ci-ok did not succeed");
  return "success";
}
export async function requireCi(commit: string, options: CiOptions): Promise<void> {
  if (await ciState(commit, options) !== "success") fail("ci-ok has not completed successfully");
}
export async function waitForCi(commit: string, options: WaitOptions): Promise<void> {
  const now = options.now ?? Date.now, sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const timeout = options.timeoutMs ?? CI_TIMEOUT_MS, poll = options.pollMs ?? CI_POLL_MS;
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > CI_TIMEOUT_MS || !Number.isFinite(poll) || poll <= 0) fail("invalid wait bounds");
  const deadline = now() + timeout;
  while (now() < deadline) {
    const state = await ciState(commit, options);
    if (now() >= deadline) break;
    if (state === "success") return;
    await sleep(Math.min(poll, Math.max(0, deadline - now())));
  }
  fail("deadline exceeded while waiting for ci-ok");
}
