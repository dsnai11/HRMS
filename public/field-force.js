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
  await faMovementCard(id, hrView);
  if (hrView) {
    await faClockCard(id);
    await faTrackingCard(id);
    await faTeamCard(id, org);
  }
}

// ---- Phase 3: movement during the day, and one person's route on a map -------------------------------
let faLeaflet = null;
function faLoadLeaflet() {
  // The map library the app already serves; the pictures come from OpenStreetMap.
  const loaded = (el) =>
    new Promise((resolve, reject) => {
      el.onload = resolve;
      el.onerror = reject;
      document.head.append(el);
    });
  if (window.L) return Promise.resolve();
  faLeaflet ??= Promise.all([
    loaded(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/vendor/leaflet.css" })),
    loaded(Object.assign(document.createElement("script"), { src: "/vendor/leaflet.js" })),
  ]).catch(() => {
    faLeaflet = null;
    throw new Error("The map could not be loaded. Refresh the page.");
  });
  return faLeaflet;
}
async function faMovementCard(id, hrView) {
  const data = await api(`/field-force/movement?date=${faState.date}`);
  if (id !== renderId || !data.settings.tracking) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Movement</h2><p class="muted">Location is shared only by field staff who agreed in the app, only while punched in. Someone who moves less than ${data.settings.still_meters} m in ${Math.round(data.settings.still_minutes / 6) / 10} hours, without logging a customer visit, gets a nudge; if it happens again before they move, their manager is told. Opening a route is recorded in the activity log.</p><div id="fa-move"></div><div id="fa-route"></div>`;
  document.querySelector("#content").append(card);
  pagedList(card.querySelector("#fa-move"), data.people, {
    head: "<tr><th>Employee</th><th>Branch</th><th>Sharing</th><th>Last location</th><th>Distance</th><th>Visits</th><th>Alerts</th><th></th></tr>",
    row: (p) =>
      `<tr><td>${faWho(p)}</td><td>${esc(p.branch_name || "—")}</td><td>${p.consent ? '<span class="pill">Agreed</span>' : '<span class="pill neutral">Not agreed</span>'}</td><td>${faTime(p.last_at) || "—"}</td><td>${p.points ? `${p.km} km` : "—"}</td><td>${p.visits || "—"}</td><td>${p.alerts ? `<span class="pill ${p.alert_open ? "" : "neutral"}">${p.alerts}${p.alert_open ? " open" : ""}</span>` : "—"}</td><td>${p.points || p.visits ? `<button class="ghost" data-fa-route="${p.id}">Route</button>` : ""}</td></tr>`,
    text: (p) => `${p.name} ${p.employee_code || ""} ${p.branch_name || ""}`,
    label: "people",
    wire: (el) =>
      el.querySelectorAll("[data-fa-route]").forEach((b) =>
        b.addEventListener("click", () => busy(b, () => faRoute(card.querySelector("#fa-route"), Number(b.dataset.faRoute)))),
      ),
  });
}
async function faRoute(el, userId) {
  const [r] = await Promise.all([api(`/field-force/route?user_id=${userId}&date=${faState.date}`), faLoadLeaflet()]);
  el.innerHTML = `<h3>${faWho(r.person)}, ${esc(r.date)}</h3><p class="muted">${r.points.length} locations · ${r.visits.length} visits · ${r.alerts.length} alerts. Green: punch in; blue: punch out; red: customer visits.</p><div id="fa-map" class="pm-map" role="region" aria-label="Route map"></div>`;
  const map = L.map("fa-map", { scrollWheelZoom: false }).setView([22.5, 79], 5);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
  }).addTo(map);
  const bounds = [];
  const line = r.points.map((p) => [p.latitude, p.longitude]);
  if (line.length) {
    L.polyline(line, { color: "#2f6fd6", weight: 3 }).addTo(map);
    bounds.push(...line);
  }
  const dot = (lat, lng, color, text) => {
    if (lat == null || lng == null) return;
    L.circleMarker([lat, lng], { radius: 7, color, fillColor: color, fillOpacity: 0.9 }).bindPopup(text).addTo(map);
    bounds.push([lat, lng]);
  };
  for (const sh of r.shifts) {
    dot(sh.in_latitude, sh.in_longitude, "#146c53", `Punch in ${esc(faTime(sh.in_at))}`);
    if (sh.out_at) dot(sh.out_latitude, sh.out_longitude, "#2f6fd6", `Punch out ${esc(faTime(sh.out_at))}`);
  }
  for (const v of r.visits) dot(v.latitude, v.longitude, "#c0392b", `Visit ${esc(faTime(v.at))}${v.customer ? `: ${esc(v.customer)}` : ""}`);
  if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

// ---- Phase 3 setup: tracking ---------------------------------------------------------------------------
async function faTrackingCard(id) {
  const s = await api("/field-force/tracking/settings");
  if (id !== renderId) return;
  const editable = has("employees.write");
  const dis = editable ? "" : "disabled";
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Location during the day</h2><p class="muted">When on, field staff are asked in the app to agree to sharing their location while punched in (they can say no, or withdraw later). It stops at punch-out, the phone shows a notification while it is on, and locations are deleted after the number of days below. Staff need the new app version. Tell staff about it, and confirm the wording with HR and legal before switching it on.</p><label class="check"><input type="checkbox" id="fa-track" ${s.tracking ? "checked" : ""} ${dis}> Ask field staff to share their location while punched in, and check for no movement</label><div class="actions"><label>Location every (minutes)<input type="number" id="fa-ping" min="5" max="60" value="${s.ping_minutes}" ${dis}></label><label>No-movement check (minutes)<input type="number" id="fa-still" min="30" max="480" value="${s.still_minutes}" ${dis}></label><label>Counts as moved (metres)<input type="number" id="fa-metres" min="50" max="5000" value="${s.still_meters}" ${dis}></label><label>Keep locations (days)<input type="number" id="fa-keep" min="7" max="365" value="${s.keep_days}" ${dis}></label>${editable ? '<button class="secondary" id="fa-track-save">Save</button>' : ""}</div>${
    editable
      ? `<h3>Upload from a tracker</h3><p class="muted">A CSV with the columns employee_code, time (date and time), latitude and longitude. Only points inside the person's punched-in time are kept.</p><div class="actions"><button class="secondary" id="fa-import">Choose a CSV file</button></div><input type="file" id="fa-import-file" accept=".csv,text/csv" hidden>`
      : ""
  }`;
  document.querySelector("#content").append(card);
  card.querySelector("#fa-track-save")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      const n = (sel) => Number(card.querySelector(sel).value);
      const saved = await api(
        "/field-force/tracking/settings",
        { tracking: card.querySelector("#fa-track").checked, ping_minutes: n("#fa-ping"), still_minutes: n("#fa-still"), still_meters: n("#fa-metres"), keep_days: n("#fa-keep") },
        "PATCH",
      );
      notice(saved.tracking ? "Location during the day is on. Field staff are asked in the app." : "Location during the day is off.");
      await render();
    }),
  );
  const file = card.querySelector("#fa-import-file");
  card.querySelector("#fa-import")?.addEventListener("click", () => file.click());
  file?.addEventListener("change", async () => {
    const f = file.files[0];
    if (!f) return;
    try {
      const table = parseCsv(await f.text());
      const head = (table.shift() ?? []).map((h) => h.trim().toLowerCase().replace(/[^a-z]+/g, "_"));
      const col = (name) => head.indexOf(name);
      const at = col("time") >= 0 ? col("time") : col("at");
      const rows = table.map((r) => ({
        employee_code: r[col("employee_code")],
        time: r[at] ? new Date(r[at]).toISOString() : null,
        latitude: Number(r[col("latitude")]),
        longitude: Number(r[col("longitude")]),
      }));
      const r = await api("/field-force/pings/import", { rows });
      notice(`${r.saved} locations saved. ${r.unknown} with an unknown employee code, ${r.outside_shift_or_duplicate} outside punched-in time or already there.`);
    } catch (err) {
      notice(err.message, true);
    }
    file.value = "";
  });
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
