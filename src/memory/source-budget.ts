/** One check/accept owns one response budget; local producer projections and all amem stdio bytes share it. */
export const SOURCE_MS = 25_000, SOURCE_BYTES = 262_144;
export interface SourceBudget {remainingBytes: number; remainingMs(): number; consume(bytes: number): boolean; exhaust(): void}
export function sourceBudget(now: () => number = Date.now): SourceBudget {
  const start = now(), wallStart = performance.now(); let last = start;
  return {remainingBytes: SOURCE_BYTES,
    remainingMs() {const current = now(); if (!Number.isFinite(current) || current < last || !Number.isFinite(start)) return 0; last = current; return Math.max(0, Math.min(SOURCE_MS - (current - start), SOURCE_MS - (performance.now() - wallStart)));},
    consume(bytes) {if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > this.remainingBytes) {this.remainingBytes = 0; return false;} this.remainingBytes -= bytes; return this.remainingMs() > 0;},
    exhaust() {this.remainingBytes = 0;},
  };
}
