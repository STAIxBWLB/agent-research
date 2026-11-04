import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as ops from "../src/commands.ts";
import { run } from "../src/cli.ts";
import { foldSkills, SKILL_BYTES, validateSkillProposal } from "../src/memory/skills.ts";
import { readLedger } from "../src/study.ts";
import { fakeRunner, tempDir } from "./helpers.ts";
const actor = { kind: "agent" as const, id: "synthetic-agent" }, ctx = { actor }, pr = "https://github.com/example/synthetic/pull/1";
const proposal = (name = "synthetic-skill") => ({ name, summary: "Synthetic reusable lesson", steps: ["Inspect the synthetic evidence", "Apply the synthetic lesson"], evidence: ["a".repeat(32), "b".repeat(32), "ares:synthetic/run:investigate"] });
function study() { const dir = tempDir(); ops.init(dir, { question: "Synthetic question" }, ctx); return dir; }
const file = (dir: string, name = "synthetic-skill") => join(dir, "proposals", "skills", `${name}.md`);
const ledger = (dir: string) => readFileSync(join(dir, "ledger.jsonl"), "utf8");

test("propose commits bounded versioned Markdown and one actor-attributed hash receipt", async () => {
  const dir = study(), before = readLedger(dir).length, row = await ops.skillPropose(dir, proposal(), ctx), content = readFileSync(file(dir), "utf8");
  expect(row).toMatchObject({ ...proposal(), skillProposal: 1, state: "proposed", actor });
  expect(content).toContain("---\nskillProposal: 1\nname: synthetic-skill\n---"); expect(content).toContain("## Steps\n\n- Inspect the synthetic evidence");
  expect(readLedger(dir)).toHaveLength(before + 1);
  expect(readLedger(dir).at(-1)).toMatchObject({ actor, type: "skill.proposed", data: { skillProposal: 1, proposal: proposal(), sha256: row.sha256 } });
  expect(ops.skillList(dir)).toEqual([row]); expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
});

test("closed proposal fields, run names, required arrays and evidence types refuse without files or events", async () => {
  const dir = study(), before = ledger(dir);
  for (const raw of [null, [], { ...proposal(), extra: true }, { ...proposal(), name: "../escape" }, { ...proposal(), name: "-bad" }, { ...proposal(), name: "x".repeat(65) },
    { ...proposal(), summary: " " }, { ...proposal(), summary: "NUL\0summary" }, { ...proposal(), steps: [] }, { ...proposal(), steps: [1] }, { ...proposal(), steps: Array(SKILL_BYTES + 1).fill("x") },
    { ...proposal(), steps: [""] }, { ...proposal(), evidence: "wrong" }, { ...proposal(), evidence: ["doi:10.0000/synthetic"] }, { ...proposal(), evidence: ["ares:"] }, { ...proposal(), evidence: [] }, { ...proposal(), evidence: ["ares:study"] }, { ...proposal(), evidence: ["ares:study/"] }, { ...proposal(), evidence: [`mem:${"a".repeat(32)}`] }, { ...proposal(), evidence: ["amem:bad"] }]) {
    await expect(ops.skillPropose(dir, raw, ctx)).rejects.toThrow("skill");
    expect(ledger(dir)).toBe(before); expect(existsSync(join(dir, "proposals"))).toBe(false);
  }
  expect(validateSkillProposal({ ...proposal(), evidence: ["a".repeat(32)] }).evidence).toEqual(["a".repeat(32)]);
});

test("Markdown bound is inclusive at 16 KiB and counts UTF-8 bytes", async () => {
  const baseline = study(); await ops.skillPropose(baseline, proposal(), ctx);
  const overhead = Buffer.byteLength(readFileSync(file(baseline), "utf8")) - Buffer.byteLength(proposal().summary), length = SKILL_BYTES - overhead;
  const summary = "한".repeat(Math.floor(length / 3)) + "x".repeat(length % 3), valid = study();
  await ops.skillPropose(valid, { ...proposal(), summary }, ctx); expect(readFileSync(file(valid))).toHaveLength(SKILL_BYTES);
  expect(ops.skillList(valid)[0]!.summary).toBe(summary);
  const invalid = study(), before = ledger(invalid);
  await expect(ops.skillPropose(invalid, { ...proposal(), summary: summary + "x" }, ctx)).rejects.toThrow("16 KiB");
  expect(ledger(invalid)).toBe(before); expect(existsSync(join(invalid, "proposals"))).toBe(false);
});

test("duplicate names and orphan proposal files are never replaced", async () => {
  const dir = study(); await ops.skillPropose(dir, proposal(), ctx); const before = ledger(dir), content = readFileSync(file(dir));
  await expect(ops.skillPropose(dir, { ...proposal(), summary: "Replacement" }, ctx)).rejects.toThrow("already exists");
  expect(readFileSync(file(dir))).toEqual(content); expect(ledger(dir)).toBe(before);
  writeFileSync(file(dir, "orphan"), "User draft");
  await expect(ops.skillPropose(dir, proposal("orphan"), ctx)).rejects.toThrow("already exists");
  expect(readFileSync(file(dir, "orphan"), "utf8")).toBe("User draft"); expect(ledger(dir)).toBe(before);
});

test("accept requires PR URL; every decision including withdraw is final and actor recorded", async () => {
  const dir = study();
  for (const name of ["accept", "reject", "withdraw", "open"]) await ops.skillPropose(dir, proposal(name), ctx);
  const before = ledger(dir), content = readFileSync(file(dir, "accept"));
  for (const url of [undefined, "not-url", "file:///synthetic", "https://user:pass@example.com/pull/1"]) {
    await expect(ops.skillDecide(dir, "accept", "accept", "Synthetic review", url, ctx)).rejects.toThrow("PR"); expect(ledger(dir)).toBe(before);
  }
  const human = { kind: "person" as const };
  for (const action of ["accept", "reject", "withdraw"] as const) {
    const row = await ops.skillDecide(dir, action, action, "Synthetic reason", action === "accept" ? pr : undefined, { actor: human });
    expect(row.state).toBe(action === "accept" ? "accepted" : action === "reject" ? "rejected" : "withdrawn");
    expect(row.decision).toMatchObject({ action, reason: "Synthetic reason", actor: human, ...(action === "accept" ? { pr } : {}) });
    expect(readLedger(dir).at(-1)).toMatchObject({ actor: human, type: "skill.decided", data: { skillProposal: 1, name: action, decision: action } });
    const terminal = ledger(dir);
    for (const next of ["accept", "reject", "withdraw"]) await expect(ops.skillDecide(dir, action, next, "Too late", pr, ctx)).rejects.toThrow("already decided");
    expect(ledger(dir)).toBe(terminal);
  }
  expect(ops.skillList(dir).map(row => row.state)).toEqual(["accepted", "rejected", "withdrawn", "proposed"]);
  expect(readFileSync(file(dir, "accept"))).toEqual(content);
});

test("unknown names/actions and missing reasons refuse without journal changes", async () => {
  const dir = study(); await ops.skillPropose(dir, proposal(), ctx); const before = ledger(dir);
  for (const [name, action, reason] of [["missing", "reject", "why"], ["../escape", "reject", "why"], ["synthetic-skill", "later", "why"], ["synthetic-skill", "reject", " "]]) {
    await expect(ops.skillDecide(dir, name!, action!, reason!, undefined, ctx)).rejects.toThrow("skill"); expect(ledger(dir)).toBe(before);
  }
});

test("100 proposals is inclusive and terminal proposals still consume their slots", async () => {
  const dir = study();
  for (let i = 0; i < 100; i++) await ops.skillPropose(dir, proposal(`skill-${i}`), ctx);
  await ops.skillDecide(dir, "skill-0", "withdraw", "Synthetic withdrawal", undefined, ctx);
  const before = ledger(dir); expect(ops.skillList(dir)).toHaveLength(100);
  await expect(ops.skillPropose(dir, proposal("extra"), ctx)).rejects.toThrow("100-proposal");
  expect(ledger(dir)).toBe(before); expect(existsSync(file(dir, "extra"))).toBe(false);
});

test("bounded file reads reject edited, oversized and non-regular proposals without writes", async () => {
  for (const change of ["edited", "oversized", "version", "directory"]) {
    const dir = study(); await ops.skillPropose(dir, proposal(), ctx); const before = ledger(dir), target = file(dir);
    if (change === "directory") { unlinkSync(target); mkdirSync(target); }
    else if (change === "edited") writeFileSync(target, readFileSync(target, "utf8") + "edited");
    else if (change === "version") writeFileSync(target, readFileSync(target, "utf8").replace("skillProposal: 1", "skillProposal: 2"));
    else writeFileSync(target, "x".repeat(SKILL_BYTES + 1));
    expect(() => ops.skillList(dir)).toThrow("skill");
    await expect(ops.skillDecide(dir, "synthetic-skill", "reject", "why", undefined, ctx)).rejects.toThrow("skill"); expect(ledger(dir)).toBe(before);
  }
});

test("replay preserves additive v1 fields and refuses unsupported versions or invalid transitions", async () => {
  const dir = study(); await ops.skillPropose(dir, proposal(), ctx); const events = readLedger(dir), proposed = events.at(-1)!;
  const additive = { ...proposed, data: { ...proposed.data, future: true, proposal: { ...proposal(), future: true } } };
  expect(foldSkills([...events.slice(0, -1), additive])[0]!.state).toBe("proposed");
  expect(() => foldSkills([{ ...proposed, data: { ...proposed.data, skillProposal: 2 } }])).toThrow("unsupported version");
  const missing = { ...proposed, type: "skill.decided", data: { skillProposal: 1, name: "missing", decision: "withdraw", reason: "why" } };
  expect(() => foldSkills([missing])).toThrow("missing");
});

test("CLI file/stdin propose, decide and read-only list run no process or network", async () => {
  const dir = study(), input = join(tempDir(), "proposal.json"); writeFileSync(input, JSON.stringify(proposal("from-file")));
  const fake = fakeRunner([]), env = { AGENTHUB_PEER_ID: "synthetic-agent" }, io = { runner: fake.runner, readStdin: async () => JSON.stringify(proposal("from-stdin")) };
  expect((await run(["skill", "propose", dir, "--file", input, "--json"], env, io)).code).toBe(0);
  expect((await run(["skill", "propose", dir, "--file", "-", "--json"], env, io)).code).toBe(0);
  expect((await run(["skill", "decide", dir, "from-file", "accept", "--reason", "Reviewed", "--pr", pr, "--json"], env, io)).code).toBe(0);
  const before = ledger(dir), files = readdirSync(dir), output = await run(["skill", "list", dir, "--json"], env, io);
  expect(JSON.parse(output.text).map((row: { state: string }) => row.state)).toEqual(["accepted", "proposed"]);
  expect(ledger(dir)).toBe(before); expect(readdirSync(dir)).toEqual(files); expect(fake.requests).toEqual([]); expect(existsSync(join(dir, ".ares.lock"))).toBe(false);
  await expect(run(["skill", "propose", dir], env, io)).rejects.toThrow("--file");
  await expect(run(["skill", "decide", dir, "from-stdin", "withdraw"], env, io)).rejects.toThrow("--reason");
});

test("failed commit preflight creates no proposal directory", async () => {
  const dir = study(), before = ledger(dir);
  await expect(ops.skillPropose(dir, proposal(), { actor: { kind: "agent", id: "x".repeat(65_536) } })).rejects.toThrow("exceeds");
  expect(ledger(dir)).toBe(before); expect(existsSync(join(dir, "proposals"))).toBe(false);
});

test("evidence accepts 64 refs and refuses 65 before any write", async () => {
  const refs = Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(32, "0")), dir = study();
  await ops.skillPropose(dir, { ...proposal(), evidence: refs }, ctx);
  expect(ops.skillList(dir)[0]!.evidence).toEqual(refs);
  const invalid = study(), before = ledger(invalid);
  await expect(ops.skillPropose(invalid, { ...proposal(), evidence: [...refs, "ares:synthetic/run:investigate"] }, ctx)).rejects.toThrow("1..64 refs");
  expect(ledger(invalid)).toBe(before); expect(existsSync(join(invalid, "proposals"))).toBe(false);
});
