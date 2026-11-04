import type { Attempt } from "../src/exp/attempts.ts";
import type { Protocol } from "../src/exp/protocol.ts";
import { shellQuote, spawnRunner, type ProcessRunner } from "../src/exp/executor.ts";
import { LOG_COPY_BYTES } from "../src/exp/metrics.ts";

export function metricProtocol(): Protocol {
  const image = `fixture@sha256:${"a".repeat(64)}`;
  return { v: 1, method: "synthetic", candidate: { image, command: ["/candidate"] }, evaluator: { image, command: ["/evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 3, maxWallHours: 1, maxGpuHours: 0 } };
}
/** Synthetic USTAR records; no real data or Docker process is involved. */
export function metricTar(entries: { path: string; data?: string | Uint8Array; type?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const content = typeof entry.data === "string" ? Buffer.from(entry.data) : Buffer.from(entry.data ?? []), header = Buffer.alloc(512);
    if (Buffer.byteLength(entry.path) > 100) throw new Error("synthetic tar fixture path too long");
    header.write(entry.path, 0); header.write("0000644", 100); header.write("0001000", 108); header.write("0001000", 116);
    header.write(content.length.toString(8).padStart(11, "0"), 124); header.write("00000000000", 136); header.fill(32, 148, 156);
    header.write(entry.type ?? "0", 156); header.write("ustar", 257); header.write("00", 263);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, "0"), 148); header[154] = 0; header[155] = 32;
    parts.push(header, content, Buffer.alloc((512 - content.length % 512) % 512));
  }
  return Buffer.concat([...parts, Buffer.alloc(1024)]);
}
export function metricLogTar(stage: "candidate" | "evaluator", stdout: string, stderr = "", cuts = { stdout: false, stderr: false }): Buffer {
  return metricTar([{ path: `logs/${stage}.stdout.log`, data: stdout }, { path: `logs/${stage}.stderr.log`, data: stderr }, { path: `logs/${stage}.state.json`, data: JSON.stringify(cuts) }]);
}
/** Execute the real private-copy shell with an oversized local fixture, replacing Docker before execution. */
export function logCaptureFixtureRunner(fallback?: ProcessRunner): ProcessRunner {
  const producer = `process.stderr.write('fixture stderr context\\n'); process.stdout.on('error',()=>process.exit(17)); process.stdout.write('x'.repeat(${LOG_COPY_BYTES + 1024}),()=>process.exit(17));`;
  return async request => {
    if (request.command === "sh" && request.stdoutSink && request.args[1]?.includes("docker logs")) {
      const script = request.args[1].replace(/docker logs [a-f0-9]{64}/, `${shellQuote(process.execPath)} -e ${shellQuote(producer)}`);
      if (script.includes("docker logs")) throw new Error("synthetic runner refused an unhandled Docker command");
      // Exercise binary Darwin metadata even on CI Macs without automatic provenance.
      const decorated = process.platform === "darwin" ? script.replace(/\n(?=(?:COPYFILE_DISABLE=1 )?tar )/, '\nfor file in "$out" "$err" "$state"; do xattr -w -x user.ares.synthetic 00ff "$file"; done\n') + '\nfor file in "$out" "$err" "$state"; do xattr -p user.ares.synthetic "$file" > /dev/null; done' : script;
      return spawnRunner({ ...request, args: ["-c", decorated] });
    }
    if (fallback) return fallback(request);
    throw new Error("unscripted synthetic fixture process");
  };
}
export function metricAttempt(): Attempt {
  const p = metricProtocol(), start = "2030-01-01T00:00:00Z";
  const stage = (cid: string, kind: "candidate" | "evaluator") => ({ image: p[kind].image, argv: p[kind].command, mounts: [], network: "none" as const, limits: p.limits, user: "1001:1001", containerId: cid, startedAt: start, endedAt: start, exitCode: 0 });
  return { v: 1, id: "0123456789abcdef", studyId: "synthetic-study", run: "main", protocolHash: "a".repeat(64), sealBinding: "b".repeat(64), commit: "a".repeat(40), treeId: "b".repeat(40), snapshotSha256: "c".repeat(64), seed: 1, label: "baseline", executor: { v: 1, kind: "local", workdir: "/private/synthetic" }, protocol: p, paths: { snapshot: "/private/synthetic/attempt/snapshot", output: "/private/synthetic/attempt/output", evaluator: "/private/synthetic/attempt/task/evaluator", result: "/private/synthetic/attempt/result" }, status: "running", stage: "evaluator", startedAt: start, stages: { candidate: stage("c".repeat(64), "candidate"), evaluator: stage("e".repeat(64), "evaluator") }, metrics: [], outputs: [], sealing: { candidateHasNoEvaluator: true, evaluatorReadOnly: true, separateContainers: true, verifiedBy: "ares-observed" } };
}
