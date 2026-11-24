import { join } from "node:path";
import type { LedgerEvent } from "../study.ts";

export const PAPER_DOCUMENTS = ["manuscript", "slides"] as const;
export type PaperDocument = typeof PAPER_DOCUMENTS[number];

export function paperDocument(value: unknown): PaperDocument {
  if (value === undefined || value === "manuscript") return "manuscript";
  if (value === "slides") return "slides";
  throw new Error("paper document: use manuscript or slides with --doc");
}

export function paperSourcePath(dir: string, doc: PaperDocument): string {
  return join(dir, "paper", `${doc}.md`);
}

export function paperEventFor(event: LedgerEvent, type: "paper.built" | "paper.rendered", doc: PaperDocument = "manuscript"): boolean {
  return event.type === type && (event.data.doc === doc || doc === "manuscript" && event.data.doc === undefined);
}
