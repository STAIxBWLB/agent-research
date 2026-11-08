# Execution evaluation preregistration

This is #63 T1, registered before treatment outcomes. All budgets, metrics and thresholds below are **proposed, not measured**. This document and `execution-eval-preregistration.json` are the frozen method; `execution-eval-frozen.json` binds their exact bytes, source code and the corpus. A freeze receipt is a registration record, not evidence that a trial passed.

The owner approved baseline preparation and a later T2a task. This change performs no baseline or treatment execution. T2a covers current-workflow Diagnose and Reuse baselines only; Supervision stays preregistered because its arms run in agent-hub. Treatment integration, treatment runs, advisory mode and native/account execution each need their separate go-ahead. No lineage, cache/reuse or supervision feature is implemented here. No external Python/Shepherd runtime, proof machinery or dependencies are introduced.

## Frozen corpus and visibility

The explicit ordered index is `test/fixtures/execution-eval/corpus.json`. It names 36 synthetic cases and separate input/expected files:

| Trial | Cases and coverage | Sealed expected properties |
| --- | --- | --- |
| Diagnose | 12, two each stale head, missing artifact, retry, uncertain delivery, privacy gap and corrupt source | Artifact-producing attempt/head, selected head, status, provenance completeness and the safe next action |
| Reuse | 12, two each local-stage edit, global code change, no-hit, corrupt artifact, pruned artifact and interrupted source | Eligibility/invalidation labels, stage execution expectations and deterministic fresh outputs for three seeds |
| Supervision | 12, four ordinary-progress tasks, four true triggers and four misleading symptoms | Explicit boolean trigger truth, reason and next action; labels do not establish useful live interventions |

Only the `input` payload inside each `.input.json` record is candidate-visible. Its wrapper id/trial/scenario, the corpus index and `.expected.json` records remain evaluator-only; never copy those labels into candidate workspaces, stdout or model prompts. Reuse fixtures describe proposed eligibility and deterministic arithmetic, but contain no treatment execution or measured cache benefit. The sealed expected outputs are not independent samples. Diagnoses/tasks are invented; no real task bodies, private logs, account material or internal host names are included.

The manifest is ordered and explicit; the harness never scans the disk. Each fixture is bounded to 16 KiB, the corpus to 48 cases, registration documents/receipts to 64 KiB, code files to 256 KiB and all read source bytes to 3 MiB. Symlink files/parents and non-regular sources are refused. Receipt files are private (0600), created exclusively, and never silently replaced.

## Arms, repetitions and order

- Diagnose: current workflow versus future H1/A1/C1 lineage view, three paired repetitions on the corpus. Automated source-resolution checks and timing are separate from human accuracy/time-to-find. Each human sees an incident only once; incident assignment is counterbalanced across participants and arms. No human sessions are authorized or measured by T1/T2a. If they remain unavailable, human timing is unknown and the lineage threshold is insufficient evidence.
- Reuse: fresh execution versus future eligible reuse, three paired seeded repetitions per cold/warm condition. Each case's frozen workload declares its three repetition seeds: 3/11/19 for first variants, 4/12/20 for second variants. Both arms must use identical hardware, pinned environment, seeds and budgets. Cold and warm observations remain separate. A rerun/final always uses fresh decisive execution; cache reuse is not an additional seed or independent sample.
- Supervision: current hub rules versus H2 shadow and separately authorized advisory mode. Six repetitions counterbalance the six orders ABC, ACB, BAC, BCA, CAB and CBA. No arm executes in T1/T2a, and simulated truth labels cannot be reported as measured human recovery benefit.

For paired trials, arm order is AB when `(corpusIndex + repetitionIndex) % 2 == 0`, BA otherwise. With 12 cases and three repetitions, the total orders balance. Baseline-only work runs only the current arm; placeholders are not fabricated treatment observations. Preserve the planned order for later authorized matching, rather than silently adapting it to outcomes.

Record the exact OS, CPU/hardware identity, Bun version and any container digest in the run-admission receipt before effect. Bun 1.4.2 is the proposed evaluation runtime. The frozen source/authority hashes identify the code; version 0.2.1 identifies the preregistered package line. An environment mismatch invalidates a paired comparison instead of being hidden by aggregation.

## Budgets and resource boundaries

The proposed budget is one active attempt per study, two CPU workers, zero GPU devices, at most 60 seconds wall and 60 process-CPU seconds per scheduled case/arm/seed/cold-or-warm condition (one attempt, no automatic retry), 256 MiB memory and 32 PIDs. Each independent trial has a two-hour wall ceiling, 7200 CPU seconds, 16 MiB retained artifacts and 16 MiB transfer. The machine protocol carries the exact limits and file bounds. Resource admission still applies; no benchmark expands host concurrency, bypasses a gate or starts a resident worker.

Stop a trial at its ceiling, record incomplete/failed/cancelled/unknown cases and the costs already incurred, and do not increase its budget after seeing a result. Budget exhaustion can mean insufficient evidence. Local fixture work is separate from live native/account evidence, which requires explicit authorization and a new cost ceiling. This protocol grants no such authorization.

## Metrics and denominators

Every planned case/arm/seed/condition is part of the full denominator. Publish succeeded, failed, cancelled, unknown and excluded counts alongside it. Exclusion requires a recorded reason and remains in the full denominator; neither successful-only summaries nor dropped failures are the primary comparison. Not-started or unobservable scheduled cases remain unknown. A secondary completed-only sensitivity analysis must be labeled separately.

- Accepted-outcome rate: outcomes accepted by the existing selection/final machinery divided by all scheduled cases, with status denominators reported. No new result authority is defined by this harness.
- Diagnose: correct provenance **and** correct next-action labels divided by all incident presentations; also report each component. Required provenance links present/correct divided by all required links measures completeness. Unreadable links count missing. Human time-to-find is presentation-to-submission monotonic wall time; automated source-resolution timing cannot substitute for it.
- Reuse: count false reuse against sealed semantic-input and validity labels. Compare paired median eligible-case compute reduction on the same hardware. CPU seconds are the primary CPU-only fixture measure; device/provider clocks are separate. No-hit p95 overhead uses nearest rank on paired per-case overhead; report the small sample size. An unknown or zero fresh denominator gives insufficient evidence.
- Supervision: helpful/false/missed/duplicate proposals, accepted outcomes and extra person decisions against the full truth-labeled set. Proposal labels alone do not prove person usability or recovery time.

Publish paired per-case distributions and sample sizes. If samples exist, median uncertainty may use 1000 bootstrap resamples with fixed seed 101; p95 uses the preregistered nearest-rank convention and reports its sample size. These are bounded product adoption trials, not scientific superiority claims.

## Proposed acceptance thresholds

No threshold is measured by this delivery:

| Trial/property | Proposed condition |
| --- | --- |
| Fault suite | Zero false reuse and zero provenance, privacy or gate violations |
| Lineage | At least 20% median human time-to-find reduction, with no accuracy loss |
| Reuse | At least 20% median eligible-case total compute reduction; at most 5% p95 compute overhead on no-hit cases |
| Supervision | Improved accepted-outcome rate **or** at least 20% lower recovery time, with no increase in the total measured cost vector or person decisions; otherwise retain shadow/off |

An unmeasurable human clock or missing cost denominator gives **insufficient evidence**, never pass. A future authorized trial can report adopt/restrict/defer only with an evidence hash, uncertainty, missing measurements, limitations and bounded scope. Trials stop independently; failure of one does not block an unrelated read-only utility. T1 has no adoption disposition.

## Cost schema and instrumentation

`costs.fields` in the machine protocol and `validateCostRecord` define the exact record. Every field is a nonnegative measured value in its declared unit or the literal `unknown`. Missing fields, NaN, infinity, negative values, numeric strings and a fabricated scalar total are refused. Unknown provider usage or missing instrumentation never becomes zero.

| Component | Separately recorded dimensions |
| --- | --- |
| Compute/provider | Process CPU seconds, GPU device-active seconds, measured provider tokens and requests |
| Wall | Monotonic end-to-end elapsed milliseconds |
| Storage/transfer | Peak bytes, byte-seconds and transferred bytes |
| Verification | CPU seconds and wall milliseconds, identified as subsets of end-to-end totals |
| Retention | Retained bytes and retained byte-seconds |
| Materialization | CPU seconds, wall milliseconds and transferred bytes |
| Failure overhead | CPU seconds, device-active seconds, wall milliseconds and transferred bytes spent on failed work/recovery |
| Idle/person | Idle wall milliseconds and person minutes, separate from compute and each other |
| Money | Explicitly labeled USD estimate, separate from measured usage and time |

Use process resource usage, monotonic timers and explicit byte/retention counters when execution is authorized. Costs include failed attempts. Materialization, verification and failure overhead annotate the appropriate end-to-end totals; never add those subsets again. Do not sum CPU, GPU, wall, idle or person clocks, or bytes, tokens and currency. Total measured cost is a vector, not one invented scalar. Missing required cost dimensions prevents the corresponding threshold comparison. T1 validates schema only and collects no measurements.

## Freeze and verify

```sh
bun scripts/execution-eval.ts freeze
bun scripts/execution-eval.ts verify
# Optional fresh receipt path for a separately reviewed registration:
bun scripts/execution-eval.ts freeze /absolute/owned-directory/receipt.json
```

The default receipt is `docs/verification/execution-eval-frozen.json`. The first command creates it exclusively. If it exists, `freeze` behaves as `verify` and never rewrites it. The explicit code list includes this harness, package identity and all current runtime source files, including selection/final dependencies. The receipt binds those code files, this document and the machine protocol, the index/candidate inputs and evaluator-only expected bytes; it separately binds thresholds and all denominators. Byte edits, changed thresholds, missing denominators or changed source hashes produce a named refusal. Restore the frozen bytes or register a separately reviewed protocol and a new receipt; do not delete or replace the prior evidence silently. There is no `run`, treatment, account or rollout command.

The existing `src/exp/selection.ts`, closed investigation reader and `src/exp/final.ts` remain the only comparison/final-result authorities. Future baseline receipts must link actual existing study/attempt/result hashes. Final decisive results stay fresh and immutable. Sealed evaluator files provide same-user workflow integrity, not a hostile same-UID security boundary. No new study file, ledger event, CLI/MCP operation or winner calculator is added.

## Verification scope

Tests cover byte mutation, threshold change, denominator removal, expected/source/method/seal drift, bounds and unknown-cost preservation using temporary synthetic roots. Standard verification is `bun install --frozen-lockfile && bun run check`. Tests never launch live agents, account tools, containers or network requests. Source/fixture checks, hosted CI and native/live evidence must always be labeled separately. The corpus and receipt show preregistration only; T2a baseline measurements remain a follow-up task.
