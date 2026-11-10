import { types } from "node:util";

/** Opaque source-owned address; it grants no resolver, path or evidence authority. */
export interface HubExecutionReferenceV1 {
  v: 1; tool: "ahub"; projectKey: string; kind: string; id: string; revision?: string; sha256?: string;
}
const invalid = (): never => { throw new Error("hub execution reference: unsupported fields or identifier bounds; supply a plain ahub v1 address with bounded identities and an optional lowercase 64-hex sha256"); };
const text = (value: unknown, bound: number): value is string => typeof value === "string" && value.length > 0 && value.length <= bound && Buffer.byteLength(value, "utf8") <= bound && !/[\p{Cc}\p{Cs}]/u.test(value);
/** Inspect descriptors before values so hostile objects cannot run getters or proxy traps. */
export function parseHubExecutionReference(raw: unknown): HubExecutionReferenceV1 {
  if (!raw || typeof raw !== "object" || types.isProxy(raw) || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Object.getOwnPropertySymbols(raw).length) return invalid();
  const fields = Object.getOwnPropertyDescriptors(raw), keys = ["v", "tool", "projectKey", "kind", "id", "revision", "sha256"];
  if (Object.entries(fields).some(([key, field]) => !keys.includes(key) || !("value" in field))) return invalid();
  const get = (key: string): unknown => fields[key]?.value;
  const projectKey = get("projectKey"), kind = get("kind"), id = get("id"), revision = get("revision"), sha256 = get("sha256");
  if (get("v") !== 1 || get("tool") !== "ahub" || !text(projectKey, 256) || !text(id, 256) || !text(kind, 64) || !/^[a-z][a-z0-9._-]*$/.test(kind) || Object.hasOwn(fields, "revision") && !text(revision, 128) || Object.hasOwn(fields, "sha256") && (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256))) return invalid();
  return {v: 1, tool: "ahub", projectKey, kind, id, ...(revision === undefined ? {} : {revision: revision as string}), ...(sha256 === undefined ? {} : {sha256: sha256 as string})};
}
