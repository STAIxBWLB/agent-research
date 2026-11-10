# Execution evaluation closeout (#63 T4)

This closeout records the defaults and live-evidence gaps left by the
[T3 report](execution-eval-t3-report.md), under the unchanged
[preregistration](execution-eval-preregistration.json). It opens no gap and authorizes nothing.
No run, seal, receipt, fixture, code, advisory-mode or live-board change is part of this document.

## Dispositions and defaults

All evidence below is harness-observed synthetic fixture evidence. The hashes are copied exactly from the
T3 report's "Receipts and custody" table; paths are relative to `docs/verification/execution-eval-t3/`.
No native, visual, account or human benefit is inferred from these observations.

| Trial | T3 disposition | Resulting default state | Evidence SHA-256 | Scope | Unmeasured or failed preregistered gate |
| --- | --- | --- | --- | --- | --- |
| Diagnose | Insufficient evidence | Lineage view stays a read-only utility and is no gate. | Manifest `20b0818f84407c55faad226b24a653f81bbb5f975041142c5004ed48539b12af`; analysis `e554933f8f8062994c939cfcd6d091e1021dd5fe2e969253b6aab1726de9ba0d` | `diagnose-a10eb2477a95-20261110T091046Z/`, `diagnose-analysis.json`; 144 paired slots, 12 synthetic incidents. Parity is by construction; integration and cost only. | No independent accuracy-loss measurement (ceiling 0 percentage points); median human time-to-find reduction (required at least 20 percent) is unknown. Neither gate is claimed as met. |
| Reuse r2 | Restrict, do not adopt | `--reuse eligible` stays off by default, an explicit operator opt-in with no performance or cost claim. | Manifest `820b5f863e28d6c4f8c7b6a07adee395b6f6e0449fab908d2b887adeceab48b0`; analysis `a0cf38756bb236407a606eac1c18a23773d1ee6323f5331ed74550ac056496c9` | `reuse-29db7d4259bc-20261110T083856Z/`, `reuse-analysis.json`; 144 paired slots over 12 rematerialized synthetic cases. Every evaluator is fresh; no general speedup claim. | Eligible compute reduction fails the at-least-20-percent gate (-9.62 percent cold, -11.11 percent warm). No-hit p95 overhead fails the at-most-5-percent gate (31.36 percent cold, 30.74 percent warm). False reuse is 0 of 18 reused stages, which does not offset the failed performance gates. |
| Supervision v2 | At most retain shadow, insufficient for adoption | Shadow only; advisory mode stays off until a separate authorization. | Manifest `673d41a11d4f63c6e4de46789c255eafdd50f2ce7a69c2935dbc3d84ad020ccf`; summary `955f278679f14bb0cda5c992a67ce8ff13ac2fd1778e2c5cc787134d3fa1c79c` | `supervision-29db7d4259bc-20261110T084549Z/`, `supervision-scored/`; 144 synthetic shadow slots: 36 helpful, 12 missed, 96 insufficient. Arms A and C not executed. | Accepted-outcome improvement or at least 20 percent median recovery-time reduction is unmeasured. Total-cost/person-decision increase ceiling of 0 is not established: total cost is unknown and 0 person decisions has no measured benefit signal. |

Final decisive results remain fresh and immutable. Reused stages are not independent samples, and this closeout grants
no gate approval, treatment adoption or sealed-result authority. The provenance, privacy and gate-violation fault-suite
gates were not re-measured in T3; only false reuse was directly observed there.

## Independent read-only utility (AC4)

Failed or insufficient trials do not block independent read-only utility. The following commands remain available;
each is marked `mutates: false` in `src/commands-table.ts`:

- Lineage and comparison: `ares lineage show`, `ares lineage compare`.
- Attempt evidence: `ares attempt list`, `ares attempt show`.
- Study and investigation views: `ares status`, `ares investigate show`.

Their existing bounds, source uncertainty and caller authority still apply. Availability does not establish diagnostic
accuracy, human usability, a performance benefit or authorization to execute an attempt.

## Live-evidence gaps (AC5)

Each gap has exactly one evidence kind. Closure conditions below describe future evidence needs, not work authorized
by this closeout. Unknown costs remain unknown rather than zero; no missing measurement changes a T3 denominator.

- Diagnose time-to-find. Evidence kind: **human**.
  - Closure: separately measured human timing showing at least 20 percent median reduction, with an independent accuracy assessment preserving the no-loss gate. Automated parity cannot supply either human timing or independent accuracy.
  - Separate authorization: a bounded human evaluation with its protocol, participants and budget approved before collection.
  - Linked issue: [#63](https://github.com/STAIxBWLB/agent-research/issues/63).
- Supervision arms A and C, accepted outcomes, recovery and person decisions. Evidence kind: **human**.
  - Closure: an agent-hub-side comparison including current outputs (A) and authorized advisory mode (C), accepted-outcome rate, recovery time, total cost and extra person decisions. Establish improved accepted outcomes or at least 20 percent lower median recovery time, with no increase in total cost or person decisions. Shadow labels alone cannot establish these benefits.
  - Separate authorization: agent-hub-side study authority and an explicit advisory-mode authorization with bounded scope and budget; any live-board activity needs its own authorization. Neither arm ran in T3, and no outcome or cost is inferred for it.
  - Linked issues: [#63](https://github.com/STAIxBWLB/agent-research/issues/63), [agent-hub#1221](https://github.com/STAIxBWLB/agent-hub/issues/1221).
- Absent-action scoring. Evidence kind: **native**.
  - Closure: re-pin the reader to a producer-owned snapshot exporting evaluated coverage for all required rules, tasks and revisions; verify the coverage join before scoring absences. The current snapshot cannot score the absent-action rule; `correctNonTriggers` remains `null`, not 0.
  - Separate authorization: the agent-hub producer/reader re-pin follow-up and any subsequent bounded scoring run; no re-pin or scoring is launched here.
  - Linked issue: [agent-hub#1221](https://github.com/STAIxBWLB/agent-hub/issues/1221).
- Changed-deliverable corpus coverage. Evidence kind: **native**.
  - Closure: a future corpus amendment supplying delivered-record ids, reviewed and separately sealed before evaluation. The frozen case has no such ids, so it cannot elicit the required producer observation; the existing 12 misses stay unrelabeled and in their original denominator.
  - Separate authorization: corpus amendment and subsequent bounded evaluation approval; no alteration to existing inputs, labels, seals or receipts.
  - Linked issue: [#63](https://github.com/STAIxBWLB/agent-research/issues/63).
- Native Docker isolation. Evidence kind: **native**.
  - Closure: an independently checked native executor run demonstrating the declared Docker isolation boundaries and refusal behavior. Synthetic scaffolding and harness admission are not independent physical attestation.
  - Separate authorization: a bounded native executor/isolation validation under the applicable resource policy.
  - Linked issue: [#61](https://github.com/STAIxBWLB/agent-research/issues/61).
- Provider and account costs. Evidence kind: **account**.
  - Closure: provider request/token usage, account cost denominators and separately labeled monetary estimates from an authorized account trial. T3 made no provider or account calls; these costs remain unknown.
  - Separate authorization: provider/account access, calls and a bounded spend budget before collection.
  - Linked issue: [#63](https://github.com/STAIxBWLB/agent-research/issues/63).
- GPU and storage-peak costs. Evidence kind: **native**.
  - Closure: instrument GPU device seconds, actual transient storage peak, storage byte-seconds and retention byte-seconds in an authorized executor trial. T3 used no GPU; these quantities remain unknown. The 16 MiB temporary-storage cap bounds storage but does not measure its peak.
  - Separate authorization: native instrumentation and a bounded trial, with explicit GPU allocation/budget approval if a GPU is used.
  - Linked issue: [#63](https://github.com/STAIxBWLB/agent-research/issues/63).
- Per-slot network isolation evidence. Evidence kind: **native**.
  - Closure: capture and verify network mode `none` per slot in a future receipt design and trial. Current mode `none` is an admission claim and is not recorded per slot; existing receipts remain unchanged.
  - Separate authorization: receipt/instrumentation changes and a bounded native validation run.
  - Linked issue: [#63](https://github.com/STAIxBWLB/agent-research/issues/63).
- Cross-platform snapshot integrity and cross-study container identity. Evidence kind: **native**.
  - Closure: demonstrate that a snapshot with native metadata preserves its frozen tree hash across platforms, and that matching attempt identities in different studies cannot collide while foreign-container refusal remains intact.
  - Separate authorization: native executor validation of the two pilot findings, preserving compatibility and isolation checks.
  - Linked issues: [#148](https://github.com/STAIxBWLB/agent-research/issues/148), [#149](https://github.com/STAIxBWLB/agent-research/issues/149).
- Reuse-outside-investigation notice. Evidence kind: **visual**.
  - Closure: inspect the operator-visible CLI/MCP request-time warning when eligible reuse is requested outside a matching investigation selection, including the reason and next step. This is notice/usability evidence, not a performance result; reuse remains investigation-only.
  - Separate authorization: a bounded interface inspection of the proposed notice.
  - Linked issue: [#150](https://github.com/STAIxBWLB/agent-research/issues/150).

This document opens no gap and authorizes nothing. It records existing gaps without commissioning follow-ups, enabling
advisory mode, changing defaults, launching runs or changing the frozen evidence.
