import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, protocolHash, validateProtocol, type Protocol } from "../src/exp/protocol.ts";
import { validateStageProtocol } from "../src/exp/stages.ts";
import { screenCandidate, SCREEN_FILES } from "../src/exp/screen.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/exp/executor.ts";
import { sha256 } from "../src/study.ts";
import { tempDir } from "./helpers.ts";

const image = `fixture@sha256:${"a".repeat(64)}`, commit = "c".repeat(40), blob = "1".repeat(40), other = "2".repeat(40);
function protocol(): Protocol {
  return { v: 1, method: "synthetic", candidate: { image, command: ["/candidate"] }, evaluator: { image, command: ["/evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 10, maxWallHours: 1, maxGpuHours: 0 } };
}
const literal = "synthetic-canary-value";
const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });

test("AC1/AC4: a screen is optional, closed and bounded, and a protocol without one keeps its identity", () => {
  const plain = validateProtocol(protocol());
  expect("screen" in plain).toBe(false);
  expect(protocolHash(plain)).toBe(protocolHash(validateProtocol({ ...protocol() })));
  const screened = validateProtocol({ ...protocol(), screen: { evaluatorInputs: true, literals: [literal] } });
  expect(screened.screen).toEqual({ evaluatorInputs: true, literals: [literal] });
  expect(protocolHash(screened)).not.toBe(protocolHash(plain));
  for (const screen of [{}, { evaluatorInputs: false }, { evaluatorInputs: "yes" }, { literals: [] }, { literals: ["short"] }, { literals: ["1234567"] }, { literals: ["a".repeat(201)] }, { literals: [literal, literal] }, { literals: [literal], extra: true }]) {
    expect(() => validateProtocol({ ...protocol(), screen })).toThrow("protocol.screen");
  }
  // A byte bound is counted in bytes: 66 Hangul syllables are 198 bytes, 67 are 201.
  expect(validateProtocol({ ...protocol(), screen: { literals: ["가".repeat(66)] } }).screen!.literals).toHaveLength(1);
  expect(() => validateProtocol({ ...protocol(), screen: { literals: ["가".repeat(67)] } })).toThrow("at most 200 UTF-8 bytes");
  expect(validateProtocol({ ...protocol(), screen: { literals: ["12345678"] } }).screen).toEqual({ literals: ["12345678"] });
  const many = Array.from({ length: 64 }, (_, index) => `synthetic-literal-${index}`);
  expect(validateProtocol({ ...protocol(), screen: { literals: many } }).screen!.literals).toHaveLength(64);
  expect(() => validateProtocol({ ...protocol(), screen: { literals: [...many, "synthetic-literal-extra"] } })).toThrow("1..64 items");
});

test("AC1: both protocol versions accept a screen, but only v1 declares the evaluator-only inputs it compares", () => {
  const stage = { name: "build", image, command: ["/build"], seed: false, code: "snapshot", needs: [], inputs: {}, outputs: {} };
  const screened = validateStageProtocol({ ...protocol(), v: 2, candidate: { stages: [stage] }, screen: { literals: [literal] } });
  expect(screened.screen).toEqual({ literals: [literal] });
  expect(() => validateStageProtocol({ ...protocol(), v: 2, candidate: { stages: [stage] }, screen: { evaluatorInputs: true } })).toThrow("stage protocols declare no protocol inputs");
});

test("AC2/AC3: an evaluator-only input copy and a declared literal are hits, and no commit file byte is read here", async () => {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = async request => {
    requests.push(request);
    const args = request.args;
    if (request.command === "python3") return ok(JSON.stringify({ files: 2, bytes: 24, blobs: [blob] }));
    if (args.includes("--show-object-format")) return ok("sha1\n");
    if (args.includes("ls-tree")) return ok([`100644 blob ${blob}\tsrc/held-out.txt`, `100644 blob ${other}\tsrc/other.txt`, ""].join("\u0000"));
    if (args.includes("grep") && args.includes("-l")) return args[args.indexOf("-e") + 1] === literal ? ok(`${commit}:src/leak.txt\0`) : { exitCode: 1, stdout: "", stderr: "" };
    if (args.includes("grep")) return ok(`${commit}:src/leak.txt\u0000${7}\u0000${literal}\n`);
    throw new Error(`unscripted synthetic process ${request.command} ${args.join(" ")}`);
  };
  const screen = { evaluatorInputs: true as const, literals: [literal] };
  const result = await screenCandidate("/synthetic/repo", commit, screen, {
    heldout: { path: "/data/heldout", sha256: "d".repeat(64), mount: { evaluator: "/in/heldout" } },
    shared: { path: "/data/shared", sha256: "e".repeat(64), mount: { candidate: "/in/shared", evaluator: "/in/shared" } },
  }, { v: 1, kind: "local", workdir: "/private/synthetic-executor" }, runner);
  expect(result.hits).toEqual([{ rule: "evaluator-input:heldout", path: "src/held-out.txt" }, { rule: "literal:0", path: "src/leak.txt", line: 7 }]);
  expect(result.summary).toEqual({ rules: ["evaluatorInputs", "literals"], sha256: sha256(canonical({ commit, screen })) });
  expect(requests.filter(request => request.command === "python3")).toHaveLength(1);
  expect(requests.some(request => request.args.includes("hashes") && request.args.includes(String(SCREEN_FILES)))).toBe(true);
  expect(requests.some(request => request.args.includes("cat-file"))).toBe(false);
});

test("AC5: the screen refuses a non-sha1 object format instead of vouching for bytes it cannot compare", async () => {
  const runner: ProcessRunner = async request => {
    if (request.args.includes("--show-object-format")) return ok("sha256\n");
    throw new Error(`unscripted synthetic process ${request.command} ${request.args.join(" ")}`);
  };
  await expect(screenCandidate("/synthetic/repo", commit, { evaluatorInputs: true }, {}, { v: 1, kind: "local", workdir: "/private/synthetic-executor" }, runner)).rejects.toThrow("object format is not sha-1");
});

test("AC3: a literal hit carries the line number real git reports", async () => {
  const dir = tempDir(), git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(dir, "plain.txt"), `first line\n${literal} on the second\n${literal} again\n`);
  writeFileSync(join(dir, "other.txt"), "synthetic prose\n");
  git("add", ".");
  git("-c", "user.name=synthetic", "-c", "user.email=synthetic@example.test", "commit", "-q", "-m", "synthetic");
  const head = git("rev-parse", "HEAD").trim();
  const result = await screenCandidate(dir, head, { literals: [literal] }, {}, { v: 1, kind: "local", workdir: dir });
  expect(result.hits).toEqual([{ rule: "literal:0", path: "plain.txt", line: 2 }]);
});
