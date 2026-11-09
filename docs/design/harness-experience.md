# Reviewed lessons and frozen experience

The #67 T1/T2/T3 path connects an existing native ares harness closure, a reviewed lesson candidate and its archive receipt to a later same-study task. Current producer records are explicitly synthetic fixtures. Their lesson exports are single-task observations, failures or limitations labeled `synthetic-fixture; not evidence of real agent behavior`. A valid receipt chain permits preparation only; it does not establish real agent behavior, improvement, transfer or eligibility for a controlled/live trial. Real producer execution and live transfer remain future work.

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

Conditions are explicit: `baseline`, `no-library`, `retrieval-only`, `prior-experience`. Baseline/no-library forbid selected entries. Nonempty retrieval-only/prior-experience selections require a current closed round from an earlier task in this same stream and study, its unchanged accepted lesson and unique archive receipt, and an exact current screened amem response matching the exported note. Model, runtime and toolset hash must match the recorded lesson compatibility. Missing compatibility or any missing, stale, withdrawn, unavailable or mismatched link refuses preparation; the selection is never silently run as an empty control.

Selection is capped at 16 exact full amem ids and 16 KiB encoded input, including bounded selection reasons. Nonempty requests include `toolsetSha256`; runtime and toolset identities match the source hashes. These are declared compatibility identities, not observed execution attestations. A frozen context is immutable, and each task has at most one context in the study. Changing its selection, condition or compatibility identity needs a new task/round or study, subject to the one-round-per-exact-task rule. Stream and snapshot files must be regular files beneath a regular design directory. Missing, edited, linked, unknown-version and unreceipted records refuse without repair.

Snapshots in `design/harness-experience.json` contain ids/digests, source version/observation time, selection reasons, compatibility identities and the bound lesson/disposition/note/closure identities. Nonempty snapshots retain `sourceStrength: synthetic-fixture` and `transfer: not-demonstrated`; they never become live-source evidence. The index has a 1 MiB bound and at most 16 snapshots, each at most 16 KiB. No note body, transcript, stale cache or second general library is stored. Newly authored metadata uses the shared URL/key-like guard plus the harness assignment/bearer guard. Generic `setting=value` prose is allowed; no request URLs or credential-shaped values are persisted.

## Reviewed lesson candidates and archive

`lesson propose <dir> --file PATH|-` proposes a bounded lesson from the current immutable harness closure. The form includes `v`, `name`, `round`, `closureSha256`, `kind`, `summary`, `procedure`, `applicability`, `limitations`, `whenNotToUse`, `failure`, `retryWhen`, concrete contrast/composition `change` refs, probe/output `behavior` refs and typed `counterevidence`. Optional reflection records its model and source execution reference; it is not an observed behavior claim. Exportable kinds are `observation`, `fail` and `limitation`. `no-lesson` records an honest reviewed non-result and is never exported. The source-owned typed closure reference kind is `harness-closure`, not a generic completion claim.

There are at most 64 proposals, each bounded to 16 KiB, with a 1 MiB receipt-checked `proposals/lessons.json` index. `lesson list` reads stored state locally; it does not freshly inspect external sources. `lesson check <dir> <name>` explicitly rechecks the current closure, required evidence and counterevidence. `lesson decide <dir> <name> --file PATH|-` takes decision, proposal hash, evidence fingerprint and reason. Acceptance also requires `acknowledgeStrength` to equal the literal `synthetic-fixture; not evidence of real agent behavior` and rechecks unchanged sources under the study lock. Rejected/withdrawn dispositions are final; an accepted candidate can later be withdrawn. A changed source needs a revised proposal rather than a silent edit.

Only accepted, unchanged, non-`no-lesson` candidates enter ordinary archive preview/confirmation. Observation exports become finding notes; failure and limitation exports become fail notes. Every note keeps the literal fixture label, single-task scope, applicability, limitations, when-not-to-use, failure/retry conditions and the `ares:<study-id>/harness-closure:<round>` evidence ref. Export rechecks the accepted evidence and counterevidence before outward writes. No export establishes successful behavior or transfer.

Archive deduplication uses successful returned ids/content hashes recorded in ares receipts. A crash after amem add but before receipt commit is ambiguous: the unreceipted write cannot be detected and a retry may duplicate it. The operator must reconcile with the owner before retrying an interrupted/crashed archive. This is receipt-only recovery, not exactly-once cross-store export. Vault promotion remains separate.

## Round and worker separation

The ordinary round's optional `context` is exactly `{streamSha256, improverContextHash}`. `improverContextHash` is SHA-256 of canonical JSON of the full frozen snapshot, including condition, compatibility and source pins. Every proposal/compose handoff references the same immutable hash. A stream-bound round must name the actual snapshot for that round and task; arbitrary hashes or legacy declared experience cannot bypass it. The full-definition gate includes these hashes, so different context bytes produce different gate bindings. Context-free legacy rounds keep their hashes byte-identical and require no stream, source reads or migration.

The improver snapshot does not alter `baseline.guidanceSha256`, a worker's `baselineContextHash`, `libraryHash` or `workerEffectiveInputHash`. Checks report `workerContext: baseline-only`. A retrieval-only preparation can expose its bounded transient text in `retrievalGuidanceSlot`, not in the worker baseline. No actual session launch, worker input assembly or automatic activation is implemented. Fixture entries refuse controlled-lane use and remain ineligible for live trials even when their source chain is valid.

## Selection and recheck

`experience select --file` uses the study project's existing lesson search and half-life ranking. Search ids are advisory, never source eligibility. Explicit full ids with no current accepted lesson/archive chain report unavailable without an exact-id source read. Only locally chain-proven eligible selections reach #62's owning screened `amem_show` contract (agent-mem >=0.22.1), in the study project. The response must return that exact id, note kind and exported text. No prefix, direct store, enumeration fallback or stale-body fallback is allowed. Ordinary legacy lessons cannot become prospective transfer evidence through retrieval alone.

`experience check <dir> <round> --model MODEL --runtime VERSION [--toolset-sha256 HASH]` rechecks the recorded snapshot and caller-declared compatibility before handoff. The current native closure, accepted unchanged lesson/disposition, archive mapping and exact screened digest/source version must still agree. Forget/absence and privacy denial share unavailable. Changed/superseded notes, digest/version drift, withdrawal and compatibility drift block the whole context. Source text is assembled transiently within 16 KiB and discarded rather than written to the study. Empty controls invoke no source process.

A selection/check shares the bounded source inspection budget, including current counterevidence and owning amem reads; there are no source retries. Source observations are rechecked against current local records before returning a context. This establishes observed policy/source liveness at those times, not a distributed atomic snapshot. Results retain `prepareOnly: true`, `transfer: not-demonstrated` and fixture strength; selection also reports `liveEligible: false`. A structurally valid earlier fixture chain is therefore useful for testing preparation, never proof of real behavior or transfer.

The archive receipt's content hash identifies the canonical exported payload, while the screened-view digest identifies the current owning response. They remain separate pins, joined only by the accepted native lesson/archive chain and exact transient note match. No general note-body cache, automatic activation, live producer execution or real transfer claim is added.
