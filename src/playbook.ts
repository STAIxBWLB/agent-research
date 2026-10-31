/** Standalone workflow for one agent session. Printed by `ares playbook` and the `ares_playbook` tool. */
export const PLAYBOOK = `ares literature playbook (A1)

1. Create the study: ares init <dir> --question "..." [--autonomy gates]
2. Write scope.json (question, subquestions, include, exclude, yearFrom, yearTo, maxCandidates) and run ares scope <dir> --file scope.json.
   In gates mode a person or the agent the workspace allows approves it: ares gate approve <dir> scope.
3. Search each subquestion: ares lit search <dir> "<query>" [--source all]. A source that is rate limited is reported, not fatal; retry later or set S2_API_KEY / OPENALEX_API_KEY.
4. Screen against include/exclude: ares lit screen <dir> <id>... --include|--exclude --reason "...". Read titles and abstracts with ares lit list.
5. For each included paper you read, record a card: summary, claims, methods, findings, limitations, relevance (ares lit card <dir> <id> --file card.json). Cards hold what the paper says, never what you hope it says.
6. Verify identifiers: ares lit verify <dir>. "verified" means the DOI or arXiv id exists and its registry title and year match. It never means the paper supports a claim.
   unknown = the registry could not be reached; run verify again. no / partial / mismatch = fix the record or exclude it.
7. Approve the screened set (ares gate approve <dir> screen), then ares lit bib <dir>. Only included and verified papers enter refs/references.bib.
8. Cite as [@key] in the draft and run ares cite check <dir> <draft>. Fix every unknown or unverified key before sharing the draft.

Rules: do not invent references; cite only keys from references.bib; support for a claim needs the passage, judged by a person or a reviewer from a different model family.
`;
