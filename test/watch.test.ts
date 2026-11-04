import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { readLedger } from "../src/study.ts";
import { loadCandidates } from "../src/lit/candidates.ts";
import { readWatch, validateWatch, watchPath } from "../src/lit/watch.ts";
import { deferred, fakeHttp, ok, status, tempDir, type Route } from "./helpers.ts";
const actor = { kind: "person" as const }, config = { v: 1, queries: [{ id: "synthetic", query: "synthetic query", source: "openalex", limit: 20 }], rubric: "Synthetic rubric for a person, never automatic scoring" };
const paper = (id: string) => ({ title: `Synthetic record ${id}`, doi: `https://doi.org/10.0000/synthetic-${id}`, publication_year: 2024, authorships: [] });
const body = (ids: string[]) => JSON.stringify({ results: ids.map(paper) });
const routes = (open: Route = ok(body(["one"])), s2: Route = ok('{"data":[]}'), arxiv: Route = ok('<feed></feed>')): [string, Route][] => [["https://api.openalex.org/works", open], ["https://api.semanticscholar.org/graph/v1/paper/search", s2], ["https://export.arxiv.org/api/query", arxiv]];
async function study(autonomy = "gates", mode = "survey") {
  const dir = tempDir(), http = fakeHttp([]).http, ctx = { actor, http };
  ops.init(dir, { question: "Synthetic question", autonomy, mode }, ctx); await ops.scope(dir, { question: "Synthetic question", yearFrom: 2020, yearTo: 2025, maxCandidates: 2000 }, ctx);
  if (autonomy === "gates") await ops.gateDecide(dir, "scope", "approve", undefined, ctx);
  return dir;
}
const ledger = (dir: string) => readFileSync(join(dir, "ledger.jsonl"), "utf8");

test("watch set validates bounded fields, stable serialization and identical-byte no-op", async () => {
  const dir = await study(), first = await ops.watchSet(dir, config, { actor }), before = ledger(dir), bytes = readFileSync(watchPath(dir));
  expect(first.changed).toBe(true); expect(readWatch(dir)).toEqual(config); expect(readLedger(dir).at(-1)!.type).toBe("watch.set");
  expect((await ops.watchSet(dir, config, { actor })).changed).toBe(false); expect(ledger(dir)).toBe(before); expect(readFileSync(watchPath(dir))).toEqual(bytes);
  for (const raw of [null, { ...config, v: 2 }, { ...config, extra: true }, { ...config, queries: [] }, { ...config, queries: Array(21).fill(config.queries[0]) },
    { ...config, queries: [config.queries[0], config.queries[0]] }, { ...config, queries: [{ ...config.queries[0], id: "../escape" }] },
    { ...config, queries: [{ ...config.queries[0], query: "x".repeat(501) }] }, { ...config, queries: [{ ...config.queries[0], source: "unknown" }] },
    { ...config, queries: [{ ...config.queries[0], yearFrom: 999 }] }, { ...config, queries: [{ ...config.queries[0], limit: 0 }] },
    { ...config, queries: [{ ...config.queries[0], limit: 51 }] }, { ...config, queries: [{ ...config.queries[0], extra: true }] }, { ...config, rubric: "한".repeat(2667) }]) {
    await expect(ops.watchSet(dir, raw, { actor })).rejects.toThrow(); expect(ledger(dir)).toBe(before); expect(readFileSync(watchPath(dir))).toEqual(bytes);
  }
  expect(validateWatch({ v: 1, queries: Array.from({ length: 20 }, (_, i) => ({ id: `q${i}`, query: "x".repeat(500), limit: 50 })), rubric: "x".repeat(8000) }).queries).toHaveLength(20);
});

test("one pass uses lit search gates/merge/events and never screens or scores", async () => {
  for (const mode of ["survey", "experiment"]) {
    const dir = await study("gates", mode); await ops.watchSet(dir, { ...config, queries: [{ id: "a", query: "first query" }, { id: "b", query: "second query" }] }, { actor });
    const fake = fakeHttp(routes()), ctx = { actor, http: fake.http }, result = await ops.watchRun(dir, ctx);
    expect(result.ok).toBe(true); expect(result.added).toBe(1); expect(result.queries.map(row => [row.added, row.merged])).toEqual([[1, 0], [0, 1]]);
    expect(result.addedIds).toEqual(["doi:10.0000/synthetic-one"]); expect(result.addedIdsTotal).toBe(1); expect(result.rubric).toBe(config.rubric);
    expect(fake.requested).toHaveLength(6); expect(fake.requested[0]!.url).toContain("from_publication_date:2020"); expect(fake.requested[0]!.url).toContain("to_publication_date:2025");
    expect(readLedger(dir).filter(event => event.type === "lit.search")).toHaveLength(2); expect(readLedger(dir).filter(event => event.type === "watch.ran")).toHaveLength(1);
    expect(readLedger(dir).filter(event => event.type === "lit.screen")).toEqual([]); expect(loadCandidates(dir).every(row => row.status === "new")).toBe(true);
    expect(JSON.stringify(loadCandidates(dir))).not.toContain("score");
    const second = await ops.watchRun(dir, ctx); expect(second.added).toBe(0); expect(second.addedIds).toEqual([]);
    await ops.screen(dir, result.addedIds, "include", "Synthetic manual screening", ctx);
    await ops.watchRun(dir, ctx); expect(loadCandidates(dir)[0]!.status).toBe("included");
  }
});

test("watch.run records partial source errors as host/status only and never records keys/URLs/bodies", async () => {
  const dir = await study(); await ops.watchSet(dir, { ...config, queries: [{ id: "all", query: "synthetic" }] }, { actor });
  const fake = fakeHttp(routes(ok(body(["one"])), { status: 503, body: "PRIVATE_RESPONSE_BODY" }, "network"), { OPENALEX_API_KEY: "PRIVATE_API_KEY", S2_API_KEY: "PRIVATE_API_KEY" });
  const result = await ops.watchRun(dir, { actor, http: fake.http }); expect(result.ok).toBe(true);
  expect(result.queries[0]!.errors).toEqual([{ host: "api.semanticscholar.org", status: 503 }, { host: "export.arxiv.org", status: null }]);
  expect(Object.keys(result.queries[0]!.errors[0]!).sort()).toEqual(["host", "status"]);
  const bytes = ledger(dir) + readFileSync(join(dir, "literature", "candidates.json"), "utf8");
  for (const secret of ["PRIVATE_API_KEY", "PRIVATE_RESPONSE_BODY", "https://api.openalex.org/works", "api_key="]) expect(bytes).not.toContain(secret);
});

test("all-source failure is recorded with non-zero CLI exit and never auto-approves scope", async () => {
  const dir = await study("auto"); await ops.watchSet(dir, { ...config, queries: [{ id: "all", query: "synthetic" }] }, { actor });
  const fake = fakeHttp(routes(status(429), status(503), "network"));
  const output = await run(["watch", "run", dir, "--json"], {}, { http: fake.http });
  expect(output.code).toBe(1); expect(JSON.parse(output.text).ok).toBe(false); expect(readLedger(dir).at(-1)!.type).toBe("watch.ran");
  expect(readLedger(dir).filter(event => event.type === "gate.approve")).toEqual([]); expect(loadCandidates(dir)).toEqual([]);
  const success = fakeHttp(routes()); await ops.watchRun(dir, { actor, http: success.http });
  expect(readLedger(dir).filter(event => event.type === "gate.approve")).toHaveLength(1);
});

test("all queries are checked against scope before any search, and pending gates refuse", async () => {
  const dir = await study(), fake = fakeHttp(routes()), ctx = { actor, http: fake.http };
  await ops.watchSet(dir, { v: 1, queries: [{ id: "first", query: "valid" }, { id: "later", query: "bad", yearFrom: 2026 }] }, { actor });
  const before = ledger(dir); await expect(ops.watchRun(dir, ctx)).rejects.toThrow("yearFrom"); expect(fake.requested).toEqual([]); expect(ledger(dir)).toBe(before);
  await ops.watchSet(dir, config, { actor }); await ops.scope(dir, { question: "Changed scope" }, ctx);
  await expect(ops.watchRun(dir, ctx)).rejects.toThrow("pending"); expect(fake.requested).toEqual([]);
});

test("watch retains one study lock across queries; concurrent run/search/set refuse while show stays read-only", async () => {
  const dir = await study(); await ops.watchSet(dir, config, { actor });
  const fake = fakeHttp(routes()), entered = deferred(), release = deferred();
  const http = { ...fake.http, json: async (...args: Parameters<typeof fake.http.json>) => { entered.resolve(); await release.promise; return fake.http.json(...args); } };
  const pending = ops.watchRun(dir, { actor, http }); await entered.promise;
  try {
    await expect(ops.watchRun(dir, { actor, http: fake.http })).rejects.toThrow("locked");
    await expect(ops.search(dir, "synthetic", {}, { actor, http: fake.http })).rejects.toThrow("locked");
    await expect(ops.watchSet(dir, config, { actor })).rejects.toThrow("locked");
    const before = ledger(dir), shown = ops.watchShow(dir); expect(shown.config).toEqual(config); expect(ledger(dir)).toBe(before);
  } finally { release.resolve(); }
  expect((await pending).ok).toBe(true); expect(fake.requested).toHaveLength(1); expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
});

test("added ids cap at 500 with full totals; show is bounded, recent and excludes screened candidates", async () => {
  const dir = await study(), queries = Array.from({ length: 11 }, (_, i) => ({ id: `q${i}`, query: `batch-${i}`, source: "openalex", limit: 50 }));
  await ops.watchSet(dir, { v: 1, queries }, { actor });
  const fake = fakeHttp(queries.map((row, i) => [`https://api.openalex.org/works?search=batch-${i}&`, ok(body(Array.from({ length: 50 }, (_, j) => `${i}-${j}`)))]));
  const result = await ops.watchRun(dir, { actor, http: fake.http }); expect(result.added).toBe(550); expect(result.addedIds).toHaveLength(500); expect(result.addedIdsTotal).toBe(550);
  await ops.screen(dir, [result.addedIds[0]!], "exclude", "Synthetic exclusion", { actor, http: fake.http });
  const before = ledger(dir), files = readdirSync(dir), shown = ops.watchShow(dir);
  expect(shown.newCandidates.total).toBe(549); expect(shown.newCandidates.candidates).toHaveLength(500); expect(shown.newCandidates.candidates.some(row => row.id === result.addedIds[0])).toBe(false);
  expect(shown.runs[0]!.at).toBe(readLedger(dir).findLast(event => event.type === "watch.ran")!.at); expect(ledger(dir)).toBe(before); expect(readdirSync(dir)).toEqual(files);
});

test("CLI file/stdin config and show use bounded reads; unsupported config versions stay unchanged", async () => {
  const dir = await study(), input = join(tempDir(), "watch.json"); writeFileSync(input, JSON.stringify(config));
  expect((await run(["watch", "set", dir, "--file", input, "--json"])).code).toBe(0);
  const before = ledger(dir); expect((await run(["watch", "set", dir, "--file", "-", "--json"], {}, { readStdin: async () => JSON.stringify(config) })).code).toBe(0); expect(ledger(dir)).toBe(before);
  expect(JSON.parse((await run(["watch", "show", dir, "--json"])).text).config).toEqual(config);
  const path = watchPath(dir); writeFileSync(path, JSON.stringify({ ...config, v: 2 })); const bytes = readFileSync(path);
  expect(() => ops.watchShow(dir)).toThrow("unsupported version"); await expect(ops.watchSet(dir, config, { actor })).rejects.toThrow("unsupported version"); expect(readFileSync(path)).toEqual(bytes); expect(ledger(dir)).toBe(before);
});

test("watch.run executes as a no-arg production plan step and returns added", async () => {
  const dir = await study(), fake = fakeHttp(routes()); await ops.watchSet(dir, config, { actor });
  const ctx = { actor, http: fake.http }; await ops.planSet(dir, { v: 1, nodes: [{ id: "watch", kind: "step", command: "watch.run", args: {} }], edges: [] }, ctx);
  let resumed = false;
  const result = await ops.planRun(dir, {}, { ...ctx, runner: async () => { throw new Error("watch must not invoke a subprocess"); }, sleep: async () => {
    if (!resumed) { resumed = true; await ops.planControl(dir, { action: "resume", commandId: "resume-watch", expectedRevision: 1 }, ctx); }
    await Bun.sleep(1);
  } });
  expect(result.state).toBe("done"); expect(result.nodes[0]!.output).toEqual({ added: 1 }); expect(readLedger(dir).filter(event => event.type === "watch.ran")).toHaveLength(1);
});

test("run receipts stay within ledger bounds even when source identifiers are unusually long", async () => {
  const dir = await study(); await ops.watchSet(dir, config, { actor });
  const fake = fakeHttp(routes(ok(body(["x".repeat(70_000)]))));
  const result = await ops.watchRun(dir, { actor, http: fake.http });
  expect(result.added).toBe(1); expect(result.addedIdsTotal).toBe(1); expect(result.addedIds).toEqual([]);
  expect(Buffer.byteLength(JSON.stringify(readLedger(dir).at(-1)))).toBeLessThan(65_536); expect(readLedger(dir).at(-1)!.type).toBe("watch.ran");
});

test("show returns only the ten most recent run records without writing", async () => {
  const dir = await study(); await ops.watchSet(dir, config, { actor }); const fake = fakeHttp(routes());
  for (let i = 0; i < 11; i++) await ops.watchRun(dir, { actor, http: fake.http });
  const before = ledger(dir), shown = ops.watchShow(dir), last = readLedger(dir).filter(event => event.type === "watch.ran").slice(-10).reverse();
  expect(shown.runs).toHaveLength(10); expect(shown.runs.map(row => row.at)).toEqual(last.map(event => event.at)); expect(ledger(dir)).toBe(before);
});
