// Field Force (a separate module; shown only when the server has it switched on).
// Activation: who in the field team has punched in today and, if not, why. HR sees
// everyone (Field Force → Activation) and sets it up; managers see their team.
let faState = { date: null, team: "", branch: "" };
const FA_PILL = { on_time: "", late: "", reason: "", no_reply: "", waiting: "neutral", leave: "neutral", od: "neutral", off: "neutral" };
const faTime = (iso) =>
  iso ? new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : "";
// Where a reason came from, and how each message or call went.
const FA_VIA = { app: "in the app", whatsapp: "by WhatsApp", ivr: "on the IVR call", ai: "on the AI call" };
const FA_CHANNEL = { whatsapp: "WhatsApp", ivr: "IVR call", ai: "AI call" };
const FA_CONTACT = { sent: "sent", failed: "failed", answered: "answered", no_answer: "no answer", skipped: "no mobile number" };
const faContacts = (list = []) =>
  list.length
    ? list
        .map((c) => `<small>${esc(FA_CHANNEL[c.channel])}${c.channel === "whatsapp" ? (c.step === "nudge" ? " (morning)" : " (reminder)") : ""}: ${esc(FA_CONTACT[c.status])}</small>`)
        .join("")
    : "—";
const faWho = (p) => `${esc(p.name)}${p.employee_code ? ` (${esc(p.employee_code)})` : ""}`;

async function fieldActivationPage(id) {
  const hrView = has("attendance.read");
  faState.date ??= today();
  const qs = new URLSearchParams({ date: faState.date });
  if (hrView && faState.team) qs.set("team", faState.team);
  if (hrView && faState.branch) qs.set("branch_id", faState.branch);
  const [data, org] = await Promise.all([
    api(`${hrView ? "/field-force/day" : "/field-force/team-day"}?${qs}`),
    hrView ? api("/admin/org") : null,
  ]);
  if (id !== renderId) return;
  const c = data.counts;
  const tile = (label, value, hint = "", featured = false) =>
    `<div class="stat ${featured ? "featured" : ""}"><div class="stat-label">${esc(label)}</div><div class="stat-value">${value}</div><small>${esc(hint)}</small></div>`;
  const reasons = Object.entries(data.reasons)
    .filter(([, n]) => n)
    .map(([k, n]) => `${n} ${data.people.find((p) => p.reason === k)?.reason_label.toLowerCase() ?? k}`)
    .join(", ");
  const working = data.total - c.leave - c.od - c.off;
  document.querySelector("#content").innerHTML =
    heading(
      "Field Force activation",
      hrView ? "Who in the field team has punched in, and why not." : "Who in your field team has punched in, and why not.",
      '<button class="secondary" id="fa-export">↓ Export CSV</button>',
    ) +
    `<div class="card"><form class="filters" id="fa-filters"><label>Date<input type="date" name="date" value="${esc(data.date)}" required></label>${
      hrView
        ? `<label>Team<select name="team"><option value="">Both</option><option value="collection" ${faState.team === "collection" ? "selected" : ""}>Collection</option><option value="sales" ${faState.team === "sales" ? "selected" : ""}>Sales</option></select></label><label>Branch<select name="branch">${options(org.branches, Number(faState.branch) || null, "All")}</select></label>`
        : ""
    }<button>Show</button></form><p class="muted">${
      data.times.on
        ? `Each working day: a message at ${esc(data.times.nudge)} to punch in, a reminder at ${esc(data.times.remind)} asking anyone not started for a reason, and a report to managers and HR at ${esc(data.times.report)}. Punched in by ${esc(data.times.remind)} counts as on time. Nobody's attendance or leave is changed.`
        : "The morning messages are switched off. The list still shows who has punched in."
    }</p></div>` +
    `<div class="stats">${tile("Punched in on time", c.on_time, `of ${working} working today`, true)}${tile("Punched in late", c.late)}${tile("Gave a reason", c.reason, reasons)}${tile(c.waiting ? "Not punched in yet" : "Not punched in, no reason", c.no_reply + c.waiting, c.leave || c.od ? `${c.leave} on leave · ${c.od} on duty` : "")}</div>` +
    `<div class="card"><h2>Field staff (${data.total})</h2><div id="fa-list"></div></div>`;
  pagedList(document.querySelector("#fa-list"), data.people, {
    head: "<tr><th>Employee</th><th>Team</th><th>Branch</th><th>Manager</th><th>Today</th><th>Punched in</th><th>Reason</th><th>Contacted</th></tr>",
    row: (p) =>
      `<tr><td>${faWho(p)}</td><td>${esc(p.team_label)}</td><td>${esc(p.branch_name || "—")}</td><td>${esc(p.manager_name || "—")}</td><td><span class="pill ${FA_PILL[p.status]}">${esc(p.status_label)}</span></td><td>${faTime(p.first_in) || "—"}</td><td>${p.reason_label ? `${esc(p.reason_label)}${p.reason_note ? `<small>${esc(p.reason_note)}</small>` : ""}<small>at ${faTime(p.reason_at)}${p.reason_via ? ` · ${esc(FA_VIA[p.reason_via] ?? p.reason_via)}` : ""}</small>` : "—"}</td><td>${faContacts(p.contacts)}</td></tr>`,
    text: (p) => `${p.name} ${p.employee_code || ""} ${p.branch_name || ""} ${p.manager_name || ""} ${p.status_label} ${p.reason_label || ""}`,
    label: "people",
  });
  document.querySelector("#fa-filters").onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    faState = { date: f.date, team: f.team ?? "", branch: f.branch ?? "" };
    render();
  };
  document.querySelector("#fa-export").onclick = () => {
    const field = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const lines = [
      ["Employee code", "Name", "Team", "Branch", "Manager", "Today", "Punched in", "Reason", "Note", "Reason given at", "Reason given", "Contacted"],
      ...data.people.map((p) => [
        p.employee_code,
        p.name,
        p.team_label,
        p.branch_name,
        p.manager_name,
        p.status_label,
        faTime(p.first_in),
        p.reason_label,
        p.reason_note,
        faTime(p.reason_at),
        FA_VIA[p.reason_via] ?? "",
        (p.contacts ?? []).map((c) => `${FA_CHANNEL[c.channel]} ${c.step}: ${FA_CONTACT[c.status]}`).join("; "),
      ]),
    ];
    const url = URL.createObjectURL(new Blob(["﻿" + lines.map((l) => l.map(field).join(",")).join("\r\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `field-activation-${data.date}.csv` }).click();
    URL.revokeObjectURL(url);
  };
  if (hrView) {
    await faClockCard(id);
    await faTeamCard(id, org);
  }
}

// ---- setup: the morning clock ---------------------------------------------------------------------------
async function faClockCard(id) {
  const [s, ready] = await Promise.all([api("/field-force/settings"), api("/field-force/channels")]);
  if (id !== renderId) return;
  const editable = has("employees.write");
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Morning messages</h2><p class="muted">Field staff who have not punched in get a phone notification at the first time, and a reminder at the second asking for a reason, which they give on the app's Home screen (on the way, on leave, app or network issue, or call me). At the third time each manager gets the list of their people who have not started, and HR gets everyone. Weekly offs, holidays, rest days, leave and on-duty days are skipped. Phone notifications reach phones only once push is set up (FCM); until then people see the reminder when they open the app. The report is emailed once email is set up.</p><label class="check"><input type="checkbox" id="fa-on" ${s.on ? "checked" : ""} ${editable ? "" : "disabled"}> Send the morning messages and the report</label><div class="actions"><label>Morning message<input type="time" id="fa-nudge" value="${esc(s.nudge)}" ${editable ? "" : "disabled"}></label><label>Reminder and reason<input type="time" id="fa-remind" value="${esc(s.remind)}" ${editable ? "" : "disabled"}></label><label>Report to managers and HR<input type="time" id="fa-report" value="${esc(s.report)}" ${editable ? "" : "disabled"}></label></div>
  <h3>Escalation (optional)</h3>
  <p class="muted">Set up: phone notifications ${ready.push_ready ? "✓" : "✗ (not set up)"} · email ${ready.email_ready ? "✓" : "✗ (not set up)"} · WhatsApp ${ready.whatsapp_ready ? "✓" : "✗ (needs FF_WHATSAPP_PHONE_ID and the WhatsApp token)"} · calls ${ready.calls_ready ? "✓" : "✗ (needs a calling provider: FF_CALL_URL and FF_CALL_TOKEN)"}.</p>
  <label class="check"><input type="checkbox" id="fa-wa" ${s.whatsapp ? "checked" : ""} ${editable ? "" : "disabled"}> Also send the morning message and the reminder by WhatsApp, with reason buttons</label>
  <div class="actions"><label>Morning template<input id="fa-wa-nudge" value="${esc(s.wa_nudge_template)}" ${editable ? "" : "disabled"}></label><label>Reminder template<input id="fa-wa-remind" value="${esc(s.wa_remind_template)}" ${editable ? "" : "disabled"}></label><label>Language<input id="fa-wa-lang" value="${esc(s.wa_language)}" maxlength="6" ${editable ? "" : "disabled"}></label></div>
  <p class="muted">Register both templates with Meta first. Morning: one variable, the first name ("Good morning {{1}}, please punch in to start your day."). Reminder: the first name and four quick-reply buttons in this order: On the way, On leave, App or network issue, Call me.</p>
  <div class="actions"><label>IVR call (press a key)<input type="time" id="fa-ivr" value="${esc(s.ivr || "")}" ${editable ? "" : "disabled"}></label><label>AI voice call<input type="time" id="fa-ai" value="${esc(s.ai || "")}" ${editable ? "" : "disabled"}></label>${editable ? '<button class="secondary" id="fa-save">Save</button>' : ""}</div>
  <p class="muted">Leave a call time blank to skip that call. Calls go only to people still not punched in and without a reason, once each, between the reminder and the report. Answers (key 1 to 4) are saved as their reason.</p>`;
  document.querySelector("#content").append(card);
  card.querySelector("#fa-save")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const v = (sel) => card.querySelector(sel).value;
      const saved = await api(
        "/field-force/settings",
        {
          on: card.querySelector("#fa-on").checked,
          nudge: v("#fa-nudge"),
          remind: v("#fa-remind"),
          report: v("#fa-report"),
          whatsapp: card.querySelector("#fa-wa").checked,
          wa_nudge_template: v("#fa-wa-nudge").trim(),
          wa_remind_template: v("#fa-wa-remind").trim(),
          wa_language: v("#fa-wa-lang").trim(),
          ivr: v("#fa-ivr") || null,
          ai: v("#fa-ai") || null,
        },
        "PATCH",
      );
      notice(saved.on ? `Morning messages on: ${saved.nudge}, ${saved.remind}, report at ${saved.report}.` : "Morning messages are off.");
      await render();
    }),
  );
}

// ---- setup: who is field staff ---------------------------------------------------------------------------
async function faTeamCard(id, org) {
  const people = await api("/field-force/staff");
  if (id !== renderId) return;
  const editable = has("employees.write");
  const card = document.createElement("div");
  card.className = "card";
  const teamSelect = (name) =>
    `<select name="${name}"><option value="collection">Collection</option><option value="sales">Sales</option><option value="">Not field staff</option></select>`;
  card.innerHTML = `<h2>Who is field staff</h2><p class="muted">Only these people get the morning messages and appear above. Collection is the FOS team; Sales is RO, SRO and ABM-RO. For a pilot, set it for one branch only.</p>${
    editable
      ? `<form class="filters" id="fa-group"><label>Set team${teamSelect("team")}</label><label>For designation<select name="designation_id">${options(org.designations, null, "Any")}</select></label><label>Department<select name="department_id">${options(org.departments, null, "Any")}</select></label><label>Branch<select name="branch_id">${options(org.branches, null, "Any")}</select></label><button>Apply to everyone matching</button></form><div class="actions"><label>Or add one person<input type="search" id="fa-q" placeholder="Name, code or branch" autocomplete="off"></label></div><div id="fa-found"></div>`
      : ""
  }<h3>Field staff (${people.length})</h3><div id="fa-team"></div>`;
  document.querySelector("#content").append(card);
  const save = (body) => api("/field-force/staff", body, "PATCH");
  pagedList(card.querySelector("#fa-team"), people, {
    head: "<tr><th>Employee</th><th>Team</th><th>Designation</th><th>Branch</th><th></th></tr>",
    row: (p) =>
      `<tr><td>${faWho(p)}</td><td><span class="pill">${esc(p.team_label)}</span></td><td>${esc(p.designation_name || "—")}</td><td>${esc(p.branch_name || "—")}</td><td>${editable ? `<button class="ghost" data-fa-remove="${p.id}">Remove</button>` : ""}</td></tr>`,
    text: (p) => `${p.name} ${p.employee_code || ""} ${p.team_label} ${p.designation_name || ""} ${p.branch_name || ""}`,
    label: "people",
    wire: (el) =>
      el.querySelectorAll("[data-fa-remove]").forEach((b) =>
        b.addEventListener("click", () =>
          busy(b, async () => {
            await save({ team: null, user_ids: [Number(b.dataset.faRemove)] });
            await render();
          }),
        ),
      ),
  });
  card.querySelector("#fa-group")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { team: f.team || null };
    for (const k of ["designation_id", "department_id", "branch_id"]) if (f[k]) body[k] = Number(f[k]);
    try {
      const r = await save(body);
      notice(`${r.updated} ${r.updated === 1 ? "person" : "people"} ${body.team ? `set to ${body.team === "sales" ? "Sales" : "Collection"}` : "taken off field staff"}.`);
      await render();
    } catch (err) {
      notice(err.message, true);
    }
  });
  const q = card.querySelector("#fa-q");
  let timer;
  q?.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const found = card.querySelector("#fa-found");
      if (!q.value.trim()) return (found.innerHTML = "");
      const rows = await api(`/field-force/staff?q=${encodeURIComponent(q.value.trim())}`);
      found.innerHTML = rows.length
        ? `<div class="cr-saved">${rows.map((p) => `<span class="cr-chip">${faWho(p)}${p.branch_name ? `<small>${esc(p.branch_name)}</small>` : ""}<button type="button" class="secondary" data-fa-add="${p.id}" data-team="collection">Collection</button><button type="button" class="secondary" data-fa-add="${p.id}" data-team="sales">Sales</button></span>`).join("")}</div>`
        : '<p class="muted">Nobody else matches.</p>';
      found.querySelectorAll("[data-fa-add]").forEach((b) =>
        b.addEventListener("click", () =>
          busy(b, async () => {
            await save({ team: b.dataset.team, user_ids: [Number(b.dataset.faAdd)] });
            notice("Added to field staff.");
            await render();
          }),
        ),
      );
    }, 250);
  });
}
