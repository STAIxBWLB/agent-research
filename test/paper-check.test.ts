import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { createAresMcp } from "../src/mcp-tools.ts";
import { checkPaper } from "../src/paper/check.ts";
import { MANUSCRIPT_BYTES, resolvePlaceholders } from "../src/paper/placeholders.ts";
import { saveCandidates, verifySubject, type Candidate } from "../src/lit/candidates.ts";
import { appendEvent, openStudy } from "../src/study.ts";
import { readProtocol, protocolHash } from "../src/exp/protocol.ts";
import { fakeHttp, tempDir } from "./helpers.ts";
const actor = { kind: "person" as const }, ctx = { actor, http: fakeHttp([]).http }, BASE = "a".repeat(40), WIN = "b".repeat(40);
function study(mode = "experiment") { const dir = tempDir(); ops.init(dir, { question: "synthetic", mode }, ctx); mkdirSync(join(dir, "paper")); return dir; }
function draft(dir: string, text: string) { writeFileSync(join(dir, "paper", "manuscript.md"), text); return checkPaper(dir); }
function references(dir: string) {
  const base: Candidate = { id: "doi:10.1/synthetic", title: "Synthetic fixture", authors: [], year: 2026, sources: ["fixture"], addedAt: "2030-01-01T00:00:00Z", status: "included", citekey: "good2026", verify: { syntax: "ok", exists: "yes", match: "yes", checkedAt: "2030-01-01T00:00:00Z" } };
  base.verify!.subject = verifySubject(base);
  saveCandidates(dir, [base, { ...base, id: "doi:10.1/missing", citekey: "failed2026", verify: { ...base.verify!, exists: "no", match: "unknown" } }]);
}
let serial = 0;
function sample(dir: string, run: string, commit: string, seed: number, value: number, metric = "score") {
  const id = (++serial).toString(16).padStart(16, "0"), protocol = readProtocol(dir)!, folder = join(dir, "runs", run, "attempts"); mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${id}.json`), JSON.stringify({ v: 1, id, studyId: openStudy(dir).study.id, run, commit, seed, protocolHash: protocolHash(protocol), protocol, executor: {}, stages: {}, stage: "evaluator", status: "succeeded", startedAt: "2030-01-01T00:00:00Z", metrics: [{ name: metric, value, unit: "points", provenance: "ares-observed" }], outputs: [] }));
  appendEvent(dir, actor, "attempt.started", { id, run, commit, seed }); return id;
}
async function results(winner = true, metric = "score") {
  const dir = study(), image = `fixture@sha256:${"a".repeat(64)}`;
  mkdirSync(join(dir, "task", "evaluator"), { recursive: true }); writeFileSync(join(dir, "task", "task.md"), "synthetic"); writeFileSync(join(dir, "task", "evaluator", "run"), "synthetic");
  await ops.protocol(dir, { v: 1, method: "synthetic", candidate: { image, command: ["candidate"] }, evaluator: { image, command: ["evaluator"] }, metrics: [{ name: metric, unit: "points", direction: "max" }], seeds: [1, 2], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 100, maxWallHours: 1, maxGpuHours: 0 } }, ctx);
  await ops.finalSeeds(dir, { v: 1, seeds: [2] }, ctx); await ops.selection(dir, { v: 1, run: "investigate", metric, baseline: { commit: BASE }, minSeeds: 1, minDelta: 1 }, ctx);
  sample(dir, "investigate", BASE, 1, 10, metric); const id = sample(dir, "investigate", WIN, 1, winner ? 12 : 9, metric); await ops.investigateClose(dir, ctx);
  if (winner) { await ops.gateDecide(dir, "final", "approve", undefined, ctx); sample(dir, "final", BASE, 2, 10, metric); sample(dir, "final", WIN, 2, 12, metric); await ops.finalClose(dir, ctx); }
  return { dir, id };
}

test("fabricated prose numbers, unresolved refs and bad formats have exact original positions", () => {
  const dir = study(), report = draft(dir, "서론\nGain 12.5 points.\n{{n:final.delta}} {{n:final.delta|.9f}}\n");
  expect(report.ok).toBe(false); expect(report.findings.map(f => [f.code, f.line, f.column])).toEqual([["bare-number", 2, 6], ["unresolved-ref", 3, 1], ["bad-format", 3, 19]]);
});

test("allowed code/link/citation/placeholder/list contexts do not hide visible prose digits", () => {
  const dir = study(); references(dir);
  const text = ["1. Listed item", "  2) Nested marker", "`12` and ``code ` 34``", "```js", "const x = 56; {{n:final.delta}} [@unknown2026]", "```", "~~~", "78", "~~~", "    indented 90", "[label](https://example.test/a1/(b2))", "<https://example.test/a3>", "[ref]: <https://example.test/a4>", "[see @good2026, p. 5]", "{{lit:cohort 2026}}"].join("\n");
  const report = draft(dir, text); expect(report.findings).toEqual([]); expect(report.literals.map(p => p.kind === "literal" ? p.text : "")).toEqual(["cohort 2026"]); expect(report.rendered).toContain("const x = 56; {{n:final.delta}} [@unknown2026]");
  const visible = draft(dir, "[label 12](https://example.test/34) and prose 56\n"); expect(visible.findings.filter(f => f.code === "bare-number").map(f => f.column)).toEqual([8, 47]);
});

test("unclosed fences are code but unmatched inline backticks and malformed links leave digits checked", () => {
  const dir = study(); expect(draft(dir, "```\n123\n").ok).toBe(true);
  expect(draft(dir, "`value 123").findings[0]?.code).toBe("bare-number");
  expect(draft(dir, "[label](url123").findings[0]?.code).toBe("bare-number");
  expect(draft(dir, "No link ](hidden123)").findings[0]?.code).toBe("bare-number");
  expect(draft(dir, "``code 12` still prose").findings[0]?.code).toBe("bare-number");
});

test("citation reports reuse verification and locate every unknown/unverified occurrence", () => {
  const dir = study(); references(dir);
  const report = draft(dir, "Known [@good2026].\nUnknown [@missing2026; @failed2026, p. 2; @missing2026].");
  expect(report.citations).toMatchObject({ unknown: ["missing2026"], notVerified: ["failed2026"], citations: 4 });
  expect(report.findings.map(f => f.code)).toEqual(["unknown-citation", "unverified-citation", "unknown-citation"]);
  expect(report.findings.every(f => f.line === 2)).toBe(true);
  expect(draft(dir, "{{lit:Year 2026 [@missing2026]}}").findings[0]?.code).toBe("unknown-citation");
});

test("final.status is required in prose and stale/rejected source numbers stay unresolved", async () => {
  const { dir } = await results(); expect(draft(dir, "Negative results omitted.").findings[0]?.code).toBe("missing-negative-result");
  expect(draft(dir, "`{{n:final.status}}`").findings[0]?.code).toBe("missing-negative-result");
  const good = draft(dir, "Status {{n:final.status}}, delta {{n:final.delta|.2f}}."); expect(good.ok).toBe(true); expect(good.rendered).toBe("Status qualified, delta 2.00.");
  await ops.gateDecide(dir, "final", "reject", "synthetic", ctx);
  expect(checkPaper(dir).findings.some(f => f.code === "unresolved-ref")).toBe(true);
});

test("no-winner reason cannot be omitted or hidden in lit/code and a stale closed result is refused", async () => {
  const { dir } = await results(false);
  expect(draft(dir, "Nothing to report.").findings[0]?.code).toBe("missing-negative-result");
  expect(draft(dir, "{{lit:{{n:investigate.reason}}}}").ok).toBe(false);
  expect(draft(dir, "No winner: {{n:investigate.reason}}.").rendered).toBe("No winner: below-margin.");
  sample(dir, "investigate", WIN, 1, 20);
  expect(checkPaper(dir).findings.some(f => f.code === "unresolved-ref")).toBe(true);
});

test("literal metric whitespace/punctuation is referenceable; delimiters remain an explicit ceiling", async () => {
  const { dir, id } = await results(true, "accuracy (%) / v2");
  const report = draft(dir, `{{n:final.status}} {{n:attempt:${id}.accuracy (%) / v2|.2f}}`); expect(report.ok).toBe(true); expect(report.rendered).toBe("qualified 12.00");
  expect(resolvePlaceholders(dir, `{{n:attempt:${id}.name|part}}`).findings[0]?.code).toBe("bad-format");
  expect(resolvePlaceholders(dir, `{{n:attempt:${id}.name}part}}`).findings[0]?.code).toBe("bad-format");
});

test("survey is citation-only, experiment placeholders refuse, CLI/MCP share read-only reports", async () => {
  const dir = study("survey"); references(dir); const text = "Year 2026 with [@good2026]."; expect(draft(dir, text).ok).toBe(true);
  const ledger = readFileSync(join(dir, "ledger.jsonl")), file = readFileSync(join(dir, "paper", "manuscript.md")), direct = ops.paperCheck(dir);
  const cli = await run(["paper", "check", dir, "--json"], {}, { http: ctx.http });
  expect(cli.code).toBe(0); expect(JSON.parse(cli.text)).toEqual(direct);
  expect(await createAresMcp({}, ctx.http).handlers.ares_paper_check!({ study: dir })).toEqual(direct);
  expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger); expect(readFileSync(join(dir, "paper", "manuscript.md"))).toEqual(file);
  expect(draft(dir, "{{n:final.status}}").findings[0]?.code).toBe("unresolved-ref");
  expect((await run(["paper", "check", dir, "--json"], {}, { http: ctx.http })).code).toBe(1);
});

test("missing and oversized manuscript reads refuse with a repair command and preserve records", () => {
  const dir = study(), before = readFileSync(join(dir, "ledger.jsonl")); expect(() => checkPaper(dir)).toThrow("paper/manuscript.md");
  writeFileSync(join(dir, "paper", "manuscript.md"), "x".repeat(MANUSCRIPT_BYTES + 1)); expect(() => checkPaper(dir)).toThrow("2 MiB"); expect(readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});


test("Markdown punctuation inside metric refs and literal payloads is preserved verbatim", async () => {
  const metric = "score `variant` [unit](v2)", { dir, id } = await results(true, metric);
  const report = draft(dir, `{{n:final.status}} {{n:attempt:${id}.${metric}|.1f}} {{lit:year 2026 with \`literal\`}}`);
  expect(report.ok).toBe(true); expect(report.rendered).toBe("qualified 12.0 year 2026 with `literal`");
});
