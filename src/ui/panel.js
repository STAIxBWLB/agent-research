// acon api 1: the shell owns polling and confirmation; decision controls use host.ui and host.action.
export default (host) => {
  const { ui } = host;
  const { h } = ui;
  const root = h("div", { class: "ares" });
  host.mount.append(root);
  let panel = "studies", params = {}, visible = true, destroyed = false, generation = 0, last = null;
  const viewKey = () => JSON.stringify([panel, params]);
  const text = (value, fallback = "Unavailable") => typeof value === "string" && value ? value : fallback;
  const number = (value) => typeof value === "number" && Number.isFinite(value) ? String(value) : "Unavailable";
  const rows = (value) => Array.isArray(value) ? value : [];
  const record = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const autonomyLabel = (value) => typeof value === "string" ? text(value)
    : `${text(record(value).default)}${Object.keys(record(record(value).phases)).length ? " (phase overrides)" : ""}`;
  const line = (value, max = 180) => {
    const valueText = text(value, "").replace(/\s+/g, " ").trim();
    return valueText.length > max ? `${valueText.slice(0, max - 3)}...` : valueText;
  };
  const at = (value) => typeof value === "string" ? value.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "Time unavailable";
  const go = (target, extra = {}) => host.navigate(host.tool, target, extra);
  const tone = (state) => ["accepted", "approved", "qualified", "succeeded", "ready"].includes(state) ? "ok"
    : ["failed", "unknown", "unavailable", "corrupt", "missing"].includes(state) ? "err"
      : ["pending", "proposed", "not_qualified", "rejected"].includes(state) ? "warn" : "neutral";
  const decisionNotice = () => ui.notice("Each decision opens a preview. Nothing is written until you confirm.", "neutral");
  const perform = async (input) => {
    try { await host.action(input); }
    catch { if (!destroyed) host.toast("The decision could not be requested. Refresh the study and retry."); }
  };
  const askDecision = (title, input, requirePr = false) => {
    const body = host.sheet.open(title), errors = h("div", { "aria-live": "polite" });
    const fields = [{ name: "reason", label: "Reason", required: true }, ...(requirePr ? [{ name: "pr", label: "Reviewed PR URL", required: true }] : [])];
    const form = ui.form(fields, { label: "Review decision", primary: true }, (values) => {
      const reason = text(values.reason, "").trim(), pr = text(values.pr, "").trim();
      if (!reason) { errors.replaceChildren(ui.notice("Enter a reason before continuing.", "err")); return; }
      if (requirePr) {
        try { const url = new URL(pr); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error(); }
        catch { errors.replaceChildren(ui.notice("Enter the reviewed HTTP(S) PR URL without credentials.", "err")); return; }
      }
      host.sheet.close();
      void perform({ ...input, reason, ...(requirePr ? { pr } : {}) });
    });
    body.append(ui.notice(input.action.startsWith("skill.") ? "Skill decisions are final. Review the evidence and reason before confirming." : "Review the evidence and reason. The next step shows the confirmation preview.", "neutral"), form, errors, ui.button("Cancel", () => host.sheet.close()));
  };
  const block = (title, value) => {
    if (value === undefined || value === null) return ui.empty(`${title} unavailable`);
    const content = JSON.stringify(value, null, 2), bound = 20_000;
    return h("section", { class: "ares-card" }, h("h3", { text: title }),
      h("pre", { class: "ares-pre", text: content.length > bound ? `${content.slice(0, bound)}\n...` : content }),
      content.length > bound ? h("p", { class: "ares-sub", text: "Preview shortened. Inspect the complete records with the ares CLI." }) : null);
  };
  const refresh = async () => {
    const current = generation;
    try {
      const snapshot = await host.snapshot({ ...params, panel, after: 0 });
      if (!destroyed && visible && current === generation) render(snapshot);
    } catch {
      if (!destroyed && visible && current === generation) root.replaceChildren(ui.notice("Research could not refresh. Retry or inspect the console System view.", "err"));
    }
  };
  const toolbar = (title, back = false) => h("div", { class: "ares-bar" },
    back ? ui.button("All studies", () => go("studies")) : null,
    h("h2", { text: title }), ui.button("Refresh", refresh));
  const gateRows = (gates, study) => h("section", { class: "ares-card" },
    ui.table({ caption: "Gate states", columns: [{ key: "gate", label: "Gate" }, { key: "state", label: "State" }],
      rows: rows(gates).map((gate) => ({ gate: text(gate.gate), state: text(gate.state) })) }),
    typeof study === "string" ? ui.rows(rows(gates).filter((gate) => gate.state === "pending" && typeof gate.gate === "string"), (gate) => ui.row({
      title: gate.gate, sub: "Pending decision", chip: { text: "pending", tone: "warn" }, verbs: [
        ui.button("Approve", () => perform({ action: "gate.approve", study, gate: gate.gate }), { tone: "primary" }),
        ui.button("Reject", () => askDecision(`Reject ${gate.gate}`, { action: "gate.reject", study, gate: gate.gate }), { tone: "danger" }),
      ],
    })) : null);
  const attemptRows = (attempts) => {
    const value = record(attempts), byStatus = record(value.byStatus);
    if (value.available === false) return h("section", { class: "ares-card" }, h("h3", { text: "Attempts unavailable" }),
      ui.notice(line(value.reason) || "Attempt records could not be read. Inspect the study records and refresh.", "err"));
    return h("section", { class: "ares-card" }, h("h3", { text: `Attempts: ${number(value.total)}` }),
      ui.rows(Object.entries(byStatus), ([state, count]) => ui.row({ title: state, sub: number(count), chip: { text: state, tone: tone(state) } })) ?? ui.empty("No attempt status details"));
  };
  const studies = (snapshot) => {
    const list = rows(snapshot.studies);
    return [toolbar("Research studies"), decisionNotice(),
      ui.rows(list, (study) => {
        const available = study.available !== false;
        const finalState = study.final?.status, reviewState = study.review?.ready === true ? "Review ready" : study.review ? "Review pending" : "Review unavailable";
        const watchState = study.lastWatch ? `${study.lastWatch.ok ? "Watch answered" : "Watch failed"}: ${number(study.lastWatch.added)} added` : "No watch run";
        const attempts = study.attempts?.available === false ? `Attempts unavailable: ${line(study.attempts.reason) || "Attempt records could not be read."}` : `${number(study.attempts?.total)} attempts`;
        const pending = rows(study.gates).filter((gate) => gate.state === "pending").length;
        return ui.row({ title: line(study.question) || text(study.id, "Unavailable study"),
          sub: available ? [text(study.mode), autonomyLabel(study.autonomy), attempts, `${pending} pending gates`, finalState ? `Final ${finalState}` : "Final unavailable", reviewState, watchState].join(" | ") : text(study.reason, "Study cannot be read; its registration is retained."),
          chip: { text: available ? text(study.mode, "study") : "unavailable", tone: available ? "neutral" : "err" },
          ...(typeof study.dir === "string" ? { onOpen: () => go("study", { study: study.dir }) } : {}) });
      }) ?? ui.empty("No registered studies", "Register one with ares console add <dir>. Ares does not scan the disk for studies.")];
  };
  const skillRows = (skills, study) => ui.rows(rows(skills), (skill) => ui.detail({
    kind: "Skill proposal", title: text(skill.name), state: { text: text(skill.state), tone: tone(skill.state) }, summary: text(skill.summary, ""),
    actions: skill.state === "proposed" && typeof skill.name === "string" && typeof study === "string" ? [
      ui.button("Accept...", () => askDecision(`Accept ${skill.name}`, { action: "skill.accept", study, name: skill.name }, true), { tone: "primary" }),
      ui.button("Reject...", () => askDecision(`Reject ${skill.name}`, { action: "skill.reject", study, name: skill.name }), { tone: "danger" }),
      ui.button("Withdraw...", () => askDecision(`Withdraw ${skill.name}`, { action: "skill.withdraw", study, name: skill.name }), { tone: "danger" }),
    ] : [],
    sections: [{ title: "Steps", body: h("ol", { class: "ares-list" }, ...rows(skill.steps).map((step) => h("li", { text: String(step) }))) },
      { title: "Evidence", body: h("ul", { class: "ares-list" }, ...rows(skill.evidence).map((ref) => h("li", { text: String(ref) }))) },
      ...(skill.decision ? [{ title: "Recorded decision", body: h("pre", { class: "ares-pre", text: JSON.stringify(skill.decision, null, 2) }) }] : [])],
    footer: typeof skill.sha256 === "string" ? [skill.sha256] : [],
  })) ?? ui.empty("No skill proposals");
  const studyView = (snapshot) => {
    const study = snapshot.study;
    if (!study) return [toolbar("Study", true), ui.notice(text(snapshot.error, "Choose a registered study from the studies panel."), "warn")];
    const sections = [toolbar(text(study.question, "Study"), true), decisionNotice()];
    if (typeof study.dir === "string") sections.push(h("div", { class: "ares-bar" },
      ui.button("Lineage", () => go("lineage", { study: study.dir })), ui.button("Compare", () => go("compare", { study: study.dir }))));
    if (study.available === false) return [...sections, ui.notice(text(study.reason, "Study unavailable; its registration is retained."), "err"), h("p", { class: "ares-sub", text: text(study.dir, "") })];
    sections.push(h("div", { class: "ares-bar" }, ui.chip(text(study.mode), "neutral"), ui.chip(autonomyLabel(study.autonomy), "neutral")),
      h("p", { class: "ares-sub", text: text(study.dir, "") }), gateRows(study.gates, study.dir), attemptRows(study.attempts));
    if (study.autonomy && typeof study.autonomy === "object") sections.push(block("Autonomy policy", study.autonomy));
    const final = record(study.final);
    sections.push(h("section", { class: "ares-card" }, h("h3", { text: "Final status" }),
      typeof final.status === "string" ? ui.chip(final.status, tone(final.status)) : ui.empty("No current closed final"),
      typeof final.reason === "string" ? h("p", { text: final.reason }) : null));
    const review = record(study.review);
    sections.push(h("section", { class: "ares-card" }, h("h3", { text: "Review readiness" }),
      study.review ? ui.chip(review.ready === true ? "ready" : "not ready", review.ready === true ? "ok" : "warn") : ui.empty("Review unavailable"),
      ui.rows(rows(review.unmet), (item) => ui.row({ title: text(item.code, "Review requirement"), sub: text(item.message, "") })),
      rows(review.openBlocking).length ? ui.notice(`${review.openBlocking.length} blocking findings remain open.`, "warn") : null));
    if (typeof study.manuscript?.id === "string") sections.push(h("section", { class: "ares-card" }, h("h3", { text: "Built manuscript" }),
      ui.link({ asset: study.manuscript.id }, "Open manuscript text")));
    const investigationArtifact = record(study.investigationArtifact);
    if (investigationArtifact.state === "missing") sections.push(ui.notice(text(investigationArtifact.message, "Investigation artifact missing; displayed result is recalculated. Restore the artifact or run ares investigate close."), "warn"));
    sections.push(block("Investigation", study.investigation), block("Posthoc exploration", study.posthoc));
    const watch = record(study.watch), watchConfig = record(watch.config);
    sections.push(h("section", { class: "ares-card" }, h("h3", { text: "Watch" }),
      typeof watchConfig.rubric === "string" ? h("div", {}, h("strong", { text: "Display-only rubric" }), h("p", { class: "ares-prose", text: watchConfig.rubric })) : null,
      ui.rows(rows(watch.runs), (run) => ui.row({ title: run.ok ? "Source answered" : run.cause === undefined ? "All sources failed" : ["terminated", "filesystem", "internal", "network", "rate", "server", "client", "format"].includes(run.cause) ? `Watch run failed (${run.cause})` : "Watch run failed (unknown cause)", sub: `${at(run.at)} | ${number(run.added)} added | ${number(run.addedIdsTotal)} recorded ids`, chip: { text: run.ok ? "answered" : "failed", tone: run.ok ? "ok" : "err" } })) ?? ui.empty("No watch runs")));
    const candidates = rows(record(watch.newCandidates).candidates).filter((candidate) => candidate.status === "new" && typeof candidate.id === "string");
    sections.push(h("section", { class: "ares-card" }, h("h3", { text: "New candidates" }),
      ui.rows(candidates, (candidate) => ui.row({ title: line(candidate.title) || candidate.id, sub: `${candidate.id}${typeof candidate.year === "number" ? ` | ${candidate.year}` : ""}`, verbs: typeof study.dir === "string" ? [
        ui.button("Include...", () => askDecision("Include candidate", { action: "screen.include", study: study.dir, ids: [candidate.id] }), { tone: "primary" }),
        ui.button("Exclude...", () => askDecision("Exclude candidate", { action: "screen.exclude", study: study.dir, ids: [candidate.id] }), { tone: "danger" }),
      ] : [] })) ?? ui.empty("No new candidates waiting")));
    sections.push(h("section", { class: "ares-card" }, h("h3", { text: "Skill proposals" }), skillRows(study.skills, study.dir)));
    const pending = study.archive?.pendingCount;
    sections.push(h("section", { class: "ares-card" }, h("h3", { text: "Archive lessons" }),
      Number.isSafeInteger(pending) && pending >= 0 ? h("p", { text: pending ? `${pending} pending lesson notes. Preview the next export batch before confirming.` : "No pending lesson notes." }) : ui.empty("Archive preview unavailable"),
      typeof study.dir === "string" && Number.isSafeInteger(pending) && pending > 0 ? ui.button("Preview archive...", () => perform({ action: "archive.confirm", study: study.dir }), { tone: "primary" }) : null));
    const errors = Object.entries(record(study.errors));
    if (errors.length) sections.push(h("section", { class: "ares-card" }, h("h3", { text: "Unavailable records" }),
      ui.rows(errors, ([name, reason]) => ui.row({ title: name, sub: String(reason) }))));
    return sections;
  };
  const rootParams = () => Object.fromEntries(["rootKind", "rootId", "rootRevision", "rootSha256"].filter(key => typeof params[key] === "string").map(key => [key, params[key]]));
  const referenceLabel = (value) => {
    const ref = record(value);
    return `${text(ref.kind)}: ${text(ref.id)}${typeof ref.revision === "string" ? ` | revision ${ref.revision}` : ""}${typeof ref.sha256 === "string" ? ` | sha256 ${ref.sha256}` : ""}`;
  };
  const trace = (study, value) => {
    const ref = record(value);
    if (typeof study !== "string" || typeof ref.kind !== "string" || typeof ref.id !== "string") return;
    go("lineage", { study, rootKind: ref.kind, rootId: ref.id,
      ...(typeof ref.revision === "string" ? { rootRevision: ref.revision } : {}), ...(typeof ref.sha256 === "string" ? { rootSha256: ref.sha256 } : {}) });
  };
  const proofLabel = (value) => {
    const proof = record(value);
    return `${text(proof.file)} | sha256 ${text(proof.sha256)}${typeof proof.ledgerIndex === "number" ? ` | ledger index ${proof.ledgerIndex}` : ""}${typeof proof.recordType === "string" ? ` | ${proof.recordType}` : ""}${typeof proof.nativeId === "string" ? ` | native id ${proof.nativeId}` : ""}`;
  };
  const chooseStudy = (snapshot, target) => ui.rows(rows(snapshot.studies).slice(0, 200), study => ui.row({
    title: text(study.question, text(study.id, text(study.dir, "Registered study"))), sub: text(study.dir, ""),
    ...(typeof study.dir === "string" ? { onOpen: () => go(target, { study: study.dir }) } : {}),
  })) ?? ui.empty("No registered studies", "Register a study with ares console add <dir>.");
  const readHeader = (title, snapshot) => {
    const study = record(snapshot.study), sections = [toolbar(title, true)];
    if (typeof study.dir === "string") sections.push(h("div", { class: "ares-bar" },
      ui.button("Study detail", () => go("study", { study: study.dir })),
      ui.button("Full lineage", () => go("lineage", { study: study.dir })), ui.button("Compare", () => go("compare", { study: study.dir }))));
    if (snapshot.error) sections.push(ui.notice(String(snapshot.error), "err"));
    return sections;
  };
  const moreNotice = (count, command) => count > 0 ? ui.notice(`${count} more; inspect with ares lineage ${command} <dir> --json`, "warn") : null;
  const reasonRows = (value, command = "compare") => {
    const values = rows(value), shown = values.slice(0, 64);
    return h("div", {}, ui.rows(shown, reason => ui.row({ title: String(reason) })), moreNotice(values.length - shown.length, command));
  };
  const readNotices = (value, command = "show") => {
    const data = record(value), notices = [];
    if (data.status === "changed") notices.push(ui.notice(command === "compare" ? "Sources changed or a write is in progress; retry the comparison." : "Sources or the root selection changed. Restart from the first page before continuing.", "warn"));
    else if (data.status === "capped" || data.truncated === true) notices.push(ui.notice(data.status === "capped" ? command === "compare" ? "Traversal capped: this is a partial comparison, not complete evidence." : "Traversal capped: this is a partial graph, not complete provenance." : "This page is partial. Continue to read the remaining source-proven records.", "warn"));
    if (data.status === "unavailable") notices.push(ui.notice("Some source records are unavailable or corrupt. Retained receipts do not establish current readable results.", "warn"));
    const issues = rows(data.issues), critical = issue => /capped|changed/.test(text(issue.code, "")) || issue.code === "comparison-selection-unavailable";
    const important = issues.filter(critical), shown = [...important, ...issues.filter(issue => !critical(issue)).slice(0, Math.max(0, 64 - important.length))];
    notices.push(...shown.map(issue => ui.notice(`${text(issue.code, "Source issue")}: ${text(issue.message, "Inspect and restore the source record.")}`, "warn")));
    const omitted = moreNotice(issues.length - shown.length, command); if (omitted) notices.push(omitted);
    return notices;
  };
  const lineageView = (snapshot) => {
    const sections = readHeader("Execution lineage", snapshot), study = record(snapshot.study), page = snapshot.lineage;
    if (!study.dir) return [...sections, chooseStudy(snapshot, "lineage")];
    if (!page) return [...sections, ui.empty("Lineage unavailable", "Choose a registered study or refresh after restoring its source records.")];
    sections.push(...readNotices(page), h("p", { class: "ares-sub ares-identifiers", text: `Source sha256: ${text(page.sourceSha256)} | ledger bytes: ${number(page.ledgerPosition)} | nodes: ${number(page.totals?.nodes)} | edges: ${number(page.totals?.edges)}` }));
    if (typeof params.rootKind === "string" && typeof params.rootId === "string") sections.push(h("p", { class: "ares-sub ares-identifiers", text: `Root ${params.rootKind}: ${params.rootId}` }));
    if (page.status === "changed") sections.push(ui.button("Restart lineage", () => go("lineage", { study: study.dir, ...rootParams() })));
    sections.push(h("section", { class: "ares-card ares-identifiers" }, h("h3", { text: "Source nodes" }),
      ui.rows(rows(page.nodes).slice(0, 100), node => ui.row({ title: referenceLabel(node.ref), sub: proofLabel(node.proof),
        chip: { text: `${text(node.state)} / ${text(node.availability)}`, tone: tone(node.state === "current" ? node.availability : node.state) }, onOpen: () => trace(study.dir, node.ref) })) ?? ui.empty("No source nodes on this page")));
    sections.push(h("section", { class: "ares-card ares-identifiers" }, h("h3", { text: "Recorded relationships" }),
      ui.table({ caption: "Source-proven edges", columns: [{ key: "from", label: "From" }, { key: "relation", label: "Relation" }, { key: "to", label: "To" }, { key: "proof", label: "Source proof" }],
        rows: rows(page.edges).slice(0, 200).map(edge => ({ from: referenceLabel(edge.from), relation: text(edge.relation), to: referenceLabel(edge.to), proof: proofLabel(edge.proof) })) })));
    sections.push(ui.notice("Current and historical receipts describe their source state. Missing/corrupt sources stay explicit; not-read artifacts show digests only, never output bodies.", "neutral"));
    if (typeof page.nextCursor === "string") sections.push(ui.button("Next lineage page", () => go("lineage", { study: study.dir, ...rootParams(), graphCursor: page.nextCursor })));
    return sections;
  };
  const compareView = (snapshot) => {
    const sections = readHeader("Compare execution records", snapshot), study = record(snapshot.study);
    if (!study.dir) return [...sections, chooseStudy(snapshot, "compare")];
    const errors = h("div", { "aria-live": "polite" });
    sections.push(ui.notice("Read-only comparison. Select exactly one list of existing records; this creates no winner, action or result receipt.", "neutral"),
      ui.form([{ name: "attempts", label: "Attempt ids (comma-separated, at most eight)", value: typeof params.attempts === "string" ? params.attempts : "" }, { name: "candidates", label: "Candidate commits (comma-separated, at most eight)", value: typeof params.candidates === "string" ? params.candidates : "" }], { label: "Compare records", primary: true }, values => {
        const attempts = text(values.attempts, "").trim(), candidates = text(values.candidates, "").trim();
        const selected = attempts || candidates, ids = selected.split(",").map(id => id.trim()), pattern = attempts ? /^[a-f0-9]{16}$/ : /^[a-f0-9]{40}$/;
        if (!!attempts === !!candidates || ids.length < 1 || ids.length > 8 || new Set(ids).size !== ids.length || ids.some(id => !pattern.test(id))) {
          errors.replaceChildren(ui.notice("Enter exactly one list: one to eight distinct 16-hex attempt ids or full 40-hex candidate commits.", "err")); return;
        }
        go("compare", { study: study.dir, ...(attempts ? { attempts: ids.join(",") } : { candidates: ids.join(",") }) });
      }), errors);
    const comparison = snapshot.comparison;
    if (!comparison) return [...sections, ui.empty("Choose records to compare", "Failed and unknown attempts remain visible; retries are not independent samples.")];
    sections.push(...readNotices(comparison, "compare"), h("p", { class: "ares-sub ares-identifiers", text: `Source sha256: ${text(comparison.sourceSha256)} | ledger bytes: ${number(comparison.ledgerPosition)}` }), ui.notice("Aggregation unavailable; performed: false. These descriptive rows do not pool retries or create a verdict. Existing closed investigation and fresh final remain the result authorities.", "neutral"));
    const aggregation = record(comparison.aggregation);
    sections.push(h("section", { class: "ares-card" }, h("h3", { text: "Input compatibility" }),
      ui.chip(aggregation.compatible === true ? "compatible inputs" : "compatibility unavailable or restricted", aggregation.compatible === true ? "neutral" : "warn"),
      reasonRows(aggregation.reasons)));
    for (const row of rows(comparison.rows).slice(0, 8)) {
      const attempts = rows(row.attempts).slice(0, 128), columns = [
        ["id", "Attempt"], ["code", "Code commit / tree / snapshot"], ["protocol", "Protocol hash"], ["seed", "Seed"], ["status", "Status"], ["retry", "Retry ancestry / sample group"], ["metrics", "Metrics and units"], ["digests", "Artifact digests (not read)"], ["wall", "Wall ms (recorded)"], ["bytes", "Output bytes"], ["other", "Other costs"],
      ].map(([key, label]) => ({ key, label, ...(["seed", "wall", "bytes"].includes(key) ? { align: "end" } : {}) }));
      const cost = value => typeof value === "number" && Number.isFinite(value) ? value : "unknown";
      const tableRows = attempts.map(attempt => {
        const code = record(attempt.code), costs = record(attempt.costs);
        return { id: text(attempt.id), code: [text(code.commit), text(code.treeId), text(code.snapshotSha256, "unknown")].join(" / "), protocol: text(attempt.protocolHash), seed: number(attempt.seed), status: text(attempt.status),
          retry: `${text(attempt.retryOf, "none")} | ancestry: ${rows(attempt.retryAncestry).join(" -> ") || "none"} | sample group: ${text(attempt.sampleGroup, "unknown")}`,
          metrics: rows(attempt.metrics).slice(0, 32).map(metric => `${text(metric.name)}: ${number(metric.value)} ${text(metric.unit, "unit unavailable")}`).join("; ") || "unknown",
          digests: rows(attempt.artifactDigests).slice(0, 64).join("; ") || "none recorded", wall: cost(costs.wallMilliseconds), bytes: cost(costs.storageBytes),
          other: ["compute", "transfer", "verification", "retention", "materialization", "idle", "person"].map(name => `${name}: ${cost(costs[name])}`).join("; ") };
      });
      const candidate = record(row.candidate), perSeed = rows(candidate.perSeed).slice(0, 128);
      const recorded = value => typeof value === "number" && Number.isFinite(value) ? value : value === null ? "null (not recorded)" : "unknown";
      const candidateSummary = row.candidate && typeof row.candidate === "object" ? h("section", { class: "ares-card" },
        h("h3", { text: "Recorded closed candidate summary" }),
        ui.notice("Existing closed investigation values only: no recalculation or new eligibility judgment.", "neutral"),
        ui.table({ caption: "Recorded closed candidate summary", columns: [{ key: "reason", label: "Recorded reason" }, { key: "eligible", label: "Recorded eligible" }, { key: "mean", label: "Recorded mean" }, { key: "baselineMean", label: "Recorded baseline mean" }, { key: "delta", label: "Recorded delta" }],
          rows: [{ reason: text(candidate.reason, "unknown"), eligible: typeof candidate.eligible === "boolean" ? String(candidate.eligible) : "unknown", mean: recorded(candidate.mean), baselineMean: recorded(candidate.baselineMean), delta: recorded(candidate.delta) }] }),
        ui.table({ caption: "Recorded per-seed values", columns: [{ key: "seed", label: "Seed", align: "end" }, { key: "attempt", label: "Attempt" }, { key: "value", label: "Recorded value", align: "end" }],
          rows: perSeed.map(sample => ({ seed: recorded(sample.seed), attempt: text(sample.attempt), value: recorded(sample.value) })) }),
        rows(candidate.perSeed).length > perSeed.length ? ui.notice("Per-seed display shortened to the first 128 records. Inspect the complete closed investigation with the ares CLI.", "warn") : null) : null;
      sections.push(h("section", { class: "ares-card ares-identifiers" }, h("h3", { text: `${text(row.kind)}: ${text(row.id)}` }), ui.chip(text(row.state), tone(row.state)), candidateSummary,
        reasonRows(row.reasons),
        ui.table({ caption: "Recorded attempt comparison", columns, rows: tableRows }),
        ui.rows(attempts, attempt => ui.row({ title: `Trace attempt ${text(attempt.id)}`, sub: rows(attempt.comparabilityReasons).join("; "), onOpen: () => trace(study.dir, { kind: "attempt", id: attempt.id }) })),
        rows(row.attempts).length > attempts.length || attempts.some(attempt => rows(attempt.metrics).length > 32 || rows(attempt.artifactDigests).length > 64) ? ui.notice("Display shortened to bounded rows or inventories. Inspect the full read-only comparison with the ares CLI.", "warn") : null));
    }
    return sections;
  };
  const render = (snapshot) => {
    if (destroyed || !visible || snapshot.changed === false) return;
    last = { key: viewKey(), snapshot };
    const body = panel === "lineage" ? lineageView(snapshot) : panel === "compare" ? compareView(snapshot) : snapshot.error && panel !== "study" ? [ui.notice(String(snapshot.error), "err")]
      : panel === "studies" ? studies(snapshot) : panel === "study" ? studyView(snapshot) : [ui.empty("Unknown research panel", "Choose Studies from the console.")];
    root.replaceChildren(...body.filter(Boolean));
  };
  host.onSnapshot(render);
  return {
    show(id, input = {}) { generation++; panel = id; params = { ...input }; visible = true; root.hidden = false; if (last?.key === viewKey()) render(last.snapshot); else root.replaceChildren(ui.notice("Loading research view...", "neutral")); },
    hide() { generation++; visible = false; root.hidden = true; },
    destroy() { generation++; destroyed = true; root.remove(); },
  };
};
