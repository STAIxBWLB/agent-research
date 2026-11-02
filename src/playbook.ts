/** Standalone workflow for one agent session. Printed by `ares playbook` and the `ares_playbook` tool. */
export const PLAYBOOK = `ares research playbook (A1 literature, A2 experiments)

Literature workflow

1. Create the study: ares init <dir> --question "..." [--autonomy gates]
2. Write scope.json (question, subquestions, include, exclude, yearFrom, yearTo, maxCandidates) and run ares scope <dir> --file scope.json.
   In gates mode a person or the agent the workspace allows approves it: ares gate approve <dir> scope.
3. Search each subquestion: ares lit search <dir> "<query>" [--source all]. A source that is rate limited is reported, not fatal; retry later or set S2_API_KEY / OPENALEX_API_KEY.
4. Screen against include/exclude: ares lit screen <dir> <id>... --include|--exclude --reason "...". Read titles and abstracts with ares lit list.
5. For each included paper you read, record a card: summary, claims, methods, findings, limitations, relevance (ares lit card <dir> <id> --file card.json). Cards hold what the paper says, never what you hope it says.
6. Verify identifiers: ares lit verify <dir>. "verified" means the DOI or arXiv id exists and its registry title and year match. It never means the paper supports a claim.
   unknown = the registry could not be reached; run verify again. no / partial / mismatch / no identifier are final: fix the record or exclude it,
   and re-check one by naming it (ares lit verify <dir> <id>).
7. Approve the screened set (ares gate approve <dir> screen), then ares lit bib <dir>. Only included and verified papers enter refs/references.bib.
8. Cite as [@key] in the draft and run ares cite check <dir> <draft>. Fix every unknown or unverified key before sharing the draft.

Rules: do not invent references; cite only keys from references.bib; support for a claim needs the passage, judged by a person or a reviewer from a different model family.

Experiment workflow

1. Create an experiment study: ares init <dir> --question "..." --mode experiment [--autonomy gates]. Survey studies refuse experiment commands; study mode is fixed at init.
2. Write task/task.md and task/evaluator/ entrypoint/data, optionally task/rubric.md. Use regular files only, at most 500 files and 64 MiB; symlinks are refused.
3. Set design/protocol.json: ares protocol <dir> --file protocol.json. Declare digest-pinned candidate/evaluator images, argv arrays, metrics (name/unit/max|min), seeds, limits, network "none" and budgets. Dependencies belong in images. ARES_SEED is reserved and supplied to both stages from the selected seed; never put secret-like keys in candidate.env.
4. Configure the executor: ares executor set <dir> --kind ssh --host ALIAS --workdir /private/owned/path, or --kind local with an explicit private workdir. Create that host directory owned by the executor user with mode 0700. Run ares executor check <dir> to check Docker, images and non-root uid:gid; it may pull missing images.
5. In gates mode approve the sealed inputs: ares gate approve <dir> design. The seal binds exact protocol bytes and the task tree. Editing either reopens approval; a budget-only edit also reopens it while preserving comparable attempt protocol identity.
6. Run a frozen baseline: ares attempt run <dir> --repo /absolute/repo --commit <full-40-hex-SHA> --seed <declared-seed> --run main --label baseline --detach. Run a variant with a different frozen commit or declared seed and --label variant. The same request returns the existing attempt; --retry <id> creates a linked attempt. A different seed or commit is a new attempt, not a reproduction. MCP attempt_run is always detached.
7. Run ares attempt reconcile <dir> to advance recorded containers, then inspect ares attempt show <dir> <id> for the full record. ares attempt list <dir> returns summaries, default 50 per page; use --limit N (at most 200) and --offset N. Reconcile again while a stage runs. Totals include failed, cancelled and unknown attempts over the whole study regardless of filters or page, all of which count against budgets. Use ares attempt cancel <dir> <id> --reason "..." to stop a stage. Lost containers become unknown; reconciliation never creates a new attempt.
8. Read logs explicitly with ares attempt logs <dir> <id> [--stage candidate|evaluator] [--stream stdout|stderr] [--tail 16384]. Tail size is 0..65536 bytes, default 16384; without stage/stream filters every recorded stream is returned after checking each copy's size and sha256. Retrieval is read-only; log content stays out of the study. Stage records keep log paths, hashes, sizes and truncation status. Attempt artifacts keep metadata rather than raw output bodies.
9. Numbers come only from the sealed evaluator's /result/metrics.json, an object of all declared metric names and finite numeric values. Candidate output and printed scores never become metrics. Candidate and evaluator run in separate isolated containers; evaluator inputs are read-only. Sealing is ares-observed (argv plus observed container configuration), never host-observed or runner-attested. It does not establish support for a research claim.
`;
