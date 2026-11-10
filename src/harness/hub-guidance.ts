import {types} from "node:util";

export const HUB_GUIDANCE_READ_BYTES = 16 * 32_768 + 4096;
export type HubGuidanceSection = "Scope" | "Deliverables" | "Evidence";
export interface HubGuidanceMetadata {
  readonly id: string;
  readonly experimentId: string;
  readonly taskId: number;
  readonly taskCreated: number;
  readonly flowRevision: number;
  readonly roleId: string;
  readonly layer: "shipped" | "project";
  readonly baselineSha256: string;
  readonly candidateSha256: string;
  readonly changedSections: readonly HubGuidanceSection[];
  readonly bytes: Readonly<{baseline: number; candidate: number; record: number}>;
  readonly author: string;
  readonly status: "declared" | "withdrawn";
  readonly applicable: boolean;
  readonly evidence: readonly Readonly<{key: string; status: "declared" | "unavailable"}>[];
}
export type HubGuidanceReadProjection = {readonly state: "unavailable"}
  | {readonly state: "available"; readonly records: readonly HubGuidanceMetadata[]; readonly rationaleOmitted: true};

function invalid(): never {
  throw new Error("hub guidance read: invalid closed metadata shape or bounds; reload a supported public guidance read result and retry");
}

/** Only inert own JSON data is inspected, including for in-process callers. */
function object(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw)) invalid();
  const prototype = Object.getPrototypeOf(raw);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== fields.length) invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    if (typeof key !== "string" || !fields.includes(key)) invalid();
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function array(raw: unknown, maximum: number): unknown[] {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || !Array.isArray(raw)
    || Object.getPrototypeOf(raw) !== Array.prototype) invalid();
  const length = Object.getOwnPropertyDescriptor(raw, "length");
  if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maximum) invalid();
  const keys = Reflect.ownKeys(raw);
  if (keys.length !== length.value + 1) invalid();
  const result: unknown[] = [];
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) invalid();
    result.push(descriptor.value);
  }
  return result;
}

function text(raw: unknown, maximum: number): string {
  if (typeof raw !== "string" || !raw.length || raw.length > maximum || Buffer.byteLength(raw) > maximum) invalid();
  return raw;
}
function digest(raw: unknown): string {
  if (typeof raw !== "string" || raw.length !== 64 || !/^[a-f0-9]{64}$/.test(raw)) invalid();
  return raw;
}
function integer(raw: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < minimum || raw > maximum) invalid();
  return raw;
}
function token(raw: unknown, pattern: RegExp, maximum: number): string {
  const result = text(raw, maximum);
  if (!pattern.test(result)) invalid();
  return result;
}
function rationaleBytes(raw: unknown): number {
  const row = object(raw, ["problemHypothesis", "expectedObservableDifference"]);
  const result = {problemHypothesis: text(row.problemHypothesis, 2000), expectedObservableDifference: text(row.expectedObservableDifference, 2000)};
  const bytes = Buffer.byteLength(JSON.stringify(result));
  if (bytes > 2000) invalid();
  return bytes;
}

function record(raw: unknown): {metadata: HubGuidanceMetadata; sourceBytes: number} {
  const row = object(raw, ["id", "experimentId", "taskId", "taskCreated", "flowRevision", "roleId", "layer", "baselineSha256", "candidateSha256", "changedSections", "bytes", "author", "status", "applicable", "rationale", "evidence"]);
  const experimentId = text(row.experimentId, 256);
  if (/[\p{Cc}\p{Cs}]/u.test(experimentId)) invalid();
  if (row.layer !== "shipped" && row.layer !== "project") invalid();
  if (row.status !== "declared" && row.status !== "withdrawn") invalid();
  if (typeof row.applicable !== "boolean" || row.status === "withdrawn" && row.applicable) invalid();
  const changedSections = array(row.changedSections, 3).map(value => {
    if (value !== "Scope" && value !== "Deliverables" && value !== "Evidence") invalid();
    return value;
  });
  if (new Set(changedSections).size !== changedSections.length) invalid();
  const sizes = object(row.bytes, ["baseline", "candidate", "record"]);
  const evidence = array(row.evidence, 16).map(value => {
    const item = object(value, ["key", "status"]);
    if (item.status !== "declared" && item.status !== "unavailable") invalid();
    return Object.freeze({key: digest(item.key), status: item.status});
  });
  if (new Set(evidence.map(value => value.key)).size !== evidence.length) invalid();
  const metadata: HubGuidanceMetadata = Object.freeze({
    id: digest(row.id), experimentId, taskId: integer(row.taskId, 1), taskCreated: integer(row.taskCreated, 0), flowRevision: integer(row.flowRevision, 0),
    roleId: token(row.roleId, /^[a-z][a-z0-9-]{0,47}$/, 48), layer: row.layer,
    baselineSha256: digest(row.baselineSha256), candidateSha256: digest(row.candidateSha256), changedSections: Object.freeze(changedSections),
    bytes: Object.freeze({baseline: integer(sizes.baseline, 1, 8192), candidate: integer(sizes.candidate, 1, 8192), record: integer(sizes.record, 1, 32_768)}),
    author: token(row.author, /^[a-z][a-z0-9-]{0,31}$/, 32), status: row.status, applicable: row.applicable, evidence: Object.freeze(evidence),
  });
  const sourceBytes = Buffer.byteLength(JSON.stringify(metadata)) + Buffer.byteLength(',"rationale":') + rationaleBytes(row.rationale);
  return {metadata, sourceBytes};
}

/** Parse public lifecycle metadata, never private role snapshots or rationale output. */
export function parseHubGuidanceReadResult(raw: unknown): HubGuidanceReadProjection {
  if (typeof raw === "string") {
    if (raw.length > HUB_GUIDANCE_READ_BYTES || Buffer.byteLength(raw) > HUB_GUIDANCE_READ_BYTES) invalid();
    try {raw = JSON.parse(raw);} catch {invalid();}
  }
  // Inspect state without accessing an untrusted property or selecting a permissive shape.
  if (!raw || typeof raw !== "object" || types.isProxy(raw)) invalid();
  const state = Object.getOwnPropertyDescriptor(raw, "state");
  if (!state || !("value" in state) || !state.enumerable) invalid();
  if (state.value === "unavailable") {
    object(raw, ["state"]);
    return Object.freeze({state: "unavailable"});
  }
  if (state.value !== "available") invalid();
  const row = object(raw, ["state", "records"]);
  const parsed = array(row.records, 16).map(record);
  if (new Set(parsed.map(value => value.metadata.id)).size !== parsed.length) invalid();
  // Rationale text never leaves its validator; only byte counts cross the record boundary.
  const sourceBytes = Buffer.byteLength('{"state":"available","records":[]}')
    + parsed.reduce((sum, value) => sum + value.sourceBytes, 0) + Math.max(0, parsed.length - 1);
  if (sourceBytes > HUB_GUIDANCE_READ_BYTES) invalid();
  return Object.freeze({state: "available", records: Object.freeze(parsed.map(value => value.metadata)), rationaleOmitted: true});
}
