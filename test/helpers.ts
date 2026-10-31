import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "bun:test";
import { createHttp, type FetchLike } from "../src/http.ts";

export const fixture = (name: string) => readFileSync(join(import.meta.dir, "fixtures", name), "utf8");

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
export function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), "ares-test-")); dirs.push(dir); return dir; }

export type Route = { status: number; body?: string } | "network";
/** A fetch that answers by URL prefix and records every requested URL. Unrouted URLs fail the test loudly. */
export function fakeHttp(routes: [string, Route][], env: NodeJS.ProcessEnv = {}) {
  const requested: { url: string; headers: Record<string, string> }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requested.push({ url, headers: init?.headers ?? {} });
    const hit = routes.find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error(`unrouted request: ${url}`);
    const route = hit[1];
    if (route === "network") throw new TypeError("connection refused");
    return new Response(route.body ?? "", { status: route.status });
  };
  return { http: createHttp(env, fetchImpl), requested };
}
export const ok = (body: string): Route => ({ status: 200, body });
export const status = (code: number): Route => ({ status: code, body: "" });
export const searchRoutes = (s2: Route = ok(fixture("s2.json"))): [string, Route][] => [
  ["https://api.openalex.org/works", ok(fixture("openalex.json"))],
  ["https://api.semanticscholar.org/graph/v1/paper/search", s2],
  ["https://export.arxiv.org/api/query?search_query", ok(fixture("arxiv-search.xml"))],
];
