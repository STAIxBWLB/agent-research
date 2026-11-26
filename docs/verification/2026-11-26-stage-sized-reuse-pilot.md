# Stage-sized execution reuse pilot

26 November 2026 KST. [Issue #64 T5](https://github.com/STAIxBWLB/agent-research/issues/64) authorizes this synthetic follow-up.

## Preregistration

Frozen before calibration in `f33a23c8d041a595f2fb4cad5b74c66acb02d661`. The [evaluation protocol](execution-eval-protocol.md) supplies the E1 gates.

- Five serial blocks on one CPU-only SSH executor. Each block starts with a fresh eligible source. Three pairs compare reuse off with eligible on unchanged, one-stage edit, and cold code-tree conditions. Odd blocks run off first and even blocks run eligible first. A new study per block prevents an edited result from warming the next edit pair.
- The one-stage edit changes bucket width from 50 to 80 through argv. The no-hit pair uses the original protocol and a changed frozen code tree. Only the eligible arm can publish eligible sources. Identical requests use explicit retries.
- A fixed PBKDF2 workload runs before each candidate stage. A calibration container measures 40 million iterations under the same isolation and CPU limit. Round the iteration count that projects 24 seconds up to the next million, freeze it before starting any measured arm, and keep it fixed through the pilot.
- Include all 30 scheduled arms. Five source attempts and the calibration are setup. Measurement uses recorded attempt end minus start wall time, including verification. Report source-stage wall, verification, materialization and storage separately. CPU telemetry stays unknown.
- Zero false reuse. Require exactly the predeclared hit set per arm, a fresh evaluator, matching sealed file bytes and metric bytes within each pair, and the independently expected evaluator numbers. The unchanged arm hits all three stages. The edit hits normalize only. The cold tree hits none.
- Every reused source stage must run for at least twice the largest measured per-attempt eligible verification overhead, and at least twice the prior pilot's 5.73 s maximum. A miss on this sizing gate or an incomplete comparison gives insufficient evidence.
- E1 performance gates use the median of ten paired percentage reductions on hit cases, at least 20%, and nearest-rank p95 of five paired no-hit overhead percentages, at most 5%. Report each case separately as well. Adopt only if all gates pass. Restrict if correctness and sizing pass and a case shows a practical benefit but a performance gate fails. Otherwise defer.
- Stop at two hours from the start of calibration. Transport and dataflow use the same private non-root, read-only rootfs, network-none, CPU-only policy. No model, GPU, download or service-account use.

## Source, fixtures and hosted CI

- Runtime base `05699c24953a0cd5a37721fc8255703d20a9b295` (v0.4.1). The [measurement script](../../scripts/verify-stage-sized-reuse.ts) calls the production attempt and retention entry points. The script copies the T4 numeric fixtures into a synthetic Git repository, freezes the CPU workload in that repository and records traversal and result hashes. The [T4 report](execution-reuse-pilot.md) remains intact.
- [Hosted CI for the runtime base](https://github.com/STAIxBWLB/agent-research/actions/runs/45550214463) passed Ubuntu, macOS and N-1. It covers repository checks and fixtures. The measurements below come from the SSH executor.

## Live setup

The cached Node image was `node@sha256:ff054b356ab93ed540518ca23cfcd9840e5256dd04db5a8d8afc43f4ecc7c9f8`. Containers used one CPU, 512 MiB RAM, 64 PIDs, zero GPUs and a 180-second attempt wall limit. The executor workspace was mode 0700. Calibration measured 5,221 ms for 40 million PBKDF2 iterations and fixed each candidate stage at 184 million iterations. The fresh evaluator verifies the numeric pipeline independently and records checksum and coverage. The resumed invocation used frozen trees `3a5829244cb103ea04cea5f88bde0b6f38b73b64` (original) and `a4bd0edb8a5967e5131c4251ac8be2ee182ec469` (cold).

To repeat the live leg, use the recorded iteration count on the same hardware or recalibrate before collecting new data. Create a new mode-0700 directory on the SSH executor and ensure the pinned image is cached. Install the frozen dependencies on the controller and run the script from the repository root. Apply the remaining total deadline after calibration.

```sh
bun install --frozen-lockfile
timeout "$remaining_seconds" bun scripts/verify-stage-sized-reuse.ts "$executor_alias" "$private_executor_dir" 184000000
```

### Setup interruption

The first invocation completed block 1 and then recorded `executor-start` while establishing the unmeasured source for block 2. The executor reported a container-start failure and did not preserve a more specific cause. The controller then resumed at block 2 in a fresh private workspace, with the frozen workload, arm order, and original deadline unchanged. Block 1 remained in the denominator. The resumed invocation removed the pilot's exited Docker containers at each block boundary and ended with exit 0. Calibration, both invocations, and the interruption fit within 1 hour 28 minutes from preregistration.

## Live measurements

All 30 planned measured arms succeeded. Zero failed, cancelled, unknown, or excluded measured arms. Five sources succeeded and one preliminary source setup failed. The setup attempts remain separate from the measured denominator.

Combined receipt log SHA-256 `3a133b5aef57d81b4b15a000bdc68d55cddedf530a9a347705549080e741ae39`. Attempt IDs are scoped to each block’s study. The table gives wall seconds, with verification and materialization in the eligible arm shown separately as components of that wall.

| Case | Block | Off attempt | Eligible attempt | Off wall s | Eligible wall s | Eligible verify s | Eligible materialize s | Eligible hits |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: |
| unchanged | 1 | `680c273d66ad927f` | `987a1d86cdde9fd2` | 140.848 | 45.655 | 5.643 | 7.864 | 3 |
| unchanged | 2 | `7b99cbeefe9d0790` | `9f488b6246a1735e` | 157.983 | 53.226 | 6.390 | 9.292 | 3 |
| unchanged | 3 | `9f488b6246a1735e` | `7b99cbeefe9d0790` | 142.309 | 44.926 | 5.130 | 7.061 | 3 |
| unchanged | 4 | `7b99cbeefe9d0790` | `9f488b6246a1735e` | 142.950 | 42.284 | 5.343 | 7.234 | 3 |
| unchanged | 5 | `9f488b6246a1735e` | `7b99cbeefe9d0790` | 141.156 | 42.303 | 5.517 | 7.314 | 3 |
| edit | 1 | `65bd036a11b7aa53` | `398c37584569753b` | 143.278 | 113.016 | 5.160 | 7.676 | 1 |
| edit | 2 | `b44972dcef3ab780` | `0b52cdd6356ca5df` | 153.488 | 125.506 | 6.797 | 9.142 | 1 |
| edit | 3 | `0b52cdd6356ca5df` | `b44972dcef3ab780` | 143.309 | 112.716 | 4.967 | 7.524 | 1 |
| edit | 4 | `b44972dcef3ab780` | `0b52cdd6356ca5df` | 141.816 | 110.535 | 5.477 | 7.731 | 1 |
| edit | 5 | `0b52cdd6356ca5df` | `b44972dcef3ab780` | 142.728 | 111.980 | 5.295 | 7.480 | 1 |
| no-hit | 1 | `2e0ef643d3315d89` | `431804aedd357b8c` | 143.822 | 150.809 | 5.378 | 7.914 | 0 |
| no-hit | 2 | `64ae1cb08d1d6dd8` | `3d5e17cedf0aacc5` | 146.224 | 156.194 | 6.529 | 8.755 | 0 |
| no-hit | 3 | `3d5e17cedf0aacc5` | `64ae1cb08d1d6dd8` | 139.739 | 146.783 | 5.457 | 7.084 | 0 |
| no-hit | 4 | `64ae1cb08d1d6dd8` | `3d5e17cedf0aacc5` | 141.579 | 149.517 | 5.498 | 7.678 | 0 |
| no-hit | 5 | `3d5e17cedf0aacc5` | `64ae1cb08d1d6dd8` | 142.781 | 148.390 | 5.280 | 7.090 | 0 |

Reused source stages ran for 23.189–29.877 s. The largest measured verification overhead was 6.797 s in an eligible arm and 6.029 s in setup. The sizing floor was 13.594 s.
Verification took 4.967–6.797 s per eligible arm.
Materialization took 7.061–9.292 s per eligible arm.
Per-attempt manifest sidecar accounting was 2,853–2,855 B off and 3,087–3,089 B eligible. CPU time and net disk savings were unknown.
Recorded attempt wall totalled 3717.850 s for the 30 measured arms and 749.155 s for the five successful source setups.

All 15 pairs matched on every sealed stage file hash and on the evaluator file hash. The evaluator produced checksum 231 with coverage 47 in unchanged and no-hit cases, and checksum 137 with coverage 47 in the edit. Each arm had its own evaluator container.

## E1 decision

| Gate | Live result | Outcome |
| --- | --- | --- |
| False reuse | 0 of 20 observed eligible hits. All 15 pairs matched on artifact and evaluator bytes. | Pass |
| Median paired wall reduction on hit cases ≥20% | 44.18% across ten pairs | Pass |
| p95 paired no-hit overhead ≤5% | 6.82% across five pairs | Fail |

- unchanged median reduction 68.43%, observed range 66.31% to 70.42%.
- edit median reduction 21.35%, observed range 18.23% to 22.06%.
- no-hit median overhead 5.04%, observed range 3.93% to 6.82%.

**Restrict.** Enable eligible reuse only for workloads with retained matching sources and stage costs comparable to or larger than this pilot. The no-hit p95 exceeded the predeclared ceiling, so the default stays off. The edit condition varied around the 20% threshold and does not establish a uniform benefit for partial hits. With five no-hit pairs, nearest-rank p95 is the single slowest observed pair. Shared-host load and controller reconciliation time are part of these wall measurements, which apply only to this synthetic pipeline and executor configuration.
