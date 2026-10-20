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
  document.querySelector("#content").innerHTML =
    heading(
      "Time off",
      "Leave balances, your calendar and attendance corrections.",
      `<div class="actions"><button id="apply">Apply for leave</button><button class="secondary" id="correct">Request correction</button></div>`,
    ) +
    (bal.length
      ? `<div class="stats">${bal.map((b) => `<div class="stat"><div class="stat-label">${esc(b.name)}</div><div class="stat-value">${b.unlimited ? "∞" : b.available}</div><small>${b.unlimited ? "Unpaid, no limit" : `${b.balance} balance${b.pending ? ` · ${b.pending} pending` : ""}`}</small></div>`).join("")}</div>`
      : `<div class="card">${empty("No leave types yet", "HR has not set up leave for your company.")}</div>`) +
    `<div class="card"><div class="card-head"><div><h2>${monthLabel(month)}</h2><p class="muted">${cal.payable_days !== undefined ? `Payable days ${cal.payable_days} · Loss of pay ${cal.lop_days}` : ""}</p></div><div class="actions"><button class="secondary" id="prev">←</button><button class="secondary" id="next">→</button></div></div>${calendarGrid(days, month)}</div>` +
    `<div class="card"><h2>My leave requests</h2>${
      reqs.length
        ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th></th></tr></thead><tbody>${reqs.map((r) => `<tr><td>${esc(r.type_name)}<small>${esc(r.reason || "")}</small></td><td>${rangeText(r)}</td><td>${r.days}</td><td>${STATUS_PILL(r.status)}${r.decision_note ? `<small>${esc(r.decision_note)}</small>` : ""}</td><td>${["pending", "approved"].includes(r.status) && (r.status === "pending" || r.from_date > today()) ? `<button class="ghost" data-cancel-leave="${r.id}">Cancel</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
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
    `<div class="card"><h2>Holidays ${month.slice(0, 4)}</h2>${hol.length ? hol.map((h) => `<div class="kv"><span>${esc(h.name)}</span><strong>${fmtDate(h.date)}</strong></div>`).join("") : '<p class="muted">No holidays have been added yet.</p>'}</div>`;
  const go = (n) => () => ((timeOffMonth = shiftMonth(month, n)), render());
  document.querySelector("#prev").onclick = go(-1);
  document.querySelector("#next").onclick = go(1);
  document.querySelector("#apply").onclick = () => applyLeaveDialog(bal);
  document.querySelector("#correct").onclick = () => correctionDialog();
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
function applyLeaveDialog(bal) {
  if (!bal.length) return notice("No leave types are available yet.", true);
  dialog(
    "Apply for leave",
    `${sel(
      "leave_type_id",
      "Leave type",
      bal.map((b) => [
        b.leave_type_id,
        `${b.name}${b.unlimited ? "" : ` (${b.available} available)`}`,
      ]),
    )}${sel("half_day", "Duration", [
      ["", "Full day(s)"],
      ["first", "Half day — first half"],
      ["second", "Half day — second half"],
    ])}${input("from_date", "From", today(), 'type="date" required')}${input("to_date", "To (leave blank for one day)", "", 'type="date"')}<label class="full">Reason<input name="reason" maxlength="500"></label>`,
    async (b) => {
      b.leave_type_id = Number(b.leave_type_id);
      b.half_day ||= null;
      if (!b.to_date) b.to_date = b.from_date;
      const r = await api("/leave/requests", b);
      notice(`Request sent for ${r.days} day(s).`);
    },
  );
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
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Dates</th><th>Days</th><th></th></tr></thead><tbody>${data.leave.map((r) => `<tr><td>${esc(r.employee_name)}<small>${esc(r.employee_code || "")}</small></td><td>${esc(r.type_name)}<small>${esc(r.reason || "")}</small></td><td>${rangeText(r)}</td><td>${r.days}</td><td>${buttons("leave", r)}</td></tr>`).join("")}</tbody></table></div>`
        : empty("Nothing waiting", "No leave requests need your decision.")
    }</div><div class="card"><h2>Attendance corrections</h2>${
      data.regularizations.length
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Date</th><th>Times</th><th></th></tr></thead><tbody>${data.regularizations.map((r) => `<tr><td>${esc(r.employee_name)}<small>${esc(r.employee_code || "")}</small></td><td>${esc(REG_KINDS[r.kind])}<small>${esc(r.reason)}</small></td><td>${fmtDate(r.date)}</td><td>${esc([r.in_time, r.out_time].filter(Boolean).join(" – ") || "Standard day")}</td><td>${buttons("reg", r)}</td></tr>`).join("")}</tbody></table></div>`
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
        ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Holiday</th><th>Applies to</th><th></th></tr></thead><tbody>${list.map((h) => `<tr><td>${fmtDate(h.date)}</td><td>${esc(h.name)}</td><td>${esc(h.branch_name || "All branches")}</td><td><button class="ghost" data-del-holiday="${h.id}">Remove</button></td></tr>`).join("")}</tbody></table></div>`
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
    )}${input("leave_start_year", "First leave year with balances", s.leave_start_year ?? "", 'type="number" min="2000" max="2100"')}<div class="full"><strong>Weekly offs</strong></div><div class="full checks">${days.map((d, i) => `<label class="check"><input type="checkbox" name="wo${i}" ${s.weekly_off_days.includes(i) ? "checked" : ""}> ${d}</label>`).join("")}</div><div class="full"><strong>Saturdays off</strong> <span class="muted">(in addition to the above)</span></div><div class="full checks">${[1, 2, 3, 4, 5].map((n) => `<label class="check"><input type="checkbox" name="sat${n}" ${s.weekly_off_saturdays.includes(n) ? "checked" : ""}> ${["1st", "2nd", "3rd", "4th", "5th"][n - 1]}</label>`).join("")}</div><div class="full"><strong>Attendance</strong></div>${input("attendance_start_date", "Counted from (blank = the day your company started)", s.attendance_start_date || "", 'type="date"')}<div class="full"><strong>Attendance corrections</strong></div>${input("regularization_window_days", "Allowed up to (days back)", s.regularization_window_days, 'type="number" min="0" max="90"')}${input("regularization_monthly_limit", "Per person per month (0 = unlimited)", s.regularization_monthly_limit, 'type="number" min="0" max="31"')}<div class="full form-actions"><button>Save</button></div></form></div>`;
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
        `<label class="full">One per line: YYYY-MM-DD, name<textarea name="lines" rows="6" required placeholder="${holidayYear}-01-26, Republic Day&#10;${holidayYear}-08-15, Independence Day"></textarea></label><label class="full">Applies to<select name="branch_id">${options(org.branches, null, "All branches")}</select></label>`,
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
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Present</th><th>Half days</th><th>Paid leave</th><th>Unpaid leave</th><th>Holidays</th><th>Weekly offs</th><th>Absent</th><th>Payable</th><th>Loss of pay</th></tr></thead><tbody>${data.people.map((p) => `<tr><td>${esc(p.name)}<small>${esc(p.employee_code || "")} · ${esc(p.department_name || "")}</small></td><td>${p.present}</td><td>${p.half_days}</td><td>${p.leave_paid}</td><td>${p.leave_unpaid}</td><td>${p.holidays}</td><td>${p.weekly_offs}</td><td>${p.absent}</td><td><strong>${p.payable_days}</strong></td><td>${p.lop_days}</td></tr>`).join("")}</tbody></table></div>`
        : empty("No employees", "Add employees to see their muster.")
    }</div><p class="muted">Today is not counted until the day has attendance or leave. Pending leave is not counted as leave.</p>`;
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
