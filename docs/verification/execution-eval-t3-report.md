# Measured treatment trials (#63 T3)

This report covers the three registered T3 trials: Diagnose (the lineage treatment against a fresh rerun of the same
workflow), Reuse under the r2 rematerialization (eligible reuse against fresh execution) and Supervision v2 in shadow
mode. All observations are synthetic fixture runs on a private CPU-only executor, scored against the frozen corpora and
the preregistered E1 thresholds. Nothing here is a live study, a model or account call, an advisory-mode run or a board
observation, and no product winner, adoption authority or research claim follows from it.

## Recorded base

| item | value |
| --- | --- |
| task base | `047c8d67540cff43c8479cdd82fa6b5ac065eca5` (PR #151 merge; PR #147 merged the #123 reuse pilot as `6a01fd23e9c26370439fac3f83cef20266b49ef4`) |
| measured branch | `feat/63-t3-runs`, head `7ac289cf9354bb0c9750d17c6dc4f54ff5a1624a` |
| Reuse and Supervision capture code | `29db7d4259bcb40b264b09a1515da8a934f5fef8` (tree `b263918887c645a527c484aee70adfe4078225cc`, code SHA-256 `94ed67e881b9fdcad4fd4473b809a94d193f54976f56f844164ede6144cb872a`) |
| Diagnose capture code | `a10eb2477a950a7d5728c268ff5a6dd480f31f2b` (tree `eb3ae53e6c09d7927b109cc9dbd6855b39656f85`, code SHA-256 `7ad41ec68eca8e4ea87bc1f6358a0c41cf7d1c26a618f2ab496741db0008798e`) |
| v1 method/corpus/threshold seal | `72f36f856c2559bf7a626689bca3825ae3cfe49f27c9d8abf544f24bd2778e20` |
| Supervision v2 amendment seal | `5fd3cc18a888bd9a11f06db2996a9cff284aae3ff52b3c47eb0609d16a4200cf` |
| Reuse r2 rematerialization receipt (setup `25cbc1a5cc41f45757723a41742407ada8db5bba71ef08aaf8728233f7eb3f80`) | `2af9433e5de8a5737bcd3791f1cee57adff015686cb9b3238ff73ac607ba72fe` |

The three seals and the superseded original Reuse receipt (raw `8ba0e135`, setup `dce537e2`) were verified before and
after every actual run and again by the final verification pass. None of them was altered, re-frozen or relabeled.

This branch must merge with a merge commit, never a squash: the run receipts bind `29db7d4` (Reuse, Supervision) and
`a10eb24` (Diagnose) as ancestors of the head through `verifyRunCodeCommit`, and a rewritten history would leave those
captures unattachable to the code that produced them.

## Constraints honored

- CPU only. `limits.gpus` is 0, no device was configured and no attempt requested one; GPU device seconds stay `unknown`.
- No model, account, provider, advisory-mode, live-board or network call. Container network mode `none`, digest-pinned
  image `sha256:72a7d979b414619df086635b69acab42da61718bacf6bd98874d8c90b30a7e1a`, Bun 1.4.2, one sequential child.
- Registered per-case and per-trial budgets only, with the same bounded harness admission as T2a: 2 CPU, 256 MiB, 32
  PIDs, network `none`, no retries beyond the single registered attempt per scheduled unit, no budget increase.
- Runs went through `_meta/scripts/remote_dev.py` with host-slot and load admission. Host preflight read about 15 of 224
  logical CPUs and no owned measurement container was active; exit 75 was treated as a deferral, never as permission
  for a local fallback.
- The Supervision snapshots were generated once, in one admitted job, outside `src`, the scripts runtime and CI, with a
  read-only producer mount, no board read and no write to any task.

## Harness differences from T2a

T2a (`3f8f373bc8c13176eae3e4b564c54542a7b3e363`) observed 2 CPU, 256 MiB and 32 PIDs in one Bun 1.4.2 container with no
controller storage cap. Three differences apply here and are harness-observed, not independently attested:

- **A 16 MiB `/tmp` tmpfs cap on both arms.** The private code tree, the per-slot workspace, the child `TMPDIR` and the
  collected output all live under it, so a transient write cannot bypass the registered trial storage bound. The cap is
  a controller fact; the actual transient peak inside it remains `unknown`.
- **Synthetic native Diagnose scaffolding.** The treatment arm bootstraps a real bounded ares study from the
  candidate-visible facts only before it reads lineage, with the identical setup step run for both arms and every row
  binding the helper SHA-256 `03bd141f6fbbfc5e8663efead747d16a877b5acb2d6bab83fda487f467748082` and the fixture
  factory SHA-256 `40d1d138408af8b51a770f6dd44c1493a2468dda5e3a4be15b4db9a11c0b38dc`. The scaffolding is
  `authority: harness-observed`, `source: visible-facts-only`, `independentPhysicalAttestation: false`; it is not
  independent physical attestation and it grants no ares-observed experiment authority.
- **Paired scheduling inside one admitted trial.** Both arms share one admitted container, one image and one code
  materialization, and the schedule is the registered paired one rather than a separately admitted baseline run. T2a
  receipts are immutable context and were never substituted for a T3 control.

## Schedule and counterbalancing

Each trial ran 12 frozen cases with three seeded paired repetitions per condition, cold and warm, in both arms:

| trial | arms | units | observations | order |
| --- | --- | --- | --- | --- |
| Diagnose | `current-workflow` (fresh rerun of the workflow) vs `H1-A1-C1-lineage-view` | 12 cases x seeds 3/11/19 x cold/warm x 2 arms | 144 (72 per arm) | AB/BA by parity; each arm executed first in 36 of its 72 slots |
| Reuse (r2) | `fresh` vs `eligible-reuse` | 12 cases x seeds 3/11/19 or 4/12/20 by case parity x cold/warm x 2 arms | 144 (72 per arm) | AB/BA by parity; each arm executed first in 36 of its 72 slots |
| Supervision v2 | shadow arm executed; adapter and advisory arms not executed | 12 cases x 6 arm permutations x cold/warm | 144 | all six orderings, 24 slots each |

`cold` resets the private fixture input and output state and `warm` retains only the payload bytes; both start a new
process, so neither condition is a host-cache or JIT-coldness claim. Reused candidate stages are never counted as
independent samples, and every slot starts a fresh evaluator.

## Arm denominators

Denominators are the registered units, not the successful subset. Nothing was retried, excluded or replaced.

| trial | arm | full | succeeded | failed | cancelled | unknown | excluded |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Diagnose | `current-workflow` | 72 | 72 | 0 | 0 | 0 | 0 |
| Diagnose | `H1-A1-C1-lineage-view` | 72 | 72 | 0 | 0 | 0 | 0 |
| Reuse | `fresh` | 72 | 72 | 0 | 0 | 0 | 0 |
| Reuse | `eligible-reuse` | 72 | 72 | 0 | 0 | 0 | 0 |
| Supervision v2 | shadow | 144 | 144 | 0 | 0 | 0 | 0 |
| Supervision v2 | adapter (A) | 144 planned | 0 | 0 | 0 | 0 | 144 not executed |
| Supervision v2 | advisory (C) | 144 planned | 0 | 0 | 0 | 0 | 144 not executed |

`cancelled` and `excluded` are 0 in every executed arm: no slot carries either state and no unit was dropped after the
fact. The not-executed Supervision arms are reported as planned-but-not-executed rather than as failures or as zeros.

## Diagnose: lineage treatment against a fresh rerun

The baseline arm resolves the diagnostic from the frozen candidate payload alone. The treatment arm bootstraps a bounded
native study from the same visible facts and answers from the actual lineage and comparison readers, including the
retry-relationship and artifact-reference checks. Both arms are scored by the same two automated checks against the
sealed projection: the full provenance object (attempt id, head, selected head, status, completeness) and the
next-action token. `mustNot` labels have no separate automated check in this harness, so they are not counted as scored.

Agreement between the two arms is not independent diagnostic accuracy, and this adapter cannot establish any.
`diagnoseTreatment` returns the current-workflow baseline diagnostic itself on `matched` and on `skipped`, and an
`unknown` completeness otherwise, while the visible-facts scaffolding writes the native records the matcher then reads.
The treatment can therefore only reproduce the control answer or fall back to unknown, so parity is by construction
once the plumbing works. What these 144 slots do establish is integration, cost and plumbing: the native read resolves
the recorded producer for all eight incidents that expose one, the four privacy-gap and corrupt-source incidents skip
without querying for a hidden identity, and every slot in both arms reproduces the sealed projection.

| measure | `current-workflow` | `H1-A1-C1-lineage-view` |
| --- | --- | --- |
| observations / incidents | 72 / 12 | 72 / 12 |
| provenance matches the sealed projection | 72 | 72 |
| next-action matches the sealed projection | 72 | 72 |
| joint matches (observation, both components) | 72 | 72 |
| incidents with every observation in agreement | 12 of 12 | 12 of 12 |
| cold / warm joint matches | 36 / 36 | 36 / 36 |
| human time-to-find | `unknown` | `unknown` |

All twelve incidents are reproduced by both arms:

| scenario | expected next action | both arms |
| --- | --- | --- |
| stale-head (old card, changed selection) | `run-fresh-selected-head` | match |
| missing-artifact (lost file) | `restore-or-reexecute-artifact` | match |
| missing-artifact (pruned file) | `reexecute-from-frozen-inputs` | match |
| retry (terminal child) | `use-terminal-retry-result` | match |
| retry (active child) | `await-retry-result` | match |
| uncertain-delivery (lost ack, ended connection) | `reconcile-dispatch-before-retry` | match |
| privacy-gap (withheld source, partial summary) | `request-safe-provenance-summary` | match |
| corrupt-source (truncated JSON) | `restore-valid-source-record` | match |
| corrupt-source (unsupported version) | `use-compatible-source-reader` | match |

Scaffolding state is a deliberate part of the result. 96 of 144 slots materialized the native study and 48 skipped it
with reason `no-visible-producer`: the two privacy-gap and two corrupt-source incidents, where the payload exposes no
producer identity. Skipping is the treatment's designed behavior (preserve privacy and corrupt-source uncertainty, never
query for a hidden identity), not a failed observation, and both arms still agreed with the sealed projection there.

Phase medians per arm (milliseconds of monotonic wall and parent-process CPU; the two component phases are nested
subsets of the scheduled child total and are never added to it, and subprocess phase CPU is `unknown`):

| condition | arm | setup wall | setup parent CPU | current wall | current parent CPU | child process wall (median / p95) | slot CPU | cgroup CPU |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cold | `current-workflow` | 8.87 | 10.51 | 0.11 | 0.11 | 43.01 / 45.40 | 52.57 | 52.93 |
| cold | `H1-A1-C1-lineage-view` | 8.85 | 10.55 | 15.01 | 19.33 | 58.19 / 64.58 | 72.82 | 73.32 |
| warm | `current-workflow` | 8.99 | 10.63 | 0.11 | 0.11 | 42.99 / 45.73 | 52.85 | 53.24 |
| warm | `H1-A1-C1-lineage-view` | 8.92 | 10.63 | 15.16 | 19.43 | 58.46 / 63.97 | 72.41 | 73.02 |

The trial's scheduled slot CPU total is 8.371 s over 6789 ms of trial wall; the admitted-container cgroup counter reads
8.796 s and is a separate budget clock, never added to process CPU. The treatment is therefore about 35 percent slower
per child process and about 38 percent higher in slot CPU, entirely in the `current` phase, which is the native read it
adds. Reading: because the parity is by construction, the measurable result of this trial is cost, plumbing and
integration rather than accuracy; the lineage path pays more automated compute for the same answer, and the human
dimension the gate actually asks about was not measured.

## Reuse (r2): eligible reuse against fresh execution

The `fresh` arm executes all three candidate stages and a fresh evaluator. The `eligible-reuse` arm runs with reuse
eligible over the r2-rematerialized numeric sources and reports source-setup, current and total phases separately. Both
arms run on the same backend in the registered order; the T2a receipts were not reused as a control.

| invariant | value |
| --- | --- |
| paired units | 72 |
| reused candidate stages observed | 18 |
| false reused stages | 0 |
| pairs with identical result / payload digests / evaluator metric digests | 72 / 72 / 72 |
| fresh evaluators | 144 of 144 |
| immutable source records / rows with no source | 120 / 24 |
| source fault rows (`none` / `corrupt` / `pruned` / `interrupted`) | 72 / 24 / 24 / 24 |

Eligible-hit compute reduction (paired, parent plus direct-child process CPU, per case, three repetitions per
condition):

| condition | median reduction | 95 percent bootstrap interval | range | pairs |
| --- | --- | --- | --- | --- |
| cold | -9.62 percent | [-10.92, -8.58] | [-11.37, -7.93] | 6 |
| warm | -11.11 percent | [-17.16, -7.06] | [-22.39, -6.71] | 6 |

No-hit p95 overhead (nearest rank, per-case paired CPU):

| set | cold | warm | pairs each |
| --- | --- | --- | --- |
| registered no-hit scenarios | 31.36 percent | 30.74 percent | 6 |
| all-ineligible sensitivity (every case with empty expected eligibility) | 29.79 percent | 30.58 percent | 30 |

The negative sign is the point: reuse eligible is slower on every one of the twelve cases in both conditions.

| case | cold | warm |
| --- | --- | --- |
| local-stage-edit (first / second variant) | -10.47 / -9.24 percent | -11.92 / -7.42 percent |
| global-code-change (first / second variant) | -13.20 / -14.01 percent | -14.01 / -12.70 percent |
| no-hit (first / second variant) | -29.79 / -29.59 percent | -28.74 / -29.80 percent |
| corrupt-artifact (first / second variant) | -15.06 / -13.20 percent | -13.59 / -13.37 percent |
| pruned-artifact (first / second variant) | -13.45 / -13.20 percent | -13.56 / -14.11 percent |
| interrupted-source (first / second variant) | -15.15 / -13.12 percent | -13.29 / -12.15 percent |

Phase medians per arm (parent-process CPU seconds and monotonic wall milliseconds; `source setup`, `current` and `total`
are separate reported phases, `total` surrounds the lifecycle and includes cleanup, and no phase is added to another):

| condition | arm | source setup wall / CPU | current wall / CPU | total wall / CPU |
| --- | --- | --- | --- | --- |
| cold | `fresh` | 897.21 / 0.368522 | 721.49 / 0.312375 | 1621.48 / 0.680933 |
| cold | `eligible-reuse` | 894.46 / 0.369120 | 944.99 / 0.426585 | 1843.02 / 0.796920 |
| warm | `fresh` | 899.54 / 0.370036 | 723.47 / 0.311925 | 1631.60 / 0.684729 |
| warm | `eligible-reuse` | 896.81 / 0.369238 | 950.41 / 0.426742 | 1846.27 / 0.797276 |

Trial totals: 267.835 s of scheduled slot CPU and 234868 ms of trial wall, with a separate cgroup counter of 268.433 s,
3243493 transfer bytes and 2688210 retained bytes. Source-setup cost is unchanged between arms; the eligible arm pays
about 223 ms more in the current phase for a mechanism that removes executed stage work at this scale, and the
subprocess phase CPU that would complete the arithmetic stay `unknown`.

## Supervision v2: shadow measurements

The 144 shadow snapshots were generated once by agent-hub's `ShadowSupervisor` at
`a470ebbd5d809e421c6fc82fab8a69434c1b2e08` (module SHA-256 `8701ef9bb3b5ddec4f7562c52c351e19a23ce159c37006c4919c8adf29f9df15`)
from each case's frozen facts, with a read-only producer mount, no board, no model, no account and no network. The
generator (SHA-256 `5192b3d285044aefe598f8d3aa8b83f2af373325ca5b515ab4b7ab4f3419e9f2`) is archived as data beside the
dataset and is never imported or executed by the runtime or CI. Generation took 28228 ms of wall, 0.233 s of
parent-process CPU and 31.626 s of separate cgroup CPU, with 144 confirmed `observe` child receipts and no unknown call.
The slots were then scored read-only with the sealed v2 method; the scoring ran in an admitted job and produced the
committed per-slot scores.

| outcome | cold | warm | total |
| --- | --- | --- | --- |
| helpful | 18 | 18 | 36 |
| missed | 6 | 6 | 12 |
| insufficient | 48 | 48 | 96 |
| correct non-trigger | `null` | `null` | `null` |
| wrong-action proposals | 0 | 0 | 0 |
| false proposals / false cases | 0 / 0 | 0 / 0 | 0 / 0 |
| person decisions, worker turns, action writes, notifications | 0 | 0 | 0 |

Per case (12 slots each, six permutations by two conditions):

| case | outcome |
| --- | --- |
| true-trigger repeated failure, same check / current plan; overlap without integration | 12 helpful each |
| true-trigger changed deliverable after pass | 12 missed |
| four ordinary-progress cases; four misleading-symptom cases | 12 insufficient each |

Arm status, reported exactly as measured:

| arm | planned | executed | reason |
| --- | --- | --- | --- |
| A, adapter / current hub outputs | 144 | 0 | no adapter and no current hub outputs to score |
| B, shadow | 144 | 144 | this dataset |
| C, advisory | 144 | 0 | unauthorized; no advisory-mode run was permitted |

No outcome, zero or denominator is invented for arms A and C.

The 12 misses are the changed-deliverable case, and they are an input-shape limitation of the sealed corpus rather than
a producer finding: the frozen facts for that case carry no delivered-record ids, while the producer requires recorded
ids before it will emit that observation, so the case cannot reach a helpful outcome from the data it supplies. They
stay in the dataset as negatives, unrelabeled, with the corpus, labels and seals untouched and no re-run. The correct
non-trigger count stays `null`, not 0, because the current snapshot has no source-owned evaluated-revision set for the
`none` label's three rules. Complete trial and recovery cost is `unknown`; only per-slot child process cost was
observed.

## E1 threshold comparison

Thresholds are the preregistered ones in `docs/verification/execution-eval-preregistration.json`, unchanged and
inherited rather than re-chosen.

| trial | gate | threshold | measured | verdict |
| --- | --- | --- | --- | --- |
| Diagnose | accuracy loss | at most 0 percentage points | 0.0 pp observed on 72 observations and 12 of 12 incidents in both arms, but parity is by construction in this adapter | not independently measured (parity by construction) |
| Diagnose | median human time-to-find reduction | at least 20 percent | `unknown`; no timing was taken | insufficient, never pass |
| Reuse | median eligible compute reduction | at least 20 percent | -9.62 percent cold, -11.11 percent warm | unmet |
| Reuse | no-hit p95 overhead | at most 5 percent | 31.36 percent cold, 30.74 percent warm | unmet |
| Reuse | false reuse | at most 0 | 0 of 18 reused stages, 72 of 72 equal results and digests | met |
| Supervision | improved accepted-outcome rate or recovery reduction | required | not measured; no accepted-outcome or recovery observation, arms A and C not executed | insufficient |
| Supervision | median recovery time reduction | at least 20 percent | `unknown` | insufficient |
| Supervision | total cost increase / person decision increase | at most 0 | total `unknown`; person decisions 0 with no benefit signal | insufficient, retain shadow |

The other fault-suite gates (`maxProvenanceViolations`, `maxPrivacyViolations`, `maxGateViolations`) belong to the
product harness fault suite and were not re-measured by these trials; only false reuse is directly observed here.

## Dispositions

- **Diagnose: insufficient evidence.** Accuracy parity holds by construction in this adapter, so the correctness half of
  the lineage gate was not independently measured and is not claimed as met; the gate's decision quantity (median human
  time-to-find reduction of at least 20 percent) was not measured either, and the preregistration makes unmeasurable
  human timing insufficient rather than passing. The descriptive cost direction is negative: the treatment is slower in
  automated compute.
- **Reuse: restrict, do not adopt.** Zero false reuse and byte-equal outputs hold, but both performance gates fail
  decisively on paired evidence: eligible reuse is slower on all twelve cases and the no-hit overhead is about six times
  its ceiling. Adopt is excluded by measurement, not by missing data, so defer would misdescribe a negative result.
  Eligible reuse stays an explicit operator decision, off by default, with no performance or cost claim attached.
- **Supervision v2: at most retain shadow, insufficient for adoption.** Shadow outcomes are recorded, but there is no
  accepted-outcome, recovery or person-decision benefit measurement, arms A and C are not executed, and repeated shadow
  slots over a transparent synthetic corpus are not independent benefit evidence. The shadow mode is retained; nothing
  is adopted.

These dispositions record the evidence against the preregistered gates. They create no product authority: no winner,
no gate approval, no adoption of a treatment and no ares-sealed result authority.

See [T4 status and live-evidence gaps](execution-eval-t4-status.md) for the resulting defaults and remaining evidence needs.

## Negative and unknown results

- Every reuse case is slower under eligible reuse, in both conditions, including the cases the mechanism is meant to
  help. This is a negative result and is not softened by the zero false-reuse invariant.
- 12 Supervision misses are retained unrelabeled; they are not converted to helpful or dropped to insufficient.
- `correctNonTriggers` is `null`, not 0, in every Supervision summary level.
- Human time-to-find is `unknown` in all 144 Diagnose slots; person minutes, idle wall and monetary estimate are
  `unknown`.
- Subprocess CPU is `unknown` in every phase clock; the cgroup CPU counters are separate budget clocks and are never
  added to process CPU.
- GPU device seconds, provider tokens and provider requests are `unknown`; no GPU, provider or account was used.
- Storage peak, storage byte-seconds and retention byte-seconds are `unknown`; the actual transient peak inside the
  16 MiB `/tmp` cap was not observed.
- 48 Diagnose slots skipped native scaffolding by design (`no-visible-producer`) and 24 reuse rows had no source
  population; both are reported as observed rather than as passes.
- Supervision arms A (adapter) and C (advisory) executed nothing; their outcomes, costs and denominators are not
  inferred.
- Complete Supervision trial and recovery cost, and any person benefit, remain `unknown`.

## Receipts and custody

All receipts are committed under `docs/verification/execution-eval-t3/`; nothing was rewritten after collection.

| artifact | path | binding |
| --- | --- | --- |
| Reuse trial | `reuse-29db7d4259bc-20261110T083856Z/` | manifest SHA-256 `820b5f863e28d6c4f8c7b6a07adee395b6f6e0449fab908d2b887adeceab48b0`, code `29db7d4`, method `84e4aabb8178299ceb84c45711c150228a328d9c6acfc2a83735514f1e8fcd62`, input `c0c7c97d0bd6d5bc588141836cb9af1b9854f40c2a974c15cdda85716274677d`, expected `30ceddce8081026f52aff1678fb0c26cdb7f627cae077ee75a87f3ed62cebf95`, schedule `9fd3fee5526a8830a4caf778cfba8d0414fbecae017be624819a865d35d0154e` |
| Reuse analysis | `reuse-analysis.json`, `analyze-reuse.py` | output SHA-256 `a0cf38756bb236407a606eac1c18a23773d1ee6323f5331ed74550ac056496c9`, script SHA-256 `945b9bee08758615b99c08a602e70c9ab51a845d0c3b9f7f14b334369e77d96e` |
| Diagnose trial | `diagnose-a10eb2477a95-20261110T091046Z/` | manifest SHA-256 `20b0818f84407c55faad226b24a653f81bbb5f975041142c5004ed48539b12af`, code `a10eb24`, method `84e4aabb`, input `c0c7c97d`, expected `30ceddce`, schedule `d7fd54bf6b0c0b550ec3bd2c329329e669970f9b5c1b62803ff3d5827d272b38` |
| Diagnose analysis | `diagnose-analysis.json`, `analyze-diagnose.py` | output SHA-256 `e554933f8f8062994c939cfcd6d091e1021dd5fe2e969253b6aab1726de9ba0d`, script SHA-256 `ed73268e2f3e4391326a16634dfd8197c303b4e737b78e69ab88ffbeb7839a6e` |
| Supervision records | `supervision-29db7d4259bc-20261110T084549Z/` | manifest SHA-256 `673d41a11d4f63c6e4de46789c255eafdd50f2ce7a69c2935dbc3d84ad020ccf`, code `29db7d4`, input `f72dd4ec4f2591a9fd7c291ca04758e22c9b2f062dfccdf629b08ccd3f812513`, method `21ad9b9c28aed72024cc11e64c64d26d36bf865d011020bd9f34daec7acd1509`, environment `717c7cdbec1157fe35f8997ac7c768d7359bffd2e02edbd5b71fb57064db715b` |
| Supervision scores | `supervision-scored/` | summary SHA-256 `955f278679f14bb0cda5c992a67ce8ff13ac2fd1778e2c5cc787134d3fa1c79c`, capture manifest bound by the summary `673d41a11d4f63c6e4de46789c255eafdd50f2ce7a69c2935dbc3d84ad020ccf`, producer `a470ebbd`, generator `5192b3d2` |

Every slot file is create-once and hash-listed in its manifest; both analysis scripts re-read each slot bounded and
refuse a slot whose bytes disagree with the manifest before computing anything, and both refuse a denominator other
than the full 144. Each manifest is at most 64 KiB and each slot at most 64 KiB, inside the 16 MiB per-trial retention
bound. The private transport logs, the remote work directories and the admission wrapper stay outside the repository;
no host path or account appears in this report.

## Limitations

- Harness-observed synthetic paired observations only: no winner, no adoption, no ares-sealed result authority and no
  native Docker isolation proof.
- Diagnose scaffolding and the fixture corpora are visible-facts synthetic constructs; they measure the adapters'
  agreement with sealed labels, not human diagnostic performance.
- Cold and warm are private fixture state only, not OS or JIT coldness; reused stages are not independent samples.
- The Reuse evaluator is always fresh, and its arithmetic is a three-stage synthetic workload, so the compute result is
  about this workload at this scale, not a general reuse speedup claim.
- Supervision measures shadow record consumption and intent-join conformance, not person benefit, and the absent-action
  rule cannot be scored from the current snapshot.
- Retention, transfer and storage accounting excludes an actual peak measurement; the `/tmp` cap bounds but does not
  measure it.
- A seal or code change detected mid-run surfaces as the `collection-interrupted` cause rather than as its own cause,
  so that label alone does not say what changed.
- The Supervision generator and producer hashes are read from the external manifest; they were checked by hand to match
  the committed `supervision-generator.ts` (`5192b3d285044aefe598f8d3aa8b83f2af373325ca5b515ab4b7ab4f3419e9f2`) but
  the receipt does not derive them itself.
- The Supervision budgets are hardcoded constants that match the preregistration today; they are not read from it, so a
  future preregistration edit would not move them.
- A producer failure would fold into the `insufficient` outcome instead of being reported as its own case state. None
  occurred in these 144 slots.
- The reader does not re-check recorded per-slot costs against the case budgets, and the budget-stop loop branches have
  no unit test, so an over-budget slot would be visible only through the recorded cost fields.
- Network mode `none` is enforced by admission but not recorded inside the receipts, so it is an admission claim here
  rather than a per-slot observation.

## Reproduce

Read-only re-verification of the base and derived artifacts (any admitted resource policy applies; in this repository
the checks run one job per worktree with two CPU workers):

```sh
bun scripts/execution-eval.ts verify
bun scripts/execution-eval.ts verify-supervision-v2
bun scripts/execution-eval.ts verify-reuse-rematerialization-r2

python3 docs/verification/execution-eval-t3/analyze-reuse.py . \
  docs/verification/execution-eval-t3/reuse-29db7d4259bc-20261110T083856Z
python3 docs/verification/execution-eval-t3/analyze-diagnose.py . \
  docs/verification/execution-eval-t3/diagnose-a10eb2477a95-20261110T091046Z
```

Both scripts print their own `analysisSha256` and the capture manifest hash they bound, so the committed JSON can be
reproduced byte for byte without launching a trial. The Supervision scores are a committed read of
`supervision-scored/`; regenerating them would require re-running the admitted generation and scoring job, which this
report does not authorize and did not do.
