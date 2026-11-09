import { runOnExecutor, type Executor, type ProcessRunner } from "./executor.ts";
import { plain } from "../study.ts";
import { RETENTION_SCRIPT } from "./retention-script.ts";

export const RETENTION_CAP = 1024 * 1024 * 1024;
export const RETENTION_ADMIN_RESERVATION = 256 * 1024;
export const RETENTION_RESERVATION = 256 * 1024 * 1024 + 256 * 1024 + RETENTION_ADMIN_RESERVATION;
export interface RetainedRef { attemptId: string; stage: string; sha256: string }
export interface RetainedFile { path: string; sha256: string; bytes: number }
export interface RetainedIdentity {
  definitionHash: string; inputHashes: Record<string, string>; codeTree: string;
  image: string; argvHash: string; envHash: string; seed: number; producerVersion: string;
}
export interface RetainedManifest {
  v: 1; studyId: string; attemptId: string; stage: string; identity: RetainedIdentity; reuseKey?: string;
  observed: { containerId: string; endedAt: string; exitCode: 0 };
  outputs: Record<string, string>; files: RetainedFile[]; directories: string[];
}
export type RetainedInput = { task: string } | { ref: RetainedRef; output?: string };
export type RetentionRequest = { studyId: string } & (
  | { op: "reserve"; attemptId: string; capBytes?: number; reservationBytes?: number }
  | { op: "release"; attemptId: string }
  | { op: "snapshot"; attemptId: string; source: string }
  | { op: "seal"; attemptId: string; stage: string; source: string; outputs: Record<string, string>; identity: RetainedIdentity; observed: RetainedManifest["observed"]; metadataLimit?: number; reuseKey?: string }
  | { op: "verify"; ref: RetainedRef }
  | { op: "lookup"; attemptId: string; stage: string; key: string; expected: RetainedIdentity; outputs: Record<string, string> }
  | { op: "materialize"; attemptId: string; stage: string; target: string; taskRoot: string; expectedTaskTreeHash?: string; codeRoot?: string; expectedCodeHash?: string; inputs: Record<string, RetainedInput> }
  | { op: "inspect"; offset?: number; limit?: number }
  | { op: "prune"; refs: RetainedRef[]; fingerprint?: string }
);
export interface RetentionResult {
  op: RetentionRequest["op"];
  hit?: boolean; reason?: "missing" | "pruned" | "corrupt" | "unsupported" | "ineligible-source" | "scan-cap"; ref?: RetainedRef;
  manifest?: RetainedManifest; sha256?: string; manifestBytes?: number; sidecarBytes?: number;
  inputHashes?: Record<string, string>; files?: RetainedFile[];
  entries?: { ref: RetainedRef; bytes: number; tombstone: boolean; active: boolean }[];
  capBytes?: number; usedBytes?: number; reservedBytes?: number; administrativeBytes?: number;
  reservations?: { attemptId: string; active: boolean; reservationBytes: number }[];
  fingerprint?: string; pruned?: number;
  archivedReservations?: number; offset?: number; limit?: number; total?: number; remaining?: number;
}
export class RetentionError extends Error {
  constructor(readonly code: "busy" | "transport" | "integrity", readonly retryable: boolean, reason: string) {
    super(`retention: ${reason}; inspect retained evidence and restore integrity before retrying`);
    this.name = "RetentionError";
  }
}
/** Executor-local bytes only. The caller owns study gates, attempt fences and observed container termination. */
export async function retainedOperation(executor: Executor, request: RetentionRequest, runner: ProcessRunner): Promise<RetentionResult> {
  const text = JSON.stringify(request);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("retention: request exceeds 1 MiB; reduce the declared manifest or selection");
  let result;
  try {
    result = await runOnExecutor(executor, "python3", ["-I", "-S", "-c", RETENTION_SCRIPT, executor.workdir], runner, {
      stdin: Buffer.from(text), timeoutMs: 300_000, maxOutputBytes: 1024 * 1024,
    });
  } catch { throw new RetentionError("transport", true, "executor operation unavailable"); }
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    let reason = "executor operation failed", native = false;
    try { const error: unknown = JSON.parse(result.stdout); if (plain(error) && typeof error.error === "string" && error.error.length <= 300) { reason = error.error; native = true; } } catch { /* Never expose executor stderr, paths or bodies. */ }
    const busy = reason.startsWith("retention operation busy");
    throw new RetentionError(busy ? "busy" : native ? "integrity" : "transport", busy || !native || result.timedOut === true || result.truncated === true, reason);
  }
  let value: unknown; try { value = JSON.parse(result.stdout); } catch { throw new RetentionError("transport", true, "malformed executor receipt"); }
  if (!plain(value) || value.op !== request.op) throw new RetentionError("transport", true, "mismatched executor receipt");
  return value as unknown as RetentionResult;
}
