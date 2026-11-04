import { resolve } from "node:path";
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
/** Only this argv-only read exists: no task creation, activation, approval or other hub write. */
export function createHubClient(project: string, runner: ProcessRunner = spawnRunner): HubClient {
  return { observe: async (campaign, unit, expected) => {
    if (!id(campaign) || campaign.startsWith("-") || !id(unit) || (expected !== undefined && !task(expected))) return failed("reference invalid");
    let result;
    try { result = await runner({ command: "ahub", args: ["--project", resolve(project), "study", "show", campaign, "--json"], timeoutMs: 10_000, maxOutputBytes: HUB_READ_BYTES }); }
    catch { return readError("unavailable"); }
    if (result.timedOut) return readError("timeout");
    if (result.truncated || Buffer.byteLength(result.stdout) > HUB_READ_BYTES) return readError("oversize");
    if (result.exitCode !== 0) return readError("exit");
    let raw: unknown;
    try { raw = JSON.parse(result.stdout); } catch { return readError("format"); }
    if (!plain(raw) || raw.id !== campaign || !task(raw.revision) || typeof raw.held !== "boolean" || !Array.isArray(raw.reasons) || !raw.reasons.every(r => typeof r === "string") || !Array.isArray(raw.units) || raw.units.length > 128) return readError("format");
    // The shipped projection has no status field; it names non-current approval in reasons.
    if (raw.reasons.includes("campaign approval is not current")) return failed("campaign approval is not current", expected);
    const units = raw.units.filter(u => plain(u) && u.unitId === unit);
    if (!units.length) return failed("unit missing from current campaign revision", expected);
    if (units.length !== 1) return readError("format");
    const found = units[0] as Record<string, unknown>;
    if (found.taskId === null || found.state === "unknown") return failed("child task missing", expected);
    if (!task(found.taskId) || typeof found.state !== "string" || !states.includes(found.state)) return readError("unsupported");
    if (expected !== undefined && found.taskId !== expected) return failed("child task binding changed", expected);
    if (found.state === "cancelled") return failed("child task cancelled", found.taskId);
    const reference = { campaign, unit, campaignRevision: raw.revision, taskId: found.taskId, state: found.state };
    return { status: found.state === "approved" ? "done" : "dispatched", taskId: found.taskId,
      ...(found.state === "approved" ? { output: { ...reference, sha256: sha256(JSON.stringify(reference)) } } : {}),
      progress: JSON.stringify(reference) };
  } };
}
/** The first known binding of this node/revision remains pinned through retries. */
export function boundHubTask(events: LedgerEvent[], revision: number, node: string): number | undefined {
  return events.find(e => (e.type === "node.intent" || e.type === "node.observed") && e.data.revision === revision && e.data.node === node && task(e.data.taskId))?.data.taskId as number | undefined;
}
