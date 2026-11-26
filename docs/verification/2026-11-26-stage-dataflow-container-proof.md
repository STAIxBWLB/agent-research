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

## T5 follow-up

T5 exercises the remaining live cases authorized in [#61](https://github.com/STAIxBWLB/agent-research/issues/61). The T4 results above retain their original scope. The follow-up used the same cached Alpine digest, mode-0700 executor directories and CPU-only isolation policy. Synthetic controllers and retention workers were the only processes targeted for interruption. Host power loss is out of scope.

### Source, fixture and compatibility evidence

- The runtime base for T5 was `195d833`. Fault injection lives in the manual verification script. The executor worker loads the unchanged production retention program under a test-only Python line trace. The trace emits a marker and delivers SIGKILL to that worker's own PID. A foreground shell preserves the signal-derived exit status over SSH.
- The worker-level fixtures use the observation and identity from a real successful Docker producer. They stage independent copies of one synthetic byte for the races and kill-point checks. The controller scenarios use complete real attempts with unchanged runtime entry points.
- Release compatibility follows the [0.3.0 N-1 matrix](../../CHANGELOG.md#030---2026-11-10). It records 0.2.1's explicit refusal of stage protocol v2 and attempt v2/v3, and read compatibility for the older study and ledger formats. The matrix was not rerun for T5.

### Live race receipts

Twenty rounds each started prune confirmation and materialization concurrently against one sealed reference. The controller alternated submission order and retried the native busy response until the processes produced a result. Consume won 13 times. Each time prune refused the active reference and the source verified. Prune won seven times. Each time the tombstone was visible, consumption refused and the consumer target was absent. A separate readback of the 13 materialized files found the same SHA-256 in every case, matching the one-byte synthetic source. This completes the AC5 live evidence started by the T4 reservation test.

### Executor interruption receipts

| SIGKILL point | State immediately after the kill | Recovery |
| --- | --- | --- |
| Seal | The worker had copied the declared output into quarantine. No inventory entry existed. | The same request discarded the pending copy, sealed again and verified the result. |
| Publication | The worker had renamed the verified directory into its final location and synced its parent. The inventory still had no reference for it. | The same request verified the manifest, original source and published bytes before indexing the seal. |
| Consumption | The worker had recorded the consumer reference and created a pending directory. The consumer target was absent. | The same request materialized the expected input hash. |
| Prune | The tombstone existed before deletion. Verifying the retained source refused it. | A fresh preview and confirmation completed disposal. |

The live-writer fixture rewrote its declared output each second. Docker confirmed that the producer remained running through the consume probe. Reconciliation published no seal, and materializing a speculative reference to the producer refused before creating a target. The producer was then cancelled and reconciled with zero completed stages.

### First-final receipt

A baseline and winner were selected from live investigation attempts. Each final used reserved seed 2 and the frozen repository snapshot. The first winner final (`4d88eec6b57e070a`) was cancelled after its fresh candidate started. The later winner retry (`a8cdc5b1da4ab0b9`) and baseline (`f4d85d97a1b72403`) succeeded with fresh candidates and separate evaluators, producing frozen scores 2 and 1. Final close kept the cancelled attempt decisive, classified the successful retry as `later-attempt`, and returned `not_qualified` with reason `cancelled`, as specified in [#32](https://github.com/STAIxBWLB/agent-research/issues/32).

### Aggregate wall receipt

The protocol allowed 70 seconds for the entire attempt, with two candidate stages and an evaluator that would otherwise sleep for 60 seconds. Both candidates completed and the evaluator started. Its container exited 137 at 69.993 seconds from the attempt start. The controller later recorded `failed/wall-clock` at 101.164 seconds with no metrics. The first run also failed with reason `wall-clock`. Its harness initially compared the controller's terminal-record time with the execution limit. The follow-up uses Docker's observed stop time for the exposure limit and reports the controller delay separately. This is CPU-only wall-budget evidence. It does not measure CPU time or exercise a GPU allowance.

### Controller interruption method

The proof launches a separate Bun controller for each private study. An instrumented transport only selects the process interruption boundary. Before sending SIGKILL to itself, the child either reaches a dispatch boundary or receives the real executor reply. Seal and consumption kill just before dispatch. Publication kills immediately after the worker completed and indexed its seal, before the controller records the stage. Prune kills the explicit prune controller after the worker completed disposal, before the controller writes its local audit event. Prune is a separate operation from `attempt run`.

The control lock left by a killed controller can block reconciliation for 30 minutes. The study write lock left by the prune controller can block confirmation for 10 minutes. The fixture allows these claims to expire on their original clock and records the initial refusal when a claim exists. The extended attempt limit in these small controller fixtures accommodates the wait. The separate aggregate-budget fixture uses the 70-second limit described above.

### Controller interruption receipts

| SIGKILL point | State after the kill | Recovery |
| --- | --- | --- |
| Seal dispatch | Zero visible seals and zero committed stage transitions. Immediate reconciliation refused the still-current claim. | After natural control-claim expiry, reconciliation sealed the stopped producer and finished the same attempt. |
| Publication response | One fully indexed and verified seal, with zero stage transitions in the controller. Immediate reconciliation refused the still-current claim. | After expiry, reconciliation adopted the same seal and finished the same attempt. The separate worker kill exercised the earlier, unindexed publication state. |
| Consumption dispatch | The valid parent seal remained visible and the next-stage input target was absent. | Reconciliation materialized the next input, ran the remaining stages and finished the same attempt. |
| Prune response | The tombstone was authoritative and source verification refused. The local audit event was absent. | After study-lock expiry, a fresh preview and confirmation recorded the local audit event. The tombstone still barred consumption. |

Each worker interruption left zero reserved bytes after exact operation recovery and study reconciliation. The controller leg exited 0 in 31 minutes 26 seconds, including natural lock expiry. All live legs and fixture retries finished within 51 minutes of the task offer. The fixture corrected its initial producer count to honor the 16-stage limit and repeated the worker probe under a foreground shell to preserve SSH signal status.

### Acceptance after T5

- **AC3 passed for process interruptions.** The worker and controller probes exercised seal, publication, consumption and prune. Quarantine or unindexed bytes never became consumable. A verified seal that had fully committed before the controller died remained valid. The live writer had no consumable reference. T4 separately covered tampering and missing bytes.
- **AC5 passed.** T4 covered in-flight reservation accounting. T5 observed both valid outcomes across 20 concurrent prune and consume rounds.
- **AC6 passed.** T4 covered v1 execution and attempt-limit refusal. T5 observed fresh v2 final execution, first-final accounting and the shared attempt wall deadline. The release compatibility evidence is the cited matrix.

### Hosted checks and reproduction

[Hosted Check for the T5 runtime base](https://github.com/STAIxBWLB/agent-research/actions/runs/45728102846) passed. The live checks here use the executor and are separate from that result.

For T5, use the same command and image as T4, with `--follow-up` to run the worker, race, live-writer, first-final and budget scenarios. Run a second invocation in a fresh private executor directory with `--controller-crashes` for the controller scenarios. Share one two-hour deadline across the invocations and allow about 30 minutes for natural lock expiry. The optional `--retention-only`, `--final-budget` and `--budget-only` selectors following `--follow-up` replay smaller groups using the same code.
