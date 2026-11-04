import { describe, expect, test } from "bun:test";
import { AMEM_OUTPUT_BYTES, createAmemClient, type AmemNote, type AmemHit } from "../src/memory/amem.ts";
import type { ProcessResult, ProcessRunner } from "../src/exp/executor.ts";
import { fakeRunner } from "./helpers.ts";

const cwd = "/synthetic/study";
const clientFor = (runner: ProcessRunner) => createAmemClient(cwd, runner, {});
const id = "a".repeat(32), secret = "PRIVATE PROCESS DIAGNOSTIC";
const response = (value: unknown, overrides: Partial<ProcessResult> = {}): ProcessResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: secret, ...overrides });
const row = { id, kind: "fail", title: "Synthetic failure", at: "2026-11-04T00:00:00Z", scoreDetails: { finalScore: 0.8, recencyFactor: 0.5 }, about: ["run:synthetic"] };
const projected: AmemHit = { id, kind: "fail", title: row.title, at: row.at, about: row.about, relevance: 1.6 };
const note: AmemNote = { text: "Synthetic study: test question", kind: "fail", approach: "baseline", symptom: "lower score", cause: "not recorded",
  evidence: ["ares:synthetic/attempt:one", "doi:10.0000/synthetic"], retryWhen: "new evidence", title: "Synthetic failure" };

describe("amem process client", () => {
  test("note add passes literal fields, repeated evidence, and returns only the id", async () => {
    const fake = fakeRunner([response({ id, kind: "fail", text: secret })]);
    expect(await clientFor(fake.runner).add(note)).toBe(id);
    expect(fake.requests).toEqual([{ command: "amem", args: ["note", "add", note.text, "--kind", "fail", "--approach", "baseline", "--symptom", "lower score",
      "--cause", "not recorded", "--evidence", "ares:synthetic/attempt:one", "--evidence", "doi:10.0000/synthetic", "--retry-when", "new evidence", "--title", "Synthetic failure", "--json"],
    cwd, env: {}, timeoutMs: 30_000, maxOutputBytes: AMEM_OUTPUT_BYTES }]);
    expect(fake.remaining()).toBe(0);
  });
  test("optional note fields are omitted; shell metacharacters stay in one argument", async () => {
    const fake = fakeRunner([response({ id })]);
    await clientFor(fake.runner).add({ text: "Question $(literal); 'quoted' 제주", kind: "finding" });
    expect(fake.requests[0]!.args).toEqual(["note", "add", "Question $(literal); 'quoted' 제주", "--kind", "finding", "--json"]);
  });
  test("search projects typed metadata without raw note text", async () => {
    const fake = fakeRunner([response([{ ...row, text: secret }]), response([]), response([{ ...row, title: null }])]);
    const client = clientFor(fake.runner);
    expect(await client.search("synthetic question", "fail")).toEqual([projected]);
    expect(await client.search("no matches")).toEqual([]);
    expect(await client.search("untitled")).toEqual([{ ...projected, title: null }]);
    expect(fake.requests[0]!.args).toEqual(["search", "synthetic question", "--json", "--explain", "--limit", "100"]);
    expect(fake.requests[1]!.args).toEqual(["search", "no matches", "--json", "--explain", "--limit", "100"]);
  });
  test("brief projects a bounded typed response", async () => {
    const brief = { brief: "제주", bytes: 6, truncated: false, state: "known" };
    const fake = fakeRunner([response({ ...brief, internal: secret })]);
    expect(await clientFor(fake.runner).brief("phase intent", 64)).toEqual(brief);
    expect(fake.requests[0]!.args).toEqual(["brief", "--for", "phase intent", "--json", "--bytes", "64"]);
  });
  for (const [name, result, message] of [
    ["spawn", new Error(secret), "spawn failure"],
    ["exit", response(secret, { exitCode: 2 }), "nonzero exit"],
    ["JSON", { exitCode: 0, stdout: secret, stderr: secret }, "bad JSON"],
    ["truncation", response({ id }, { truncated: true }), "over-bound"],
    ["UTF-8 bytes", { exitCode: 0, stdout: "제".repeat(Math.floor(AMEM_OUTPUT_BYTES / 3) + 1), stderr: secret }, "over-bound"],
    ["deadline", response({ id }, { timedOut: true }), "timeout"],
  ] as const) {
    test(`${name} failure is classified without process diagnostics`, async () => {
      const client = clientFor(fakeRunner([result]).runner);
      try { await client.add(note); throw new Error("expected rejection"); }
      catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain(message);
        expect((error as Error).message).not.toContain(secret);
      }
    });
  }
  test("exact output bound is accepted", async () => {
    const stdout = JSON.stringify({ id }).padEnd(AMEM_OUTPUT_BYTES, " ");
    expect(await clientFor(fakeRunner([{ exitCode: 0, stdout, stderr: "" }]).runner).add(note)).toBe(id);
  });
  test("malformed add and search projections fail closed", async () => {
    for (const raw of [null, [], {}, { id: secret }]) {
      await expect(clientFor(fakeRunner([response(raw)]).runner).add(note)).rejects.toThrow("bad JSON");
    }
    for (const raw of [{}, [null], [{ ...row, id: "" }], [{ ...row, kind: "unknown" }], [{ ...row, at: "yesterday" }],
      [{ ...row, title: 1 }], [{ ...row, about: [1] }]]) {
      await expect(clientFor(fakeRunner([response(raw)]).runner).search("question")).rejects.toThrow("bad JSON");
    }
  });
  test("brief rejects malformed shapes and the requested byte bound", async () => {
    const brief = { brief: "abc", bytes: 3, truncated: false, state: "known" };
    for (const raw of [null, [], { ...brief, brief: "제주" }, { ...brief, bytes: 4 }, { ...brief, bytes: -1 }, { ...brief, bytes: 1.5 },
      { ...brief, truncated: "false" }, { ...brief, state: null }]) {
      await expect(clientFor(fakeRunner([response(raw)]).runner).brief("phase", 3)).rejects.toThrow("bad JSON");
    }
  });
  test("invalid inputs never invoke a runner or an interactive note editor", async () => {
    const fake = fakeRunner([]), client = clientFor(fake.runner);
    for (const text of ["", " ", "-", "--json", "bad\0text"]) {
      await expect(client.add({ text, kind: "finding" })).rejects.toThrow("input");
      await expect(client.search(text)).rejects.toThrow("input");
      await expect(client.brief(text, 100)).rejects.toThrow("input");
    }
    await expect(client.add({ ...note, evidence: Array(17).fill("ares:synthetic/run:one") })).rejects.toThrow("16 evidence");
    for (const bytes of [0, -1, 8193, 1.5, NaN]) await expect(client.brief("phase", bytes)).rejects.toThrow("brief bytes");
    expect(fake.requests).toEqual([]);
  });
});

test("study cwd and agent identity/config context survive without API credentials", async () => {
  const env = {
    AGENTHUB_PEER_ID: "codex", CLAUDECODE: "", CLAUDE_CODE_SESSION_ID: "claude-session", CODEX_THREAD_ID: "codex-session", PI_SESSION_ID: "pi-session",
    HOME: "/synthetic/home", AMEM_HOME: "/synthetic/memory", AGENTHUB_HOME: "/synthetic/hub", CLAUDE_CONFIG_DIR: "/synthetic/claude", CODEX_HOME: "/synthetic/codex",
    XDG_CONFIG_HOME: "/synthetic/config", KIMI_CODE_HOME: "/synthetic/kimi", PI_CODING_AGENT_DIR: "/synthetic/pi", QWEN_HOME: "/synthetic/qwen", JCODE_HOME: "/synthetic/jcode",
  };
  const fake = fakeRunner([response({ id }), response([]), response({ brief: "", bytes: 0, truncated: false, state: "unknown" })]);
  const client = createAmemClient(cwd, fake.runner, { ...env, ANTHROPIC_API_KEY: secret, OPENAI_API_KEY: secret, PRIVATE_TOKEN: secret });
  await client.add(note); await client.search("question"); await client.brief("phase", 64);
  for (const request of fake.requests) { expect(request.cwd).toBe(cwd); expect(request.env).toEqual(env); }
});

test("agent-marked search keeps curated views, drops capture/repo hits and filters kind locally", async () => {
  const fake = fakeRunner([response({ engine: "fts5", hits: [
    { source: "capture", capture: { text: secret }, score: 9 }, { source: "repo", view: row }, { source: "curated" },
    { source: "curated", view: { ...row, text: secret }, score: 0.8, scoreDetails: row.scoreDetails },
    { source: "curated", view: { ...row, kind: "decision" }, score: 1, scoreDetails: { finalScore: 1, recencyFactor: 0.25 } },
  ] })]);
  expect(await clientFor(fake.runner).search("question", "fail", 50)).toEqual([projected]);
  expect(fake.requests[0]!.args).toEqual(["search", "question", "--json", "--explain", "--limit", "50"]);
});

test("both search shapes remove amem recency rather than applying a second decay", async () => {
  const fake = fakeRunner([response([{ ...row, scoreDetails: { finalScore: 0.1, recencyFactor: 0.125 } }]),
    response({ engine: "fts5", hits: [{ source: "curated", view: row, scoreDetails: { finalScore: 0.4, recencyFactor: 0.5 } }] })]);
  const client = clientFor(fake.runner);
  expect((await client.search("question"))[0]!.relevance).toBe(0.8);
  expect((await client.search("question"))[0]!.relevance).toBe(0.8);
});

test("missing, non-positive, non-finite or overflowing score factors refuse without leaking output", async () => {
  for (const details of [undefined, null, {}, { finalScore: null, recencyFactor: 1 }, { finalScore: 1, recencyFactor: null },
    { finalScore: 0, recencyFactor: 1 }, { finalScore: -1, recencyFactor: 1 }, { finalScore: 1, recencyFactor: 0 },
    { finalScore: 1, recencyFactor: -1 }, { finalScore: 1e308, recencyFactor: 1e-308 }]) {
    for (const raw of [[{ ...row, text: secret, scoreDetails: details }], { hits: [{ source: "curated", view: row, scoreDetails: details }] }]) {
      await expect(clientFor(fakeRunner([response(raw)]).runner).search("question")).rejects.toThrow("score unavailable");
    }
  }
  const stdout = JSON.stringify([{ ...row, scoreDetails: { finalScore: "replace", recencyFactor: 1 } }]).replace('"replace"', '1e999');
  await expect(clientFor(fakeRunner([{ exitCode: 0, stdout, stderr: secret }]).runner).search("question")).rejects.toThrow("score unavailable");
});

test("search limit is bounded before any subprocess", async () => {
  const fake = fakeRunner([]);
  for (const limit of [0, -1, 101, 1.5, NaN]) await expect(clientFor(fake.runner).search("question", undefined, limit)).rejects.toThrow("1..100");
  expect(fake.requests).toEqual([]);
});
