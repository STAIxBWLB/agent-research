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

## Pending T2 and T3

Contrast, per-edit composition, successor readiness, adoption/closure, explicit real-source resolution and the console producer panel are not implemented here. They must preserve the distinction between subjective preference, task checks, measured outcomes and transferable support. A successor will remain untested until its exact execution receipt exists. No fixture record can create native metrics, pass scientific final gates, activate guidance or export a lesson.
