// Time off: balances, calendar, requests, approvals, HR administration, muster.
const DAY_LABEL = {
  present: "Present",
  half_day: "Half day",
  leave: "Leave",
  half_leave: "Half leave",
  half_day_and_leave: "Half day + leave",
  absent: "Absent",
  holiday: "Holiday",
  weekly_off: "Weekly off",
  pending: "Today",
};
const REG_KINDS = {
  missed_punch: "Missed punch",
  wrong_punch: "Wrong punch",
  on_duty: "On duty",
  work_from_home: "Work from home",
};
const STATUS_PILL = (s) =>
  `<span class="pill ${s === "approved" ? "" : "neutral"}">${esc(s)}</span>`;
const fmtDate = (d) =>
  d
    ? new Intl.DateTimeFormat("en-IN", {
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${d}T00:00:00Z`))
    : "—";
const rangeText = (r) =>
  r.from_date === r.to_date
    ? `${fmtDate(r.from_date)}${r.half_day ? ` (${r.half_day} half)` : ""}`
    : `${fmtDate(r.from_date)} – ${fmtDate(r.to_date)}`;
const thisMonth = () => today().slice(0, 7);
const shiftMonth = (m, n) => {
  const d = new Date(`${m}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
};
const monthLabel = (m) =>
  new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${m}-01T00:00:00Z`));
const sel = (name, label, entries, selected = "") =>
  `<label>${label}<select name="${name}">${entries.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(selected) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`;

// ---- employee: my time off ---------------------------------------------------
let timeOffMonth = null;
function calendarGrid(days, month) {
  const lead = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const cells = Array.from(
    { length: lead },
    () => '<div class="day blank"></div>',
  );
  for (const d of days)
    cells.push(
      `<div class="day ${d.status}" title="${esc(d.holiday || DAY_LABEL[d.status] || "")}"><b>${Number(d.date.slice(8))}</b><small>${esc(d.holiday || DAY_LABEL[d.status] || "")}</small></div>`,
    );
  return `<div class="cal"><div class="dow">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((x) => `<span>${x}</span>`).join("")}</div><div class="grid">${cells.join("")}</div></div>`;
}
// Where to reach someone on leave and who covers for them, when they said.
const leaveExtras = (r) =>
  [
    r.address_on_leave && `Address: ${esc(r.address_on_leave)}`,
    r.contact_on_leave && `Contact: ${esc(r.contact_on_leave)}`,
    r.handover_name && `Work handled by ${esc(r.handover_name)}`,
    r.document_id &&
      `<a href="/api/documents/${r.document_id}/file" target="_blank" rel="noopener">Medical document ↗</a>`,
    r.status === "pending" &&
      JSON.parse(r.approvals || "[]").length &&
      `Approved so far by ${JSON.parse(r.approvals)
        .map((a) => esc(a.name))
        .join(", ")}`,
  ]
    .filter(Boolean)
    .map((x) => `<small>${x}</small>`)
    .join("");
async function timeOffPage(id) {
  timeOffMonth ||= thisMonth();
  const month = timeOffMonth;
  const [bal, reqs, regs, cal, hol] = await Promise.all([
    api("/leave/balances"),
    api("/leave/requests"),
    api("/regularizations"),
    api(`/attendance/calendar?month=${month}`),
    api(`/holidays?year=${month.slice(0, 4)}`),
  ]);
  if (id !== renderId) return;
  const days = cal.days || [];
  const colleagues = await api("/directory").catch(() => []);
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    crumb("Leave / My Leave") +
    `<div class="leave-layout"><div class="card"><div class="card-head"><h2>Leave Request</h2><button class="secondary" id="correct">Request attendance correction</button></div>${
      bal.length
        ? `<form id="leave-form" class="form-grid"><label>Please grant me<select name="leave_type_id" required><option value="">-Select-</option>${bal.map((b) => `<option value="${b.leave_type_id}" data-half="${b.allow_half_day ? 1 : 0}">${esc(b.name)}${b.unlimited ? "" : ` (${b.available} available)`}</option>`).join("")}</select></label><label class="check"><input type="checkbox" name="is_half"> Is Half Day</label><label id="half-which" hidden>Which half<select name="half_day"><option value="first">First half</option><option value="second">Second half</option></select></label>${input("from_date", "From", "", 'type="date" required')}<label id="to-wrap">To<input name="to_date" type="date"></label><p class="full muted" id="leave-days">Total Days:</p><label class="full">For the following reason<textarea name="reason" rows="3" maxlength="500"></textarea></label><label class="full">My Address on leave will be<input name="address_on_leave" maxlength="300"></label>${input("contact_on_leave", "Contact No.", "", 'maxlength="20" inputmode="tel"')}<label>In my absence, work handled by<select name="handover_to"><option value="">-Select-</option>${colleagues
            .filter((p) => p.id !== me.id)
            .map(
              (p) =>
                `<option value="${p.id}">${esc(p.name)}${p.employee_code ? ` (${esc(p.employee_code)})` : ""}</option>`,
            )
            .join(
              "",
            )}</select></label><label class="full">Upload Medical Document (optional; PDF, JPG or PNG up to 2 MB)<input type="file" name="medical" accept="application/pdf,image/jpeg,image/png"></label><p class="error-text full" id="leave-error" role="alert"></p><div class="actions full"><button>Submit</button></div></form>`
        : empty("No leave types yet", "HR has not set up leave for your company.")
    }</div><div class="card"><h2>Leave Balance</h2><div class="lb-row"><span>Leave Summary For Year</span><strong>${month.slice(0, 4)}</strong></div>${bal
      .map(
        (b, i) =>
          `<div class="lb-row"><div data-css="color:${LEAVE_DOTS[i % LEAVE_DOTS.length]}"><span class="dot dot-current"></span><span class="lb-name">${esc(b.code ? `${b.code} (${b.name})` : b.name)}</span><small>${b.unlimited ? "No limit" : `${b.available} Leaves`}</small></div><span class="applied">${b.pending || 0} Applied</span></div>`,
      )
      .join(
        "",
      )}<div class="lb-total"><span>Total:</span><span>${bal.filter((b) => !b.unlimited).reduce((n, b) => n + Number(b.available || 0), 0)} Days</span></div></div></div>` +
    `<div class="card"><div class="card-head"><div><h2>${monthLabel(month)}</h2><p class="muted">${cal.payable_days !== undefined ? `Payable days ${cal.payable_days} · Loss of pay ${cal.lop_days}` : ""}</p></div><div class="actions"><button class="secondary" id="prev">←</button><button class="secondary" id="next">→</button></div></div>${calendarGrid(days, month)}</div>` +
    `<div class="card"><h2>My leave requests</h2>${
      reqs.length
        ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th></th></tr></thead><tbody>${reqs.map((r) => `<tr><td>${esc(r.type_name)}<small>${esc(r.reason || "")}</small>${leaveExtras(r)}</td><td>${rangeText(r)}</td><td>${r.days}</td><td>${STATUS_PILL(r.status)}${r.decision_note ? `<small>${esc(r.decision_note)}</small>` : ""}</td><td>${["pending", "approved"].includes(r.status) && (r.status === "pending" || r.from_date > today()) ? `<button class="ghost" data-cancel-leave="${r.id}">Cancel</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : empty("No leave requests", "Requests you make will appear here.")
    }</div>` +
    `<div class="card"><h2>Attendance corrections</h2>${
      regs.length
        ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Times</th><th>Status</th><th></th></tr></thead><tbody>${regs.map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${esc(REG_KINDS[r.kind])}<small>${esc(r.reason)}</small></td><td>${esc([r.in_time, r.out_time].filter(Boolean).join(" – ") || "Standard day")}</td><td>${STATUS_PILL(r.status)}${r.decision_note ? `<small>${esc(r.decision_note)}</small>` : ""}</td><td>${r.status === "pending" ? `<button class="ghost" data-cancel-reg="${r.id}">Cancel</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : empty(
            "No corrections",
            "Missed a punch? Request a correction within the allowed window.",
          )
    }</div>` +
    `<div class="card"><h2>Holidays ${month.slice(0, 4)}</h2>${hol.length ? hol.map((h) => `<div class="kv"><span>${esc(h.name)}${h.optional ? " (optional)" : ""}</span><strong>${fmtDate(h.date)}</strong></div>`).join("") : '<p class="muted">No holidays have been added yet.</p>'}</div>`;
  const go = (n) => () => ((timeOffMonth = shiftMonth(month, n)), render());
  document.querySelector("#prev").onclick = go(-1);
  document.querySelector("#next").onclick = go(1);
  document.querySelector("#correct").onclick = () => correctionDialog();
  const form = document.querySelector("#leave-form");
  if (form) {
    // Calendar days in the range; the server leaves out holidays and weekly offs.
    const count = () => {
      const half = form.is_half.checked;
      const from = form.from_date.value;
      const to = half ? from : form.to_date.value || from;
      const n =
        from && to >= from
          ? Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1
          : 0;
      document.querySelector("#leave-days").textContent =
        `Total Days: ${half ? (from ? 0.5 : 0) : n}${n ? " (holidays and weekly offs in the range are not counted)" : ""}`;
    };
    const halfAllowed = () =>
      form.leave_type_id.selectedOptions[0]?.dataset.half === "1";
    form.onchange = () => {
      if (!halfAllowed()) form.is_half.checked = false;
      form.is_half.disabled = !halfAllowed();
      document.querySelector("#half-which").hidden = !form.is_half.checked;
      document.querySelector("#to-wrap").hidden = form.is_half.checked;
      count();
    };
    form.onchange();
    form.onsubmit = (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      const half = form.is_half.checked;
      busy(e.submitter, async () => {
        try {
          // The document is stored first, then attached to the request.
          const file = form.medical.files[0];
          let documentId = null;
          if (file) {
            if (file.size > 2 * 1024 * 1024)
              throw new Error("The document can be up to 2 MB.");
            if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type))
              throw new Error("Use a PDF, JPG or PNG document.");
            documentId = (
              await api("/documents", {
                kind: "medical",
                name: `Medical, leave from ${f.from_date}`,
                mime: file.type,
                data: await toB64(file),
              })
            ).id;
          }
          const r = await api("/leave/requests", {
            leave_type_id: Number(f.leave_type_id),
            from_date: f.from_date,
            to_date: half ? f.from_date : f.to_date || f.from_date,
            half_day: half ? f.half_day : null,
            reason: f.reason || null,
            address_on_leave: f.address_on_leave || null,
            contact_on_leave: f.contact_on_leave || null,
            handover_to: f.handover_to ? Number(f.handover_to) : null,
            document_id: documentId,
          });
          notice(`Leave request sent for approval: ${r.days} day(s).`);
          await render();
        } catch (err) {
          document.querySelector("#leave-error").textContent = err.message;
        }
      });
    };
  }
  const cancel = (attr, path) =>
    document.querySelectorAll(`[${attr}]`).forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            await api(`${path}/${b.getAttribute(attr)}/cancel`, {});
            notice("Cancelled.");
            await render();
          })),
    );
  cancel("data-cancel-leave", "/leave/requests");
  cancel("data-cancel-reg", "/regularizations");
  await compOffCard(id);
}
function correctionDialog() {
  dialog(
    "Request an attendance correction",
    `${sel("kind", "Type", Object.entries(REG_KINDS))}${input("date", "Date", today(), 'type="date" required')}${input("in_time", "In time", "09:30", 'type="time"')}${input("out_time", "Out time", "18:30", 'type="time"')}<label class="full">Reason<input name="reason" maxlength="500" required></label><p class="full muted">On duty and work-from-home days count as full days; in and out times are optional for them.</p>`,
    async (b) => {
      if (["on_duty", "work_from_home"].includes(b.kind)) {
        if (!b.in_time) delete b.in_time;
        if (!b.out_time) delete b.out_time;
      }
      await api("/regularizations", b);
      notice("Correction requested.");
    },
  );
}

// ---- approvers ---------------------------------------------------------------
function decideDialog(kind, row, decision) {
  dialog(
    `${decision === "approved" ? "Approve" : "Reject"} ${kind === "leave" ? "leave" : "correction"}`,
    `<div class="full muted">${esc(row.employee_name)} · ${kind === "leave" ? `${esc(row.type_name)}, ${rangeText(row)}` : `${esc(REG_KINDS[row.kind])}, ${fmtDate(row.date)}`}</div><label class="full">Note (optional)<input name="note" maxlength="300"></label>`,
    async (b) => {
      await api(
        `/${kind === "leave" ? "leave/requests" : "regularizations"}/${row.id}/decision`,
        { decision, note: b.note || undefined },
      );
      notice(decision === "approved" ? "Approved." : "Rejected.");
      await loadMe();
    },
  );
}
async function approvalsPage(id) {
  const data = await api("/approvals");
  if (id !== renderId) return;
  const buttons = (kind, r) =>
    `<button class="secondary" data-act="approved" data-kind="${kind}" data-id="${r.id}">Approve</button> <button class="ghost" data-act="rejected" data-kind="${kind}" data-id="${r.id}">Reject</button>`;
  document.querySelector("#content").innerHTML =
    heading("Approvals", "Requests from your team waiting for a decision.") +
    `<div class="card"><h2>Leave requests</h2>${
      data.leave.length
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th></th></tr></thead><tbody>${data.leave.map((r) => `<tr><td>${esc(r.employee_name)}<small>${esc(r.employee_code || "")}</small></td><td>${esc(r.type_name)}<small>${esc(r.reason || "")}</small>${leaveExtras(r)}${r.steps > 1 ? `<small>Step ${r.step_number} of ${r.steps}: ${esc(r.step_name)}</small>` : ""}</td><td>${rangeText(r)}</td><td>${r.days}</td><td>${buttons("leave", r)}</td></tr>`).join("")}</tbody></table></div>`
        : empty("Nothing waiting", "No leave requests need your decision.")
    }</div><div class="card"><h2>Attendance corrections</h2>${
      data.regularizations.length
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Date</th><th>Times</th><th></th></tr></thead><tbody>${data.regularizations.map((r) => `<tr><td>${esc(r.employee_name)}<small>${esc(r.employee_code || "")}</small></td><td>${esc(REG_KINDS[r.kind])}<small>${esc(r.reason)}</small>${r.steps > 1 ? `<small>Step ${r.step_number} of ${r.steps}: ${esc(r.step_name)}</small>` : ""}</td><td>${fmtDate(r.date)}</td><td>${esc([r.in_time, r.out_time].filter(Boolean).join(" – ") || "Standard day")}</td><td>${buttons("reg", r)}</td></tr>`).join("")}</tbody></table></div>`
        : empty("Nothing waiting", "No corrections need your decision.")
    }</div>`;
  document.querySelectorAll("[data-act]").forEach(
    (b) =>
      (b.onclick = () => {
        const kind = b.dataset.kind,
          row = (kind === "leave" ? data.leave : data.regularizations).find(
            (r) => r.id === Number(b.dataset.id),
          );
        decideDialog(kind, row, b.dataset.act);
      }),
  );
  await claimsApprovals(id);
  await hiringApprovals(id);
  await compOffApprovals(id);
  await bankChangeApprovals(id);
}

// ---- HR: leave types, holidays, settings, requests, balances ------------------
let leaveAdminTab = "types";
const LA_TABS = {
  types: "Leave types",
  holidays: "Holidays",
  settings: "Calendar & rules",
  requests: "Requests",
  balances: "Balances",
};
const yn = (v) => (v ? "Yes" : "No");
async function leaveAdminPage(id) {
  const tab = leaveAdminTab;
  const html = await leaveAdminTabHtml(tab);
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Leave & holidays",
      "Policies, calendar and balances for your company.",
    ) +
    `<div class="tabbar">${Object.entries(LA_TABS)
      .map(
        ([k, l]) =>
          `<button class="${k === tab ? "" : "secondary"}" data-tab="${k}">${l}</button>`,
      )
      .join("")}</div><div id="tab">${html}</div>`;
  document
    .querySelectorAll("[data-tab]")
    .forEach(
      (b) => (b.onclick = () => ((leaveAdminTab = b.dataset.tab), render())),
    );
  await leaveAdminWire(tab);
}
let holidayYear = null;
async function leaveAdminTabHtml(tab) {
  if (tab === "types") {
    const types = await api("/admin/leave-types");
    leaveAdminCache.types = types;
    return `<div class="card"><div class="card-head"><div><h2>Leave types</h2><p class="muted">Balances accrue per leave year from the year leave was first set up.</p></div><div class="actions"><button class="secondary" id="seed">Add standard Indian types</button><button id="add-type">+ Add leave type</button></div></div>${
      types.length
        ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Paid</th><th>Yearly quota</th><th>Accrual</th><th>Carry forward</th><th>Status</th><th></th></tr></thead><tbody>${types.map((t) => `<tr><td>${esc(t.name)}<small>${esc(t.code)}${t.applicable_gender ? ` · ${esc(t.applicable_gender)} only` : ""}</small></td><td>${yn(t.paid)}</td><td>${t.unlimited ? "Unlimited" : t.quota_per_year}</td><td>${esc(t.accrual)}</td><td>${t.carry_forward_max || "—"}</td><td><span class="pill ${t.active ? "" : "neutral"}">${t.active ? "Active" : "Inactive"}</span></td><td><button class="secondary" data-edit-type="${t.id}">Edit</button></td></tr>`).join("")}</tbody></table></div>`
        : empty(
            "No leave types",
            "Add the standard Indian types to start, then adjust them.",
          )
    }</div>`;
  }
  if (tab === "holidays") {
    holidayYear ||= Number(today().slice(0, 4));
    const list = await api(`/admin/holidays?year=${holidayYear}`);
    return `<div class="card"><div class="card-head"><div><h2>Holidays ${holidayYear}</h2><p class="muted">Holidays and weekly offs are not deducted from leave.</p></div><div class="actions"><button class="secondary" id="hy-prev">←</button><button class="secondary" id="hy-next">→</button><button id="add-holidays">+ Add holidays</button></div></div>${
      list.length
        ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Holiday</th><th>Applies to</th><th></th></tr></thead><tbody>${list.map((h) => `<tr><td>${fmtDate(h.date)}</td><td>${esc(h.name)}${h.optional ? ' <span class="pill neutral">Optional</span>' : ""}</td><td>${esc(h.branch_name || "All branches")}</td><td><button class="ghost" data-del-holiday="${h.id}">Remove</button></td></tr>`).join("")}</tbody></table></div>`
        : empty("No holidays", "Add the year's holidays.")
    }</div>`;
  }
  if (tab === "settings") {
    const s = await api("/admin/leave-settings");
    leaveAdminCache.settings = s;
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return `<div class="card"><h2>Calendar & rules</h2><form id="settings" class="form-grid">${sel(
      "leave_year_start_month",
      "Leave year starts in",
      Array.from({ length: 12 }, (_, i) => [
        i + 1,
        new Date(2000, i, 1).toLocaleString("en", { month: "long" }),
      ]),
      s.leave_year_start_month,
    )}${input("leave_start_year", "First leave year with balances", s.leave_start_year ?? "", 'type="number" min="2000" max="2100"')}<div class="full"><strong>Weekly offs</strong></div><div class="full checks">${days.map((d, i) => `<label class="check"><input type="checkbox" name="wo${i}" ${s.weekly_off_days.includes(i) ? "checked" : ""}> ${d}</label>`).join("")}</div><div class="full"><strong>Saturdays off</strong> <span class="muted">(in addition to the above)</span></div><div class="full checks">${[1, 2, 3, 4, 5].map((n) => `<label class="check"><input type="checkbox" name="sat${n}" ${s.weekly_off_saturdays.includes(n) ? "checked" : ""}> ${["1st", "2nd", "3rd", "4th", "5th"][n - 1]}</label>`).join("")}</div><div class="full"><strong>Attendance</strong></div>${input("attendance_start_date", "Counted from (blank = the day your company started)", s.attendance_start_date || "", 'type="date"')}<div class="full"><strong>Attendance corrections</strong></div>${input("regularization_window_days", "Allowed up to (days back)", s.regularization_window_days, 'type="number" min="0" max="90"')}${input("regularization_monthly_limit", "Per person per month (0 = unlimited)", s.regularization_monthly_limit, 'type="number" min="0" max="31"')}${[
      ["leave_chain", "chain", "Leave approval chain"],
      ["correction_chain", "cchain", "Attendance correction approval chain"],
    ]
      .map(
        ([key, prefix, title]) =>
          `<div class="full"><strong>${title}</strong> <span class="muted">(each step approves in turn; HR can act at any step)</span></div>${[0, 1, 2]
            .map(
              (i) =>
                `<label>Step ${i + 1}<select name="${prefix}${i}">${i ? '<option value="">— None —</option>' : ""}${Object.entries(
                  s.approval_steps,
                )
                  .map(
                    ([k, v]) =>
                      `<option value="${k}" ${s[key][i] === k ? "selected" : ""}>${esc(v)}</option>`,
                  )
                  .join("")}</select></label>`,
            )
            .join("")}`,
      )
      .join("")}${input("approval_reminder_hours", "Remind the approver after (hours)", s.approval_reminder_hours, 'type="number" min="1" max="720"')}${input("approval_escalate_hours", "Escalate to HR after (hours)", s.approval_escalate_hours, 'type="number" min="1" max="720"')}<div class="full form-actions"><button>Save</button></div></form></div>`;
  }
  if (tab === "requests") {
    const q = leaveAdminCache.status ?? "pending";
    const data = await api(
      `/admin/leave/requests?limit=100${q ? `&status=${q}` : ""}`,
    );
    return `<div class="card"><div class="card-head"><h2>Leave requests</h2><label class="inline">Status <select id="req-status">${["", "pending", "approved", "rejected", "cancelled"].map((v) => `<option value="${v}" ${v === q ? "selected" : ""}>${v || "All"}</option>`).join("")}</select></label></div>${
      data.items.length
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th></th></tr></thead><tbody>${data.items.map((r) => `<tr><td>${esc(r.employee_name)}<small>${esc(r.employee_code || "")}</small></td><td>${esc(r.type_name)}</td><td>${rangeText(r)}</td><td>${r.days}</td><td>${STATUS_PILL(r.status)}</td><td>${["pending", "approved"].includes(r.status) ? `<button class="ghost" data-hr-cancel="${r.id}">Cancel</button>` : ""}</td></tr>`).join("")}</tbody></table></div><p class="muted">${data.total} request(s) match.</p>`
        : empty("No requests", "Nothing matches this filter.")
    }</div>`;
  }
  const org = await api("/admin/org");
  leaveAdminCache.people = org.managers;
  return `<div class="card"><h2>Balances</h2><div class="filters"><label>Employee<select id="bal-person">${options(org.managers, leaveAdminCache.person, "Choose…")}</select></label></div><div id="bal-view"></div></div>`;
}
const leaveAdminCache = {};
function typeDialog(t) {
  dialog(
    t ? "Edit leave type" : "Add leave type",
    `${input("name", "Name", t?.name || "", 'maxlength="60" required')}${t ? "" : input("code", "Code", "", 'maxlength="10" required placeholder="CL"')}${sel(
      "paid",
      "Paid",
      [
        ["true", "Paid"],
        ["false", "Unpaid"],
      ],
      String(t ? Boolean(t.paid) : true),
    )}${sel(
      "unlimited",
      "Balance",
      [
        ["false", "Limited (quota)"],
        ["true", "Unlimited"],
      ],
      String(Boolean(t?.unlimited)),
    )}${input("quota_per_year", "Yearly quota (days)", t?.quota_per_year ?? 12, 'type="number" min="0" max="366" step="0.5"')}${sel(
      "accrual",
      "Accrual",
      [
        ["monthly", "Monthly"],
        ["yearly", "Yearly (upfront)"],
      ],
      t?.accrual || "monthly",
    )}${input("carry_forward_max", "Carry forward up to (days)", t?.carry_forward_max ?? 0, 'type="number" min="0" max="366" step="0.5"')}${sel(
      "allow_half_day",
      "Half days",
      [
        ["true", "Allowed"],
        ["false", "Not allowed"],
      ],
      String(t ? Boolean(t.allow_half_day) : true),
    )}${sel(
      "encashable",
      "Can be paid out (encashed)",
      [
        ["false", "No"],
        ["true", "Yes"],
      ],
      String(Boolean(t?.encashable)),
    )}${sel(
      "applicable_gender",
      "Applies to",
      [
        ["", "Everyone"],
        ["female", "Women only"],
        ["male", "Men only"],
        ["other", "Other only"],
      ],
      t?.applicable_gender || "",
    )}${input("max_days_per_request", "Max days per request (optional)", t?.max_days_per_request ?? "", 'type="number" min="0.5" max="366" step="0.5"')}${
      t
        ? sel(
            "active",
            "Status",
            [
              ["true", "Active"],
              ["false", "Inactive"],
            ],
            String(Boolean(t.active)),
          )
        : ""
    }`,
    async (b) => {
      for (const k of [
        "paid",
        "unlimited",
        "allow_half_day",
        "encashable",
        "active",
      ])
        if (k in b) b[k] = b[k] === "true";
      for (const k of ["quota_per_year", "carry_forward_max"])
        b[k] = Number(b[k]);
      b.max_days_per_request = b.max_days_per_request
        ? Number(b.max_days_per_request)
        : null;
      b.applicable_gender ||= null;
      await api(
        t ? `/admin/leave-types/${t.id}` : "/admin/leave-types",
        b,
        t ? "PATCH" : "POST",
      );
      notice("Leave type saved.");
    },
  );
}
async function leaveAdminWire(tab) {
  const on = (sel_, fn) =>
    document.querySelector(sel_)?.addEventListener("click", fn);
  if (tab === "types") {
    on("#add-type", () => typeDialog());
    on("#seed", (e) =>
      busy(e.target, async () => {
        const r = await api("/admin/leave-types/seed-defaults", {});
        notice(
          r.created
            ? `Added ${r.created} leave type(s).`
            : "The standard types already exist.",
        );
        await render();
      }),
    );
    document
      .querySelectorAll("[data-edit-type]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            typeDialog(
              leaveAdminCache.types.find(
                (t) => t.id === Number(b.dataset.editType),
              ),
            )),
      );
  } else if (tab === "holidays") {
    on("#hy-prev", () => ((holidayYear -= 1), render()));
    on("#hy-next", () => ((holidayYear += 1), render()));
    on("#add-holidays", async () => {
      const org = await api("/admin/org");
      dialog(
        "Add holidays",
        `<label class="full">One per line: YYYY-MM-DD, name<textarea name="lines" rows="6" required placeholder="${holidayYear}-01-26, Republic Day&#10;${holidayYear}-08-15, Independence Day"></textarea></label><label class="full">Applies to<select name="branch_id">${options(org.branches, null, "All branches")}</select></label><label class="check full"><input type="checkbox" name="optional"> Optional holidays (people may take them; they still count as working days)</label>`,
        async (b) => {
          const items = b.lines
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const [date, ...name] = l.split(",");
              return { date: date.trim(), name: name.join(",").trim() };
            });
          const r = await api("/admin/holidays", {
            items,
            branch_id: b.branch_id ? Number(b.branch_id) : null,
            optional: "optional" in b,
          });
          notice(`Added ${r.created} holiday(s).`);
        },
      );
    });
    document.querySelectorAll("[data-del-holiday]").forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            await api(
              `/admin/holidays/${b.dataset.delHoliday}`,
              undefined,
              "DELETE",
            );
            notice("Holiday removed.");
            await render();
          })),
    );
  } else if (tab === "settings") {
    document.querySelector("#settings").onsubmit = (e) => {
      e.preventDefault();
      busy(e.submitter, async () => {
        const f = new FormData(e.target);
        const body = {
          leave_year_start_month: Number(f.get("leave_year_start_month")),
          weekly_off_days: [0, 1, 2, 3, 4, 5, 6].filter((i) => f.get(`wo${i}`)),
          weekly_off_saturdays: [1, 2, 3, 4, 5].filter((i) => f.get(`sat${i}`)),
          regularization_window_days: Number(
            f.get("regularization_window_days"),
          ),
          regularization_monthly_limit: Number(
            f.get("regularization_monthly_limit"),
          ),
          leave_chain: [0, 1, 2]
            .map((i) => f.get(`chain${i}`))
            .filter(Boolean),
          correction_chain: [0, 1, 2]
            .map((i) => f.get(`cchain${i}`))
            .filter(Boolean),
          approval_reminder_hours: Number(f.get("approval_reminder_hours")),
          approval_escalate_hours: Number(f.get("approval_escalate_hours")),
        };
        if (f.get("leave_start_year"))
          body.leave_start_year = Number(f.get("leave_start_year"));
        body.attendance_start_date = f.get("attendance_start_date") || null;
        await api("/admin/leave-settings", body, "PATCH");
        notice("Settings saved.");
      });
    };
  } else if (tab === "requests") {
    document.querySelector("#req-status").onchange = (e) => (
      (leaveAdminCache.status = e.target.value),
      render()
    );
    document.querySelectorAll("[data-hr-cancel]").forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            await api(`/leave/requests/${b.dataset.hrCancel}/cancel`, {});
            notice("Cancelled.");
            await render();
          })),
    );
  } else {
    const view = async () => {
      const personId = Number(document.querySelector("#bal-person").value);
      leaveAdminCache.person = personId || null;
      const box = document.querySelector("#bal-view");
      if (!personId) return (box.innerHTML = "");
      const data = await api(`/admin/employees/${personId}/leave`);
      box.innerHTML = `<div class="stats">${data.balances.map((b) => `<div class="stat"><div class="stat-label">${esc(b.name)}</div><div class="stat-value">${b.unlimited ? "∞" : b.balance}</div><small>${b.pending ? `${b.pending} pending` : esc(b.code)}</small></div>`).join("")}</div><div class="actions"><button id="adjust">Adjust balance</button></div><h3>Recent entries</h3>${data.ledger.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Type</th><th>Entry</th><th>Days</th><th>Note</th></tr></thead><tbody>${data.ledger.map((l) => `<tr><td>${time(l.created_at)}</td><td>${esc(l.code)}</td><td>${esc(l.kind.replace("_", " "))}</td><td>${l.days > 0 ? "+" : ""}${l.days}</td><td>${esc(l.note || "")}</td></tr>`).join("")}</tbody></table></div>` : empty("No entries", "Balances appear once leave types exist.")}`;
      document.querySelector("#adjust").onclick = () =>
        dialog(
          "Adjust balance",
          `${sel(
            "leave_type_id",
            "Leave type",
            data.balances
              .filter((b) => !b.unlimited)
              .map((b) => [b.leave_type_id, b.name]),
          )}${input("days", "Days (negative to deduct)", "", 'type="number" step="0.5" required')}<label class="full">Reason<input name="note" maxlength="300" required></label>`,
          async (b) => {
            await api("/admin/leave/adjust", {
              user_id: personId,
              leave_type_id: Number(b.leave_type_id),
              days: Number(b.days),
              note: b.note,
            });
            notice("Balance adjusted.");
          },
        );
    };
    document.querySelector("#bal-person").onchange = () =>
      busy(document.querySelector("#bal-person"), view);
    if (leaveAdminCache.person) await view();
  }
}

// ---- HR: monthly muster ------------------------------------------------------
let musterMonth = null;
async function musterPage(id) {
  musterMonth ||= thisMonth();
  const m = musterMonth;
  const data = await api(`/admin/attendance-summary?month=${m}`);
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Monthly muster",
      "Payable and loss-of-pay days from attendance, leave, holidays and weekly offs.",
      `<div class="actions"><button class="secondary" id="m-prev">←</button><button class="secondary" id="m-next">→</button><button class="secondary" id="m-export">↓ Export CSV</button></div>`,
    ) +
    `<div class="card"><h2>${monthLabel(m)}</h2>${
      data.people.length
        ? '<div id="muster-list"></div>'
        : empty("No employees", "Add employees to see their muster.")
    }</div><p class="muted">Today is not counted until the day has attendance or leave. Pending leave is not counted as leave.</p>`;
  const list = document.querySelector("#muster-list");
  if (list)
    pagedList(list, data.people, {
      head: "<tr><th>Employee</th><th>Present</th><th>Half days</th><th>Paid leave</th><th>Unpaid leave</th><th>Holidays</th><th>Weekly offs</th><th>Absent</th><th>Payable</th><th>Loss of pay</th></tr>",
      row: (p) =>
        `<tr><td>${esc(p.name)}<small>${esc(p.employee_code || "")} · ${esc(p.department_name || "")}</small></td><td>${p.present}</td><td>${p.half_days}</td><td>${p.leave_paid}</td><td>${p.leave_unpaid}</td><td>${p.holidays}</td><td>${p.weekly_offs}</td><td>${p.absent}</td><td><strong>${p.payable_days}</strong></td><td>${p.lop_days}</td></tr>`,
      text: (p) => `${p.name} ${p.employee_code || ""} ${p.department_name || ""}`,
      label: "people",
    });
  const go = (n) => () => ((musterMonth = shiftMonth(m, n)), render());
  document.querySelector("#m-prev").onclick = go(-1);
  document.querySelector("#m-next").onclick = go(1);
  document.querySelector("#m-export").onclick = (e) =>
    busy(e.target, () =>
      download(
        `/admin/attendance-summary/export?month=${m}`,
        `muster-${m}.csv`,
      ),
    );
}
