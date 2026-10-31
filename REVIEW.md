# Review

- Compare the complete diff with the linked phase spec (child issue of #1) and its acceptance criteria.
- Important: a path that lets an unverified or excluded reference into `references.bib` or past `cite check`; a gate that stays approved after its bound content changed; a network failure reported as `exists: no`; an API key, request URL or response body written to disk or the ledger.
- Important: unbounded reads (files, stdin, HTTP bodies), unknown fields or options accepted silently, a write that happens before validation, a lock left behind on failure.
- Important: CLI and MCP behaving differently for the same operation; a command missing from `src/commands-table.ts`.
- Check that tests stay offline and that a test exists for each acceptance criterion it claims.
- Do not report: formatting, naming preferences, `ponytail:` simplifications that state their ceiling, generated `bun.lock`. At most five nits.
