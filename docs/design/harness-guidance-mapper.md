# Harness guidance metadata mapper

The read-only consumer follows `GuidanceReadResult` at agent-hub commit `50100a8` ([producer contract](https://github.com/STAIxBWLB/agent-hub/blob/50100a8/docs/design/guidance-experiments.md)). `parseHarnessVariant` distinguishes the existing ares fixture projection from the producer's public metadata view. Existing fixture parsing, stored rounds, bindings and candidate limits retain their earlier behavior.

An available producer view preserves its variant id, screened experiment id, task creation/revision identity, role id and layer, baseline/candidate raw digests and byte counts, author, changed section names, lifecycle status, applicability and evidence digests. `changedSections` contains only `Scope`, `Deliverables` and `Evidence`. A literal `withheld` experiment id stays withheld; the mapper never reconstructs its private identity. An unavailable view returns an explicit unavailable result.

The view has at most 16 variants. Role byte counts are bounded by 8192, private-record byte counts by 32768 and evidence entries by 16. The canonical two-field rationale object is bounded by 2000 UTF-8 bytes, including JSON escaping. Input fields, statuses, integers, hashes and inert JSON containers are checked before use. Unknown fields and raw role snapshots refuse with safe cause and recovery advice.

## Privacy boundary

Privacy follow-up: agent-hub task #822. Until that field-screening fix is available, rationale is accepted only for shape/bound validation and is omitted from every mapped record. The available result carries `rationaleOmitted: true`; it retains no rationale text or digest. Errors never include input snippets, unknown field names or rationale text. Synthetic multiline PII-shaped canaries verify successful and refused reads. A future change to rationale exposure needs its own review against the screened producer contract.

The public view supplies metadata rather than private raw snapshots. Its content id and raw digests are preserved as producer identities, not recomputed from the view JSON or asserted as independently verified bytes. Evidence keys are producer digests, not addresses to resolve. Lifecycle applicability is not probe success, handoff, model attention, approval or demonstrated improvement.

## Reference ownership and compatibility

The shared reference decoder accepts strict `ahub` ExecutionReferenceV1 addresses alongside existing native `ares` addresses. Addresses remain opaque and never select a file, URL, command or implicit producer connection. Local provenance and skill-evidence readers refuse foreign references before local source inspection, including matching project/id/kind values.

This adds no CLI/MCP tool, hub call, persistence or live import. The fixture projection remains a separate ares-owned format. Real probe/handoff receipts remain unavailable until agent-hub#1226 supplies their own contract and authority. No study/ledger format, existing serialized ares record or measured-sample denominator changes. Offline golden-vector conformance and hosted CI remain separate from native/live evidence.
