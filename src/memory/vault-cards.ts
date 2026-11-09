import { PROCESS_CONTEXT_ENV_KEYS, spawnRunner, type ProcessRunner } from "../exp/executor.ts";
import { isVerified, loadCandidates, type Candidate } from "../lit/candidates.ts";
import { CARD_BYTES, CARD_FIELDS, cardPath, readCard, validateCard, validateProvenance, type Card, type CardProvenance, type StoredCard } from "../lit/cards.ts";
import { boundedText, commit, onlyKeys, openStudy, plain, readLedger, sha256, withLock, type Actor } from "../study.ts";

/**
 * Cross-study card reuse through vault-mem reference notes (#101). A reused card is a planning aid only:
 * nothing here touches verification, screening, gates or the bibliography.
 */
export const VAULT_OUTPUT_BYTES = 262_144, CARD_SECTION = "ares card", MAX_CARD_IDS = 50;
const VAULT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/, NOTE = /^[a-z0-9][a-z0-9._-]{0,199}$/, SHA = /^[a-f0-9]{64}$/;
export interface VaultNoteRef { path: string; doi?: string; arxivId?: string }
export interface VaultClient {
  /** Reference notes whose frontmatter doi/arxiv_id equals the identifier exactly. */
  findReference(identifier: { doi?: string; arxivId?: string; citekey?: string; title?: string }): Promise<VaultNoteRef[]>;
  /** The note's current hash and the ares card block, or undefined when the note has no card section. */
  readCard(path: string): Promise<{ hash: string; block?: string }>;
  /** Append the card section, guarded by the hash just read. */
  appendCard(path: string, expectedSha: string, markdown: string): Promise<void>;
  /** Replace an existing card section's block, guarded by the hash just read. */
  replaceCard(path: string, expectedSha: string, oldBlock: string, newBlock: string): Promise<void>;
}

function fail(what: string): never { throw new Error(`vault-mem ${what}; check vmem --version and vmem status, then retry`); }
/** The process boundary returns projections only; raw output and note bodies never reach errors or the study. */
export function createVaultClient(vault: string, cwd: string, runner: ProcessRunner = spawnRunner, env: NodeJS.ProcessEnv = process.env): VaultClient {
  if (!VAULT_ID.test(vault)) throw new Error("--vault: registered vault id (lower-case letters, digits, - or _); list them with vmem vaults list");
  const context = Object.fromEntries([...PROCESS_CONTEXT_ENV_KEYS, "HOME", "PATH", "VMEM_HOME"].flatMap(key => env[key] === undefined ? [] : [[key, env[key]!]]));
  const call = async (args: string[], stdin?: string): Promise<{ code: number; json: unknown; unknownSection: boolean }> => {
    let result;
    try { result = await runner({ command: "vmem", args: [...args, "--json"], cwd, env: context, ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin, "utf8") }), maxOutputBytes: VAULT_OUTPUT_BYTES, timeoutMs: 30_000 }); }
    catch { fail("spawn failure (is vmem on PATH?)"); }
    if (result.truncated || Buffer.byteLength(result.stdout) > VAULT_OUTPUT_BYTES) fail("over-bound output");
    if (result.timedOut) fail("timeout");
    let json: unknown;
    try { json = result.stdout.trim() ? JSON.parse(result.stdout) : undefined; } catch { fail("bad JSON"); }
    // Only this exact diagnostic is classified; stderr is never copied into errors or the study.
    return { code: result.exitCode, json, unknownSection: result.exitCode !== 0 && /section: unknown H2 heading/.test(result.stderr) };
  };
  const notePath = (path: string) => { if (!NOTE.test(path)) fail("returned an invalid note path"); return path; };
  // vmem parses any argument that starts with "-" as an option and has no "--" separator, so such terms are never sent.
  const term = (value: string) => value && !value.startsWith("-") && Buffer.byteLength(value) <= 1024 && !/[\r\n]/.test(value) ? value : undefined;
  return {
    async findReference(identifier) {
      // vault-mem indexes a reference note's doi and citekey for search, not arxiv_id. An arXiv-only candidate is found
      // through its arXiv DOI, its citekey, the bare id or its title in the note text; every hit is then matched on
      // frontmatter exactly, so a broad title search can never select the wrong note.
      const title = identifier.title?.replace(/[^\p{L}\p{N}\s]+/gu, " ").trim().split(/\s+/).slice(0, 12).join(" ");
      const terms = [...new Set([identifier.doi, identifier.arxivId ? `10.48550/arxiv.${identifier.arxivId.replace(/v\d+$/, "")}` : undefined, identifier.citekey, identifier.arxivId?.replace(/v\d+$/, ""), identifier.arxivId ? title : undefined].flatMap(v => v && term(v) ? [v] : []))];
      const paths = new Set<string>();
      for (const query of terms) {
        const { code, json } = await call(["search", vault, query, "--type", "reference", "--limit", "20"]);
        if (code !== 0 || !Array.isArray(json)) fail("search failed");
        for (const row of json) { if (!plain(row) || typeof row.path !== "string") fail("search returned an invalid row"); paths.add(notePath(row.path)); }
      }
      const found: VaultNoteRef[] = [], wantDoi = identifier.doi?.toLowerCase(), wantArxiv = identifier.arxivId?.replace(/v\d+$/, "");
      for (const path of paths) {
        const shown = await call(["show", vault, path, "--max-bytes", "65536"]);
        if (shown.code !== 0 || !plain(shown.json) || typeof shown.json.content !== "string") fail("show failed");
        const head = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(shown.json.content)?.[1];
        // A frontmatter block that does not close within the read bound is refused, never read as "no identifier".
        if (head === undefined) fail(`note ${path} has no complete frontmatter within 64 KiB`);
        const doi = /^doi:\s*["']?([^"'\s]+)["']?\s*$/m.exec(head)?.[1]?.toLowerCase(), arxivId = /^arxiv_id:\s*["']?([^"'\s]+)["']?\s*$/m.exec(head)?.[1]?.replace(/v\d+$/, "");
        const arxivDoi = doi && /^10\.48550\/arxiv\.(.+)$/.exec(doi)?.[1];
        if ((wantDoi && doi === wantDoi) || (wantArxiv && (arxivId === wantArxiv || arxivDoi === wantArxiv.toLowerCase()))) found.push({ path, ...(doi ? { doi } : {}), ...(arxivId ? { arxivId } : {}) });
      }
      return found;
    },
    async readCard(path) {
      const whole = await call(["show", vault, notePath(path), "--max-bytes", "1"]);
      if (whole.code !== 0 || !plain(whole.json) || typeof whole.json.hash !== "string" || !SHA.test(whole.json.hash)) fail("show failed");
      const section = await call(["show", vault, path, "--section", CARD_SECTION, "--max-bytes", "65536"]);
      if (section.code !== 0) { if (section.unknownSection) return { hash: whole.json.hash }; fail(`could not read the ${CARD_SECTION} section (it may be duplicated)`); }
      if (!plain(section.json) || typeof section.json.content !== "string" || section.json.hash !== whole.json.hash) fail("show changed during the read");
      // A section over the bound is refused rather than read as absent, so export never appends a second card section.
      if (section.json.truncated === true) fail(`the ${CARD_SECTION} section of ${path} exceeds 64 KiB; shorten it in the vault note`);
      const blocks = [...section.json.content.matchAll(/```json\n([\s\S]*?)\n```/g)];
      if (blocks.length > 1) fail(`the ${CARD_SECTION} section of ${path} holds more than one json block; keep one`);
      if (!blocks.length) fail(`the ${CARD_SECTION} section of ${path} has no json block; restore it or remove the section`);
      return { hash: whole.json.hash, block: blocks[0]![1]! };
    },
    async appendCard(path, expectedSha, markdown) {
      const { code, json } = await call(["append", vault, notePath(path), "--section", CARD_SECTION, "--markdown", markdown, "--expected-sha", expectedSha]);
      if (code !== 0 || !plain(json) || json.ok !== true || json.applied !== true) fail("append refused (the note may have changed or failed validation)");
    },
    async replaceCard(path, expectedSha, oldBlock, newBlock) {
      const { code, json } = await call(["patch", vault, notePath(path), "--old", oldBlock, "--new", newBlock, "--expected-sha", expectedSha]);
      if (code !== 0 || !plain(json) || json.ok !== true || json.applied !== true) fail("patch refused (the note may have changed or failed validation)");
    },
  };
}

/** The vault payload: card fields plus provenance, the study hashed and nothing else from the study. */
interface VaultCardPayload { v: 1; card: Card; provenance: CardProvenance }
function payloadText(payload: VaultCardPayload): string { return JSON.stringify(payload, null, 2); }
function parsePayload(text: string, where: string): VaultCardPayload {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`${where}: the ares card block is not valid JSON; fix or re-export the card in the vault note`); }
  if (!plain(raw)) throw new Error(`${where}: card block must be an object`);
  onlyKeys(raw, ["v", "card", "provenance"], where);
  if (raw.v !== 1) throw new Error(`${where}: unsupported card block version; use an ares version that supports it`);
  return { v: 1, card: validateCard(raw.card), provenance: validateProvenance(raw.provenance, `${where}.provenance`) };
}
const identifierOf = (c: Candidate) => ({ ...(c.doi ? { doi: c.doi } : {}), ...(c.arxivId ? { arxivId: c.arxivId } : {}), ...(c.citekey ? { citekey: c.citekey } : {}), title: c.title });

function cardIds(values: string[]): string[] {
  if (!values.length || values.length > MAX_CARD_IDS) throw new Error(`lit card: give 1..${MAX_CARD_IDS} candidate ids`);
  const ids = values.map((v, i) => boundedText(v, `id[${i}]`, 300));
  if (new Set(ids).size !== ids.length) throw new Error("lit card: duplicate candidate id; list each id once");
  return ids;
}
function ownCard(dir: string, candidates: Candidate[], id: string): { candidate: Candidate; card: StoredCard } {
  const candidate = candidates.find(c => c.id === id);
  if (!candidate) throw new Error(`lit card export: unknown candidate ${id}; check ares lit list`);
  if (!isVerified(candidate) || !(candidate.doi || candidate.arxivId)) throw new Error(`lit card export: ${id} has no identifier verified in this study; run ares lit verify first`);
  const card = readCard(dir, id);
  if (!card) throw new Error(`lit card export: ${id} has no card; record one with ares lit card`);
  if (card.reused) throw new Error(`lit card export: ${id} holds a card reused from the vault; only cards extracted in this study are exported`);
  return { candidate, card };
}

/** Read-only preview: the exact payloads, keyed by candidate, and a fingerprint binding them and the target vault. */
export function previewCardExport(dirArg: string, vault: string, values: string[], extractor: { kind: Actor["kind"]; modelFamily?: string }) {
  const { dir, study } = openStudy(dirArg), ids = cardIds(values), candidates = loadCandidates(dir), events = readLedger(dir);
  if (!VAULT_ID.test(vault)) throw new Error("--vault: registered vault id (lower-case letters, digits, - or _); list them with vmem vaults list");
  const family = extractor.modelFamily?.trim().toLowerCase();
  const cards = ids.map(id => {
    const { candidate, card } = ownCard(dir, candidates, id);
    // extractedAt is the time this card's bytes were last recorded, so re-previews stay stable.
    const recorded = events.filter(e => e.type === "lit.card" && e.data.id === id).at(-1);
    const { id: _id, reused: _r, ...fields } = card;
    const payload: VaultCardPayload = { v: 1, card: fields, provenance: { studySha256: sha256(study.id), extractedAt: recorded?.at ?? "1970-01-01T00:00:00.000Z", extractor: { kind: extractor.kind, ...(family ? { modelFamily: family } : {}) } } };
    validateProvenance(payload.provenance, "card provenance");
    return { id, identifier: identifierOf(candidate), payload };
  });
  const fingerprint = sha256(JSON.stringify([vault, cards.map(c => [c.id, c.identifier, payloadText(c.payload)])]));
  return { vault, fingerprint, cards: cards.map(c => ({ id: c.id, identifier: c.identifier, fields: CARD_FIELDS.filter(f => (c.payload.card as unknown as Record<string, unknown>)[f] !== undefined), provenance: c.payload.provenance })), payloads: cards };
}

/**
 * Writes each card to the single matching reference note. The study lock is held only to check the fingerprint and to
 * commit the receipt, never across vmem calls; each vault write is itself guarded by the note hash it just read.
 */
export async function exportCards(dirArg: string, vault: string, values: string[], fingerprint: string, actor: Actor, client: VaultClient, modelFamily?: string) {
  const { dir } = openStudy(dirArg), extractor = { kind: actor.kind, ...(modelFamily ? { modelFamily } : {}) };
  const preview = await withLock(dir, () => previewCardExport(dir, vault, values, extractor));
  if (fingerprint !== preview.fingerprint) throw new Error("lit card export: stale fingerprint; run ares lit card export again without --confirm and confirm its current fingerprint");
  const written: { id: string; note: string; sha256: string }[] = [];
  try {
    for (const item of preview.payloads) {
      const notes = await client.findReference(item.identifier);
      if (notes.length !== 1) throw new Error(`lit card export: ${item.id} matches ${notes.length} reference notes by identifier in vault ${vault}; create exactly one reference note with this doi/arxiv_id (vmem new ... --type reference) and retry`);
      const note = notes[0]!.path, text = payloadText(item.payload), current = await client.readCard(note);
      if (current.block === undefined) await client.appendCard(note, current.hash, "```json\n" + text + "\n```");
      else if (current.block !== text) await client.replaceCard(note, current.hash, current.block, text);
      written.push({ id: item.id, note, sha256: sha256(text) });
    }
  } finally {
    // Receipt what reached the vault even when a later card fails, so the next run can tell.
    if (written.length) await withLock(dir, () => commit(dir, [], [{ actor, type: "lit.card.exported", data: { vault, fingerprint, cards: written } }]));
  }
  return { vault, fingerprint, written };
}

function importPlan(dir: string, ids: string[]) {
  const candidates = loadCandidates(dir);
  return ids.map(id => {
    const candidate = candidates.find(c => c.id === id);
    if (!candidate) throw new Error(`lit card import: unknown candidate ${id}; check ares lit list`);
    if (!isVerified(candidate) || !(candidate.doi || candidate.arxivId)) throw new Error(`lit card import: ${id} has no identifier verified in this study; run ares lit verify first`);
    if (candidate.status !== "included") throw new Error(`lit card import: ${id} is not included; cards are recorded for included candidates only`);
    const existing = readCard(dir, id);
    if (existing && !existing.reused) throw new Error(`lit card import: ${id} already has a card extracted in this study; keep it, or remove it before importing`);
    return { id, candidate, key: JSON.stringify([candidate.status, candidate.verify, identifierOf(candidate), existing ?? null]) };
  });
}
/**
 * Imports only for included candidates whose identifier is verified in this study. Eligibility is checked under the
 * lock, vault reads run unlocked, and the commit re-checks eligibility under the lock so nothing changed in between.
 */
export async function importCards(dirArg: string, vault: string, values: string[], actor: Actor, client: VaultClient) {
  const { dir } = openStudy(dirArg), ids = cardIds(values), at = new Date().toISOString();
  const plan = await withLock(dir, () => importPlan(dir, ids));
  const files: [string, string, number][] = [], rows: { id: string; note: string; sha256: string }[] = [];
  for (const { id, candidate } of plan) {
    const notes = await client.findReference(identifierOf(candidate));
    if (notes.length !== 1) throw new Error(`lit card import: ${id} matches ${notes.length} reference notes by identifier in vault ${vault}; resolve the duplicates or export a card first`);
    const note = notes[0]!.path, read = await client.readCard(note);
    if (read.block === undefined) throw new Error(`lit card import: reference note ${note} has no ares card section; export a card to it first`);
    const payload = parsePayload(read.block, `vault note ${note}`);
    const stored: StoredCard = { id, ...payload.card, reused: { from: "vault", vault, note, at, provenance: payload.provenance } };
    const text = JSON.stringify(stored, null, 2) + "\n";
    if (Buffer.byteLength(text) > CARD_BYTES) throw new Error(`lit card import: card for ${id} exceeds 64 KiB; shorten it in the vault note`);
    files.push([cardPath(dir, id), text, CARD_BYTES]); rows.push({ id, note, sha256: sha256(text) });
  }
  // One commit for every imported card; the candidate file, verification and gates are not written.
  await withLock(dir, () => {
    if (JSON.stringify(importPlan(dir, ids).map(p => p.key)) !== JSON.stringify(plan.map(p => p.key))) throw new Error("lit card import: a candidate or its card changed during the vault read; nothing was written, run the import again");
    commit(dir, files, [{ actor, type: "lit.card.imported", data: { vault, cards: rows } }]);
  });
  return { vault, imported: rows };
}

/** Every stored card with its reuse record, for review before citing. */
export function listCards(dirArg: string) {
  const { dir } = openStudy(dirArg);
  return { cards: loadCandidates(dir).flatMap(c => {
    const card = readCard(dir, c.id);
    return card ? [{ id: c.id, status: c.status, fields: CARD_FIELDS.filter(f => (card as unknown as Record<string, unknown>)[f] !== undefined), reused: card.reused ?? null }] : [];
  }) };
}
