import {realHubProbeUnavailable} from "../harness/receipts.ts";
import { isAbsolute, resolve } from "node:path";
import { spawnRunner, type ProcessRunner } from "../exp/executor.ts";
import { plain, sha256, type LedgerEvent } from "../study.ts";
import type { Observation } from "./controller.ts";

export interface HubObservation extends Observation { taskId?: number }
export interface HubClient { observe(campaign: string, unit: string, taskId?: number): Promise<HubObservation> }
export const HUB_READ_BYTES = 1_048_576;
const states = ["backlog", "proposed", "in_progress", "in_review", "approved", "changes_requested", "cancelled", "unknown"];
const id = (value: unknown): value is string => typeof value === "string" && !!value.trim() && !value.includes("\0") && Buffer.byteLength(value) <= 128;
const task = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
function readError(kind: string): HubObservation { return { status: "dispatched", reason: `hub read ${kind}; check ahub study show for this campaign and restore hub access` }; }
function failed(reason: string, taskId?: number): HubObservation { return { status: "failed", reason: `hub ${reason}; inspect ahub study show, correct the plan reference and retry explicitly`, ...(taskId !== undefined ? { taskId } : {}) }; }
/** Only bounded status/study-show argv reads; no task creation, activation, approval or other hub write. */
export function createHubClient(project: string, runner: ProcessRunner = spawnRunner): HubClient {
  async function read(args: string[]): Promise<{ data?: unknown; error?: HubObservation }> {
    let result;
    try { result = await runner({ command: "ahub", args: ["--project", resolve(project), ...args], timeoutMs: 10_000, maxOutputBytes: HUB_READ_BYTES }); }
    catch { return { error: readError("unavailable") }; }
    if (result.timedOut) return { error: readError("timeout") };
    if (result.truncated || Buffer.byteLength(result.stdout) > HUB_READ_BYTES) return { error: readError("oversize") };
    if (result.exitCode !== 0) return { error: readError("exit") };
    try { return { data: JSON.parse(result.stdout) }; } catch { return { error: readError("format") }; }
  }
  return { observe: async (campaign, unit, expected) => {
    if (!id(campaign) || campaign.startsWith("-") || !id(unit) || (expected !== undefined && !task(expected))) return failed("reference invalid");
    const status = await read(["status", "--json"]);
    if (status.error) return { ...status.error, reason: "hub read project-unavailable: no reachable agent-hub project for this study; run ahub status --json from the study directory" };
    if (!plain(status.data) || typeof status.data.cwd !== "string" || !isAbsolute(status.data.cwd) || status.data.cwd.includes("\0") || Buffer.byteLength(status.data.cwd) > 4096) return readError("project-format");
    const hubProject = status.data.cwd;
    const finish = (result: HubObservation): HubObservation => ({ ...result, hubProject });
    const result = await read(["study", "show", campaign, "--json"]);
    if (result.error) return finish(result.error);
    const raw = result.data;
    if (!plain(raw) || raw.id !== campaign || !task(raw.revision) || typeof raw.held !== "boolean" || !Array.isArray(raw.reasons) || !raw.reasons.every(r => typeof r === "string") || !Array.isArray(raw.units) || raw.units.length > 128) return finish(readError("format"));
    // The shipped projection has no status field; it names non-current approval in reasons.
    if (raw.reasons.includes("campaign approval is not current")) return finish({ status: "dispatched", reason: "hub campaign approval pending; a person approves it in ahub study" });
    const units = raw.units.filter(u => plain(u) && u.unitId === unit);
    if (!units.length) return finish(failed("unit missing from current campaign revision", expected));
    if (units.length !== 1) return finish(readError("format"));
    const found = units[0] as Record<string, unknown>;
    if (found.taskId === null) return finish({ status: "dispatched", reason: "hub campaign activation pending: no child taskId; a person activates the campaign in ahub study" });
    if (found.state === "unknown") return finish(failed("child task missing", expected));
    if (!task(found.taskId) || typeof found.state !== "string" || !states.includes(found.state)) return finish(readError("unsupported"));
    if (expected !== undefined && found.taskId !== expected) return finish(failed("child task binding changed", expected));
    if (found.state === "cancelled") return finish(failed("child task cancelled", found.taskId));
    const reference = { campaign, unit, campaignRevision: raw.revision, taskId: found.taskId, state: found.state };
    return finish({ status: found.state === "approved" ? "done" : "dispatched", taskId: found.taskId,
      ...(found.state === "approved" ? { output: { ...reference, sha256: sha256(JSON.stringify(reference)) } } : {}),
      progress: JSON.stringify(reference) });
  } };
}
/** The first known binding of this node/revision remains pinned through retries. */
export function boundHubTask(events: LedgerEvent[], revision: number, node: string): number | undefined {
  return events.find(e => (e.type === "node.intent" || e.type === "node.observed") && e.data.revision === revision && e.data.node === node && task(e.data.taskId))?.data.taskId as number | undefined;
}

/** Producer #1225/#1226 has not shipped an admitted receipt reader; no guessed CLI or wire fallback. */
export async function readHarnessProbeSource(_address: unknown) {
  return realHubProbeUnavailable(_address);
}
