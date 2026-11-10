# Reuse rematerialization r2 amendment

This is the pre-measurement adapter amendment authorized by the 2026-11-10 planner ruling under issue #63 T3. It supersedes the setup code binding in the original Reuse amendment, setup SHA-256 `dce537e27d78d1771cb8d16edea295b0d06a28bdd7b5c148eab9443137a06cef`, before its first T3 use. It does not report treatment observations, measured benefit or adoption.

## Reason and preserved identity

The original callable admission check hardcodes eligible reuse for both source and current attempts and hides its source construction and fault injection helpers. It cannot schedule a comparable fresh current arm without a source change. The r2 source change adds exports to those existing helpers and types only. Their implementations, arithmetic, source population and fault semantics stay unchanged. The new arm-neutral runner calls those helpers rather than copying source construction or fault injection.

The original receipt remains immutable history. The r2 receipt records its raw hash, its original setup hash and the reason `export-only-before-first-t3-use`. Before sealing, the reader independently checks the old receipt against both pins. Every per-case field, including stage bytes, values, hashes, seeds, source state, fault, label and hit-capable stages, must match the old receipt. Inherited method, input, workload, stage, corpus, threshold and denominator bindings must match too. Only the authorized execution-reuse.ts module's file identity and the resulting aggregate setup-code binding may change.

The v1 registration `72f36f85`, Supervision v2 amendment `5fd3cc18`, original Reuse receipt, every corpus input and evaluator label, and T2a baseline bytes remain unchanged. A changed code identity is documented by the new receipt, never hidden by replacing the old seal.

## Arm-neutral fixture runner

`runReuseTrialArm(input, seed, reuse)` accepts only `off` or `eligible` for the current arm. Both arms use the same bounded synthetic transport and actual ares attempt, retention, verification and fresh evaluator APIs. When a case declares a source, both arms build that source fresh with eligible recording enabled, then call the same sealed fault injector before current execution. This records reusable source keys without borrowing a prior trial result. A no-source case creates no source in either arm.

Current code and stage edits are applied symmetrically. Only the current attempt's reuse control differs. Every current stage decision and retained payload digest is reported. Reused bytes must match the original source, and the source record and metrics must remain unchanged. Current evaluator work always runs fresh. Faulty source artifacts must admit no reused stage, including in the eligible arm. The runner reads no expected label to choose a source, fault or action.

This runner is fixture instrumentation, not native container isolation evidence. Its fake transport does not prove kernel isolation, device accounting or native workload speed. It calls no model, account, live board or network operation.

## Costs and later scheduling

Source setup, current execution and total lifecycle are separate consistent phases for both arms. The total surrounds the lifecycle and includes cleanup; source setup and current are component views of that total. Each phase reports monotonic wall milliseconds and parent process CPU seconds. Subprocess phase CPU is explicitly unknown. Parent CPU is not relabeled total compute, and component clocks are never added to their enclosing total again. Later admitted trial receipts must retain these clock scopes and bind the exact runner code; a missing total-compute denominator prevents the E1 compute threshold from passing.

The registered per-case and per-trial budgets, seeds, AB/BA order and cold/warm definitions are unchanged. No treatment invocation is authorized by creating or verifying this receipt. T3 measurements remain pending review of this amendment/runner PR, completion of the separate reuse pilot and normal host admission.

## Seal and verify

The separate receipt is `docs/verification/execution-eval-reuse-rematerialization-r2-frozen.json`. Repository-only `freeze-reuse-rematerialization-r2` creates it once; later calls verify existing bytes and never overwrite it. `verify-reuse-rematerialization-r2` checks the current setup, this protocol, the sealer and the superseded receipt bindings. Unsupported versions, unknown fields, changed inputs/code, links or oversized files refuse with a restore or new-reviewed-amendment next step.

The original verifier retains its historical source comparison and can report changed once the exported source replaces its original code. That is not permission to rewrite the old receipt. Current integration selects a verified r2 receipt when present and reports the supersession explicitly; it never falls back to the old receipt when r2 is present but invalid.
