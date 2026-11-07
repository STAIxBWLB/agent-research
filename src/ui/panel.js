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
  const line = (value, max = 180) => {
    const valueText = text(value, "").replace(/\s+/g, " ").trim();
    return valueText.length > max ? `${valueText.slice(0, max - 3)}...` : valueText;
  };
  const at = (value) => typeof value === "string" ? value.replace("T", " ").replace(/\.\d+Z$/, " UTC") : "Time unavailable";
  const go = (target, extra = {}) => host.navigate(host.tool, target, extra);
  const tone = (state) => ["accepted", "approved", "qualified", "succeeded", "ready"].includes(state) ? "ok"
    : ["failed", "unknown", "unavailable"].includes(state) ? "err"
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
          sub: available ? [text(study.mode), text(study.autonomy), attempts, `${pending} pending gates`, finalState ? `Final ${finalState}` : "Final unavailable", reviewState, watchState].join(" | ") : text(study.reason, "Study cannot be read; its registration is retained."),
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
    if (study.available === false) return [...sections, ui.notice(text(study.reason, "Study unavailable; its registration is retained."), "err"), h("p", { class: "ares-sub", text: text(study.dir, "") })];
    sections.push(h("div", { class: "ares-bar" }, ui.chip(text(study.mode), "neutral"), ui.chip(text(study.autonomy), "neutral")),
      h("p", { class: "ares-sub", text: text(study.dir, "") }), gateRows(study.gates, study.dir), attemptRows(study.attempts));
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
  const render = (snapshot) => {
    if (destroyed || !visible || snapshot.changed === false) return;
    last = { key: viewKey(), snapshot };
    const body = snapshot.error && panel !== "study" ? [ui.notice(String(snapshot.error), "err")]
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
