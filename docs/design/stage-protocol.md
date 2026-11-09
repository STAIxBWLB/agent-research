# Serial stage execution and retained artifacts

Protocol v2 opts into fresh serial candidate stages and bounded executor-local artifact retention. The CLI and MCP use the same protocol, attempt, inspect and prune implementations. Existing protocol/attempt v1 readers and execution paths keep their identity and raw-byte seal behavior. The source requires a compatible minor release for distribution; no version bump, tag or publication is included.

## Definition

`validateStageProtocol(raw)` accepts this v2 shape, retaining the existing v1 method, evaluator, metric, seed, isolation, limit and budget fields:

```json
{
  "v": 2,
  "method": "synthetic pipeline",
  "candidate": {
    "stages": [
      {
        "name": "prepare",
        "image": "synthetic@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "command": ["/bin/prepare"],
        "env": {"MODE": "fixture"},
        "seed": true,
        "code": "snapshot",
        "needs": [],
        "inputs": {"data": {"task": "data/train.json"}},
        "outputs": {"rows": "rows.json"}
      },
      {
        "name": "train",
        "image": "synthetic@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "command": ["/bin/train"],
        "seed": true,
        "code": "snapshot",
        "needs": ["prepare"],
        "inputs": {"rows": {"stage": "prepare", "output": "rows"}},
        "outputs": {"model": "model.bin"}
      }
    ]
  },
  "evaluator": {
    "image": "synthetic@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "command": ["/bin/evaluate"]
  },
  "metrics": [{"name": "score", "unit": "points", "direction": "max"}],
  "seeds": [0, 1],
  "limits": {"cpus": 1, "memoryMb": 128, "pidsLimit": 64, "wallSeconds": 60, "gpus": 0},
  "network": "none",
  "budget": {"maxAttempts": 5, "maxWallHours": 1, "maxGpuHours": 0}
}
```

- `candidate.stages` contains 1..16 uniquely named stages in explicit serial execution order. All ordering and data references must name earlier stages, making cycles impossible. Independent stages also keep their declared order.
- `needs` is an ordering edge only. An input `{stage, output}` is a data edge and requires the earlier stage's declared output name; it does not need a redundant `needs` entry. Neither edge permits reuse.
- Every stage declares `code: "snapshot"`, meaning the attempt's frozen code commit/tree, and boolean `seed` use. No mutable code locator is accepted. A stage's `seed: false` does not remove the attempt seed from attempt identity.
- Inputs are either `{task: relativePath}` within the frozen task snapshot or `{stage, output}`. Task evaluator paths are private and refused. There is no arbitrary host path, caller-chosen mount or top-level v1 external-input descriptor in this form.
- Named input/output maps each have at most 32 ports. Names contain 1..32 lowercase ASCII letters, digits, underscores or hyphens and begin with a letter. Reserved object names and `evaluator` are refused. Output values name disjoint relative files or directories within that stage's fresh output root. Dot segments, absolute paths, empty segments and unsafe characters are refused.
- Image digest, argv and explicitly declared nonsecret env entries use the authoritative v1 validator, including reserved-key and secret-like-key refusal. No inherited host environment is declared by this schema. The evaluator retains its separate v1 definition and does not accept candidate env.
- The entire formatted definition remains at most 65,536 bytes; stage count does not multiply this ceiling. There are no per-stage wall/compute budget overrides.

This validator is structural preflight only. Task paths and code bytes must be checked against frozen snapshots by the execution implementation. The existing bounded `taskTreeHash` refuses symlinks and special files; structural path validation alone cannot attest filesystem contents.

Optional `reuse` declarations use the [T1 pure-artifact contract](stage-reuse.md). They are included in the design seal but do not activate reuse execution or authorize cache hits.

## Identity

`stageProtocolHash` validates and canonically hashes the entire v2 definition except `budget`. It binds the version, explicit stage order, image, argv, env, seed policy, code source, port names/paths, every ordering/data edge, evaluator, metrics, seeds, limits and network policy. Object key order is irrelevant; array order and argv bytes remain significant. This hash can feed the existing attempt identity formula together with frozen commit/tree, seed, run and retry identity once v2 execution is implemented.

`stageDesignBinding` hashes the validated full definition, including budget, together with a caller-supplied bounded task-tree hash. It is only the protocol/task component for study integration. It does not read a study, record approval, replace `readDesign`, or bind selection/final-seed files. The integrated study design seal composes the v2 definition with the bounded task tree and existing selection/final-seed seals. No v1 hash or raw-byte design-seal formula changes.

## Execution and integrity

Code snapshots hash symlink targets as link metadata without following them; artifact/task snapshots still refuse links. Valid unusual Git filenames remain code inputs, rather than being misreported as transfer failures.

A v2 attempt record freezes the complete v2 definition, code commit/tree, task-tree hash, extracted code snapshot digest, seed and design seal. Its current candidate/evaluator projection is validated against that frozen definition on every read. Completed candidate receipts retain distinct container ids, observed termination and manifest digests; they are not independent samples. One study still admits at most one running attempt.

Candidates run sequentially in distinct fresh containers with non-root uid/gid, network none, read-only root, no capabilities, no-new-privileges and bounded resources. Code mounts at `/workspace:ro`, named copied inputs at `/in/<port>:ro` and fresh writable output at `/out`. A stage with `seed: false` receives no injected `ARES_SEED`. The separate fresh evaluator mounts its private `/eval:ro`, all sealed stage trees at `/candidate/<stage>:ro` and fresh writable `/result`. Only the evaluator result supplies metrics. The complete frozen task tree is reverified whenever the evaluator will mount `/eval`, even when no named input is a task descriptor.

Before consumption, bounded executor operations rehash the extracted code tree, frozen task tree and retained parent manifests/payloads. Parent input identities reference the producing manifest digest, while separate internal payload hashes verify the selected port bytes. They copy only declared inputs into a fresh per-stage snapshot, hash the copy again and mount it read-only. Idempotent materialization rechecks original sources and actual copied bytes, including rejection of undeclared extra inputs; a changed marker alone cannot bless tampered bytes. Same-user/executor interference between verification and use remains an integrity limit. Local permissions are not remote attestation.

Seal requires a verified stopped successful container. Declared output bytes are copied to deterministic quarantine under the study store, verified against the stopped producer and observed output inventory, then published by same-filesystem rename. Metadata is bounded and digest-referenced. An unindexed publication is unavailable until an exact retry revalidates its manifest and payload against the producer. Partial snapshots do not become usable inputs. Deterministic quarantine limits interrupted retries to one pending copy per attempt/stage.

Read-only logs resolve both current candidate receipts and `pipeline.completed` history, validating the exact `candidate-<name>` path and original hash/size. CLI `--candidate-stage NAME` and MCP `candidateStage` share selection; returned rows retain the candidate name. V1 path/selection behavior stays unchanged. Combined tails are bounded at 256 KiB, with smaller defaults for many streams and explicit oversized selections refused before executor reads.

## Aggregate budgets and retention lifecycle

All candidate stages and evaluator share at most 500 output files, 256 MiB payload, 256 KiB metadata (ordinary output inventory plus retained manifest sidecars), and a 1 MiB attempt record. Stage transfers and verification use the remaining attempt-wide wall/global wall/compute budget as their process timeout. Admission and stage transitions do not multiply the budget by stage count; stopped evaluators cannot succeed after verification exhausts it. Existing first-final semantics and explicit retry identities remain authoritative. Permanent observed stopped-stage seal/input failures end as failed with their evidence/artifact-limit/wall-clock cause and release their reservation. A no-start transport or flock failure keeps an explicit retryable launchPending receipt. A transient seal busy/transport error preserves the stopped successful container receipt and retries sealing without rerunning its computation; exhausted wall budget and integrity failures remain terminal. Fresh claim/error fences bind both the exact stage index and monotonic preflight revision; stale workers cannot overwrite a successor or terminate an uncertain launched container. A kill acknowledgement without observed termination keeps the active slot and reservation held.

Retention defaults to a 1 GiB study cap, configurable through executor `retentionCapBytes` or CLI `--retention-cap-bytes` (1..1 TiB). Admission reserves a full bounded output/metadata allowance, including in-flight work, plus a bounded 256 KiB administration allowance before recording/launching a new v2 attempt under the same owned study lock. Released reservations and their stage-index entries move into immutable bounded archive shards; tombstone/disposal markers preserve provenance. Archive publication uses deterministic quarantine temporaries rather than files in the scanned archive prefix; interrupted writes can be retried, and validated legacy temporary names are never exposed as shards. The active 1 MiB index does not accumulate released history, and quota includes archived administration bytes. Full capacity refuses admission without eviction. Explicit attempt reconciliation releases dangling/terminal holds only after the executor confirms no owned live container; it never reruns unknown work. Active consumer references survive interrupted operations until confirmed safe release.

`retention inspect --offset N --limit N` (default 200, maximum 500 rows) returns paged identities, reservations, usage and tombstones. `retention prune --file refs.json` previews explicit `{attemptId,stage,sha256}` references; `--confirm FINGERPRINT` checks that exact state and current design policy. A store-wide OS lock serializes reservation, materialization and prune. Active producer/consumer pins refuse disposal. Tombstones are durable before payload deletion, and manifests remain as provenance; interrupted disposal retains its old quota charge until confirmed cleanup finishes.

Executor mutation and the study filesystem are separate transaction domains. Confirmed prune preflights the local commit, performs fingerprinted executor disposal, then writes approval and its own audit event in one study commit on validated success only. A crash in between leaves authoritative executor tombstones and no false local success or automatic approval. Inspect and preview again before retrying; no cross-system atomic transaction is claimed.

## Migration-free compatibility matrix

| Record or operation | Older v1 reader | Current compatible reader |
| --- | --- | --- |
| Existing v1 study/protocol/attempt | Existing support | Read and fresh execution unchanged |
| Opt-in protocol/attempt v2 | Refuse unsupported version without mutation | Validated fresh serial execution |
| Future protocol/attempt version | Refuse | Refuse before mutation |
| Selection/final rules | Existing support | Existing seals and first-final semantics preserved |
| Retention inspect/prune | Not advertised | Shared CLI/MCP; bounded metadata and explicit prune |

Study and ledger versions do not change. Protocol and attempt manifest format versions become 2. The original v1 no-input protocol hash and raw-byte design-binding formulas do not change. `scripts/n1-check.ts` continues selecting the previous minor line's latest published patch and checking installed CLI, MCP and study/ledger compatibility separately from offline fixtures. Unreleased `CHANGELOG.md` records separate N-1 statements; release authorization, version bump, tag and publication remain outside this implementation.

## Evidence coverage

- AC1: synthetic private-filesystem/Git/tar/Python executor fixture runs three fresh candidate stages in order and a distinct fake evaluator, checks retained parent hashes and read-only mounts. Docker is fake; this is not native container-isolation proof.
- AC2: schema fixtures reject cycles/forward/undeclared refs, unsafe paths, unsupported versions, images/env and actual aggregate definition overflow. Runtime fixtures cover cumulative zero-byte file/metadata caps and in-flight retention admission.
- AC3: synthetic interrupted-state fixtures cover unindexed publication, partial consumption and tombstone-before-disposal; payload, marker, task and code tampering are refused. Most are crash-state simulations. A focused archive-compaction test additionally SIGKILLs the private Python writer before rename, then checks retry and operation recovery; no power-loss or container-isolation proof is claimed.
- AC4: fake-executor fixtures cover unknown/cancelled attempts without descendant reruns, distinct stage containers and read-only copied inputs. Actual kernel mount enforcement remains pending container proof.
- AC5: real private-filesystem store tests cover in-flight reservations, active cross-attempt consumer pins, stale fingerprints, tombstones and metadata retained after disposal. Explicit reconciliation recovers failed terminal release without a rerun.
- AC6: the required full check includes v1, budget, first-final and compatibility regressions; installed-package N-1 and hosted CI are reported separately. Protocol v2 requires its compatible minor release.

The separately authorized container proof remains pending. No reuse, model-output cache, process snapshot, native session manipulation or measured speedup is implemented.
