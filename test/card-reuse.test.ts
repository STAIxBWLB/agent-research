import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendFileSync, mkdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { loadCandidates } from "../src/lit/candidates.ts";
import { cardPath, readCard, validateCard } from "../src/lit/cards.ts";
import { checkPaper } from "../src/paper/check.ts";
import { readLedger } from "../src/study.ts";
import type { ProcessRequest, ProcessRunner } from "../src/exp/executor.ts";
import { createVaultClient } from "../src/memory/vault-cards.ts";
import { fakeHttp, fixture, ok, searchRoutes, status, tempDir } from "./helpers.ts";

const person = { kind: "person" as const };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const ARX = "arxiv:2502.04321", DOI = "doi:10.1234/jrl.2024.001", UNVERIFIED = "arxiv:2501.01234";

/**
 * A fake vault-mem CLI over in-memory notes that mirrors vmem 0.5.1: search matches the body plus the frontmatter
 * doi/citekey only (never arxiv_id), arguments starting with "-" are options, show pages by --max-bytes and reports
 * truncated, an unknown H2 exits 1 with "section: unknown H2 heading", and writes need --expected-sha.
 */
function fakeVault(notes: Record<string, string>) {
  const calls: string[][] = [];
  const opt = (args: string[], name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
  const parts = (text: string) => { const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!; return { head: m[1]!, body: m[2]! }; };
  const sections = (text: string, title: string) => [...text.matchAll(new RegExp(`(^|\\n)## ${title}\\n([\\s\\S]*?)(?=\\n## |$)`, "g"))].map(m => `## ${title}\n${m[2]}`);
  const runner: ProcessRunner = async (request: ProcessRequest) => {
    expect(request.command).toBe("vmem"); const args = request.args; calls.push(args);
    const reply = (exitCode: number, value: unknown, stderr = "") => ({ exitCode, stdout: exitCode ? "" : JSON.stringify(value), stderr });
    const [verb, , target] = args;
    if (args.slice(1).some((a, i) => a.startsWith("-") && !/^--(json|type|limit|max-bytes|section|markdown|expected-sha|old|new)$/.test(a) && !/^--/.test(args[i] ?? ""))) return reply(2, {}, `${verb}: unknown or repeated option`);
    if (verb === "search") return reply(0, Object.entries(notes).filter(([, text]) => {
      const { head, body } = parts(text), keys = [/^doi:\s*(\S+)/m.exec(head)?.[1], /^citekey:\s*(\S+)/m.exec(head)?.[1]].filter(Boolean).join("\n");
      // Like FTS: every whitespace-separated query token must occur in the indexed text.
      const haystack = `${body}\n${keys}`.toLowerCase();
      return target!.toLowerCase().split(/\s+/).every(token => haystack.includes(token));
    }).map(([path]) => ({ path, type: "reference" })));
    const note = notes[target!];
    if (note === undefined) return reply(1, {}, "note: unknown target");
    const max = Number(opt(args, "--max-bytes") ?? 65536);
    if (verb === "show") {
      const wanted = opt(args, "--section");
      if (wanted === undefined) return reply(0, { path: target, hash: hash(note), content: note.slice(0, max), ...(note.length > max ? { truncated: true } : {}) });
      const found = sections(note, wanted);
      if (found.length !== 1) return reply(1, {}, found.length ? "vmem: section: ambiguous H2 heading" : "vmem: section: unknown H2 heading");
      return reply(0, { path: target, hash: hash(note), content: found[0]!.slice(0, max), section: wanted, ...(found[0]!.length > max ? { truncated: true } : {}) });
    }
    if (opt(args, "--expected-sha") !== hash(note)) return reply(1, {}, "stale sha");
    if (verb === "append") { notes[target!] = `${note}\n## ${opt(args, "--section")}\n\n${opt(args, "--markdown")}\n`; return reply(0, { ok: true, applied: true }); }
    if (verb === "patch") { notes[target!] = note.replace(opt(args, "--old")!, opt(args, "--new")!); return reply(0, { ok: true, applied: true }); }
    return reply(2, {});
  };
  return { runner, notes, calls };
}
const reference = (key: string, value: string, extra = "", title = "Reference") => `---\ntype: reference\n${key}: ${value}\n${extra}---\n\n# ${title}\n\nSynthetic note.\n`;

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
// The arXiv note carries only arxiv_id in frontmatter and the paper title in its text; real vmem search indexes doi and
// citekey but never arxiv_id, so it must be found by title and then matched on arxiv_id exactly.
const vaultNotes = () => ({ "arxiv-ref.md": reference("arxiv_id", "2502.04321", "", "Cross-Family Review of Generated Papers"), "doi-ref.md": reference("doi", "10.1234/jrl.2024.001"), "other.md": reference("arxiv_id", "2401.00002", "", "Cross-Family Review of Generated Papers") });

test("vault client: arXiv-only notes resolve, option-like terms are never sent, truncation and broken card sections refuse", async () => {
  const big = "x: " + "y".repeat(70_000) + "\n";
  const vault = fakeVault({
    ...vaultNotes(),
    "long-head.md": reference("doi", "10.5/long", big),
    "dup.md": reference("doi", "10.5/dup") + "\n## ares card\n\n```json\n{}\n```\n\n## ares card\n\nx\n",
    "huge.md": reference("doi", "10.5/huge") + "\n## ares card\n\n```json\n" + "z".repeat(70_000) + "\n```\n",
    "noblock.md": reference("doi", "10.5/noblock") + "\n## ares card\n\nprose only\n",
  });
  const client = createVaultClient("test-vault", tempDir(), vault.runner, {});
  // P1: arxiv_id is not search-indexed, yet the note resolves by title and is matched exactly on arxiv_id.
  expect((await client.findReference({ arxivId: "2502.04321", title: "Cross-Family Review of Generated Papers" })).map(n => n.path)).toEqual(["arxiv-ref.md"]);
  // P2a: an identifier that starts with "-" is never passed to vmem as an argument.
  const before = vault.calls.length;
  expect(await client.findReference({ doi: "--limit", citekey: "-x" })).toEqual([]);
  expect(vault.calls.slice(before)).toEqual([]);
  // P2b: a frontmatter that does not close within the read bound refuses instead of being read as no identifier.
  await expect(client.findReference({ doi: "10.5/long" })).rejects.toThrow(/no complete frontmatter within 64 KiB/);
  // P2c: duplicated, oversized or block-less card sections refuse instead of reading as absent.
  await expect(client.readCard("dup.md")).rejects.toThrow(/could not read the ares card section/);
  await expect(client.readCard("huge.md")).rejects.toThrow(/exceeds 64 KiB/);
  await expect(client.readCard("noblock.md")).rejects.toThrow(/has no json block/);
  expect(await client.readCard("doi-ref.md")).toEqual({ hash: hash(vault.notes["doi-ref.md"]!) });
});

test("P2c: export never appends a second card section over one it cannot read", async () => {
  const source = await study(), notes = vaultNotes();
  notes["arxiv-ref.md"] += "\n## ares card\n\n```json\n" + "z".repeat(70_000) + "\n```\n";
  const vault = fakeVault(notes), ctx = { ...source.ctx, runner: vault.runner }, original = vault.notes["arxiv-ref.md"];
  await ops.card(source.dir, ARX, { summary: "Synthetic summary." }, source.ctx);
  const { fingerprint } = await ops.cardExport(source.dir, [ARX], { vault: "test-vault" }, ctx) as { fingerprint: string };
  await expect(ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: fingerprint }, ctx)).rejects.toThrow(/exceeds 64 KiB/);
  expect(vault.notes["arxiv-ref.md"]).toBe(original);
});

test("P2d: paper check reports an unreadable cited card instead of hiding it", async () => {
  const { dir, ctx } = await study();
  await ops.gateDecide(dir, "screen", "approve", undefined, ctx);
  await ops.bib(dir, ctx);
  const key = loadCandidates(dir).find(c => c.id === DOI)!.citekey!;
  mkdirSync(join(dir, "literature", "cards"), { recursive: true });
  writeFileSync(cardPath(dir, DOI), "{ not json");
  mkdirSync(join(dir, "paper"));
  writeFileSync(join(dir, "paper", "manuscript.md"), `Prior work [@${key}].\n`);
  const report = checkPaper(dir);
  expect(report.unreadableCards).toEqual([{ citekey: key, id: DOI, message: expect.stringMatching(/unreadable, invalid JSON.*record the card again/) }]);
  expect(report.reusedCards).toBeUndefined();
});

test("B1: export and import need the scope gate, and auto approvals ride in the command's commit", async () => {
  const source = await study(), vault = fakeVault(vaultNotes()), ctx = { ...source.ctx, runner: vault.runner };
  await ops.card(source.dir, ARX, { summary: "Synthetic summary." }, source.ctx);
  const { fingerprint } = await ops.cardExport(source.dir, [ARX], { vault: "test-vault" }, ctx) as { fingerprint: string };
  // Gates mode with a changed scope: the scope gate is pending, so both commands refuse before any vault call.
  await ops.autonomySet(source.dir, "gates", undefined, source.ctx);
  await ops.scope(source.dir, { question: "Changed question?" }, source.ctx);
  const calls = vault.calls.length, ledger = readFileSync(join(source.dir, "ledger.jsonl"));
  await expect(ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: fingerprint }, ctx)).rejects.toThrow(/gate scope is pending: run ares gate approve <dir> scope/);
  await expect(ops.cardImport(source.dir, [ARX], { vault: "test-vault" }, ctx)).rejects.toThrow(/gate scope is pending/);
  expect(vault.calls.length).toBe(calls); expect(readFileSync(join(source.dir, "ledger.jsonl"))).toEqual(ledger);
  // In auto mode the pending scope is approved automatically, and that approval is committed with the receipt.
  await ops.autonomySet(source.dir, "auto", undefined, source.ctx);
  await ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: fingerprint }, ctx);
  expect(readLedger(source.dir).slice(-2).map(e => [e.type, e.data.gate ?? null])).toEqual([["gate.approve", "scope"], ["lit.card.exported", null]]);
});

test("B2: a ledger without room for the receipt refuses before any vault write", async () => {
  const source = await study(), vault = fakeVault(vaultNotes()), ctx = { ...source.ctx, runner: vault.runner };
  await ops.card(source.dir, ARX, { summary: "Synthetic summary." }, source.ctx);
  const { fingerprint } = await ops.cardExport(source.dir, [ARX], { vault: "test-vault" }, ctx) as { fingerprint: string };
  const ledger = join(source.dir, "ledger.jsonl"), size = statSync(ledger).size;
  // Pad the ledger with blank lines (which the reader skips) to just under its 64 MiB bound.
  appendFileSync(ledger, "\n".repeat(64 * 1024 * 1024 - 300 - size));
  const original = vault.notes["arxiv-ref.md"], calls = vault.calls.length;
  await expect(ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: fingerprint }, ctx)).rejects.toThrow(/ledger\.jsonl would exceed/);
  expect(vault.calls.length).toBe(calls); expect(vault.notes["arxiv-ref.md"]).toBe(original);
  truncateSync(ledger, size);
}, 60_000);

test("B3: exported provenance names the actor who recorded the card, not the exporter", async () => {
  const source = await study(), vault = fakeVault(vaultNotes());
  await ops.card(source.dir, ARX, { summary: "Synthetic summary." }, source.ctx);
  const agent = { ...source.ctx, actor: { kind: "agent" as const, id: "exporter" }, runner: vault.runner };
  const preview = await ops.cardExport(source.dir, [ARX], { vault: "test-vault" }, agent) as { fingerprint: string; cards: { provenance: { extractor: { kind: string }; extractedAt: string } }[] };
  const recorded = readLedger(source.dir).filter(e => e.type === "lit.card" && e.data.id === ARX).at(-1)!;
  expect(preview.cards[0]!.provenance).toMatchObject({ extractor: { kind: "person" }, extractedAt: recorded.at });
  await ops.cardExport(source.dir, [ARX], { vault: "test-vault", confirm: preview.fingerprint }, agent);
  expect(vault.notes["arxiv-ref.md"]).toContain('"kind": "person"');
});

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
  expect(checkPaper(target.dir).reusedCards).toBeUndefined();
});
