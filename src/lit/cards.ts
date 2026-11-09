import { existsSync } from "node:fs";
import { join } from "node:path";
import { boundedText, onlyKeys, plain, readTextBounded, sha256 } from "../study.ts";

export interface Card { summary: string; claims: string[]; methods?: string; findings?: string; limitations?: string; relevance?: string; datasets?: string; results?: string; motivation?: string }
const OPTIONAL = ["methods", "findings", "limitations", "relevance", "datasets", "results", "motivation"] as const;
export const CARD_FIELDS = ["summary", "claims", ...OPTIONAL] as const;
export const CARD_BYTES = 65_536;

/** Who extracted a card, carried with it when it travels through the vault. */
export interface CardProvenance { studySha256: string; extractedAt: string; extractor: { kind: "person" | "agent" | "auto"; modelFamily?: string } }
/** Stored only by `lit card import`: a planning aid copied from a vault note, never verification, screening or support evidence. */
export interface CardReuse { from: "vault"; vault: string; note: string; at: string; provenance: CardProvenance }
export interface StoredCard extends Card { id: string; reused?: CardReuse }

/** User card input: the original closed field set plus the optional datasets/results/motivation. `reused` is never accepted here. */
export function validateCard(raw: unknown): Card {
  if (!plain(raw)) throw new Error("card: JSON object required");
  onlyKeys(raw, CARD_FIELDS, "card");
  const claims = raw.claims ?? [];
  if (!Array.isArray(claims) || claims.length > 50) throw new Error("card.claims: list of at most 50");
  const card: Card = { summary: boundedText(raw.summary, "card.summary", 4000), claims: claims.map((c, i) => boundedText(c, `card.claims[${i}]`, 1000)) };
  for (const key of OPTIONAL) if (raw[key] !== undefined) card[key] = boundedText(raw[key], `card.${key}`, 4000);
  return card;
}

const HEX64 = /^[a-f0-9]{64}$/, FAMILY = /^[a-z0-9][a-z0-9 ._-]{0,47}$/;
export function validateProvenance(raw: unknown, what: string): CardProvenance {
  if (!plain(raw)) throw new Error(`${what}: object required`);
  onlyKeys(raw, ["studySha256", "extractedAt", "extractor"], what);
  if (typeof raw.studySha256 !== "string" || !HEX64.test(raw.studySha256)) throw new Error(`${what}.studySha256: 64-hex study hash required`);
  if (typeof raw.extractedAt !== "string" || !Number.isFinite(Date.parse(raw.extractedAt))) throw new Error(`${what}.extractedAt: ISO time required`);
  if (!plain(raw.extractor)) throw new Error(`${what}.extractor: object required`);
  onlyKeys(raw.extractor, ["kind", "modelFamily"], `${what}.extractor`);
  const kind = raw.extractor.kind;
  if (kind !== "person" && kind !== "agent" && kind !== "auto") throw new Error(`${what}.extractor.kind: person, agent or auto`);
  const family = raw.extractor.modelFamily;
  if (family !== undefined && (typeof family !== "string" || !FAMILY.test(family))) throw new Error(`${what}.extractor.modelFamily: lower-case label of at most 48 characters`);
  return { studySha256: raw.studySha256, extractedAt: raw.extractedAt, extractor: { kind, ...(family !== undefined ? { modelFamily: family as string } : {}) } };
}

/** A stored card file: the user fields plus id and, for imported cards, the reuse record. */
export function readCard(dir: string, id: string): StoredCard | undefined {
  const path = cardPath(dir, id);
  if (!existsSync(path)) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(readTextBounded(path, CARD_BYTES)); }
  catch { throw new Error(`card ${id}: unreadable, invalid JSON or larger than 64 KiB; restore ${join("literature", "cards")} from the ledger's lit.card hash or record the card again`); }
  if (!plain(raw) || raw.id !== id) throw new Error(`card ${id}: malformed or belongs to another candidate; record the card again with ares lit card`);
  const { id: _id, reused, ...fields } = raw;
  const card: StoredCard = { id, ...validateCard(fields) };
  if (reused !== undefined) {
    if (!plain(reused)) throw new Error(`card ${id}.reused: object required`);
    onlyKeys(reused, ["from", "vault", "note", "at", "provenance"], `card ${id}.reused`);
    if (reused.from !== "vault" || typeof reused.vault !== "string" || typeof reused.note !== "string" || typeof reused.at !== "string") throw new Error(`card ${id}.reused: from, vault, note and at required; re-import the card`);
    card.reused = { from: "vault", vault: boundedText(reused.vault, "reused.vault", 64), note: boundedText(reused.note, "reused.note", 200), at: reused.at, provenance: validateProvenance(reused.provenance, `card ${id}.reused.provenance`) };
  }
  return card;
}

/** A readable, collision-free file name for a candidate id such as `doi:10.1/x`. */
export function cardPath(dir: string, id: string): string {
  const readable = id.toLowerCase().replace(/[^a-z0-9.-]+/g, "_").slice(0, 80);
  return join(dir, "literature", "cards", `${readable}-${sha256(id).slice(0, 8)}.json`);
}
