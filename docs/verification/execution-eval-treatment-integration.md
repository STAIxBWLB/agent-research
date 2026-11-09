# Treatment fixture integration

This is [#63 T2b](https://github.com/STAIxBWLB/agent-research/issues/63), authorized on 2026-11-09. It connects the frozen synthetic corpus to the merged producer interfaces. It does not launch T3, create paired trial observations, measure a treatment benefit or decide adoption. The T1 method/corpus/threshold seal and T2a baseline receipts remain unchanged; new code is bound independently by the existing run-code reader.

```sh
bun scripts/execution-eval.ts integration-check
bun test test/execution-treatment.test.ts test/execution-diagnose.test.ts test/execution-lineage.test.ts test/execution-reuse.test.ts test/execution-supervision.test.ts
```

The first command is read-only: it verifies the existing frozen receipt, retains the ordered 12 Diagnose, 12 Reuse and 12 Supervision cases, checks the adapter/record-reader/scorer exports and binds the clean committed source. It classifies Supervision fact coverage from candidate-visible payloads only; it does not invoke Diagnose or Reuse, call the shadow rule evaluator, score evaluator truth, write a receipt or accept trial arguments. Evaluator truth remains outside the adapter payload: it receives the frozen candidate input and input/expected digests, not expected outcomes. The tests exercise the callable adapters with private synthetic producer fixtures. Run these checks through the workspace resource admission, one job per worktree, two CPU workers and no GPU. Exit 75 is a deferral, not permission for an alternative local run.

## Diagnose

`diagnoseTreatment(studyDir, input)` uses the actual bounded ares lineage and comparison readers. The study directory is an explicit operator/test binding, never a locator taken from candidate text. Only the explicit visible producer identity is resolved. Producer commit/status and retry relationships must agree with the recorded native view before its diagnostic is retained. Missing, inconsistent, corrupt or capped evidence stays unavailable. Privacy gaps and malformed source inputs never cause a query for a hidden identity.

Candidate-visible statements about artifact presence, delivery acknowledgement and selected head remain fixture facts; a metadata lineage read does not attest physical output availability, transport effects or current selection authority. The result is labeled harness-observed fixture integration, not a human usability measurement. The lost-ack ordering fix validates retry relationships before the ordinary unresolved-delivery fallback, preserving retry provenance without treating an unknown effect as permission to redispatch.

## Reuse

The callable Reuse fixture adapter goes through the actual attempt/reconcile, retained-manifest verification, lookup, materialization and fresh evaluator paths. Its container transport is a serialized synthetic seam; filesystem/Git/retention operations use private temporary fixtures. It is not native Docker isolation evidence and grants no production result authority. The three frozen arithmetic operations are separate candidate stages, followed by a separate fixed fresh producer evaluator. Declared inputs are stage-scoped, so a downstream parameter does not become an upstream input accidentally. Global code identities must be actual producer tree/snapshot identities, not a truncated frozen digest.

The frozen source artifacts contain opaque `Synthetic cached bytes fixture-object-*` strings, not numeric stage results or ares retained manifests. A valid digest establishes those opaque bytes only. They are not converted, silently recomputed or relabeled as numeric cache hits. Until a separately reviewed source-establishment method exists, they stay unsupported source bindings and current numeric execution remains fresh. Proposed positive eligibility in the frozen evaluator truth is preserved, not rewritten to disguise this gap. These functional checks establish safe fallback and producer wiring; they do not establish successful treatment reuse across the frozen positive cases.

Pending: no numeric source established on the frozen corpus.

A clearly separate non-frozen unit fixture calls `checkProducerReuseUnitFixture()` on the same adapter backend. One actual producer attempt seals its own bytes; another eligible attempt consumes the original manifest references and executes only its new evaluator. The test checks source-record preservation and byte-exact outputs. This is producer-hit conformance, not a source setup phase for the frozen corpus or a treatment observation.

Option B would change a preregistered trial method and needs the owner's decision before T3; it is not part of T2b. Any future T3 source-establishment method must retain its real producer identities and account for setup, verification, retention and materialization costs. T3 must rerun both fresh and eligible arms on the same backend in the registered AB/BA order; T2a is not a reusable control sample. No hidden warmup, independent-sample claim from borrowed work or reuse of evaluator metrics is allowed. Missing cost dimensions, person time and native coverage remain unknown.

## Supervision record integration

The earlier pending stub named agent-hub#1220. The actual producer is [agent-hub#1221 T1](https://github.com/STAIxBWLB/agent-hub/issues/1221), pinned to `bc6f46b077dd3a255debaee8152fa17f1f13b79c`. Its contract is `docs/design/supervision.md` and its source is `src/hub/supervision-rules.ts` at that commit. The ares boundary reader owns its closed record types locally; it does not import the hub evaluator or translate fixture states into hub-owned history, deliverable measurements or overlap facts.

`integration-check` reports `integrated-record-reader`. It checks `readShadowSnapshot` and `scoreSupervisionRecords` export availability without calling either, and classifies the frozen candidate payloads with `classifySupervisionFixture`. All 12 frozen inputs describe task-state observations rather than admitted T1 rule facts. Their coverage rows preserve case ids and input/expected digests and report `unsupported` with reason `task-state-not-admitted-rule-facts`; covered is 0 and unsupported is 12. Those rows are not observations, missed triggers or correct non-triggers. Helpful, false and missed remain `null`, while person decisions are the literal shadow-mode value 0.

Separate synthetic unit vectors live outside the sealed corpus under `test/fixtures/execution-supervision`. They exercise the pinned record shapes, deduplication identities, each gap path, suppression and retention bounds, closed refusal behavior and scoring only against separately supplied covered truth. These are deterministic record-consumer conformance checks, not new evaluations of the hub rules or measured treatment benefit. No private task body, hidden task, live hub, daemon, model or network is read at runtime.

The T1 method/corpus/threshold seal, every frozen input and expected file, and all checked-in T2a baseline observation bytes remain unchanged. New integration code is bound per run by the existing committed code reader. Before T3, the owner must decide whether to re-express the frozen Supervision corpus in actual T1 rule facts under a newly reviewed method; this implementation does not build that translation or infer coverage from expected labels.

## Pending scope

Treatment trials, native/account/model runs, measured cost/speedup claims and adoption remain pending their own authorization and evidence. The frozen Supervision task-state corpus remains unsupported by the pinned T1 rule inputs; the record consumer does not make that mismatch disappear. No actor, gate, final-result or cross-tool record is written by the check-only command, and `trialExecutions` and `treatmentObservations` stay 0.
