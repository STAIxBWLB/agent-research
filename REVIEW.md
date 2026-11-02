# Review

- Compare the complete diff with the linked phase spec (child issue of #1) and its acceptance criteria.
- Important: a path that lets an unverified or excluded reference into `references.bib` or past `cite check`; a gate that stays approved after its bound content changed; a network failure reported as `exists: no`; an API key, request URL or response body written to disk or the ledger.
- Important: unbounded reads (files, stdin, HTTP bodies), unknown fields or options accepted silently, a write that happens before validation, a lock left behind on failure.
- Important: CLI and MCP behaving differently for the same operation; a command missing from `src/commands-table.ts`.
- Check that tests stay offline and that a test exists for each acceptance criterion it claims.
- Error messages: a new or changed error, refusal or failure message a person or agent sees names the cause (what failed and why) and the next step (the command, setting or target that fixes it). When secrets, ids or paths must stay out, it names the cause class and how to check it. A message missing either is a finding; Important when it is the only signal of a blocked action (a CLI exit, a refused tool call), otherwise a nit.
- Do not report: formatting, naming preferences, `ponytail:` simplifications that state their ceiling, generated `bun.lock`. At most five nits.
