# Current-workflow baseline observations

This is #63 T2a under the 2026-11-08 observation-only ruling. Only Diagnose and Reuse baseline arms execute on the frozen synthetic corpus. Every observation is **harness-observed**, never a product attempt or evaluator-isolation attestation. No ares study, attempt, selection/final/winner/adoption record is written. Existing selection/final remain the only result authorities; this adapter creates none. Supervision stays preregistered only, and treatment slots are empty.

These T2a observations check the adapter and estimate variability/cost. **They are not T3's control arm.** T3 must rerun fresh beside each separately authorized treatment through this same adapter in the paired AB/BA order. There is no treatment benefit, workflow-usability, cache-saving, adoption or broad research claim here.

## Repeatable command and resource admission

After a clean committed checkout, the entry point is:

```sh
bun scripts/execution-eval.ts verify
export EXECUTION_EVAL_IMAGE_DIGEST=sha256:ACTUAL_IMMUTABLE_IMAGE_ID
bun scripts/execution-eval.ts baseline /absolute/fresh-output-directory --emit
```

`ACTUAL_IMMUTABLE_IMAGE_ID` is the resource controller's real Docker image ID, not a fabricated value or mutable tag. The admission launcher pins that ID and supplies it to the one admitted remote_dev container. Baseline code itself never invokes Docker, SSH, network or account commands. The optional `--emit` prints a bounded machine JSON bundle prefixed `EXECUTION_BASELINE_BUNDLE`; omit it to keep only a short summary. Keep its transport log outside Git, and commit only the verified JSON files named by the manifest. Existing output directories are refused.

The exact resource-controller wrapper is in [Baseline admission replay](execution-eval-baseline-admission.md). Use the workspace's normal `remote_dev.py verify` admission, one run per worktree and one heavy job per repository. Do not bypass or retry an exit75. The baseline admission uses two CPUs, 256 MiB, 32 PIDs and no network. The adapter verifies those cgroup v2 limits, Linux container presence, the preregistered Bun 1.4.2 and the supplied image ID before effects. It launches one real Bun child at a time. No agent/model/account processes, privileged containers, Docker socket or extra concurrency are used. Standard full checks run as a separate ordinary admitted verify job.

The T1 method/corpus/threshold/denominator receipt `72f36f856c2559bf7a626689bca3825ae3cfe49f27c9d8abf544f24bd2778e20` is verified before baseline admission. The corpus, inputs and expected bytes are checked against that receipt before they are held in memory. Source admission binds the exact clean committed runtime/bootstrap/package/lock/harness/adapter dependency set; untracked, staged, linked or dirty source refuses. A private code snapshot, checked again by per-file hashes, supplies every child. The resulting run receipt records the actual source commit/tree/hash and environment; a later receipt/docs-only commit need not have the same Git commit but must have identical executed-code hashes.

## Schedule and candidate visibility

The original corpus order is retained. For each trial's 12 cases, three declared seeds/repetitions each run cold then warm. Reuse uses each frozen workload's seed triplet. Diagnose is deterministic; its pairing seed is only a repetition key, not statistical independence. When `(corpusIndex+repetition)%2` is even, baseline occupies A and B is null; when odd, A is null and baseline occupies B. Only that current/fresh slot runs. Each trial therefore has 72 scheduled baseline observations, including any failed/cancelled/unknown/excluded rows. Treatment slots are not observations and are never fabricated or counted as baseline exclusions. Supervision has zero executed observations.

Each child receives only the candidate-visible `input` payload. Corpus wrapper labels/index and expected records remain in the parent, and are never copied into the child snapshot. The same-user trust limit remains: this is controlled synthetic code, not hostile same-UID isolation. All children use the run's fresh private HOME/config/temp tree and no inherited API keys or agent identity/session configuration.

Cold means freshly materialized private fixture bytes; warm retains those input bytes. Both launch fresh subprocesses and recompute every stage, including evaluation. Neither reads a cached artifact, reuses a computed output or claims an OS-page-cache/JIT reset. The current deterministic workload supports only the frozen bounded integer operations. It is not a reuse implementation.

## Diagnose and measurement limits

The rule adapter resolves raw producer pointers, status/retention, acknowledgements, withheld visibility and malformed/versioned source facts only from `input`. Parent scoring compares the returned provenance/next action with `.expected`. Report this as **automated source-resolution accuracy**. A rule engine scoring its development fixtures is not evidence of human workflow usability. Human time-to-find is always `unknown` here, and proposed lineage usability thresholds remain unassessed.

Every case file retains cold/warm raw observation rows, status/cause, actual numeric outputs or diagnostic projections, pairing slots, measured costs, and artifact/log hashes with sizes. Large logs and child diagnostics are not committed. Failed/cancelled/unknown/excluded cases stay in the full denominator. An exhausted or unavailable budget leaves remaining scheduled baseline rows unknown, independently per trial; no implicit rerun or budget expansion occurs.

CPU uses same-unit parent process deltas and post-exit child rusage microseconds, converted to seconds. Wall is monotonic. Materialization/verification/failure counters are subsets of case totals, never added again. Admission records its parent CPU/wall and code-copy bytes separately; Git-admission subprocess CPU is not instrumented, so there is no claim of a complete end-to-end scalar cost. Per-case timing excludes admission. Provider/GPU usage, peak/long-term storage/transfer, retention byte-seconds, idle/person time and monetary estimates remain `unknown` where not measured, never substituted with zero. Logical input materialization bytes and retained receipt-file sizes are explicit partial byte counters, not inferred total network/storage cost. No incomparable clocks are summed and no treatment percentages are computed.

The proposed 60-second wall/CPU and 256-MiB per-case ceilings are checked; each independent trial retains the preregistered two-hour/7200-CPU-second stop and bounded file/retention limits. A failure in one trial does not authorize another arm or erase its denominator. Machine receipts are observations only, not pass/adopt decisions.

## Receipts and verification

The run manifest binds code, the T1 registration/method/input/expected hashes, OS/CPU/Bun and the pinned container image ID. Each per-case receipt binds its exact input and expected hashes plus the run code/method. File hashes in the manifest bind the raw observation summary files. All JSON reads/writes are bounded to 64 KiB per receipt, and emitted transport is bounded to 2 MiB. Raw subprocess logs are retained as hashes and byte sizes only. No private paths, internal host names, accounts or real tasks are included.

New local receipt files are created 0600; checked-in synthetic hash/observation copies are ordinary 0644 Git files. The old T1 prose's blanket 0600 wording applies only to new local files. Its sealed bytes stay unchanged; this clarification does not re-freeze the protocol.

Run `bun install --frozen-lockfile && bun run check` separately for the source gate. Offline tests cover fresh deterministic results, candidate-only diagnostic checks, paired slot order, complete status denominators, preregistration drift refusal before effects and exact clean-code admission. Hosted CI and these fixture checks remain separate from real baseline observations, human measurements, native/account evidence and any future treatment decision.


## Recorded T2a observation

The completed run executed source commit `3f8f373bc8c13176eae3e4b564c54542a7b3e363`, code hash `d86195d060b84f282db94621b7ddb90afddd2e512d2344e910e9eafd26bb9708`, in one Bun 1.4.2 container. Its image ID was `sha256:72a7d979b414619df086635b69acab42da61718bacf6bd98874d8c90b30a7e1a`; observed cgroup limits were 2 CPU, 256 MiB, 32 PIDs. The later receipt/docs commit changes no executed source bytes.

The machine manifest and 24 per-case raw summaries are under [baseline-3f8f373](execution-eval-baseline/baseline-3f8f373/manifest.json). Manifest SHA-256 is `dd0e8949b6c1cabd07b34e89e8e79bac178787ce213c4abbe34a430c0e506840`. Their total logical JSON footprint is 338262 bytes; this is not a peak filesystem or retention-cost measurement. The derived [summary](execution-eval-baseline/baseline-3f8f373/summary.json) retains status denominators and cold/warm distributions, and links the admission-failure metadata.

| Trial | Full | Succeeded | Failed | Cancelled | Unknown | Excluded |
| --- | --- | --- | --- | --- | --- | --- |
| Diagnose | 72 | 72 | 0 | 0 | 0 | 0 |
| Reuse fresh | 72 | 72 | 0 | 0 | 0 | 0 |

Automated source-resolution matched 72/72 fixture projections across 12 incidents and repeated conditions. This is a deterministic rule engine scored on its development corpus, not 72 independent user trials. Human time-to-find is unknown. All 72 fresh arithmetic outputs matched their fixed expected values; no cached output was consumed. Treatment observations: 0. Supervision observations: 0.

| Trial/condition | Observations | Median case CPU seconds | Median case wall ms | p95 case wall ms |
| --- | --- | --- | --- | --- |
| Diagnose cold | 36 | 0.015340 | 15.279 | 16.152 |
| Diagnose warm | 36 | 0.0149545 | 14.305 | 15.118 |
| Reuse fresh cold | 36 | 0.015536 | 15.746 | 17.216 |
| Reuse fresh warm | 36 | 0.0153875 | 14.954 | 15.555 |

These are raw descriptive baseline costs including subprocess startup. Per-condition summaries also give observed minimum/maximum and descriptive sample variance; repeated observations are not an independent population sample or evidence of treatment savings. No percentage improvement or threshold pass is computed. Verification/materialization/failure costs remain separately identified, and uninstrumented cost dimensions remain unknown. Missing human timing and complete end-to-end cost prevent the proposed adoption comparisons. T3 must run fresh control observations again in each authorized paired treatment run.
