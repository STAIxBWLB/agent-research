import type { Attempt } from "../src/exp/attempts.ts";
import type { Protocol } from "../src/exp/protocol.ts";

export function metricProtocol(): Protocol {
  const image = `fixture@sha256:${"a".repeat(64)}`;
  return { v: 1, method: "synthetic", candidate: { image, command: ["/candidate"] }, evaluator: { image, command: ["/evaluator"] }, metrics: [{ name: "score", unit: "points", direction: "max" }], seeds: [1], limits: { cpus: 1, memoryMb: 64, pidsLimit: 32, wallSeconds: 60, gpus: 0 }, network: "none", budget: { maxAttempts: 3, maxWallHours: 1, maxGpuHours: 0 } };
}
export function metricAttempt(): Attempt {
  const p = metricProtocol(), start = "2030-01-01T00:00:00Z";
  const stage = (cid: string, kind: "candidate" | "evaluator") => ({ image: p[kind].image, argv: p[kind].command, mounts: [], network: "none" as const, limits: p.limits, user: "1001:1001", containerId: cid, startedAt: start, endedAt: start, exitCode: 0 });
  return { v: 1, id: "0123456789abcdef", studyId: "synthetic-study", run: "main", protocolHash: "a".repeat(64), sealBinding: "b".repeat(64), commit: "a".repeat(40), treeId: "b".repeat(40), snapshotSha256: "c".repeat(64), seed: 1, label: "baseline", executor: { v: 1, kind: "local", workdir: "/private/synthetic" }, protocol: p, paths: { snapshot: "/private/synthetic/attempt/snapshot", output: "/private/synthetic/attempt/output", evaluator: "/private/synthetic/attempt/task/evaluator", result: "/private/synthetic/attempt/result" }, status: "running", stage: "evaluator", startedAt: start, stages: { candidate: stage("c".repeat(64), "candidate"), evaluator: stage("e".repeat(64), "evaluator") }, metrics: [], outputs: [], sealing: { candidateHasNoEvaluator: true, evaluatorReadOnly: true, separateContainers: true, verifiedBy: "ares-observed" } };
}
