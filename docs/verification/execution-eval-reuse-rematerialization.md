# Reuse source rematerialization amendment (#63 T3a)

This amendment makes the preregistered Reuse cases hit-capable without changing any frozen byte of the v1 method, the
supervision v2 amendment or the expected labels. It declares one deterministic setup that rebuilds each case's source
stage outputs from that case's own frozen `source.workload`, and it seals the setup so a later run can prove the setup was
not silently rewritten. No treatment trial, evaluator, model or hub call is added, and no outcome is claimed.

## Run

    bun scripts/execution-eval.ts freeze-reuse-rematerialization
    bun scripts/execution-eval.ts verify-reuse-rematerialization
    bun scripts/execution-eval.ts integration-check

The first command creates the receipt exclusively; a second call only verifies it. Both are repository-only modes, so the
installed `ares` command list is unchanged.

## Why the v1 sources could not be reused

Each frozen Reuse source carries `source.artifact.payload.stages[]` entries whose `content` is an opaque string
(`Synthetic cached bytes fixture-object-...`). The bytes are self-consistent and hash-verified, but they are not producer
checkpoints, so the #64 reuse path can only ever miss them. `integration-check` therefore reported
`integrated-fresh-fallback` with `sourceEstablishment: opaque-frozen-sources-not-numeric-manifests`, and every paired
trial would have measured a miss against a miss.

Every one of those cases also declares an explicit `source.workload` with bounded integers, three declared stages and
declared seeds, which is exactly the arithmetic the synthetic producer already runs. The setup rebuilds the source from
that declaration.

## What the setup does

- One case at a time, from frozen bytes only: `prepare` is the input sum plus the declared seed, `transform` is
  multiply-plus-offset, `evaluate` is square-plus-seed or square-plus-two-seeds. These are the frozen v1 workload
  semantics, imported, never re-implemented.
- Every declared seed is rebuilt, not only the first, so the receipt covers the whole declared population.
- The rebuilt bytes are the producer's own payload shape: one decimal integer and one newline per stage and seed. Their
  digests are what a retained-stage artifact would carry, so the reuse path, not the setup, decides admission.
- Labels are never opened. The setup reads `corpus.json` and the `.input.json` files only, and the receipt records no
  expected-file hash of its own; label immutability comes from the parent v1 seal, which `verifyPreregistration` re-checks
  over its own `expectedFiles`.

## Which sources are rebuilt, and which are refused

A source is rebuilt only when it is a succeeded source whose frozen artifact payload still matches its declared digest.
The other cases keep the fault that their scenario injects, because repairing it would delete the scenario:

| Cases | Reason | Why the setup refuses |
| --- | --- | --- |
| local-stage-edit (2), global-code-change (2) | `rematerialized` | succeeded sources with a matching artifact digest |
| corrupt-artifact (2) | `source-corrupt` | the frozen payload no longer matches its declared digest |
| pruned-artifact (2) | `source-not-retained` | `artifact.present` is false; the frozen bytes carry no retention flag, so no pruned/missing distinction is invented |
| interrupted-source (2) | `source-not-succeeded` | source status is `cancelled` or `unknown` |
| no-hit (2) | `no-frozen-source` | the case declares no source at all |

## Hit capability

A stage can serve a hit only when the code tree is unchanged and that stage's own declaration and upstream bytes are
unchanged. Candidate stage keys bind the selected stage definition, the actual input digests, the seed and the code tree,
so a stage edited further down the pipeline leaves earlier keys intact. The receipt records this per case as
`hitCapableStages`:

- local-stage-edit variant one edits the transform offset, so `prepare` keeps its key and `transform` and `evaluate` lose
  theirs. Variant two edits the evaluator operation, so `prepare` and `transform` keep theirs.
- global-code-change declares a different current code digest, so no stage keeps its key.

`test/execution-reuse-rematerialize.test.ts` does not trust that derivation. It rebuilds the source in a private study
through the real producer adapter, then runs the case's current attempt with `--reuse eligible` against the rebuilt
source and requires the reuse path itself to admit exactly those stages and to miss the rest.

## Cost

The setup's own cost is recorded separately in the receipt under `setupCosts`, using the preregistered 22-field cost
schema where `unknown` is a literal state and never zero. Only `materializationCpuSeconds` and `materializationWallMs` are
measured; every other dimension stays `unknown`, so no total double counts CPU, wall, device, idle or person clocks. The
setup cost is not added to any treatment cost, because no treatment cost exists yet.

## Seal, verification and refusal

The receipt is create-once: a temporary file plus a hard link, so an existing receipt is verified and never overwritten.
`identity` holds everything reproducible (parent binding, code digest, corpus and input hashes, per-case workload and stage
hashes, and the hashed file list). `setupSha256` is the canonical hash of that identity. Verification recomputes the
identity from the working tree and requires exact equality, so any change to the setup code, the corpus, a case input, the
protocol document, the parent v1 receipt or the inherited method is refused instead of silently resealed.

The recorded timings are the freeze run's measurement. Verification validates their schema and units; it cannot re-derive
a CPU measurement, so a tampered value that stays inside the allowed units is not detectable. The seal proves the
identity, not the timing.

## Invariants this amendment does not touch

- v1 preregistration, its receipt (`72f36f85...`, raw `ad2c48aa...`), the frozen corpus and every expected label stay
  byte-identical.
- The supervision v2 amendment receipt and protocol stay byte-identical.
- `checkReuseTreatmentFixture` keeps reporting the fresh-fallback classification for the opaque corpus, so the earlier
  conservative path remains available and unchanged.

## Limits

The rebuilt source is a synthetic bounded-integer pipeline: it proves producer control, dataflow and reuse admission, not
kernel isolation and not any scientific result. The container transport is fake. Whether reuse saves measured compute is
T4's question, not this amendment's, and its outcomes stay `null` with zero trial executions.
