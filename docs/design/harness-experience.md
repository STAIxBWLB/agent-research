# Frozen experience: T1 and T2 boundary

This implements #67 T1+T2 under the 2026-11-09 eligibility ruling. #67 T3 moved to task #89 after #66 T2/T3 (task #88). No native completed-round-to-lesson-to-amem receipt chain exists yet. Nonempty prospective experience therefore reports unavailable, even when a screened note exists, an ordinary harness gate is approved, or a synthetic probe declares success. Positive completed-earlier-round eligibility tests belong to #88/#89 when those source records exist.

## Stream and controls

Before the first harness round, `harness stream set --file` fixes `design/harness-stream.json`:

```json
{"v":1,"id":"stream-one","revision":1,"tasks":["task-a","task-b"]}
```

The stream has a positive integer revision, an ASCII run-name id and 1..16 unique task ids, each at most 256 UTF-8 bytes. Identity, membership, order and revision are immutable; an identical set is a no-op. A changed stream needs another study. The stream file is bounded to 16 KiB and its canonical hash and value are committed together in `experience.stream.set`. Every frozen context's target must be in this stream. Wall clocks, cross-study ordering, directory scanning and title/text matching cannot establish source order.

`experience freeze --file` accepts this bounded selection form before its round's first definition:

```json
{"v":1,"round":"round-two","taskId":"task-b","condition":"no-library","model":"synthetic-model","runtime":"synthetic-runtime","selected":[]}
```

Conditions are explicit: `baseline`, `no-library`, `retrieval-only`, `prior-experience`. Baseline/no-library forbid selected entries. Only these two empty controls can freeze now. Retrieval-only and prior-experience remain unavailable until native source closure and reviewed lesson/export records can prove eligibility. They are never silently run as no-library controls.

Selection is capped at 16 exact full amem ids and 16 KiB encoded input, including bounded selection reasons. Model/runtime are declared compatibility identities, not observed execution attestations. A frozen context is immutable, and each task has at most one context in the study. Changing its selection, condition or compatibility identity needs a new task/round or study, subject to the one-round-per-exact-task rule. Stream and snapshot files must be regular files beneath a regular design directory. Missing, edited, linked, unknown-version and unreceipted records refuse without repair.

Snapshots in `design/harness-experience.json` store versioned ids/conditions, model/runtime identities, stream hash and empty entries. The index has a 1 MiB bound and at most 16 snapshots, each at most 16 KiB. A future admitted nonempty snapshot may contain only ids/digests, permitted provenance and selection reasons; this implementation deliberately refuses nonempty durable snapshots rather than inventing a closure proof or provisional format. No note body, transcript, stale cache or second general library is stored. All newly authored metadata uses the shared URL/key-like guard plus the harness assignment/bearer guard. Generic `setting=value` prose is allowed; no request URLs or credential-shaped values are persisted.

## Round and worker separation

The ordinary round's optional `context` is exactly `{streamSha256, improverContextHash}`. `improverContextHash` is SHA-256 of canonical JSON of the full frozen snapshot, including its condition and compatibility identity. Every proposal/compose handoff references the same immutable hash. A stream-bound round must name the actual snapshot for that round and task; arbitrary hashes or legacy declared experience cannot bypass it. The existing full-definition gate includes these hashes, so different context bytes produce different gate bindings. Context-free legacy rounds keep their hashes byte-identical and require no stream, source reads or migration.

The improver snapshot does not alter `baseline.guidanceSha256`, a worker's `baselineContextHash`, `libraryHash` or `workerEffectiveInputHash`. Workers receive the fixed baseline context plus their admitted guidance slot, never the improver library directly. A future retrieval-only control must render admitted experience into that same bounded slot, not add it to worker baseline context. No actual session launch, worker input assembly or automatic activation is implemented here; producer execution is still unavailable.

## Selection and recheck

`experience select --file` uses the current project's existing lesson search and half-life ranking. Search ids are advisory, never source eligibility. Only explicitly selected full ids are inspected through #62's owning screened `amem_show` contract (agent-mem >=0.22.1), in the study project. The response must return that exact id. No prefix, direct store, enumeration fallback or body is returned. Selected notes still report `unavailable` because their completed source round and lesson receipts cannot yet be proven. Ordinary legacy lessons are not promoted to prospective transfer evidence.

`experience check <dir> <round> --model MODEL --runtime VERSION` verifies the recorded snapshot and caller-declared compatibility identity before handoff. It calls the same owning exact-id reader for pinned sources, requires both the current screened-view digest and exact source version to match, and returns body-free observations with digest and observation time. Forget/absence and privacy denial are the same unavailable result; stale/superseded content, digest drift and version drift block the whole context. There is no stale-body fallback. Reads revalidate local stream/snapshot generation after source observation and make no distributed atomicity claim.

The independently tested source-recheck primitive accepts up to 16 pins, each with full id, screened-view digest and supported source version. Each owning read has the existing 25-second/256-KiB limit, with no retries. These synthetic positive recheck fixtures prove policy/source liveness only, not round eligibility. Current durable snapshots have no entries, so successful checks return an empty transient context and invoke no source process. A model/runtime mismatch returns unavailable and no context. Future nonempty handoff also needs bounded procedural-only transient assembly and current native source/lesson proof; it is not enabled by these fixtures.

The existing archive receipt hash binds an exported canonical note payload, whereas the screened-view digest binds a current screened amem response. They are different identities. This PR does not infer their connection, change either store's schema or write new archive receipts. The source chain and positive temporal proof land with #88/#89. Contrast-backed lesson candidates, reviewed dispositions, archive crash recovery and producer console details remain T3 work; none is automatically activated here.
