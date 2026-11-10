# Stage-artifact reuse

Protocol v2 candidate stages can opt into deterministic artifact reuse during the current investigation run. Default execution stays fresh. Evaluators, ablation, final and posthoc execution always stay fresh; evaluator metrics are never copied. The implementation uses the existing attempt controller and study-scoped retained store, with no global cache or model-output cache.

## Declaration and controls

Declare `stages[].reuse` in the protocol and obtain the current design approval under workspace policy:

```json
{
  "reuse": {
    "v": 1,
    "kind": "pure-artifact",
    "inputs": "declared-only",
    "externalState": "none",
    "writableState": "fresh-output-only",
    "modelOutputs": "forbidden",
    "determinism": "byte-exact",
    "toolchain": {
      "description": "Synthetic deterministic byte transformer and its documented toolchain",
      "documentationSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  }
}
```

The description is at most 1,024 UTF-8 bytes; the documentation digest is 64 lowercase hex digits. Every field is required, unknown fields/future versions refuse, and strings retain their original bytes. A declaration is not evidence that the documentation exists or that isolation proves determinism. Review the actual toolchain and complete mounted input set; do not place secrets or locators in this text. There is no caller `reviewed` or `approved` flag.

`attempt run --reuse off|eligible` and MCP `reuse` use the same implementation. Off is the default and adds no reuse probes/indexing. Eligible mode requires a current selection rule whose run matches the attempt; a caller cannot classify a final run as investigate. Undeclared, no-output, unsupported and out-of-phase stages execute fresh with a reasoned miss. Sources without an indexed key remain misses; off-mode work is not retroactively promoted.

`--force-fresh` / MCP `forceFresh` prevents consuming a hit. Existing terminal identities remain immutable and idempotent; use the existing explicit `--retry ID` path for a new computation. A re-delivery of the same controls returns its existing running or terminal identity, even for force-fresh. Changing controls on that identity refuses with the recorded settings and an explicit retry hint. A first forced fresh eligible run can publish its verified source for later reuse. These controls do not replace decisive first-final records or mint a new identity by changing a hidden cache flag.

## Key and source facts

The version-1 key binds:

- Study id, full frozen Git tree (40 hex) and extracted code snapshot digest (64 hex), without an unproven narrowed code closure.
- Exactly one actual digest per declared input port. Retained inputs use the verified parent manifest digest; task input hashes come from frozen materialization.
- The full selected stage, including name, image, argv/env bytes, seed policy, data/order edges, output paths and pure-artifact contract; the selected seed remains keyed even when seed injection is off.
- Protocol version, method, evaluator, metrics, declared seeds, limits and network; candidates outside the selected stage and budget are excluded. An unrelated downstream configuration edit can preserve an upstream key, but the complete current design still must be resealed and approved.
- A presence-aware canonical fingerprint of the source-owned validated selection rule and reserved seeds, including an absent reservation file.
- Actual Bun version, package producer version and bounded producer-source hashes, plus an isolated executor OS/architecture/kernel/libc and CPU model/features/count and uid/gid identity and a hashed executor configuration. No raw executor locator or invented ABI is returned as a fact.

Platform probing is bounded to 5 seconds/4 KiB and runs only for eligible investigation candidates. GPU ABI reuse is currently unsupported and becomes a fresh miss; no GPU equivalence or measured savings is claimed. Missing runtime/platform/population facts do not receive a numeric or identity substitute. The frozen context is stored with admitted outcomes/receipts for audit; source and current keys must agree.

The T1 pure helpers still return structural `declaration-only` eligibility. The runtime adapter supplies source-owned facts and actual authorization; the helper itself remains neither a lookup nor an approval receipt.

## Lookup, admission and recovery

Lookup stays in the current physical study/executor store. Under its flock it excludes active/current producers and any source attempt that is not succeeded, scans at most 10,000 records/entries and 4 MiB metadata, verifies the original manifest and payload, checks the key and producing definition/input/code/image/argv/env/seed/version/output identities, and pins the source before returning. Missing, pruned, corrupt, unsupported and scan-capped sources are reasoned misses, followed by ordinary fresh admission. A valid digest alone never makes an interrupted or semantically stale source eligible. No automatic eviction or cross-study/node fallback is added.

Before consumption and after awaited lookup, the controller checks current design binding, design gate, copilot/hypotheses acceptance, remaining budgets and exact stage owner/index/revision. The local stage advance, source receipt, own ledger event and any workspace automatic approval share one study commit. Decoded hit metadata is checked again against the original source attempt and file metadata; malformed/underreported hits cannot claim success or avoid metadata accounting.

A durable preflight marker says no container start was issued. Interrupted lookup/materialization can reconcile that intent and its persisted pin without recomputing the source. The marker is cleared in a fenced fresh-start intent before Docker is called; a genuinely uncertain issued start retains the existing inspection/unknown rules and is never automatically replayed. Native source pin and local study receipt are separate transaction domains: a crash can leave a conservative pin without a local success receipt. Safe explicit reconciliation releases holds only after no owned live container is confirmed.

A reused completion references the original manifest and original container receipt, explicitly marked reused; it never claims a current candidate container. Fresh downstream stages materialize selected original bytes read-only and verify them again. A separate fresh evaluator sees the complete logical candidate pipeline. Existing aggregate file/payload/metadata/record and wall/GPU budgets still apply; referenced manifest sidecars count toward the attempt metadata bound. Original source computation is not charged again as current GPU time.

## Counts, costs and provenance

Controlled v2 pipeline attempts use format v3, so readers unaware of reused stage semantics refuse them. Default fresh attempts keep existing v1/v2 formats. Legacy v1 execution remains fresh; explicitly supplied new request controls are preserved as additive `freshRequest` metadata for idempotent re-delivery, without reuse receipts. Study and ledger versions remain unchanged; new progress/admission events are additive. The source reference, key and receipt are recorded with local admission. Source disposal disables later hits while preserving historical receipts and tombstones. Successful explicit prune commits its path-free exact manifest-reference tuples `[attemptId, stage, sha256]` alongside fingerprint/hash/count in the same local audit event. Show, comparison/provenance and export derive source `disposed` state only from an exact matching ledger receipt, retaining its record proof; older hash-only events and absent witnesses remain `unknown`, never inferred available. These reads do not contact the executor or rewrite stored attempts, so earlier reused receipts remain readable after source disposal.

Provenance, export and console views separate executed candidates, reused candidates, fresh evaluators and independent samples. Artifact edges are attributed per output: fresh stage/evaluator evidence uses `produced` with its attempt-record proof; borrowed output uses `reused-artifact` with the exact reuse ledger receipt. Plan dispatch `observed-output` is not repurposed, and unmatched inventory stays explicitly unattributed. All controlled independent counts use the same row view, including retries. Attempts with reused computation are not counted as new independent samples; retries are not pooled as additional samples. These descriptive projections do not change investigation/final authority. Reused-stage logs remain owned by the original attempt; explicit named requests return the source attempt id rather than pretending the logs were produced by the current run.

Original source wall/GPU allocation time is separate from current monotonic lookup/verification and materialization wall intervals. CPU usage, total failure overhead, storage and transfer costs remain unknown where uninstrumented. Observed preflight-failure timing is a subset that can overlap other categories; the clock relationship is explicit and these fields must not be summed as total compute. No cache-hit-rate-to-cost-saving conversion or adoption verdict is produced.

## Evidence and limits

Private synthetic Git/tar/Python fixtures compare fresh and reused pipeline bytes, require a new evaluator and unchanged source receipts, exercise invalidation/prune/corruption/false-hit, policy/budget/unknown-state guards, source pinning and CLI/MCP parity. Docker execution is fake. Same-user/executor tampering between verification and use remains an integrity limit; filesystem modes are not attestation.

The separately authorized measured pilot remains pending. No treatment trial, live/native/account run, version bump, tag or publication is included. A compatible minor release is required for opt-in attempt v3 and its reader semantics; existing fresh studies need no migration.
