# Stage-sized execution reuse pilot

## Preregistration

- Five serial blocks on one CPU-only SSH executor. Each block starts with a fresh eligible source. Three pairs compare reuse off with eligible on unchanged, one-stage edit, and cold code-tree conditions. Odd blocks run off first and even blocks run eligible first. A new study per block prevents an edited result from warming the next edit pair.
- The one-stage edit changes bucket width from 50 to 80 through argv. The no-hit pair uses the original protocol and a changed frozen code tree. Only the eligible arm can publish eligible sources. Identical requests use explicit retries.
- A fixed PBKDF2 workload runs before each candidate stage. A calibration container measures 40 million iterations under the same isolation and CPU limit. Round the iteration count that projects 24 seconds up to the next million, freeze it before starting any measured arm, and keep it fixed through the pilot.
- Include all 30 scheduled arms. Five source attempts and the calibration are setup. Measurement uses recorded attempt end minus start wall time, including verification. Report source-stage wall, verification, materialization and storage separately. CPU telemetry stays unknown.
- Zero false reuse. Require exactly the predeclared hit set per arm, a fresh evaluator, matching sealed file bytes and metric bytes within each pair, and the independently expected evaluator numbers. The unchanged arm hits all three stages. The edit hits normalize only. The cold tree hits none.
- Every reused source stage must run for at least twice the largest measured per-attempt eligible verification overhead, and at least twice the prior pilot's 5.73 s maximum. A miss on this sizing gate or an incomplete comparison gives insufficient evidence.
- E1 performance gates use the median of ten paired percentage reductions on hit cases, at least 20%, and nearest-rank p95 of five paired no-hit overhead percentages, at most 5%. Report each case separately as well. Adopt only if all gates pass. Restrict if correctness and sizing pass and a case shows a practical benefit but a performance gate fails. Otherwise defer.
- Stop at two hours from the start of calibration. Transport and dataflow use the same private non-root, read-only rootfs, network-none, CPU-only policy. No model, GPU, download or service-account use.

