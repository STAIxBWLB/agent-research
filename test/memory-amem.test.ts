import { describe, expect, test } from "bun:test";
import { AMEM_OUTPUT_BYTES, createAmemClient, type AmemNote } from "../src/memory/amem.ts";
import type { ProcessResult } from "../src/exp/executor.ts";
import { fakeRunner } from "./helpers.ts";

const id = "a".repeat(32), secret = "PRIVATE PROCESS DIAGNOSTIC";
const response = (value: unknown): ProcessResult => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: secret });
const row = { id, kind: "fail", title: "Synthetic failure", at: "2026-11-04T00:00:00Z", score: 0.8, about: ["run:synthetic"] };
const note: AmemNote = { text: "Synthetic study: test question", kind: "fail", approach: "baseline", symptom: "lower score", cause: "not recorded",
  evidence: ["ares:synthetic/attempt:one", "doi:10.0000/synthetic"], retryWhen: "new evidence", title: "Synthetic failure" };

describe("amem process client", () => {
  test("note add passes literal fields, repeated evidence, and returns only the id", async () => {
    const fake = fakeRunner([response({ id, kind: "fail", text: secret })]);
    expect(await createAmemClient(fake.runner).add(note)).toBe(id);
    expect(fake.requests).toEqual([{ command: "amem", args: ["note", "add", note.text, "--kind", "fail", "--approach", "baseline", "--symptom", "lower score",
      "--cause", "not recorded", "--evidence", "ares:synthetic/attempt:one", "--evidence", "doi:10.0000/synthetic", "--retry-when", "new evidence", "--title", "Synthetic failure", "--json"],
    timeoutMs: 30_000, maxOutputBytes: AMEM_OUTPUT_BYTES }]);
    expect(fake.remaining()).toBe(0);
  });
  test("optional note fields are omitted; shell metacharacters stay in one argument", async () => {
    const fake = fakeRunner([response({ id })]);
    await createAmemClient(fake.runner).add({ text: "Question $(literal); 'quoted' 제주", kind: "finding" });
    expect(fake.requests[0]!.args).toEqual(["note", "add", "Question $(literal); 'quoted' 제주", "--kind", "finding", "--json"]);
  });
  test("search projects typed metadata without raw note text", async () => {
    const fake = fakeRunner([response([{ ...row, text: secret }]), response([]), response([{ ...row, title: null }])]);
    const client = createAmemClient(fake.runner);
    expect(await client.search("synthetic question", "fail")).toEqual([row]);
    expect(await client.search("no matches")).toEqual([]);
    expect(await client.search("untitled")).toEqual([{ ...row, title: null }]);
    expect(fake.requests[0]!.args).toEqual(["search", "synthetic question", "--kind", "fail", "--json"]);
    expect(fake.requests[1]!.args).toEqual(["search", "no matches", "--json"]);
  });
  test("brief projects a bounded typed response", async () => {
    const brief = { brief: "제주", bytes: 6, truncated: false, state: "known" };
    const fake = fakeRunner([response({ ...brief, internal: secret })]);
    expect(await createAmemClient(fake.runner).brief("phase intent", 64)).toEqual(brief);
    expect(fake.requests[0]!.args).toEqual(["brief", "--for", "phase intent", "--json", "--bytes", "64"]);
  });
  for (const [name, result, message] of [
    ["spawn", new Error(secret), "spawn failure"],
    ["exit", { exitCode: 2, stdout: secret, stderr: secret }, "nonzero exit"],
    ["JSON", { exitCode: 0, stdout: secret, stderr: secret }, "bad JSON"],
    ["truncation", { ...response({ id }), truncated: true }, "over-bound"],
    ["UTF-8 bytes", { exitCode: 0, stdout: "제".repeat(Math.floor(AMEM_OUTPUT_BYTES / 3) + 1), stderr: secret }, "over-bound"],
    ["deadline", { ...response({ id }), timedOut: true }, "timeout"],
  ] as const) {
    test(`${name} failure is classified without process diagnostics`, async () => {
      const client = createAmemClient(fakeRunner([result]).runner);
      for (const operation of [() => client.add(note)]) {
        try { await operation(); throw new Error("expected rejection"); }
        catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain(message);
          expect((error as Error).message).not.toContain(secret);
        }
      }
    });
  }
  test("exact output bound is accepted", async () => {
    const stdout = JSON.stringify({ id }).padEnd(AMEM_OUTPUT_BYTES, " ");
    expect(await createAmemClient(fakeRunner([{ exitCode: 0, stdout, stderr: "" }]).runner).add(note)).toBe(id);
  });
  test("malformed add and search projections fail closed", async () => {
    for (const raw of [null, [], {}, { id: secret }]) {
      await expect(createAmemClient(fakeRunner([response(raw)]).runner).add(note)).rejects.toThrow("bad JSON");
    }
    for (const raw of [{ hits: [row] }, [null], [{ ...row, id: "" }], [{ ...row, kind: "unknown" }], [{ ...row, at: "yesterday" }],
      [{ ...row, score: undefined }], [{ ...row, score: null }], [{ ...row, title: 1 }], [{ ...row, about: [1] }]]) {
      await expect(createAmemClient(fakeRunner([response(raw)]).runner).search("question")).rejects.toThrow("bad JSON");
    }
  });
  test("brief rejects malformed shapes and the requested byte bound", async () => {
    const brief = { brief: "abc", bytes: 3, truncated: false, state: "known" };
    for (const raw of [null, [], { ...brief, brief: "제주" }, { ...brief, bytes: 4 }, { ...brief, bytes: -1 }, { ...brief, bytes: 1.5 },
      { ...brief, truncated: "false" }, { ...brief, state: null }]) {
      await expect(createAmemClient(fakeRunner([response(raw)]).runner).brief("phase", 3)).rejects.toThrow("bad JSON");
    }
  });
  test("invalid inputs never invoke a runner or an interactive note editor", async () => {
    const fake = fakeRunner([]), client = createAmemClient(fake.runner);
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
