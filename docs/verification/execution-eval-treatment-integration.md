# Treatment fixture integration

This is [#63 T2b](https://github.com/STAIxBWLB/agent-research/issues/63), authorized on 2026-11-09. It connects the frozen synthetic corpus to the merged producer interfaces. It does not launch T3, create paired trial observations, measure a treatment benefit or decide adoption. The T1 method/corpus/threshold seal and T2a baseline receipts remain unchanged; new code is bound independently by the existing run-code reader.

```sh
bun scripts/execution-eval.ts integration-check
bun test test/execution-treatment.test.ts test/execution-diagnose.test.ts test/execution-lineage.test.ts test/execution-reuse.test.ts
```

The first command is read-only: it verifies the existing frozen receipt, retains the ordered 12 Diagnose and 12 Reuse cases, checks the adapter exports and binds the clean committed source. It does not invoke either arm, write a receipt or accept trial arguments. Evaluator truth remains outside the adapter payload: it receives the frozen candidate input and input/expected digests, not expected outcomes. The tests exercise the callable adapters with private synthetic producer fixtures. Run these checks through the workspace resource admission, one job per worktree, two CPU workers and no GPU. Exit 75 is a deferral, not permission for an alternative local run.

## Diagnose

`diagnoseTreatment(studyDir, input)` uses the actual bounded ares lineage and comparison readers. The study directory is an explicit operator/test binding, never a locator taken from candidate text. Only the explicit visible producer identity is resolved. Producer commit/status and retry relationships must agree with the recorded native view before its diagnostic is retained. Missing, inconsistent, corrupt or capped evidence stays unavailable. Privacy gaps and malformed source inputs never cause a query for a hidden identity.

Candidate-visible statements about artifact presence, delivery acknowledgement and selected head remain fixture facts; a metadata lineage read does not attest physical output availability, transport effects or current selection authority. The result is labeled harness-observed fixture integration, not a human usability measurement. The lost-ack ordering fix validates retry relationships before the ordinary unresolved-delivery fallback, preserving retry provenance without treating an unknown effect as permission to redispatch.

## Reuse

The callable Reuse fixture adapter goes through the actual attempt/reconcile, retained-manifest verification, lookup, materialization and fresh evaluator paths. Its container transport is a serialized synthetic seam; filesystem/Git/retention operations use private temporary fixtures. It is not native Docker isolation evidence and grants no production result authority. The three frozen arithmetic operations are separate candidate stages, followed by a separate fixed fresh producer evaluator. Declared inputs are stage-scoped, so a downstream parameter does not become an upstream input accidentally. Global code identities must be actual producer tree/snapshot identities, not a truncated frozen digest.

The frozen source artifacts contain opaque `Synthetic cached bytes fixture-object-*` strings, not numeric stage results or ares retained manifests. A valid digest establishes those opaque bytes only. They are not converted, silently recomputed or relabeled as numeric cache hits. Until a separately reviewed source-establishment method exists, they stay unsupported source bindings and current numeric execution remains fresh. Proposed positive eligibility in the frozen evaluator truth is preserved, not rewritten to disguise this gap. These functional checks establish safe fallback and producer wiring; they do not establish successful treatment reuse across the frozen positive cases.

Any future T3 source-establishment method must retain its real producer identities and account for setup, verification, retention and materialization costs. T3 must rerun both fresh and eligible arms on the same backend in the registered AB/BA order; T2a is not a reusable control sample. No hidden warmup, independent-sample claim from borrowed work or reuse of evaluator metrics is allowed. Missing cost dimensions, person time and native coverage remain unknown.

## Pending scope

At implementation start, [agent-hub#1220](https://github.com/STAIxBWLB/agent-hub/issues/1220) was OPEN. Supervision is therefore pending, with no fake H2 shadow arm or observations. That is a dated dependency observation, not an automatic runtime capability claim. Native/account/model runs, treatment trials, measured cost/speedup claims and adoption remain pending their own authorization and evidence. No actor, gate, final-result or cross-tool record is written by the check-only command.
