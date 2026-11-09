import { onlyKeys, plain } from "../study.ts";

/** A reviewable declaration, never evidence of determinism or an approval receipt. */
export interface StageReuseContract {
  v: 1;
  kind: "pure-artifact";
  inputs: "declared-only";
  externalState: "none";
  writableState: "fresh-output-only";
  modelOutputs: "forbidden";
  determinism: "byte-exact";
  toolchain: { description: string; documentationSha256: string };
}
export const REUSE_DESCRIPTION_BYTES = 1024;
export const STAGE_REUSE_CONTRACT_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["v", "kind", "inputs", "externalState", "writableState", "modelOutputs", "determinism", "toolchain"],
  properties: {
    v: { type: "integer", enum: [1] }, kind: { type: "string", enum: ["pure-artifact"] },
    inputs: { type: "string", enum: ["declared-only"] }, externalState: { type: "string", enum: ["none"] },
    writableState: { type: "string", enum: ["fresh-output-only"] }, modelOutputs: { type: "string", enum: ["forbidden"] },
    determinism: { type: "string", enum: ["byte-exact"] },
    toolchain: { type: "object", additionalProperties: false, required: ["description", "documentationSha256"], properties: {
      description: { type: "string", minLength: 1, maxLength: REUSE_DESCRIPTION_BYTES },
      documentationSha256: { type: "string", minLength: 64, maxLength: 64 },
    } },
  },
};
export function reuseIdentityText(raw: unknown, label: string, bytes = 128): string {
  if (typeof raw !== "string" || !raw.trim() || /\p{Cc}/u.test(raw) || Buffer.byteLength(raw) > bytes) throw new Error(`${label}: nonblank bounded text without control characters required`);
  return raw;
}
export function reuseDigest(raw: unknown, label: string, length = 64): string {
  if (typeof raw !== "string" || raw.length !== length || !/^[a-f0-9]+$/.test(raw)) throw new Error(`${label}: ${length} lowercase hex digits required`);
  return raw;
}
export function validateReuseContract(raw: unknown): StageReuseContract {
  if (!plain(raw)) throw new Error("stage reuse contract: object required");
  onlyKeys(raw, STAGE_REUSE_CONTRACT_SCHEMA.required, "stage reuse contract");
  if (raw.v !== 1) throw new Error("stage reuse contract: unsupported version; retain the original declaration and use a compatible reader");
  if (raw.kind !== "pure-artifact" || raw.inputs !== "declared-only" || raw.externalState !== "none" || raw.writableState !== "fresh-output-only" || raw.modelOutputs !== "forbidden" || raw.determinism !== "byte-exact") throw new Error("stage reuse contract: declare byte-exact pure artifacts, complete declared inputs, no external state, fresh output only and no model-output caching");
  if (!plain(raw.toolchain)) throw new Error("stage reuse toolchain: documented deterministic toolchain required");
  onlyKeys(raw.toolchain, ["description", "documentationSha256"], "stage reuse toolchain");
  return { v: 1, kind: "pure-artifact", inputs: "declared-only", externalState: "none", writableState: "fresh-output-only", modelOutputs: "forbidden", determinism: "byte-exact", toolchain: {
    description: reuseIdentityText(raw.toolchain.description, "stage reuse toolchain description", REUSE_DESCRIPTION_BYTES),
    documentationSha256: reuseDigest(raw.toolchain.documentationSha256, "stage reuse toolchain documentation digest"),
  } };
}
