import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { loadCandidates } from "../src/lit/candidates.ts";
import { cardPath, readCard, validateCard } from "../src/lit/cards.ts";
import { checkPaper } from "../src/paper/check.ts";
import { readLedger } from "../src/study.ts";
import type { ProcessRequest, ProcessRunner } from "../src/exp/executor.ts";
import { fakeHttp, fixture, ok, searchRoutes, status, tempDir } from "./helpers.ts";

const person = { kind: "person" as const };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const ARX = "arxiv:2502.04321", DOI = "doi:10.1234/jrl.2024.001", UNVERIFIED = "arxiv:2501.01234";

/** A fake vault-mem CLI over in-memory notes: search, show (whole/section), append and patch with --expected-sha. */
function fakeVault(notes: Record<string, string>) {
  const calls: string[][] = [];
  const opt = (args: string[], name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const section = (text: string, title: string) => { const m = new RegExp(`(^|\\n)## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`).exec(text); return m ? `## ${title}\n${m[2]}` : undefined; };
  const runner: ProcessRunner = async (request: ProcessRequest) => {
    expect(request.command).toBe("vmem"); const args = request.args; calls.push(args);
    const reply = (exitCode: number, value: unknown) => ({ exitCode, stdout: JSON.stringify(value), stderr: "" });
    const [verb, , target] = args;
    if (verb === "search") return reply(0, Object.entries(notes).filter(([, text]) => text.includes(target!)).map(([path]) => ({ path, type: "reference" })));
    const note = notes[target!];
    if (note === undefined) return reply(1, { error: "unknown target" });
    if (verb === "show") {
      const wanted = opt(args, "--section");
      if (wanted === undefined) return reply(0, { path: target, hash: hash(note), content: note.slice(0, Number(opt(args, "--max-bytes"))) });
      const part = section(note, wanted);
      return part === undefined ? reply(1, { error: "unknown H2" }) : reply(0, { path: target, hash: hash(note), content: part });
    }
    if (opt(args, "--expected-sha") !== hash(note)) return reply(1, { ok: false, applied: false });
    if (verb === "append") { notes[target!] = `${note}\n## ${opt(args, "--section")}\n\n${opt(args, "--markdown")}\n`; return reply(0, { ok: true, applied: true }); }
    if (verb === "patch") { notes[target!] = note.replace(opt(args, "--old")!, opt(args, "--new")!); return reply(0, { ok: true, applied: true }); }
    return reply(2, {});
  };
  return { runner, notes, calls };
}
const reference = (key: string, value: string) => `---\ntype: reference\n${key}: ${value}\n---\n\n# Reference\n\nSynthetic note.\n`;

async function study() {
  const dir = join(tempDir(), "s");
  ops.init(dir, { question: "Q?", autonomy: "auto" }, { actor: person });
  const fake = fakeHttp([
    ...searchRoutes(),
    ["https://api.crossref.org/works/10.1234/jrl.2024.001", ok(fixture("crossref.json"))],
    ["https://api.crossref.org/", status(404)],
    ["https://api.datacite.org/dois/10.5555/budget.2025.7", ok(fixture("datacite.json"))],
    ["https://export.arxiv.org/api/query?id_list=", ok(fixture("arxiv-search.xml"))],
  ]);
  const ctx = { actor: person, http: fake.http, sleep: async () => {} };
  await ops.scope(dir, { question: "Q?" }, ctx);
  await ops.search(dir, "agent review", {}, ctx);
  await ops.screen(dir, [DOI, ARX, UNVERIFIED], "include", undefined, ctx);
  await ops.verify(dir, [], ctx);
  return { dir, ctx };
}
const vaultNotes = () => ({ "arxiv-ref.md": reference("arxiv_id", "2502.04321"), "doi-ref.md": reference("doi", "10.1234/jrl.2024.001"), "other.md": reference("doi", "10.9/other 2502.04321") });

test("AC1: export previews and needs the fingerprint; import refuses unverified identifiers", async () => {
  const source = await study(), vault = fakeVault(vaultNotes());
  await ops.card(source.dir, ARX, { summary: "Synthetic summary.", claims: ["Synthetic claim."], datasets: "Synthetic dataset." }, source.ctx);
  const ctx = { ...source.ctx, runner: vault.runner }, ledger = readFileSync(join(source.dir, "ledger.jsonl"));
  const preview = await ops.cardExport(source.dir, [ARX], { vault: "test-vault", modelFamily: "Family-A" }, ctx) as { fingerprint: string; cards: { provenance: { studySha256: string; extractor: unknown } }[] };
  expect(vault.calls).toEqual([]); expect(readFileSync(join(source.dir, "ledger.jsonl"))).toEqual(ledger);
  expect(preview.cards[0]!.provenance.extractor).toEqual({ kind: "person", modelFamily: "family-a" });
  expect(preview.cards[0]!.provenance.studySha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: "0".repeat(64) }, ctx)).rejects.toThrow(/stale fingerprint; run ares lit card export again without --confirm/);
  const done = await ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: preview.fingerprint, modelFamily: "Family-A" }, ctx) as { written: { note: string }[] };
  expect(done.written).toEqual([expect.objectContaining({ id: ARX, note: "arxiv-ref.md" })]);
  expect(vault.notes["arxiv-ref.md"]).toContain("## ares card"); expect(vault.notes["arxiv-ref.md"]).not.toContain("Q?");
  expect(readLedger(source.dir).at(-1)).toMatchObject({ type: "lit.card.exported", data: { vault: "test-vault", fingerprint: preview.fingerprint } });
  // Exporting the same bytes again leaves the note unchanged.
  const before = vault.notes["arxiv-ref.md"];
  await ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: preview.fingerprint, modelFamily: "Family-A" }, ctx);
  expect(vault.notes["arxiv-ref.md"]).toBe(before);
  // Export refuses a candidate without a verified identifier.
  await ops.card(source.dir, UNVERIFIED, { summary: "Unverified card." }, source.ctx);
  await expect(ops.cardExport(source.dir, [UNVERIFIED], { vault: "test-vault" }, ctx)).rejects.toThrow(/no identifier verified in this study; run ares lit verify first/);

  // A second study imports the card; an unverified identifier refuses before any vault call or write.
  const target = await study(), targetCtx = { ...target.ctx, runner: vault.runner }, calls = vault.calls.length, targetLedger = readFileSync(join(target.dir, "ledger.jsonl"));
  await expect(ops.cardImport(target.dir, [UNVERIFIED], { vault: "test-vault" }, targetCtx)).rejects.toThrow(/no identifier verified in this study; run ares lit verify first/);
  expect(vault.calls.length).toBe(calls); expect(readFileSync(join(target.dir, "ledger.jsonl"))).toEqual(targetLedger);
  const imported = await ops.cardImport(target.dir, [ARX], { vault: "test-vault" }, targetCtx);
  expect(imported.imported).toEqual([expect.objectContaining({ id: ARX, note: "arxiv-ref.md" })]);
  const card = readCard(target.dir, ARX)!;
  expect(card).toMatchObject({ summary: "Synthetic summary.", datasets: "Synthetic dataset.", reused: { from: "vault", vault: "test-vault", note: "arxiv-ref.md", provenance: { extractor: { kind: "person", modelFamily: "family-a" } } } });
  // A note without a card section refuses with the next step.
  await expect(ops.cardImport(target.dir, [DOI], { vault: "test-vault" }, targetCtx)).rejects.toThrow(/has no ares card section; export a card to it first/);
});

test("AC2: a reused card never changes verification, screening or gate state", async () => {
  const source = await study(), vault = fakeVault(vaultNotes());
  await ops.card(source.dir, ARX, { summary: "Synthetic summary." }, source.ctx);
  const ctx = { ...source.ctx, runner: vault.runner };
  const { fingerprint } = await ops.cardExport(source.dir, [ARX], { vault: "test-vault" }, ctx) as { fingerprint: string };
  await ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: fingerprint }, ctx);
  const target = await study(), candidatesFile = join(target.dir, "literature", "candidates.json");
  await ops.gateDecide(target.dir, "screen", "approve", undefined, target.ctx);
  const candidates = readFileSync(candidatesFile), gates = JSON.stringify(ops.gateList(target.dir));
  await ops.cardImport(target.dir, [ARX], { vault: "test-vault" }, { ...target.ctx, runner: vault.runner });
  expect(readFileSync(candidatesFile)).toEqual(candidates);
  expect(JSON.stringify(ops.gateList(target.dir))).toBe(gates);
  const events = readLedger(target.dir).at(-1)!;
  expect(events.type).toBe("lit.card.imported");
  expect(loadCandidates(target.dir).map(c => [c.id, c.status, c.verify?.exists])).toEqual(JSON.parse(candidates.toString()).map((c: { id: string; status: string; verify?: { exists: string } }) => [c.id, c.status, c.verify?.exists]));
  // A user card file cannot carry `reused`; only import sets it.
  expect(() => validateCard({ summary: "x", reused: { from: "vault" } })).toThrow(/unknown field reused/);
});

test("AC3: new optional fields validate and old cards read unchanged", async () => {
  const { dir, ctx } = await study();
  expect(validateCard({ summary: "s", datasets: "d", results: "r", motivation: "m" })).toEqual({ summary: "s", claims: [], datasets: "d", results: "r", motivation: "m" });
  expect(() => validateCard({ summary: "s", results: "x".repeat(4001) })).toThrow(/card\.results/);
  expect(() => validateCard({ summary: "s", motivation: 3 })).toThrow(/card\.motivation/);
  // An N-1 card file with only the original fields reads exactly as written.
  mkdirSync(join(dir, "literature", "cards"), { recursive: true });
  const old = { id: DOI, summary: "Old summary.", claims: ["Old claim."], methods: "Old methods." };
  writeFileSync(cardPath(dir, DOI), JSON.stringify(old, null, 2) + "\n");
  expect(readCard(dir, DOI)).toEqual(old);
  expect(ops.cardList(dir).cards).toEqual([{ id: DOI, status: "included", fields: ["summary", "claims", "methods"], reused: null }]);
  await ops.card(dir, ARX, { summary: "New.", results: "Synthetic result." }, ctx);
  expect(readCard(dir, ARX)).toEqual({ id: ARX, summary: "New.", claims: [], results: "Synthetic result." });
});

test("AC4: provenance is shown wherever a reused card is referenced, CLI and MCP alike", async () => {
  const source = await study(), vault = fakeVault(vaultNotes());
  await ops.card(source.dir, ARX, { summary: "Synthetic summary." }, source.ctx);
  const sctx = { ...source.ctx, runner: vault.runner };
  const { fingerprint } = await ops.cardExport(source.dir, [ARX], { vault: "test-vault", modelFamily: "family-a" }, sctx) as { fingerprint: string };
  await ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: fingerprint, modelFamily: "family-a" }, sctx);
  const target = await study();
  await ops.cardImport(target.dir, [ARX], { vault: "test-vault" }, { ...target.ctx, runner: vault.runner });
  const listed = ops.cardList(target.dir).cards.find(c => c.id === ARX)!;
  expect(listed.reused).toMatchObject({ note: "arxiv-ref.md", provenance: { extractor: { modelFamily: "family-a" } } });
  expect(await createAresMcp({}).handlers.ares_lit_card_list!({ study: target.dir })).toEqual(ops.cardList(target.dir));
  expect(JSON.parse((await run(["lit", "card", "list", target.dir, "--json"], {})).text)).toEqual(JSON.parse(JSON.stringify(ops.cardList(target.dir))));
  // paper check (and review show through its check field) marks citations backed by reused cards.
  await ops.gateDecide(target.dir, "screen", "approve", undefined, target.ctx);
  await ops.bib(target.dir, target.ctx);
  const key = loadCandidates(target.dir).find(c => c.id === ARX)!.citekey!;
  mkdirSync(join(target.dir, "paper"));
  writeFileSync(join(target.dir, "paper", "manuscript.md"), `Prior work [@${key}].\n`);
  const report = checkPaper(target.dir);
  expect(report.reusedCards).toEqual([expect.objectContaining({ citekey: key, id: ARX, note: "arxiv-ref.md", provenance: expect.objectContaining({ extractor: { kind: "person", modelFamily: "family-a" } }) })]);
  expect(report.citations.notVerified).toEqual([]);
  // Cited candidates with their own cards are not marked.
  await ops.card(target.dir, DOI, { summary: "Own card." }, target.ctx);
  const own = loadCandidates(target.dir).find(c => c.id === DOI)!.citekey!;
  writeFileSync(join(target.dir, "paper", "manuscript.md"), `Prior work [@${own}].\n`);
  expect(checkPaper(target.dir).reusedCards).toEqual([]);
});
