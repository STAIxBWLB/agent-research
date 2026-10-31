import { join } from "node:path";
import { boundedText, onlyKeys, plain, sha256 } from "../study.ts";

export interface Card { summary: string; claims: string[]; methods?: string; findings?: string; limitations?: string; relevance?: string }
const OPTIONAL = ["methods", "findings", "limitations", "relevance"] as const;

export function validateCard(raw: unknown): Card {
  if (!plain(raw)) throw new Error("card: JSON object required");
  onlyKeys(raw, ["summary", "claims", ...OPTIONAL], "card");
  const claims = raw.claims ?? [];
  if (!Array.isArray(claims) || claims.length > 50) throw new Error("card.claims: list of at most 50");
  const card: Card = { summary: boundedText(raw.summary, "card.summary", 4000), claims: claims.map((c, i) => boundedText(c, `card.claims[${i}]`, 1000)) };
  for (const key of OPTIONAL) if (raw[key] !== undefined) card[key] = boundedText(raw[key], `card.${key}`, 4000);
  return card;
}

/** A readable, collision-free file name for a candidate id such as `doi:10.1/x`. */
export function cardPath(dir: string, id: string): string {
  const readable = id.toLowerCase().replace(/[^a-z0-9.-]+/g, "_").slice(0, 80);
  return join(dir, "literature", "cards", `${readable}-${sha256(id).slice(0, 8)}.json`);
}
