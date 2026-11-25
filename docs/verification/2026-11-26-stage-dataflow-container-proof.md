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

Attempt `363ce4fe91857fe4` from the review follow-up run, which exited 0 in 3 minutes 56 seconds. The controller compared full Docker IDs. The table shows ID prefixes for readability. Digests are SHA-256.

| Stage | Docker ID prefix | Declared input digest | Sealed manifest digest |
| --- | --- | --- | --- |
| prepare | `ae372e61928e` | data `7aa7978d5993914049b72041270eec80b6a6e53f592cafd1db88b39a7664b622` | `f135215cf85e5ebd1615b24d7a1760a96b747f1399d24c7161502c5e9974e982` |
| train | `6fd96f1c4e48` | rows `f135215cf85e5ebd1615b24d7a1760a96b747f1399d24c7161502c5e9974e982` | `bd5480d62e3453bb23ff98af5006a0cde030a3227755ac200e3e0d85d52e5c7e` |
| predict | `341152f8b991` | model `bd5480d62e3453bb23ff98af5006a0cde030a3227755ac200e3e0d85d52e5c7e` | `06d80416092d7fcf3312a80f93f87638ff8ae4a2cce362d2ff4b7d1269f7f49f` |
| evaluator | `372c2a43e0ad` | Verified candidate mounts | Score 32, provenance `ares-observed` |

### Acceptance criteria

| Criterion | Result | Evidence and remaining coverage |
| --- | --- | --- |
| AC1 | Passed | Fresh `prepare → train → predict → evaluator` in four distinct Docker containers. After the evaluator exited, the production verifier joined each seal to its observed container ID and checked each declared input hash. The evaluator read the final bytes through its own mount, validated them and emitted score 32. |
| AC2 | Passed | Controller-side protocol writes refused a cycle, traversal path, undeclared port, mutable image tag and forbidden environment name without changing the ledger. The executor refused an unsafe output link before sealing, an unavailable pinned image before launch, a cumulative 501st file before accepting evaluator evidence, and reservation overflow without changing reservation state. See the refusal receipts below. |
| AC3 | Unknown | Changing the retained train payload and deleting the retained predict payload each caused the executor to refuse materialization and leave the target absent. A live writer and process or host interruption at seal, publish, consume and prune remain unknown. |
| AC4 | Passed | Train and predict were refused writes to upstream inputs. Predict could see its declared input and did not receive the earlier rows port. The evaluator was refused writes to all three candidate artifacts, and each sealed hash still verified. Cancelling a running prepare container produced `cancelled`. Removing another running prepare container led reconciliation to record `unknown`. Each case launched exactly one container and no descendants. |
| AC5 | Unknown | A 268,959,744-byte in-flight reservation counted against a 270,008,320-byte cap and a second reservation was refused without changing reservation state. A materialized consumer reference blocked prune. Releasing that reference allowed fingerprinted prune and left a visible tombstone. Interleaving concurrent prune and consume operations remains unknown. |
| AC6 | Unknown | The v1 candidate and evaluator ran with the same isolation policy and produced score 6. The next seed was refused before a container launch or ledger mutation when the attempt limit was exhausted. First-final semantics, aggregate wall/compute budget probes, and release-level protocol v2 compatibility remain unknown in the live run. |

### Refusal receipts

| Probe | Observed refusal | Published evidence |
| --- | --- | --- |
| Declared output symlink to a path outside the output mount | The candidate exited and its output archive was rejected as `invalid-artifact`. One container launched. | Zero seals, outputs or metrics. |
| Cumulative output count | Two candidate stages wrote 250 regular files each. The evaluator wrote one metrics file, which exceeded the shared 500-file limit. All three containers launched and the attempt failed with `artifact-limit`. | The two valid candidate seals and 500 candidate output records remained. The overflowing file and metrics were rejected. |
| Unavailable pinned image | The declared digest was unavailable. The daemon's image lookup and pull failed against a loopback-only registry endpoint. Zero containers launched. | Zero seals, outputs or metrics. |
| Missing retained bytes | The predict payload file was deleted from the private test workspace. Consumer materialization rejected the retained-manifest mismatch. | The consumer target remained absent. |

All three failed attempts released their retention reservations. The image probe exercises pre-launch refusal for an unavailable digest. A running container with an image identity different from its recorded request would require substituting the container or changing the runtime. The executor checks that identity during inspection.

### Reproduce

On the controller, install the pinned dependencies and run the proof from the checkout. Create the executor directory with `mktemp -d` on the designated SSH executor and verify mode 0700. Use a new directory for each run. The Alpine digest must already be cached on the executor. Run under a two-hour outer timeout and remove the synthetic executor directory after collecting the receipt.

```sh
bun install --frozen-lockfile
timeout 2h bun scripts/verify-stage-dataflow-container.ts "$executor_alias" "$private_executor_dir" \
  alpine@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659
```
