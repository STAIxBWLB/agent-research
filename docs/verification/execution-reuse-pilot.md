# Measured execution-reuse pilot (#64 T4)

This pilot ran the product's optional stage artifact reuse against a small deterministic three-stage protocol on a
private CPU-only SSH executor and compared it with fresh execution on the same code tree. It measures wall time,
executed stage time and retained storage as ares reports them, and it decides the #63 E1 gates: adopt, restrict or
defer. Nothing here is evidence about containers beyond what ares recorded, and no research claim follows from the
numbers.

## Recorded base

| item | value |
| --- | --- |
| main commit the pilot ran from | `3795ad0bd5ed71f117ffb86a822def2ded64f035` (includes the reuse-admission fix from #145) |
| pilot fixture commit (code tree `85cea594`) | `935d78f187cb001e610e0f91598321dc4e43082b` |
| global code-change trees | `9d06ff50aa5682352d84e1e31307fef1be8f2973` (tree `d0201073`), `b23ed65d3d8ff5a6dda1b77f938b66b9df2ac3b8` (tree `103eafa1`), `4d22ba620c35982dd15549cffd5b0237996f28b7` (tree `e8c03d4b`) |
| study mode | experiment, gates autonomy, one investigation selection |

`main` did not move during the runs. The three code-change trees exist only on a local branch created for the pilot and
are not part of this change.

## Constraints honored

- One SSH executor (`kind: ssh`), CPU only. No GPU device was configured, `limits.gpus` is 0, and no attempt used
  `--gpus`.
- The executor workdir is a private directory on the executor host, owned by the executor user, mode `0700`; the
  container user was the non-root `1001:1001` reported by `ares executor check`.
- Network mode `none` for every container, digest-pinned image, `--read-only` root with a tmpfs `/tmp`, capabilities
  dropped. No model, account or download was involved.
- Wall ceiling: the measured study used 22 attempts totalling 1236 s of ares-reported attempt wall (about 21 min); the
  discarded setup studies used about 10 min more. All of it is inside the 2-hour ceiling.
- Host pressure was read before starting (`load average 17.1 / 18.1` against 224 logical CPUs, about 8 percent) and no
  other ares run was active on the host.

## Workload

`test/fixtures/execution-reuse-pilot/` holds the workload. Three candidate stages in serial order plus a separate fresh
evaluator, all in `node@sha256:ff054b356ab93ed540518ca23cfcd9840e5256dd04db5a8d8afc43f4ecc7c9f8`:

| stage | inputs | outputs | work |
| --- | --- | --- | --- |
| `normalize` | task input `workload` (`workload.json`, 48 integers with one duplicate) | `values` (`values.json`) | dedupe, sort, `value * 7 + 13` |
| `bucket` | upstream `normalize.values` | `buckets` (`buckets.json`) | group by `Math.floor(value / width)`, width from argv (default 50) |
| `summarize` | upstream `bucket.buckets` | `summary` (`summary.json`) | integer checksum `sum(bucket * count)` |
| evaluator (fresh, never reused) | all three sealed stage trees under `/candidate/<stage>` | `/result/metrics.json` | recompute the checksum from `normalize` values, check the artifacts agree, publish `checksum` and `coverage` |

Each stage declares the reviewed pure-artifact contract (`v 1`, `kind pure-artifact`, `inputs declared-only`,
`externalState none`, `writableState fresh-output-only`, `modelOutputs forbidden`, `determinism byte-exact`) with
`toolchain.documentationSha256 = a1ae6cec4a8ca3c31826b1795167c5c07a90a7f26c06453d64db468273d05a98`, the digest of
`test/fixtures/execution-reuse-pilot/toolchain.md`. The study's task tree carries byte-identical copies of
`workload.json` (`b017c0ac29d77c7973958fac40b4ce8c0356b2f021746c830b1ce304a6168b3b`) and `evaluator.mjs`
(`b6d9b590a7d20cf0f451479f5b64435edeeac3a578c6b8de96eab97be1366560`).

`protocol.json` is the exact file applied to the study with `ares protocol`. `protocol-stage-edit.json` is identical
except that the `bucket` argv carries an explicit `80`.

## Study setup

    ares init <study> --mode experiment --question "Does eligible stage artifact reuse reduce total compute ..."
    # task/task.md, task/workload.json, task/evaluator/evaluator.mjs
    ares protocol <study> --file test/fixtures/execution-reuse-pilot/protocol.json
    ares selection <study> --file selection.json     # {v:1, run:"reuse", metric:"checksum", baseline 935d78f1, minSeeds 1, minDelta 0}
    ares gate approve <study> design
    ares executor set <study> --kind ssh --workdir <private workdir>
    ares executor check <study>

`ares executor check` reported Docker server `29.1.3`, user `1001:1001`, and the pinned image already available, so no
pull happened. The stage-edit case re-applied `protocol-stage-edit.json` and re-approved `design`; approval is design
only and does not change the retained population.

## Cases, arms and order

`main` is the fresh arm (`--reuse off`), `reuse` is the eligible arm (`--reuse eligible`), seed 7 everywhere, same
image, same limits and same budget. Repeats of one frozen request are explicit `--retry <id>` links, because ares treats
an identical request as the same attempt; they are repeated measurements of one configuration, not independent samples.

| case | trees | protocol | expected |
| --- | --- | --- | --- |
| A unchanged rerun | `85cea594` | `protocol.json` | eligible hits all three stages |
| B local stage edit | `85cea594` | `protocol-stage-edit.json` | `normalize` hits, `bucket` and `summarize` re-execute |
| C global code change | three distinct trees | `protocol.json` | every stage misses |
| D no-hit control | `85cea594` and the three C trees | both | eligible mode with nothing to reuse |

Only B1 measures the edit. It is the first eligible run after the protocol change and the only attempt in the pilot
where one stage reuses while the next two run fresh. B1 then seals fresh sources for the edited `bucket` and
`summarize`, so B2 and B3 reuse all three stages: they are unchanged reruns of the edited protocol, which makes them a
second case-A measurement rather than a second stage-edit measurement, and they are reported that way below.

Arm order was counterbalanced: A rep 1 fresh then eligible, rep 2 eligible then fresh, rep 3 fresh then eligible; C tree
1 fresh then eligible, tree 2 eligible then fresh, tree 3 fresh then eligible; B rep 1 eligible, rep 2 eligible then
fresh, rep 3 fresh then eligible. The cold eligible run that populates the store (D1) ran before A rep 1 so the three A
eligible reps are all hits.

## Per-attempt rows

Nineteen measured attempts. `executed stage ms` sums the wall of candidate stages this attempt actually ran (0 when all
three were reused). `verify` and `materialize` are the ares-reported reuse overheads; they are recorded only on
reuse-aware attempts, so the fresh arm shows `-` and its materialization is unmeasured, which is why the attempt wall
below is the fair comparison.

| case | rep | arm | attempt | tree | wall ms | executed stage ms | stage outcome | verify ms | materialize ms | metrics | sidecar B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| unchanged rerun | A1 | fresh | `fdae8e8d804a0060` | 85cea594 | 57465 | 387 | normalize=fresh bucket=fresh summarize=fresh | - | - | checksum=231,coverage=47 | 2854 |
| unchanged rerun | A2 | fresh | `e9cc409ba2051ebd` | 85cea594 | 58018 | 416 | normalize=fresh bucket=fresh summarize=fresh | - | - | checksum=231,coverage=47 | 2855 |
| unchanged rerun | A3 | fresh | `7b69d473cfc39a73` | 85cea594 | 57930 | 406 | normalize=fresh bucket=fresh summarize=fresh | - | - | checksum=231,coverage=47 | 2852 |
| unchanged rerun | A1 | eligible | `c5aa747248a2352a` | 85cea594 | 46548 | 0 | normalize=reused bucket=reused summarize=reused | 5394 | 7516 | checksum=231,coverage=47 | 3089 |
| unchanged rerun | A2 | eligible | `265f6538c3ffb454` | 85cea594 | 46665 | 0 | normalize=reused bucket=reused summarize=reused | 5386 | 7033 | checksum=231,coverage=47 | 3089 |
| unchanged rerun | A3 | eligible | `9c0f68011975910c` | 85cea594 | 47060 | 0 | normalize=reused bucket=reused summarize=reused | 5687 | 7624 | checksum=231,coverage=47 | 3089 |
| local stage edit | B1 | fresh | `e45919c9062ae544` | 85cea594 | 57424 | 394 | normalize=fresh bucket=fresh summarize=fresh | - | - | checksum=137,coverage=47 | 2853 |
| rerun after the edit | B2 | fresh | `6a375d1a514442fd` | 85cea594 | 58321 | 400 | normalize=fresh bucket=fresh summarize=fresh | - | - | checksum=137,coverage=47 | 2855 |
| rerun after the edit | B3 | fresh | `5ae54292ed099c7b` | 85cea594 | 56749 | 385 | normalize=fresh bucket=fresh summarize=fresh | - | - | checksum=137,coverage=47 | 2854 |
| local stage edit | B1 | eligible | `2d660d3aa4ff01d2` | 85cea594 | 59533 | 253 | normalize=reused bucket=fresh summarize=fresh | 5730 | 7731 | checksum=137,coverage=47 | 3088 |
| rerun after the edit | B2 | eligible | `71933ad0139da073` | 85cea594 | 46847 | 0 | normalize=reused bucket=reused summarize=reused | 5149 | 7647 | checksum=137,coverage=47 | 3088 |
| rerun after the edit | B3 | eligible | `6d5c633d3b834c96` | 85cea594 | 46045 | 0 | normalize=reused bucket=reused summarize=reused | 5346 | 7340 | checksum=137,coverage=47 | 3088 |
| global code change | C1 | fresh | `17b4c14ab26cf30d` | d0201073 | 57847 | 528 | normalize=fresh bucket=fresh summarize=fresh | - | - | checksum=236,coverage=47 | 2854 |
| global code change | C1 | eligible | `d3e28f3bbe73c247` | d0201073 | 62797 | 372 | normalize=fresh bucket=fresh summarize=fresh | 5501 | 7910 | checksum=236,coverage=47 | 3089 |
| global code change | C2 | fresh | `392d1d41fba84be8` | 103eafa1 | 57979 | 398 | normalize=fresh bucket=fresh summarize=fresh | - | - | checksum=237,coverage=47 | 2855 |
| global code change | C2 | eligible | `d151885f4f695e2e` | 103eafa1 | 64493 | 400 | normalize=fresh bucket=fresh summarize=fresh | 5605 | 8008 | checksum=237,coverage=47 | 3089 |
| global code change | C3 | fresh | `c5ad2e3b491cdb24` | e8c03d4b | 61065 | 395 | normalize=fresh bucket=fresh summarize=fresh | - | - | checksum=241,coverage=47 | 2855 |
| global code change | C3 | eligible | `a80033bf2d47e4e8` | e8c03d4b | 70411 | 392 | normalize=fresh bucket=fresh summarize=fresh | 5697 | 8884 | checksum=241,coverage=47 | 3089 |
| no-hit control (store empty) | D1 | eligible | `c873be129a3aa4f3` | 85cea594 | 61928 | 388 | normalize=fresh bucket=fresh summarize=fresh | 5233 | 7899 | checksum=231,coverage=47 | 3089 |

Denominators: case A 3 fresh and 3 eligible attempts, case B 3 fresh and 3 eligible attempts of which one eligible run
(B1) measures the edit and two (B2, B3) are reruns, case C 3 fresh and 3 eligible across three distinct trees, case D 4
eligible no-hit attempts (D1 plus the three C eligible runs) against 4 fresh attempts on the same trees. Three further
attempts are excluded and listed under "Discarded attempts".

## Thresholds

### Zero false reuse: passes

Every eligible hit was a `verified-hit` on a source attempt that ran under the same code tree, the same stage
definition, the same declared input hashes and the same seed. Case C produced no hit at all on any of three distinct
trees. Case B reused only the stage whose definition and inputs did not change. In all three cases the evaluator's
metrics are identical between arms (`231 / 47`, `137 / 47`, `236 / 47`, `237 / 47`, `241 / 47`), so reuse did not change
any published number, and the byte-exact comparison is over the sealed `/result/metrics.json` of each attempt. Observed
false reuse: 0 of 16 eligible-hit stage admissions (9 in case A, 1 in B1, 3 each in B2 and B3).

### Median total compute reduction on eligible-hit cases: not met as written

| case | fresh wall median | eligible wall | reduction | executed stage ms (fresh to eligible) |
| --- | --- | --- | --- | --- |
| A unchanged rerun | 57930 | 46665 (median of three) | 19.45 percent | 406 to 0 |
| B1 stage edit, first eligible run after the edit | 57424 | 59533 (single run) | 3.67 percent slower | 394 to 253, only `normalize` reused |
| B2 and B3 unchanged reruns of the edited protocol | 57424 | 46446 (median of two) | 19.12 percent | 394 to 0 |

Measured against the attempt wall ares reports, the reduction is 19.45 percent on the unchanged-rerun case, below the
20 percent threshold. Case B is not a second measurement of that saving. Only B1 measures the stage edit: it reused one
of three stages and came out 3.67 percent slower than the fresh median at the same stage size, so a partial hit at this
scale shows no wall saving at all. B2 and B3 reuse all three stages because B1 created the edited sources, which makes
them unchanged reruns of the edited protocol, and they land at 19.12 percent against the same fresh median.

Measured as candidate stage execution time the reduction is 100 percent on a full hit and 35.8 percent on B1 (394 to
253 ms). CPU is not available: the reuse receipts record `cpuSeconds: "unknown"` and the attempt record carries no CPU
telemetry, so "total compute" cannot be read as CPU from this pilot. The readings disagree, so the threshold is not met
on the stricter denominator and the CPU reading stays unknown.

### p95 overhead on no-hit cases: not met

Each no-hit eligible attempt is compared with a fresh attempt on the same tree and protocol:

| pair | fresh wall ms | eligible wall ms | overhead |
| --- | --- | --- | --- |
| C1 tree d0201073 | 57847 | 62797 | 8.56 percent |
| C2 tree 103eafa1 | 57979 | 64493 | 11.24 percent |
| C3 tree e8c03d4b | 61065 | 70411 | 15.30 percent |
| D1 tree 85cea594 | 57930 (A fresh median) | 61928 | 6.90 percent |

p95 by nearest rank over four samples is 15.30 percent, against a ceiling of 5 percent. The cost is the verification
pass ares performs on every eligible attempt before it can admit a hit: 5233 to 5697 ms across all eligible attempts,
which is charged whether or not a source exists.

## Where the time goes

The reused work itself is small and the real saving is elsewhere. In case A a sealed stage ran for 125 to 132 ms (ares
reports that source wall in each receipt), so all three stages together are 387 to 528 ms across the fresh attempts,
while verifying the same three sources costs 5149 to 5730 ms on every eligible attempt. A hit attempt is nevertheless
10.6 to 11.4 s faster end to end than a fresh one. Since 387 to 528 ms of execution cannot explain 11 s, the saving has
to come from not launching and inspecting three candidate containers at all: 11.3 s + 5.4 s of verification leaves about
16.7 s of launch, inspect and stop work for three containers, roughly 5.5 s each including its stage run.

That is an inference from the difference between attempt wall and stage wall, not from per-container telemetry, which
ares does not record. What ares does record is the direction and the size of the difference, and it repeats on every
rep.

The exception is the partial hit. B1 reused one of three stages and skipped one launch instead of three, so it paid the
same 5730 ms of verification to avoid 141 ms of stage execution and one launch: 59533 ms against a fresh median of
57424 ms, 3.67 percent slower. The break-even point follows from these numbers: a hit has to skip launches, or replace
execution, worth more than the verification pass it pays for.

## Decision: restrict

Adopt is excluded: two of the three gates are unmet, and E1 forbids adopting on insufficient evidence. Defer would
ignore a mechanism that repeated cleanly across six hit attempts (one of them partial) and four misses, so the pilot
records a restriction instead:

- Eligible reuse stays off by default. A study whose stages execute in well under a second pays 5.2 to 5.7 s of
  verification on every attempt and saves only 0.4 to 0.5 s of stage execution, and its no-hit overhead (6.90 to 15.30
  percent) is above the 5 percent ceiling.
- A partial hit at this stage size is a net loss, not a smaller gain: the one run that measured a stage edit (B1) reused
  one of three stages and was 3.67 percent slower than fresh, because the verification pass is charged once per attempt
  while only one stage's execution is avoided. Reuse is therefore not for cases where a single edited stage is expected
  to miss while its upstream still hits.
- Reuse may be enabled for a run whose sources are already retained and whose declared stages execute on the order of
  the verification cost or more, where a hit saves execution rather than only container launches.
- No default, no selector and no documentation change follows from this pilot. A follow-up pilot with stage-sized work,
  five or more reps per arm and an agreed compute denominator (CPU if the producer starts recording it) is required
  before any adoption decision.

## Unknowns

- CPU time is unknown for every attempt, so the compute threshold is judged on wall time and on executed stage time.
- Per-container launch and inspect cost is not recorded; the 4 to 5 s figure above is inferred.
- Materialization time is recorded only on reuse-aware attempts, so the fresh arm's materialization is unmeasured and
  the arms are compared on attempt wall.
- The retained store is study-local: these numbers say nothing about hit rates once a store is large or shared.

## Discarded attempts

- Setup study, 5 attempts, all `failed` with `retention: frozen task snapshot integrity mismatch`: macOS `bsdtar`
  stores `com.apple.provenance` as AppleDouble `._` members, a Linux GNU tar extracts them as real files, and the
  frozen task-tree hash then disagrees. The measured study ran with a `tar` wrapper that adds `--no-mac-metadata`, which
  changes no transferred content byte.
- Second setup study, 4 attempts, all `succeeded` but with every stage `fresh|outside-investigation`: reuse needs a
  declared investigation selection whose `run` matches the attempt, and without one eligible mode silently executes
  everything fresh. The measured study declares `selection.run = "reuse"` before the first attempt.
- Measured study, 1 attempt `unknown` with `container isolation verification failed`: attempt ids do not include the
  study id and container names derive from the attempt id, so the first request of a new study can collide with a
  leftover container of an earlier study at the same identity. The container was removed and the chain continued with
  explicit retries.
- Measured study, 2 attempts excluded as mis-specified: the first `protocol-stage-edit.json` also changed `method`, and
  the reuse comparison domain includes `method`, so all three stages missed instead of only the edited one and its
  downstream. The variant used for case B differs from the base protocol in the `bucket` argv only.

None of these four are product fixes here. Each is recorded so the numbers above can be read with their provenance.

## Reproduce

    ares init <study> --mode experiment --question "..."
    ares protocol <study> --file test/fixtures/execution-reuse-pilot/protocol.json
    ares selection <study> --file <selection.json with run "reuse">
    ares gate approve <study> design
    ares executor set <study> --kind ssh --workdir <private workdir>
    ares executor check <study>
    ares attempt run <study> --repo <checkout> --commit 935d78f187cb001e610e0f91598321dc4e43082b --seed 7 --run reuse --reuse eligible
    ares attempt run <study> --repo <checkout> --commit 935d78f187cb001e610e0f91598321dc4e43082b --seed 7 --run main --reuse off
    ares attempt reconcile <study>
    ares attempt show <study> <id>

Repeat each arm with `--retry <previous id>`, switch to `protocol-stage-edit.json` for case B, and use the three
code-change commits for case C.
