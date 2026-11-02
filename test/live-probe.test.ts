import { expect, test } from "bun:test";
import { probeSnapshotExtraction } from "../scripts/live-exp-probe.ts";
import type { Executor, ProcessRequest, ProcessResult, ProcessRunner } from "../src/exp/executor.ts";
import { fakeDocker } from "./helpers.ts";

const executor: Executor = { v: 1, kind: "local", workdir: "/private/synthetic" }, root = "/private/synthetic/probe-root";
const ok = (stdout = ""): ProcessResult => ({ exitCode: 0, stdout, stderr: "" });
const refusal: ProcessResult = { exitCode: 2, stdout: "", stderr: "tar: escape/payload: Cannot open: Not a directory\n" };

test("snapshot probe uses production extraction flags and a sibling-only synthetic escape", async () => {
  const fake = fakeDocker([ok(), refusal, ok('{"outsideUnchanged":true}')]);
  expect(await probeSnapshotExtraction(executor, root, fake.runner)).toEqual({ exitCode: 2, refused: true, outsideUnchanged: true, stderr: refusal.stderr });
  const request = fake.requests[1]!;
  expect(request.command).toBe("tar"); expect(request.args).toEqual(["--no-same-owner", "-xf", "-", "-C", `${root}/probe/snapshot`]);
  const tar = Buffer.from(request.stdin as Uint8Array);
  const text = (start: number, length: number) => tar.subarray(start, start + length).toString("utf8").split("\0")[0];
  expect(text(0, 100)).toBe("escape"); expect(text(156, 1)).toBe("2"); expect(text(157, 100)).toBe("../outside");
  expect(text(512, 100)).toBe("escape/payload"); expect(text(512 + 156, 1)).toBe("0");
  expect(tar.subarray(1024, 1056).toString()).toContain("synthetic traversal payload");
  expect(fake.requests[0]!.args.join(" ")).toContain(`mkdir -m 700 ${root}/probe`);
  expect(fake.requests[2]!.args.join(" ")).toContain(`head -c 26`);
  expect(fake.requests.every(call => call.maxOutputBytes === 2048)).toBe(true);
});
test("refusal and outside integrity are independent observations, never inferred from status", async () => {
  for (const exitCode of [0, 2]) for (const outsideUnchanged of [false, true]) {
    const fake = fakeDocker([ok(), { exitCode, stdout: "", stderr: "synthetic tar output" }, ok(JSON.stringify({ outsideUnchanged }))]);
    const result = await probeSnapshotExtraction(executor, root, fake.runner);
    expect(result.refused).toBe(exitCode !== 0); expect(result.outsideUnchanged).toBe(outsideUnchanged);
  }
});
test("invalid executor/root options start no process and preparation refuses reused or unsafe host roots", async () => {
  const untouched = fakeDocker([]);
  for (const value of ["", "/", "relative", "/private/../other", "/private/root/", "/private/a\nnext", '/private/a"b']) await expect(probeSnapshotExtraction(executor, value, untouched.runner)).rejects.toThrow("snapshot probe root: invalid");
  await expect(probeSnapshotExtraction({ ...executor, kind: "ssh", host: "-oProxyCommand=bad" }, root, untouched.runner)).rejects.toThrow("SSH alias");
  expect(untouched.requests).toEqual([]);
  const stopped = fakeDocker([{ exitCode: 1, stdout: "", stderr: "synthetic-private-root-detail" }]);
  await expect(probeSnapshotExtraction(executor, root, stopped.runner)).rejects.toThrow("snapshot probe prepare failed; check the fresh private test root");
  expect(stopped.requests).toHaveLength(1);
  expect(stopped.requests[0]!.args.join(" ")).toContain('test ! -L "$root"');
  expect(stopped.requests[0]!.args.join(" ")).toContain('test "$mode" = 700');
});
test("SSH preparation/extraction/readback retain BatchMode and shell-quoted paths", async () => {
  const fake = fakeDocker([ok(), refusal, ok('{"outsideUnchanged":true}')]), quoted = "/private/synthetic/probe with ' quote";
  await probeSnapshotExtraction({ ...executor, kind: "ssh", host: "fixture-host" }, quoted, fake.runner);
  expect(fake.requests.every(call => call.command === "ssh" && call.args.slice(0, 3).join(" ") === "-o BatchMode=yes fixture-host")).toBe(true);
  expect(fake.requests[1]!.args.at(-1)).toBe("'/private/synthetic/probe with '\\'' quote/probe/snapshot'");
});
test("tar diagnostics are bounded observed UTF-8; failures are not fabricated refusals", async () => {
  const requests: ProcessRequest[] = [];
  const runner: ProcessRunner = async request => {
    requests.push(request);
    if (requests.length === 1) return ok();
    if (requests.length === 2) return { exitCode: 2, stdout: "", stderr: "관측된 tar 오류\n".repeat(500) };
    return ok('{"outsideUnchanged":true}');
  };
  const result = await probeSnapshotExtraction(executor, root, runner);
  expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(2048); expect(result.stderr).toContain("tar 오류");
  for (const extraction of [{ ...ok(), timedOut: true }, { exitCode: -1, stdout: "", stderr: "signal" }]) await expect(probeSnapshotExtraction(executor, root, fakeDocker([ok(), extraction]).runner)).rejects.toThrow("snapshot probe extract failed");
  await expect(probeSnapshotExtraction(executor, root, fakeDocker([ok(), refusal, ok('{"outsideUnchanged":"yes"}')]).runner)).rejects.toThrow("snapshot probe readback failed");
});
