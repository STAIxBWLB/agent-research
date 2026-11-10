# Execution-reuse pilot toolchain

The three candidate stages and the evaluator run in one digest-pinned image:
`node@sha256:ff054b356ab93ed540518ca23cfcd9840e5256dd04db5a8d8afc43f4ecc7c9f8`.

What makes each stage a pure artifact producer:

- Inputs are declared only: one read-only task file at `/in/workload` for the first stage and one read-only
  upstream artifact file at `/in/<port>` for each later stage. No environment variable, clock, locale,
  hostname, network socket or `/workspace` mutation participates in a value.
- Arithmetic is integer-only (`value * 7 + 13`, `Math.floor(value / width)`, integer sums), so byte
  equality does not depend on floating-point formatting.
- Serialization is `JSON.stringify` over a fixed insertion order plus one trailing newline, so the same
  inputs produce the same bytes.
- The only writable path is `/out`, mounted fresh per stage. The root filesystem is read-only, `/tmp` is a
  tmpfs, the network mode is `none`, and capabilities are dropped by the runner.
- Stage argv carries every variable that can change an artifact: the `width` argument of the bucket stage is
  part of its argv, so changing it changes the stage definition and therefore the reuse key.

This document is the reviewed statement behind `reuse.toolchain.documentationSha256` in each stage's
pure-artifact reuse contract.
