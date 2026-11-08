# Harness rounds: T1 fixture boundary

This is the ares-owned record and synthetic fixture projection for #66 T1. It is not the serialized producer contract, an execution receipt, or an attestation for agent-hub#1225/#1226. Those producers and their admitted read path have not shipped. Real source reads always return unavailable, with no difference between absent and denied addresses. No guessed hub command, fallback, mutation, model call or probe is implemented.

## Round definition

`design/harness.json` has `{v:1, rounds:[...]}` with at most 16 entries and a 1 MiB file ceiling. Every round is bounded to 64 KiB and follows this shape:

```json
{
  "v": 1,
  "id": "round-one",
  "task": {"id": "synthetic-task", "inputSha256": "<64 lowercase hex>"},
  "baseline": {"guidanceSha256": "<64 lowercase hex>"},
  "candidates": [{"id": "candidate-one", "guidanceSha256": "<64 lowercase hex>", "category": "procedure"}],
  "hypothesis": {"deficiency": "Synthetic observed omission", "predictedChange": "Synthetic expected difference"},
  "experience": [],
  "authoring": "uncontrolled-authoring"
}
```

IDs follow the 1..64 ASCII run-name rule. There are at most two candidates, each optionally procedure or domain; neither category is mandatory. Baseline and successor are reserved arm ids. The exact task identity is the immutable `{id,inputSha256}` pair; it may have only one round in this study. A new task snapshot is a different identity. Hypothesis fields are at most 2,000 UTF-8 bytes each. Guidance is represented by hashes, not copied prompts or role bodies. Experience has at most 16 typed #60/#62 refs with their frozen digests; these remain declarations, not new source resolution or lesson adoption.

`authoring` is `uncontrolled-authoring` or `controlled-lane`. Controlled candidate proposals require `sourceExecutions.proposal1` and, when present, `proposal2`. The source map also permits composition, selection and reflection stage refs. Each address has `{v:1,tool:"ahub",projectKey,kind,id,revision?,sha256}` and is declared/unresolved, not evidence of source existence. Every measured model-authored stage must name its execution receipt. Even when such refs exist, end-to-end evaluation remains unavailable until a real admitted producer reader exists. The optional `context: {streamSha256, improverContextHash}` is validated against #67's recorded immutable stream and frozen snapshot. Context-free legacy rounds retain the original canonical definition and binding. See [the frozen-context boundary](harness-experience.md).

A `harness.round.set` event carries the bounded definition and canonical SHA-256. File and event share the study commit/lock preflight, including the existing event ceiling. Identical sets write nothing. Updates retain old events, preserve task identity and change the definition's binding. Unknown versions/forms or an edited/unreceipted index refuse without repair or overwrite.

## Independent gate

`harness:<round-id>` binds the canonical current definition: config, guidance hashes and frozen refs. It uses the study default autonomy without phase inference. Gate actor/auto behavior is unchanged; there is no person-only rule. A changed definition reopens only this gate. This is approval of the round declaration, not proof of a successful execution or scientific result. Container protocol/design/final bindings and attempt/selection/final denominators are untouched. An experiment study needs no container protocol to use this namespace; surveys refuse it.

## Synthetic projection parsers

Only `parseVariantFixture` and `parseProbeFixture` accept these fixture shapes. Both are strict and bounded to 64 KiB, reject unsupported fields (transcript, environment, paths or assurance claims), and retain no raw native transcript. Swapping future producer serialization belongs at these narrow boundaries, after its actual contract and source reader ship. Fixture metadata does not prove upstream restricted-edit or sandbox enforcement.

Variant fields are the #1225 concepts: v, projectKey, taskId, revision, baselineRoleId, baselineRoleHash, baselineBytes, candidateHash, candidateBytes, author, problemHypothesis, expectedObservableDifference, rationale and typed evidence refs. Byte fields are declared counts (0..8192), not copied snapshots. Rationale is at most 2,000 bytes and evidence at most 16 refs. Only the producer can verify admitted bytes, the rendered-role limit and restricted sections.

Probe fields are the #1226 concepts: v, id, experimentId, arm, taskId, taskRevision, taskInputHash, workerEffectiveInputHash, codeTreeHash, baselineHash, guidanceHash, baselineContextHash, libraryHash, requestedModel, requestedConfigHash, servedModel, servedConfigHash, toolsetHash, hostRuntimeHash, budgetHash, outputManifestHash, state, usage and samplingControl. Missing served model/config/output metadata is null; usage and sampling control remain literal unknown. Failed, cancelled, unknown and unavailable states remain visible, never converted into successful executions.

`compareProbeFixtures` checks declared task/revision/input, baseline context/library, code/runtime/toolset, requested/served model/config and budget equality. Own-model/config fallback and missing served values are incompatible. The full workerEffectiveInputHash stays separate from editor/library context: compare it directly only for identical guidance; different admitted guidance can change the effective worker input. This is not proof that only the guidance slot changed. Equal declarations are at most compatible, always with `matched:false`, synthetic-fixture strength, end-to-end unavailable and explicit sampling/producer confounders.

## Local fixture import

`harness import --file` is only a local synthetic declaration. `harness.probe.declared` records the round binding, normalized projection SHA-256 and synthetic-fixture strength under the harness gate. The projection hash is not a resolved producer-file hash. Duplicate identical imports are no-ops; changed reuse of an id, conflicting arm/task/guidance, or another execution of the same arm refuses. There is one baseline and at most two candidate declarations per active definition. Updating a definition leaves earlier imports historical rather than rebinding them.

Show returns current declarations, historical counts, comparisons and unavailable real/evaluation states. It reports truncation/remaining if the complete encoded view would exceed 1 MiB. Full history remains in the bounded study ledger; reads do not launch or resolve anything.


## Contrast, composition and experimental closure

T2/T3 extend this namespace with `harness.contrast.recorded`, `harness.composition.recorded`, `harness.adoption.decided` and `harness.round.closed` (format `harnessTransition: 1`). They remain local fixture records, not measured live evidence. All writes carry the current round binding, bounded normalized form, actor, canonical record hash and event time. New free text uses the same shared URL/key-like and harness assignment/bearer guard. Real producer reads, model calls, probe launch, native metrics, final qualification and transfer promotion remain unavailable.

`harness show --json` returns the current `transitions.fingerprint`, computed over the current definition, admitted projections, contrasts and composition. Each new form supplies that value. A stale fingerprint refuses before approval or writes. IDs are immutable across history: an identical re-submission returns its receipt without writes; changed reuse refuses, even after a definition revision. Replay checks hashes, refs and fingerprints at the event's position, using maps and bounded current buckets rather than scanning all historical transitions per event.

A contrast has these fields:

```json
{"v":1,"id":"contrast-one","fingerprint":"<current fingerprint>","arm":"candidate","outcome":"inconclusive","basis":"actor-claim","observations":"Synthetic admitted behavior","uncertainty":"No real producer proof","explanations":["Task variation may explain it"],"evidence":[{"probe":"synthetic-candidate-probe","projectionSha256":"<admitted projection hash>","outputManifestHash":"<its declared output hash>"}]}
```

Outcomes are improved/unchanged/regressed/inconclusive; basis is deterministic-check/blinded-judgment/actor-claim. Blinded judgments declare judge human/model, with a model identity for a model judge. These labels do not attest that blinding happened; all sources are fixture declarations. Actor/model claims never become observed events. Every evidence ref must match a current admitted projection and, if supplied, its exact declared output hash. Non-inconclusive comparisons require the baseline and selected guidance execution refs. Missing/failed/unknown declarations stay visible; a subjective label never changes their state or becomes an evaluator metric. Deterministic-check basis is a declared fixture-check annotation here, not an executed independent correctness check. Actor comes only from the shared command context, not the form.

A composition enumerates 1..32 unique sections. Each has `{section,decision,contrasts:[{id,sha256}],reason}`, with decision keep/drop/revise and 1..16 current exact contrast links. The form also has v, id, fingerprint, optional model/sourceExecution and `successorSha256` (a declared new guidance hash, or null to keep baseline). There is at most one composition/successor per definition; another successor requires an explicit definition revision. Up to 64 contrasts may be active per definition. Every form remains under 64 KiB and the existing event/ledger caps. Mutations also refuse before the current round evidence view would exhaust its 1 MiB read envelope, reserving space for the full header and closure; the existing records remain readable.

A new successor is `unexecuted` until an explicitly imported successor fixture names that exact hash under the current round. T1's baseline and at most two candidates remain; there may be one extra successor import. Parent executions never count for different bytes. If composition preserves an already executed identical guidance hash, its existing execution is referenced and another successor sample is refused. A fixture declaration remains fixture-only, including when its state says succeeded; real execution assurance and end-to-end evaluation are still unavailable.

Controlled-lane composition, selection/adoption and model contrast forms require their own declared sourceExecution and model identity. They do not mutate the pre-probe definition to add a later source and do not imply that a confined producer actually ran. The source map and per-form refs remain declared/unresolved; missing runtime/budget/served-source assurance cannot be promoted.

## Preview, confirmation and readiness

`harness adopt --file` accepts `{v,id,fingerprint,decision:"adopt",arm,reason,checks,independentCheck}` plus optional model/sourceExecution. Independent checks have `{state:passed|failed|unavailable, source:{kind:deterministic-executable|unavailable,refs:[...]}}`. Their source kind is distinct from blinded human/model judgments and actor claims. Probe/output refs still require exact current admission. All current fixtures have state unavailable; a request to claim passed or failed refuses before writes, even when it cites a succeeded fixture projection. An unavailable source has no refs; a declared deterministic-executable source requires refs but remains unavailable until an owning real source can prove a check. Adoption remains experimental and never qualifies correctness, reuse, transfer or scientific final approval.

`harness close --file` separately accepts `{v,id,fingerprint,outcome,reason}` plus optional model/sourceExecution for a measured authored stage. Without any adoption it can close baseline-kept, inconclusive or withdrawn. Adopted-experimental closures are generated only by a confirmed adoption and carry its exact adoption hash. Model-authored controlled closure fields must carry the declared source ref; an actor's baseline/inconclusive/withdrawal disposition alone claims no measured model stage and needs no adoption.

Both operations first preview without writing or auto-approving. `--confirm` binds the current form and evidence fingerprint. Confirmed adoption writes adoption plus closure together; standalone close writes the closure only, under the same ordinary harness gate. Wrong or stale confirmation changes nothing. Each immutable closure binds the round binding, evidence fingerprint, outcome, actor and reason through its canonical hash and ledger event; the show view exposes these fields directly. Existing current closure cannot be overwritten by another disposition at the same fingerprint. Duplicate exact ids replay without writes.

A later round definition or evidence change makes the earlier closure stale, preserves it and reopens disposition readiness. The current view retains the old closure with current false and a bounded last-16 closure history, explicitly reporting remainingClosures. New decisions use new ids and the new fingerprint. #67 eligibility may consume only a non-stale closure of an earlier same-study stream task, through the later reviewed lesson/export receipt chain; neither clock order, closure alone nor a withdrawn/inconclusive outcome supplies successful-improvement or transfer evidence. Current readiness always retains experimental true, correctness unavailable and transfer not-demonstrated.

The read-only console Harness rounds panel delegates this same show view for an explicitly selected registered study/round. It renders comparison identities, contrasts, section-to-evidence links, closure/current-vs-stale state and successor execution state. It offers no adoption action or external source resolution. Ordinary studies/inbox polling never starts a harness source read, model or executor. Every shortened envelope/visual list is marked incomplete; inspect a single round through CLI JSON when the all-round view reports truncated/remaining.
