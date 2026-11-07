import { expect, test } from "bun:test";
import { createHttp, createHttpPacing, HttpError, type FetchLike } from "../src/http.ts";
import { deferred, fakeHttp, ok } from "./helpers.ts";

const s2 = "https://api.semanticscholar.org";
function virtualClock() {
  let time = 0;
  const waits: number[] = [];
  return { now: () => time, waits, sleep: async (ms: number) => { waits.push(ms); time += ms; } };
}

test("S2 JSON and text endpoints share start pacing across clients, without awaiting responses", async () => {
  const clock = virtualClock(), pacing = createHttpPacing(clock);
  const starts: { url: string; at: number }[] = [];
  const firstResponse = deferred<Response>(), secondStarted = deferred();
  const fetcher: FetchLike = url => {
    starts.push({ url, at: clock.now() });
    if (starts.length === 1) return firstResponse.promise;
    if (starts.length === 2) secondStarted.resolve();
    return Promise.resolve(new Response("{}"));
  };
  const a = createHttp({}, fetcher, pacing), b = createHttp({}, fetcher, pacing);
  const first = a.json(`${s2}/graph/v1/paper/search?query=first`);
  const second = b.text(`${s2}/recommendations/v1/papers/forpaper/second`);
  const third = a.json(`${s2}/graph/v1/paper/third`);
  await secondStarted.promise;
  expect(starts.slice(0, 2).map(start => start.at)).toEqual([0, 1100]);
  firstResponse.resolve(new Response("{}"));
  await Promise.all([first, second, third]);
  expect(starts.map(start => start.at)).toEqual([0, 1100, 2200]);
  expect(clock.waits).toEqual([1100, 1100]);
});

test("failed S2 starts consume their slot, including network, status and JSON failures", async () => {
  const clock = virtualClock(), pacing = createHttpPacing(clock), starts: number[] = [];
  const outcomes = ["network", "rate", "server", "client", "format", "ok"];
  const fetcher: FetchLike = async () => {
    starts.push(clock.now());
    const outcome = outcomes.shift();
    if (outcome === "network") throw new Error("private response details");
    if (outcome === "rate") return new Response("private", { status: 429 });
    if (outcome === "server") return new Response("private", { status: 503 });
    if (outcome === "client") return new Response("private", { status: 401 });
    return new Response(outcome === "format" ? "bad JSON" : "{}");
  };
  const http = createHttp({}, fetcher, pacing);
  for (const kind of ["network", "rate", "server", "client", "format"] as const) {
    try { await http.json(`${s2}/graph/v1/paper/private`); throw new Error("expected refusal"); }
    catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).kind).toBe(kind);
      expect((error as Error).message).not.toContain("private");
    }
  }
  await http.json(`${s2}/graph/v1/paper/last`);
  expect(starts).toEqual([0, 1100, 2200, 3300, 4400, 5500]);
});

test("OpenAlex and arXiv proceed while a Semantic Scholar admission is waiting", async () => {
  let now = 0;
  const sleeping = deferred(), wake = deferred();
  const pacing = createHttpPacing({ now: () => now, sleep: async ms => {
    sleeping.resolve(); await wake.promise; now += ms;
  } });
  const starts: string[] = [];
  const http = createHttp({}, async url => { starts.push(url); return new Response("{}"); }, pacing);
  await http.json(`${s2}/graph/v1/paper/first`);
  const pending = http.text(`${s2}/graph/v1/paper/second`);
  await sleeping.promise;
  try {
    await Promise.all([http.json("https://api.openalex.org/works"), http.text("https://export.arxiv.org/api/query")]);
    expect(starts).toEqual([`${s2}/graph/v1/paper/first`, "https://api.openalex.org/works", "https://export.arxiv.org/api/query"]);
  } finally { wake.resolve(); await pending; }
});

test("fakeHttp uses isolated virtual pacing by default and accepts shared timing", async () => {
  const routes: [string, ReturnType<typeof ok>][] = [[s2, ok("{}")]];
  const a = fakeHttp(routes), b = fakeHttp(routes);
  await Promise.all([a.http.json(`${s2}/one`), a.http.text(`${s2}/two`), b.http.json(`${s2}/three`)]);
  expect(a.requested).toHaveLength(2);
  expect(b.requested).toHaveLength(1);
  const clock = virtualClock(), pacing = createHttpPacing(clock);
  const c = fakeHttp(routes, {}, pacing), d = fakeHttp(routes, {}, pacing);
  await Promise.all([c.http.json(`${s2}/one`), d.http.text(`${s2}/two`)]);
  expect(clock.waits).toEqual([1100]);
});
