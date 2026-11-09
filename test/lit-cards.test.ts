import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cardPath, readCard } from "../src/lit/cards.ts";
import { tempDir } from "./helpers.ts";

const ID = "doi:10.1234/jrl.2024.001", CARD = { id: ID, summary: "Reported effect.", claims: ["Effect holds."] };
/** The card's fixed address, with literature/cards in place so a link can be planted at the file itself. */
function address(dir: string): string { const path = cardPath(dir, ID); mkdirSync(dirname(path), { recursive: true }); return path; }

test("a regular card still reads, and an absent card stays missing", () => {
  const dir = tempDir(), path = address(dir);
  writeFileSync(path, JSON.stringify(CARD));
  expect(readCard(dir, ID)).toEqual({ id: ID, summary: "Reported effect.", claims: ["Effect holds."] });
  expect(readCard(dir, "doi:10.9999/absent")).toBeUndefined();
});

test("a card path linked to bytes outside literature/cards refuses instead of resolving", () => {
  const dir = tempDir(), path = address(dir), outside = join(dir, "outside.json");
  writeFileSync(outside, JSON.stringify(CARD));
  symlinkSync(outside, path);
  expect(() => readCard(dir, ID)).toThrow(/holds a link or special file/);
  expect(() => readCard(dir, ID)).toThrow(/restore the card from the ledger's lit\.card hash/);
});

test("a dangling link and a directory at the card path refuse rather than reading as missing", () => {
  const dir = tempDir();
  symlinkSync(join(dir, "absent.json"), address(dir));
  expect(() => readCard(dir, ID)).toThrow(/holds a link or special file/);
  const other = tempDir(), directory = address(other);
  mkdirSync(directory);
  expect(() => readCard(other, ID)).toThrow(/must be a regular physical file/);
});
