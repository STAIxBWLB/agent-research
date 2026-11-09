import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { previewArchive } from "../src/memory/archive.ts";
import { readLedger, readTextBounded, readBytesBounded } from "../src/study.ts";
import type { ProcessRunner } from "../src/exp/executor.ts";
import { acceptedLesson, lessonFixture } from "./lesson-fixtures.ts";

interface StoredNote { id: string; text: string; args: string[] }
const rows = (file: string): StoredNote[] => readTextBounded(file, 1024 * 1024).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));

test("a process crash after fake amem writes leaves no receipt and a reconciled retry can duplicate notes", async () => {
  const f = await lessonFixture(); await acceptedLesson(f);
  const backend = join(f.env.HOME!, "synthetic-amem-backend.jsonl"); writeFileSync(backend, "");
  const preview = previewArchive(f.dir), before = readBytesBounded(join(f.dir, "ledger.jsonl"), 64 * 1024 * 1024);
  expect(preview.notes.length).toBeGreaterThan(0);
  const studyModule = new URL("../src/study.ts", import.meta.url).pathname;
  const commandsModule = new URL("../src/commands.ts", import.meta.url).href;
  const script = `
    import {mock} from "bun:test";
    import {appendFileSync} from "node:fs";
    const study = await import(${JSON.stringify(studyModule)}), realCommit = study.commit;
    mock.module(${JSON.stringify(studyModule)}, () => ({...study, commit(...args) {
      if (args[2].some(event => event.type === "archive.exported")) process.exit(88);
      return realCommit(...args);
    }}));
    globalThis.fetch = async () => {throw new Error("network forbidden in synthetic crash fixture");};
    const ops = await import(${JSON.stringify(commandsModule)}); let count = 0;
    const runner = async request => {
      if (request.command !== "amem" || request.args[0] !== "note" || request.args[1] !== "add") throw new Error("unexpected synthetic process request");
      const id = (++count).toString(16).padStart(32, "0");
      appendFileSync(${JSON.stringify(backend)}, JSON.stringify({id, text: Buffer.from(request.stdin).toString("utf8"), args: request.args}) + "\\n");
      return {exitCode: 0, stdout: JSON.stringify({id}), stderr: ""};
    };
    await ops.archive(${JSON.stringify(f.dir)}, {confirm: ${JSON.stringify(preview.fingerprint)}}, {actor: ${JSON.stringify(f.ctx.actor)}, runner}, ${JSON.stringify(f.env)});
    process.exit(99);
  `;
  const child = spawnSync(process.execPath, ["--eval", script], {
    cwd: f.env.HOME!, env: { PATH: process.env.PATH, ...f.env }, timeout: 10_000, maxBuffer: 65_536,
  });
  expect(child.error).toBeUndefined(); expect(child.signal).toBeNull(); expect(child.status).toBe(88);
  const unreceipted = rows(backend);
  expect(unreceipted.map(row => row.text)).toEqual(preview.notes.map(row => row.note.text));
  expect(readBytesBounded(join(f.dir, "ledger.jsonl"), 64 * 1024 * 1024)).toEqual(before);
  expect(readLedger(f.dir).some(event => event.type === "archive.exported")).toBe(false);
  expect(previewArchive(f.dir).notes).toEqual(preview.notes);

  // The subprocess is known to have exited. The synthetic operator reconciles only its own dead PID lock.
  const lock = join(f.dir, ".ares.lock"); expect(existsSync(lock)).toBe(true);
  expect(readTextBounded(lock, 1024).split(" ")[0]).toBe(String(child.pid)); unlinkSync(lock);
  const runner: ProcessRunner = async request => {
    expect(request.command).toBe("amem"); expect(request.args.slice(0, 2)).toEqual(["note", "add"]);
    const id = (rows(backend).length + 1).toString(16).padStart(32, "0");
    appendFileSync(backend, JSON.stringify({id, text: Buffer.from(request.stdin as Uint8Array).toString("utf8"), args: request.args}) + "\n");
    return {exitCode: 0, stdout: JSON.stringify({id}), stderr: ""};
  };
  const retried = await ops.archive(f.dir, {confirm: preview.fingerprint}, {...f.ctx, runner}, f.env);
  expect("written" in retried && retried.written).toHaveLength(preview.notes.length);
  const stored = rows(backend); expect(stored).toHaveLength(unreceipted.length * 2);
  for (const note of preview.notes) expect(stored.filter(row => row.text === note.note.text)).toHaveLength(2);
  expect(readLedger(f.dir).filter(event => event.type === "archive.exported")).toHaveLength(1);
  expect(previewArchive(f.dir).notes).toEqual([]); expect(existsSync(lock)).toBe(false);
});
