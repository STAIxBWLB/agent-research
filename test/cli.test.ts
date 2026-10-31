import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { readLedger } from "../src/study.ts";
import { fakeHttp, searchRoutes, tempDir } from "./helpers.ts";

const agentEnv = { CLAUDECODE: "1" };
const io = (stdin = "") => ({ readStdin: async () => stdin, http: fakeHttp(searchRoutes()).http });

describe("AC8 CLI", () => {
  test("an agent session runs every step without a TTY and the ledger records actor kind agent", async () => {
    const dir = join(tempDir(), "s");
    expect((await run(["init", dir, "--question", "Q?"], agentEnv, io())).code).toBe(0);
    expect((await run(["scope", dir, "--file", "-"], agentEnv, io(JSON.stringify({ question: "Q?" })))).code).toBe(0);
    expect((await run(["gate", "approve", dir, "scope"], agentEnv, io())).code).toBe(0);
    const search = await run(["lit", "search", dir, "agent review", "--limit", "5", "--json"], agentEnv, io());
    expect(JSON.parse(search.text).candidates).toBe(4);
    expect(readLedger(dir).every(e => e.actor.kind === "agent" && e.actor.id === "claude")).toBe(true);
    const status = JSON.parse((await run(["status", dir, "--json"], agentEnv, io())).text);
    expect(status.literature.candidates).toBe(4);
    expect(status.gates.map((g: { state: string }) => g.state)).toEqual(["approved", "none"]);
  });
  test("unknown or repeated options and bad values are refused before any write", async () => {
    const dir = join(tempDir(), "s");
    await expect(run(["init", dir, "--question", "Q?", "--force"], {}, io())).rejects.toThrow("unknown or repeated option --force");
    await expect(run(["init", dir, "--question", "Q?", "--question", "R?"], {}, io())).rejects.toThrow("repeated");
    await expect(run(["init", dir, "--question", "Q?", "--autonomy", "copilot"], {}, io())).rejects.toThrow("--autonomy");
    expect(existsSync(join(dir, "study.json"))).toBe(false);
    await expect(run(["lit", "frobnicate", dir], {}, io())).rejects.toThrow("unknown command");
    await expect(run(["lit", "search", dir, "q", "--limit", "many"], {}, io())).rejects.toThrow("--limit: integer required");
  });
  test("a malformed card file is refused without writing a card", async () => {
    const dir = join(tempDir(), "s");
    await run(["init", dir, "--question", "Q?", "--autonomy", "auto"], {}, io());
    await run(["scope", dir, "--file", "-"], {}, io(JSON.stringify({ question: "Q?" })));
    await run(["lit", "search", dir, "agent review"], {}, io());
    await run(["lit", "screen", dir, "doi:10.1234/jrl.2024.001", "--include"], {}, io());
    const file = join(dir, "card.json");
    writeFileSync(file, JSON.stringify({ summary: "ok", verdict: "supports everything" }));
    await expect(run(["lit", "card", dir, "doi:10.1234/jrl.2024.001", "--file", file], {}, io())).rejects.toThrow("unknown field verdict");
    writeFileSync(file, "{not json");
    await expect(run(["lit", "card", dir, "doi:10.1234/jrl.2024.001", "--file", file], {}, io())).rejects.toThrow("not valid JSON");
    expect(readLedger(dir).some(e => e.type === "lit.card")).toBe(false);
    writeFileSync(file, JSON.stringify({ summary: "Checks references against registries.", claims: ["Registry lookups catch fabricated DOIs."] }));
    const out = JSON.parse((await run(["lit", "card", dir, "doi:10.1234/jrl.2024.001", "--file", file, "--json"], {}, io())).text);
    expect(JSON.parse(readFileSync(out.path, "utf8")).claims).toHaveLength(1);
    await expect(run(["lit", "card", dir, "arxiv:2502.04321", "--file", file], {}, io())).rejects.toThrow("included candidates only");
  });
  test("lit screen needs exactly one decision flag", async () => {
    await expect(run(["lit", "screen", "/tmp/x", "id", "--include", "--exclude"], {}, io())).rejects.toThrow("exactly one");
  });
  test("help and version", async () => {
    expect((await run(["--help"], {}, io())).text).toContain("ares lit verify <dir>");
    expect((await run(["playbook"], {}, io())).text).toContain("Only included and verified papers");
  });
});
