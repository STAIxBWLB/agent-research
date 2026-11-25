# Stage dataflow container proof

26 November 2026 KST. [Issue #61](https://github.com/STAIxBWLB/agent-research/issues/61) authorized a two-hour window for a synthetic CPU-only run on the designated SSH container executor.

## Source and fixtures

- Executor and retention source at `05699c24953a0cd5a37721fc8255703d20a9b295` (v0.4.1). The proof script changes no runtime code.
- [verify-stage-dataflow-container.ts](../../scripts/verify-stage-dataflow-container.ts) creates a synthetic Git repo and studies. It calls the real attempt and retention entry points and delegates SSH requests to the production process runner. There are no fake Docker results, injected clocks, model calls, or evaluator metric stubs.
- [PR #124](https://github.com/STAIxBWLB/agent-research/pull/124) added the fake transport and synthetic retention states. The protocol validation probes in the proof also run on the controller, before a container could observe the rejected configuration.

## Hosted CI

- [Check on the tested main commit](https://github.com/STAIxBWLB/agent-research/actions/runs/45550214463) passed Ubuntu, macOS and the N-1 job. These jobs are fixture and compatibility evidence. The live script is a separate manual run.

## Live evidence

The fixture used a private mode-0700 executor directory and cached Alpine image `alpine@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659`. The attempt limits were one CPU, 64 MiB, 32 PIDs, 120 seconds and zero GPUs. Each successful stage checked that its UID was nonzero, loopback was its only visible interface, `/dev/nvidia0` was absent and a root filesystem write returned `Read-only file system`. The executor managed every stage and the separate evaluator as fresh Docker containers. The fixture used no models, external service accounts, or GPU devices.

### Stage receipt

Attempt `ee1f366167949944`. The final proof invocation exited 0 after 2 minutes 41 seconds. The controller compared full Docker IDs. The table shows ID prefixes for readability. Digests are SHA-256.

| Stage | Docker ID prefix | Declared input digest | Sealed manifest digest |
| --- | --- | --- | --- |
| prepare | `f30fe3a484f2` | data `7aa7978d5993914049b72041270eec80b6a6e53f592cafd1db88b39a7664b622` | `748a4d8cd2bf6ae6fa8d7b630a47c01f6e9e571d7d18ad061680a65d428aa172` |
| train | `f64af63ad997` | rows `748a4d8cd2bf6ae6fa8d7b630a47c01f6e9e571d7d18ad061680a65d428aa172` | `ad7a9473a3b5f68e673f12a7541294a7df09c5fe363488fb18c4b0450959c32c` |
| predict | `47e59658e41c` | model `ad7a9473a3b5f68e673f12a7541294a7df09c5fe363488fb18c4b0450959c32c` | `f2fc986761e08ad6c0ea644b2aea32079089a74e85f3cd16e632bf5338b028bf` |
| evaluator | `de805a1eb307` | Verified candidate mounts | Score 32, provenance `ares-observed` |

### Acceptance criteria

| Criterion | Result | Evidence and remaining coverage |
| --- | --- | --- |
| AC1 | Passed | Fresh `prepare → train → predict → evaluator` in four distinct Docker containers. After the evaluator exited, the production verifier joined each seal to its observed container ID and checked each declared input hash. The evaluator read the final bytes through its own mount, validated them and emitted score 32. |
| AC2 | Unknown | Controller-side protocol writes refused a cycle, traversal path, undeclared port, mutable image tag and forbidden environment name without changing the ledger. Executor-side reservation overflow refused before changing reservations. Live unsafe-link, wrong-image identity, and cumulative size-limit cases remain unknown. |
| AC3 | Unknown | Deliberate same-user mutation of a synthetic retained payload caused the executor to refuse materialization and leave the target absent. Missing bytes, a live writer, and process or host interruption at seal, publish, consume and prune remain unknown. |
| AC4 | Passed | Train and predict were refused writes to upstream inputs. Predict could see its declared input and did not receive the earlier rows port. The evaluator was refused writes to all three candidate artifacts, and each sealed hash still verified. Cancelling a running prepare container produced `cancelled`. Removing another running prepare container led reconciliation to record `unknown`. Each case launched exactly one container and no descendants. |
| AC5 | Unknown | A 268,959,744-byte in-flight reservation counted against a 270,008,320-byte cap and a second reservation was refused without changing reservation state. A materialized consumer reference blocked prune. Releasing that reference allowed fingerprinted prune and left a visible tombstone. Interleaving concurrent prune and consume operations remains unknown. |
| AC6 | Unknown | The v1 candidate and evaluator ran with the same isolation policy and produced score 6. The next seed was refused before a container launch or ledger mutation when the attempt limit was exhausted. First-final semantics, aggregate wall/compute budget probes, and release-level protocol v2 compatibility remain unknown in the live run. |

### Reproduce

On the controller, install the pinned dependencies and run the proof from the checkout. Create the executor directory with `mktemp -d` on the designated SSH executor and verify mode 0700. Use a new directory for each run. The Alpine digest must already be cached on the executor. Run under a two-hour outer timeout and remove the synthetic executor directory after collecting the receipt.

```sh
bun install --frozen-lockfile
timeout 2h bun scripts/verify-stage-dataflow-container.ts "$executor_alias" "$private_executor_dir" \
  alpine@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659
```
