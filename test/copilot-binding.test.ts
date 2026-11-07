import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { copilotBinding, requireCopilotAccept, COPILOT_HYPOTHESES_BYTES, COPILOT_PAPER_BYTES, COPILOT_PAPER_FILES, COPILOT_PAPER_DEPTH, COPILOT_PAPER_DIRECTORIES } from "../src/copilot.ts";
import { ACCEPT_ARTIFACTS, type AcceptArtifact } from "../src/autonomy.ts";
import { appendEvent, commit, initStudy, openStudy, readLedger, STUDY_BYTES } from "../src/study.ts";
import { tempDir } from "./helpers.ts";

const agent = { kind: "agent" as const, id: "synthetic-agent" };
function study(mode = "copilot") {
  const dir = join(tempDir(), "study"); initStudy(dir, { question: "Synthetic copilot draft", autonomy: mode }, agent); return dir;
}
function paper(dir: string, name = "manuscript.md", text = "Synthetic paper\n") {
  const file = join(dir, "paper", name); fs.mkdirSync(join(file, ".."), { recursive: true }); fs.writeFileSync(file, text); return file;
}
function event(dir: string, artifact: AcceptArtifact, text = "Synthetic draft") {
  return appendEvent(dir, agent, artifact === "hypotheses" ? "idea.added" : "review.added", { id: "synthetic", draft: text });
}
function approve(dir: string, artifact: AcceptArtifact) {
  const binding = copilotBinding(dir, artifact)!;
  appendEvent(dir, agent, "gate.approve", { gate: `accept:${artifact}`, binding });
  return binding;
}
function refusal(fn: () => unknown, artifact: AcceptArtifact) {
  let message = "";
  try { fn(); } catch (error) { message = (error as Error).message; }
  expect(message).toContain(`copilot draft ${artifact}`); expect(message).toContain("restore");
  expect(message).not.toContain("private-name"); expect(message).not.toContain("https://private.invalid");
}

test("inactive phases leave old studies and artifacts untouched, and absent active drafts have no gate", () => {
  for (const mode of ["auto", "gates", "step", "copilot"]) {
    const dir = study(mode), ledger = fs.readFileSync(join(dir, "ledger.jsonl")), studyFile = fs.readFileSync(join(dir, "study.json"));
    for (const artifact of ACCEPT_ARTIFACTS) {
      expect(copilotBinding(dir, artifact)).toBeUndefined(); expect(() => requireCopilotAccept(dir, artifact)).not.toThrow();
    }
    if (mode !== "copilot") {
      fs.symlinkSync(join(dir, "missing"), join(dir, "hypotheses.md"));
      fs.symlinkSync(join(dir, "missing"), join(dir, "paper"));
      for (const artifact of ACCEPT_ARTIFACTS) expect(copilotBinding(dir, artifact)).toBeUndefined();
    }
    expect(fs.readFileSync(join(dir, "study.json"))).toEqual(studyFile); expect(fs.readFileSync(join(dir, "ledger.jsonl"))).toEqual(ledger);
  }
});

test("acceptance is phase-specific and never manufactures an approval", () => {
  const dir = study("gates"), { study: old } = openStudy(dir);
  commit(dir, [[join(dir, "study.json"), JSON.stringify({ ...old, v: 2, autonomy: { default: "gates", phases: { write: "copilot" } } }) + "\n", STUDY_BYTES]], []);
  fs.writeFileSync(join(dir, "hypotheses.md"), "Synthetic hypothesis\n"); paper(dir); event(dir, "reviews");
  expect(copilotBinding(dir, "hypotheses")).toBeUndefined(); expect(copilotBinding(dir, "reviews")).toBeUndefined();
  expect(copilotBinding(dir, "paper")).toMatch(/^[a-f0-9]{64}$/);
  const before = fs.readFileSync(join(dir, "ledger.jsonl"));
  expect(() => requireCopilotAccept(dir, "paper")).toThrow("ares gate approve <dir> accept:paper");
  expect(fs.readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
});

test("hypotheses binds optional UTF-8 file bytes and complete raw idea events, excluding unrelated events", () => {
  const dir = study(), file = join(dir, "hypotheses.md");
  fs.writeFileSync(file, "Synthetic hypothesis\n"); const fileOnly = copilotBinding(dir, "hypotheses");
  fs.writeFileSync(file, "Synthetic hypothesis\n\n"); expect(copilotBinding(dir, "hypotheses")).not.toBe(fileOnly);
  fs.unlinkSync(file); expect(copilotBinding(dir, "hypotheses")).toBeUndefined();
  const first = event(dir, "hypotheses"), journalOnly = copilotBinding(dir, "hypotheses"); expect(journalOnly).toBeDefined();
  appendEvent(dir, agent, "idea.decided", { id: "synthetic", decision: "pivot", reason: "Synthetic reason", additive: { field: "kept" } });
  const decided = copilotBinding(dir, "hypotheses"); expect(decided).not.toBe(journalOnly);
  appendEvent(dir, agent, "review.added", { id: "unrelated" }); appendEvent(dir, agent, "synthetic.other", {});
  expect(copilotBinding(dir, "hypotheses")).toBe(decided);
  const events = readLedger(dir), added = events.find(row => row.at === first.at && row.type === first.type)!;
  added.data.newField = "Unknown additive fields remain bound";
  fs.writeFileSync(join(dir, "ledger.jsonl"), events.map(row => JSON.stringify(row)).join("\n") + "\n");
  expect(copilotBinding(dir, "hypotheses")).not.toBe(decided);
  fs.writeFileSync(file, ""); expect(copilotBinding(dir, "hypotheses")).not.toBe(journalOnly);
});

test("paper binds manuscript sources, notes and assets while ignoring exact root build outputs", () => {
  const dir = study(), file = paper(dir), built = paper(dir, "build/manuscript.md"), evidence = paper(dir, "build/evidence.json", "{}\n");
  const first = copilotBinding(dir, "paper");
  const content = fs.readFileSync(file); fs.unlinkSync(file); fs.writeFileSync(file, content);
  expect(copilotBinding(dir, "paper")).toBe(first);
  fs.writeFileSync(evidence, "{\"synthetic\":true}\n");
  fs.renameSync(built, join(dir, "paper", "build", "renamed.md"));
  paper(dir, "build/private-derived-output.bin", "Derived bytes do not affect the source gate");
  appendEvent(dir, agent, "paper.built", { synthetic: true });
  expect(copilotBinding(dir, "paper")).toBe(first);
  approve(dir, "paper");
  fs.rmSync(join(dir, "paper", "build"), { recursive: true });
  expect(copilotBinding(dir, "paper")).toBe(first);
  expect(() => requireCopilotAccept(dir, "paper")).not.toThrow();
  const notes = paper(dir, "notes/synthetic.md", "Synthetic source notes\n");
  const noted = copilotBinding(dir, "paper"); expect(noted).not.toBe(first);
  expect(() => requireCopilotAccept(dir, "paper")).toThrow("pending");
  fs.renameSync(notes, join(dir, "paper", "notes", "renamed.md"));
  const moved = copilotBinding(dir, "paper"); expect(moved).not.toBe(noted);
  const asset = paper(dir, "build-other/asset.txt", "Synthetic source asset\n");
  const added = copilotBinding(dir, "paper"); expect(added).not.toBe(moved);
  fs.writeFileSync(asset, "Revised source asset\n"); expect(copilotBinding(dir, "paper")).not.toBe(added);
  fs.rmSync(join(dir, "paper"), { recursive: true }); expect(copilotBinding(dir, "paper")).toBeUndefined();
  fs.mkdirSync(join(dir, "paper", "build"), { recursive: true });
  paper(dir, "build/manuscript.md", "Only derived output exists\n");
  expect(copilotBinding(dir, "paper")).toBeUndefined();
});

test("ignored derived output does not consume source byte limits or follow build links", () => {
  const dir = study(); paper(dir); const original = copilotBinding(dir, "paper");
  const built = paper(dir, "build/oversized.bin", ""); fs.truncateSync(built, COPILOT_PAPER_BYTES + 1);
  expect(copilotBinding(dir, "paper")).toBe(original);
  fs.rmSync(join(dir, "paper", "build"), { recursive: true });
  fs.symlinkSync(join(dir, "missing-derived-output"), join(dir, "paper", "build"));
  expect(copilotBinding(dir, "paper")).toBe(original);
});

test("reviews bind all builds and full review events while excluding acceptance and unrelated events", () => {
  const dir = study(); event(dir, "reviews", "Synthetic old build review"); const old = copilotBinding(dir, "reviews");
  appendEvent(dir, agent, "review.added", { id: "new-build", buildSha256: "b".repeat(64), additive: "Synthetic current review" });
  const both = copilotBinding(dir, "reviews"); expect(both).not.toBe(old);
  appendEvent(dir, agent, "review.resolved", { reviewId: "synthetic", findingId: "finding", reason: "Synthetic resolution" });
  const resolved = copilotBinding(dir, "reviews"); expect(resolved).not.toBe(both);
  appendEvent(dir, agent, "idea.decided", { id: "unrelated" }); appendEvent(dir, agent, "paper.built", {});
  expect(copilotBinding(dir, "reviews")).toBe(resolved);
  approve(dir, "reviews"); expect(copilotBinding(dir, "reviews")).toBe(resolved);
});

test("explicit agent acceptance passes, rejects refuse, and changed drafts make approvals stale", () => {
  for (const artifact of ACCEPT_ARTIFACTS) {
    const dir = study(); if (artifact === "paper") paper(dir); else event(dir, artifact);
    expect(() => requireCopilotAccept(dir, artifact)).toThrow(`accept:${artifact}`);
    const binding = approve(dir, artifact), before = fs.readFileSync(join(dir, "ledger.jsonl"));
    expect(() => requireCopilotAccept(dir, artifact)).not.toThrow(); expect(copilotBinding(dir, artifact)).toBe(binding);
    expect(fs.readFileSync(join(dir, "ledger.jsonl"))).toEqual(before);
    appendEvent(dir, agent, "gate.reject", { gate: `accept:${artifact}`, binding, reason: "Synthetic rejection" });
    expect(() => requireCopilotAccept(dir, artifact)).toThrow("rejected");
    approve(dir, artifact);
    if (artifact === "paper") paper(dir, "manuscript.md", "Changed synthetic paper\n"); else event(dir, artifact, "Changed synthetic draft");
    expect(copilotBinding(dir, artifact)).not.toBe(binding);
    expect(() => requireCopilotAccept(dir, artifact)).toThrow("pending");
  }
});

test("linked, non-regular, invalid UTF-8 and unreadable present artifacts refuse without leaking paths or causes", () => {
  for (const artifact of ["hypotheses", "paper"] as const) {
    for (const shape of ["link", "wrong-type", "unreadable"] as const) {
      const dir = study(), file = artifact === "paper" ? paper(dir, "private-name.md") : join(dir, "hypotheses.md");
      if (artifact === "hypotheses") fs.writeFileSync(file, "Synthetic draft\n");
      if (shape === "link") { fs.unlinkSync(file); fs.symlinkSync(join(dir, "missing-private-name"), file); }
      if (shape === "wrong-type") {
        if (artifact === "hypotheses") { fs.unlinkSync(file); fs.mkdirSync(file); }
        else { fs.rmSync(join(dir, "paper"), { recursive: true }); fs.writeFileSync(join(dir, "paper"), "wrong type"); }
      }
      const lstat = fs.lstatSync, spy = shape === "unreadable" ? spyOn(fs, "lstatSync").mockImplementation(((path, options) => {
        if (String(path) === file) throw new Error("https://private.invalid/private-name unreadable");
        return lstat(path, options as never);
      }) as typeof fs.lstatSync) : undefined;
      try { refusal(() => copilotBinding(dir, artifact), artifact); }
      finally { spy?.mockRestore(); }
    }
  }
  const dir = study(); fs.writeFileSync(join(dir, "hypotheses.md"), Buffer.from([255])); refusal(() => copilotBinding(dir, "hypotheses"), "hypotheses");
  fs.writeFileSync(join(dir, "ledger.jsonl"), "private-name https://private.invalid not JSON\n");
  refusal(() => copilotBinding(dir, "reviews"), "reviews");
});

test("hypotheses and paper byte ceilings refuse before oversized sparse artifacts are read", () => {
  for (const artifact of ["hypotheses", "paper"] as const) {
    const dir = study(), file = artifact === "paper" ? paper(dir) : join(dir, "hypotheses.md");
    if (artifact === "hypotheses") fs.writeFileSync(file, "");
    fs.truncateSync(file, (artifact === "paper" ? COPILOT_PAPER_BYTES : COPILOT_HYPOTHESES_BYTES) + 1);
    refusal(() => copilotBinding(dir, artifact), artifact);
  }
});

test("paper traversal has independent file, directory and nesting bounds", () => {
  const files = study(); for (let i = 0; i <= COPILOT_PAPER_FILES; i++) paper(files, `synthetic-${i}.md`, "");
  refusal(() => copilotBinding(files, "paper"), "paper");
  const dirs = study(); fs.mkdirSync(join(dirs, "paper"));
  for (let i = 0; i < COPILOT_PAPER_DIRECTORIES; i++) fs.mkdirSync(join(dirs, "paper", `synthetic-${i}`));
  refusal(() => copilotBinding(dirs, "paper"), "paper");
  const deep = study(); let folder = join(deep, "paper");
  for (let i = 0; i <= COPILOT_PAPER_DEPTH + 1; i++) { fs.mkdirSync(folder); folder = join(folder, "nested"); }
  refusal(() => copilotBinding(deep, "paper"), "paper");
});


test("unsupported study or ledger versions refuse without changing their bytes", () => {
  const dir = study(), file = join(dir, "study.json"), original = fs.readFileSync(file, "utf8");
  const future = JSON.stringify({ ...JSON.parse(original), v: 3 }) + "\n"; fs.writeFileSync(file, future);
  expect(() => copilotBinding(dir, "hypotheses")).toThrow("unsupported schema version"); expect(fs.readFileSync(file, "utf8")).toBe(future);
  fs.writeFileSync(file, original);
  const ledger = join(dir, "ledger.jsonl"), bytes = fs.readFileSync(ledger, "utf8") + JSON.stringify({ v: 2, actor: { kind: "agent" }, type: "future", data: {}, at: "2030-01-01T00:00:00Z" }) + "\n";
  fs.writeFileSync(ledger, bytes);
  expect(() => copilotBinding(dir, "reviews")).toThrow("unsupported ledger version");
  paper(dir); expect(() => requireCopilotAccept(dir, "paper")).toThrow("unsupported ledger version"); expect(fs.readFileSync(ledger, "utf8")).toBe(bytes);
});


test("derived build exclusion follows filesystem aliases while distinct source names remain bound", () => {
  const dir = study(); paper(dir); const folder = join(dir, "paper", "Build"); fs.mkdirSync(folder);
  const aliased = fs.existsSync(join(dir, "paper", "build")), before = copilotBinding(dir, "paper");
  fs.writeFileSync(join(folder, "synthetic.txt"), "Synthetic derived or distinct-source bytes");
  if (aliased) expect(copilotBinding(dir, "paper")).toBe(before);
  else expect(copilotBinding(dir, "paper")).not.toBe(before);
});
