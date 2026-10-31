# agent-research

- Implement the accepted issue contract (the phase's child spec under #1) on a branch with a PR. Change the spec first when the code must differ.
- Source is in `src/`, the bootstrap in `bin/`, checks in `scripts/`, tests and synthetic fixtures in `test/`.
- Strict TypeScript, `.ts` imports, `noUncheckedIndexedAccess`. Runtime imports: relative files, Node builtins and `bun:` only (`scripts/check-boundary.ts`).
- `src/commands-table.ts` is the single CLI source; CLI and MCP both call `src/commands.ts`. Add a command to all three.
- Verify with `bun install --frozen-lockfile && bun run check`. Passing output ends with `boundary: ok`, `0 fail` and the package dry-run listing. Tests never touch the network: route requests through `fakeHttp` in `test/helpers.ts`.
- Fixtures are synthetic records shaped like real API responses; do not paste real paper records or keys into tests.
- Read files only through `readTextBounded`/`readBytesBounded` in `src/study.ts` (regular files, stop past the limit), and pass the reader's bound to `writeAtomic`. Every mutating command ends in one `commit(dir, files, events)` that carries the files, the `requireGate` approval and the command's own event, so a failed check changes nothing and a failed command never records an approval. (2026-11-01: PR #3 review found unbounded reads twice; revisit if a streaming store replaces whole-file JSON.)
- Never write API keys, request URLs or response bodies into a study; errors name the host and status only.
- "verified" is identifier existence plus title and year match. Do not add any path that marks support for a claim or lets unverified references into the bibliography.
- No agent-environment refusal or TTY requirement. Gates record the actor; approval policy belongs to the workspace.
- Keep unimplemented phases out of the CLI and README command list.
- Conventional English commits, no coauthor trailers unless requested.
