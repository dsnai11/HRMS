// Directory, referrals, career changes, selfie evidence, tax statement, password reset.
const CHANGE_KIND = {
  promotion: "Promotion",
  transfer: "Transfer",
  increment: "Increment",
  confirmation: "Confirmation",
};

// ---- directory ---------------------------------------------------------------------------------
async function directoryPage(id) {
  const rows = await api("/directory");
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading("Directory", "Find colleagues and their contact details.") +
    `<div class="card"><input id="dir-q" type="search" placeholder="Search by name, code, designation or department" aria-label="Search"><div id="dir-list"></div></div>`;
  const draw = (list) => {
    const box = document.querySelector("#dir-list");
    if (!box) return; // the person moved to another page while the search ran
    box.innerHTML = list.length
      ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Designation</th><th>Department</th><th>Branch</th><th>Contact</th></tr></thead><tbody>${list.map((p) => `<tr><td><div class="person"><span class="avatar">${initials(p.name)}</span><div>${esc(p.name)}<small>${esc(p.employee_code || "")}</small></div></div></td><td>${esc(p.designation_name || "—")}</td><td>${esc(p.department_name || "—")}</td><td>${esc(p.branch_name || "—")}</td><td>${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ""}<small>${esc(p.email)}</small></td></tr>`).join("")}</tbody></table></div>`
      : empty("Nobody found", "Try a different search.");
  };
  draw(rows);
  let timer;
  document.querySelector("#dir-q").oninput = (e) => {
    clearTimeout(timer);
    timer = setTimeout(
      async () =>
        draw(await api(`/directory?q=${encodeURIComponent(e.target.value)}`)),
      250,
    );
  };
}

// ---- referrals ---------------------------------------------------------------------------------
async function referPage(id) {
  const [openings, mine] = await Promise.all([
    api("/openings/open"),
    api("/referrals"),
  ]);
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Refer a candidate",
      "Know someone who would be a good fit? Send their details to HR.",
      '<button id="new-ref">Refer someone</button>',
    ) +
    `<div class="card"><h2>Open positions</h2>${openings.length ? openings.map((o) => `<div class="activity"><strong>${esc(o.title)}</strong> · ${o.positions} position(s)<br><small>${esc([o.department_name, o.branch_name].filter(Boolean).join(" · ") || "")}</small></div>`).join("") : empty("No open positions", "HR has no openings right now. You can still refer someone.")}</div><div class="card"><h2>My referrals</h2>${mine.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Position</th><th>Status</th></tr></thead><tbody>${mine.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.opening_title || "—")}</td><td>${stagePill(r.stage)}</td></tr>`).join("")}</tbody></table></div>` : empty("No referrals yet", "People you refer and where they are in the process appear here.")}</div>`;
  document.querySelector("#new-ref").onclick = () =>
    dialog(
      "Refer someone",
      `${input("name", "Name", "", "required maxlength=100")}${input("email", "Email", "", 'type="email"')}${input("phone", "Phone")}<label>Position<select name="opening_id"><option value="">— Any —</option>${openings.map((o) => `<option value="${o.id}">${esc(o.title)}</option>`).join("")}</select></label><label class="full">Why are they a good fit?<input name="note" maxlength="1000"></label>`,
      async (b) => {
        const body = { name: b.name, note: b.note || undefined };
        if (b.email) body.email = b.email;
        if (b.phone) body.phone = b.phone;
        if (b.opening_id) body.opening_id = Number(b.opening_id);
        await api("/referrals", body);
        notice("Thank you. HR has been told.");
      },
    );
}

// ---- career changes (HR tab) -----------------------------------------------------------------------
async function changesHtml() {
  const rows = await api("/admin/changes");
  return `<div class="card"><div class="card-head"><div><h2>Promotions, transfers and increments</h2><p class="muted">A change takes effect on its date. Apply it when due; the profile and salary update and the employee is told.</p></div><button id="new-change">New change</button></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Effective</th><th>Details</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((c) => `<tr><td>${esc(c.employee_name)}<small>${esc(c.employee_code || "")}</small></td><td>${CHANGE_KIND[c.kind]}</td><td>${fmtDate(c.effective_date)}</td><td>${[c.designation_name, c.department_name, c.branch_name, c.manager_name && `reports to ${c.manager_name}`, c.monthly_gross && `${inr(c.monthly_gross)} a month`].filter(Boolean).map(esc).join(" · ") || "—"}</td><td><span class="pill ${c.status === "pending" ? "" : "neutral"}">${c.status}</span></td><td>${c.status === "pending" ? `<button class="secondary" data-apply-change="${c.id}" ${c.effective_date > today() ? 'disabled title="Not due yet"' : ""}>Apply</button> <button class="ghost" data-cancel-change="${c.id}">Cancel</button>` : ""} <a class="button secondary" target="_blank" rel="noopener" href="/letter.html?type=change&id=${c.id}">Letter</a></td></tr>`).join("")}</tbody></table></div>`
      : empty(
          "No changes",
          "Record a promotion, transfer, increment or confirmation.",
        )
  }</div>`;
}
function changesWire() {
  document.querySelectorAll("[data-apply-change]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/admin/changes/${b.dataset.applyChange}/apply`, {});
          notice("Applied.");
          render();
        })),
  );
  document.querySelectorAll("[data-cancel-change]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/admin/changes/${b.dataset.cancelChange}/cancel`, {});
          render();
        })),
  );
  document.querySelector("#new-change")?.addEventListener("click", async () => {
    const [{ departments, branches, designations, workplaces }, people] =
      await Promise.all([api("/admin/org"), peopleList()]);
    const pick = (name, label, list) =>
      `<label>${label}<select name="${name}">${options(list, null, "— No change —")}</select></label>`;
    dialog(
      "New change",
      `${personSel("user_id", "Employee", people)}${sel("kind", "Type", Object.entries(CHANGE_KIND))}${input("effective_date", "Effective date", today(), 'type="date" required')}${pick("designation_id", "New designation (promotion)", designations)}${pick("department_id", "New department", departments)}${pick("branch_id", "New branch", branches)}${pick("manager_id", "New reporting manager", people)}${pick("workplace_id", "New workplace (for punching)", workplaces)}${input("monthly_gross", "New monthly gross, ₹ (increment)", "", 'type="number" min="1"')}<label class="full">Note for the letter<input name="note" maxlength="500"></label>`,
      async (b) => {
        const body = {
          user_id: Number(b.user_id),
          kind: b.kind,
          effective_date: b.effective_date,
          note: b.note || undefined,
        };
        for (const k of [
          "designation_id",
          "department_id",
          "branch_id",
          "manager_id",
          "workplace_id",
        ])
          if (b[k]) body[k] = Number(b[k]);
        if (b.monthly_gross) body.monthly_gross = Number(b.monthly_gross);
        await api("/admin/changes", body);
        notice("Recorded.");
      },
    );
  });
}
async function myChangesCard(id) {
  const rows = await api("/my-changes");
  if (id !== renderId || !rows.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>My career history</h2>${rows.map((c) => `<div class="activity"><strong>${CHANGE_KIND[c.kind]}</strong> · ${fmtDate(c.effective_date)}<br><small>${[c.designation_name, c.department_name, c.branch_name, c.monthly_gross && "salary revised"].filter(Boolean).map(esc).join(" · ")}</small></div>`).join("")}`;
  document.querySelector("#content").append(card);
}

// ---- selfie evidence -----------------------------------------------------------------------------------
document.addEventListener("click", async (e) => {
  const b = e.target.closest?.("[data-selfie]");
  if (!b) return;
  const shift = b.dataset.selfie;
  const images = [];
  for (const kind of ["in", "out"]) {
    const res = await fetch(`/api/admin/shifts/${shift}/selfie?kind=${kind}`, {
      headers: activeCompany ? { "X-Company-Id": String(activeCompany) } : {},
    });
    if (res.ok) images.push([kind, URL.createObjectURL(await res.blob())]);
  }
  viewDialog(
    "Punch selfies",
    images.length
      ? `<div class="selfies">${images.map(([k, u]) => `<figure><img src="${u}" alt="Selfie at punch ${k}"><figcaption>Punch ${k}</figcaption></figure>`).join("")}</div>`
      : empty("No selfie", "No selfie was taken for this shift."),
  );
});
async function selfieSettingCard(id) {
  if (!has("org.manage")) return;
  const s = await api("/admin/attendance-settings");
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Selfie at punch</h2><p class="muted">When on, the phone app asks for a selfie with every punch, and HR can see it in Attendance records. It helps against someone punching for a colleague.</p><label class="check"><input type="checkbox" id="selfie-on" ${s.require_selfie ? "checked" : ""}> Require a selfie to punch in and out</label><div class="actions"><label>Oldest app version allowed to punch<input id="min-version" value="${esc(s.min_app_version || "")}" placeholder="e.g. 1.2.0 (blank = any)" maxlength="12"></label><button class="secondary" id="min-save">Save</button></div>`;
  document.querySelector("#content").append(card);
  card.querySelector("#min-save").onclick = () =>
    busy(card.querySelector("#min-save"), async () => {
      await api(
        "/admin/attendance-settings",
        {
          min_app_version:
            card.querySelector("#min-version").value.trim() || null,
        },
        "PATCH",
      );
      notice("Saved. Phones on an older version can no longer punch.");
    });
  card.querySelector("#selfie-on").onchange = async (e) => {
    await api(
      "/admin/attendance-settings",
      { require_selfie: e.target.checked },
      "PATCH",
    );
    notice(
      e.target.checked
        ? "Selfies are now required. Phones need the latest app."
        : "Selfies are no longer required.",
    );
  };
}

// ---- tax statement on the payslips page ------------------------------------------------------------------
async function taxStatementCard(id) {
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  const y = taxYearStart();
  card.innerHTML = `<div class="card-head"><div><h2>Annual tax statement</h2><p class="muted">Your salary, tax deducted and provident fund for a financial year, from approved payroll. For your tax return (Form 130/Form 16 comes from your employer's filing).</p></div><div class="actions"><select id="tax-year">${[y, y - 1, y - 2].map((v) => `<option value="${v}">${v}-${String(v + 1).slice(2)}</option>`).join("")}</select><button class="secondary" id="tax-show">Show</button></div></div>`;
  document.querySelector("#content").append(card);
  card.querySelector("#tax-show").onclick = async () => {
    const d = await api(
      `/my/tax-statement?year=${card.querySelector("#tax-year").value}`,
    );
    viewDialog(
      `Tax statement ${d.year}-${String(d.year + 1).slice(2)}`,
      d.months.length
        ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Gross</th><th>Taxable</th><th>PF</th><th>PT</th><th>Tax deducted</th></tr></thead><tbody>${d.months.map((m) => `<tr><td>${monthLabel(m.month)}</td><td>${inr(m.gross)}</td><td>${inr(m.taxable)}</td><td>${inr(m.pf)}</td><td>${inr(m.pt)}</td><td>${inr(m.tds)}</td></tr>`).join("")}</tbody><tfoot><tr><td>Total${d.opening ? " (with earlier employer or opening balance)" : ""}</td><td>${inr(d.totals.gross)}</td><td>${inr(d.totals.taxable)}</td><td>${inr(d.totals.pf)}</td><td>${inr(d.totals.pt)}</td><td>${inr(d.totals.tds)}</td></tr></tfoot></table></div>`
        : empty("No payroll yet", "Nothing approved for that year."),
    );
  };
}

// ---- forgot / reset password ----------------------------------------------------------------------------------
function forgotDialog(e) {
  e?.preventDefault();
  dialog(
    "Forgot your password?",
    `<p class="full muted">Enter your work email. If email is set up, you will get a link to choose a new password. Otherwise ask HR to reset it.</p>${input("email", "Email address", "", 'type="email" required')}`,
    async (b) => {
      const r = await api("/forgot-password", { email: b.email });
      notice(r.message);
    },
  );
}
function resetFromLink() {
  const token = new URLSearchParams(location.search).get("reset");
  if (!token) return false;
  app.innerHTML = `<div class="login"><section class="login-story">${brand()}<div><h1>Choose a new password</h1><p>Use at least 10 characters.</p></div></section><section class="login-panel"><form id="reset"><label>New password<input type="password" name="password" minlength="10" autocomplete="new-password" required></label><button>Save password</button></form></section></div>`;
  document.querySelector("#reset").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api("/reset-password", {
        token,
        password: new FormData(e.target).get("password"),
      });
      history.replaceState(null, "", "/");
      notice("Password changed. Sign in with your new password.");
      login();
    });
  };
  return true;
}

// ---- shift policies (Workplaces page) -----------------------------------------------------------------
async function shiftPolicyCard(id) {
  if (!has("org.read")) return;
  const rows = await api("/admin/shift-policies");
  if (id !== renderId) return;
  const manage = has("org.manage");
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="card-head"><div><h2>Shift rules</h2><p class="muted">Punch in by the start time plus grace, work the full hours and not before the earliest punch-out, or the day is a half day. A rule on an employee beats their branch, which beats the company default; with none, the server default (9:30, 15 minutes, 9 hours, 6:30 pm) applies.</p></div>${manage ? '<div class="actions"><button class="secondary" id="assign-policy">Assign</button><button id="new-policy">New rule</button></div>' : ""}</div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Start</th><th>Grace</th><th>Hours</th><th>Earliest out</th><th>Used by</th><th></th></tr></thead><tbody>${rows.map((p) => `<tr><td>${esc(p.name)}${p.is_default ? ' <span class="pill">Company default</span>' : ""}</td><td>${p.start_time}</td><td>${p.grace_minutes} min</td><td>${p.hours}</td><td>${p.earliest_out}</td><td>${p.employees} people · ${p.branches} branches</td><td>${manage ? `<button class="ghost" data-edit-policy="${p.id}">Edit</button> <button class="ghost" data-del-policy="${p.id}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : empty(
          "Using the server default",
          "Add a rule to change the times for a branch, a person or everyone.",
        )
  }`;
  document.querySelector("#content").append(card);
  const fieldsHtml = (p = {}) =>
    `${input("name", "Name", p.name || "", "required maxlength=60")}${input("start_time", "Start time", p.start_time || "09:30", 'type="time" required')}${input("grace_minutes", "Grace (minutes)", p.grace_minutes ?? 15, 'type="number" min="0" max="240"')}${input("hours", "Shift hours", p.hours ?? 9, 'type="number" min="1" max="16" step="0.5"')}${input("earliest_out", "Earliest punch-out", p.earliest_out || "18:30", 'type="time" required')}`;
  const body = (b) => ({
    name: b.name,
    start_time: b.start_time,
    grace_minutes: Number(b.grace_minutes),
    hours: Number(b.hours),
    earliest_out: b.earliest_out,
  });
  card.querySelector("#new-policy")?.addEventListener("click", () =>
    dialog("New shift rule", fieldsHtml(), async (b) => {
      await api("/admin/shift-policies", body(b));
      notice("Saved.");
    }),
  );
  card.querySelectorAll("[data-edit-policy]").forEach(
    (b) =>
      (b.onclick = () => {
        const p = rows.find((x) => x.id === Number(b.dataset.editPolicy));
        dialog(`Edit ${p.name}`, fieldsHtml(p), async (f) => {
          await api(`/admin/shift-policies/${p.id}`, body(f), "PATCH");
          notice("Saved. It applies to punches from now on.");
        });
      }),
  );
  card.querySelectorAll("[data-del-policy]").forEach(
    (b) =>
      (b.onclick = async () => {
        if (
          !confirm(
            "Remove this rule? People using it go back to the next level.",
          )
        )
          return;
        await api(
          `/admin/shift-policies/${b.dataset.delPolicy}`,
          undefined,
          "DELETE",
        );
        render();
      }),
  );
  card.querySelector("#assign-policy")?.addEventListener("click", async () => {
    const [org, people] = await Promise.all([api("/admin/org"), peopleList()]);
    dialog(
      "Assign a shift rule",
      `${sel("target", "Applies to", [
        ["company", "Whole company (default)"],
        ["branch", "One branch"],
        ["employee", "One employee"],
      ])}<label>Branch<select name="branch">${options(org.branches, null, "—")}</select></label><label>Employee<select name="employee">${options(people, null, "—")}</select></label>${sel("policy_id", "Rule", [["", "Remove the rule (use the next level)"], ...rows.map((p) => [p.id, p.name])])}`,
      async (b) => {
        const target = b.target;
        const body2 = {
          target,
          policy_id: b.policy_id ? Number(b.policy_id) : null,
        };
        if (target === "branch") body2.id = Number(b.branch);
        if (target === "employee") body2.id = Number(b.employee);
        if (target !== "company" && !body2.id)
          throw new Error("Choose who it applies to.");
        await api("/admin/shift-policies/assign", body2);
        notice("Assigned.");
      },
    );
  });
}

// ---- attendance import (biometric or another system) ---------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [],
    cell = "",
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((cell += '"'), i++);
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}
async function importCard(id) {
  if (!has("attendance.import")) return;
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="card-head"><div><h2>Import attendance</h2><p class="muted">Bring in attendance from a biometric machine or another system. Use a CSV with the columns employee_code, date (YYYY-MM-DD), in_time and out_time (HH:MM). Days that already have attendance are skipped; late and early rules apply as usual.</p></div><button id="import-csv">Choose a CSV file</button></div><input type="file" id="import-file" accept=".csv,text/csv" hidden>`;
  document.querySelector("#content").append(card);
  const file = card.querySelector("#import-file");
  card.querySelector("#import-csv").onclick = () => file.click();
  file.onchange = async () => {
    const f = file.files[0];
    if (!f) return;
    const table = parseCsv(await f.text());
    const head =
      table.shift()?.map((h) =>
        h
          .trim()
          .toLowerCase()
          .replace(/[^a-z]+/g, "_"),
      ) ?? [];
    const col = (...names) => head.findIndex((h) => names.includes(h));
    const [ci, di, ii, oi] = [
      col("employee_code", "code", "emp_code"),
      col("date"),
      col("in_time", "in", "punch_in"),
      col("out_time", "out", "punch_out"),
    ];
    if ([ci, di, ii, oi].some((x) => x < 0))
      return notice(
        "The first row must have the columns employee_code, date, in_time and out_time.",
        true,
      );
    const rows = table.map((r) => ({
      employee_code: (r[ci] || "").trim(),
      date: (r[di] || "").trim(),
      in_time: (r[ii] || "").trim().slice(0, 5),
      out_time: (r[oi] || "").trim().slice(0, 5),
    }));
    try {
      const dry = await api("/admin/attendance/import", {
        rows,
        dry_run: true,
        source: f.name.slice(0, 40),
      });
      viewDialog(
        "Check before importing",
        `<p>${dry.would_import} row(s) will be imported and ${dry.skipped} skipped.</p>${
          dry.report.length
            ? `<div class="table-wrap"><table><thead><tr><th>Line</th><th>Employee</th><th>Date</th><th>Why skipped</th></tr></thead><tbody>${dry.report
                .slice(0, 50)
                .map(
                  (r) =>
                    `<tr><td>${r.line}</td><td>${esc(r.code)}</td><td>${esc(r.date)}</td><td>${esc(r.reason)}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : ""
        }${dry.would_import ? '<div class="actions"><button id="confirm-import">Import now</button></div>' : ""}`,
      );
      document
        .querySelector("dialog #confirm-import")
        ?.addEventListener("click", (e) =>
          busy(e.target, async () => {
            const done = await api("/admin/attendance/import", {
              rows,
              source: f.name.slice(0, 40),
            });
            document.querySelector("dialog")?.remove();
            notice(`Imported ${done.imported} day(s).`);
          }),
        );
    } catch (e) {
      notice(e.message, true);
    }
    file.value = "";
  };
}

// ---- roster ---------------------------------------------------------------------------------------------------
const ROSTER_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const mondayOf = (d) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};
const addDaysTo = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
async function rosterCard(id) {
  if (!has("org.read")) return;
  const card = document.createElement("div");
  card.className = "card";
  document.querySelector("#content").append(card);
  let start = mondayOf(today());
  const draw = async () => {
    const days = Array.from({ length: 7 }, (_, i) => addDaysTo(start, i));
    const [rows, policies] = await Promise.all([
      api(`/admin/roster?from=${days[0]}&to=${days[6]}`),
      api("/admin/shift-policies"),
    ]);
    if (id !== renderId) return;
    const people = [
      ...new Map(rows.map((r) => [r.user_id, r.employee_name])).entries(),
    ];
    const cell = (uid, d) => {
      const r = rows.find((x) => x.user_id === uid && x.date === d);
      return r
        ? r.off
          ? '<span class="pill neutral">Off</span>'
          : esc(r.policy_name || "")
        : "—";
    };
    card.innerHTML = `<div class="card-head"><div><h2>Roster</h2><p class="muted">Give people a different shift, or a rest day, on particular dates. It beats their standing shift rule and the weekly off. A rostered working day on a Sunday counts as a working day.</p></div>${has("org.manage") ? '<button id="set-roster">Set roster</button>' : ""}</div><div class="actions"><button class="ghost" id="r-prev">← Previous week</button><strong>${fmtDate(days[0])} – ${fmtDate(days[6])}</strong><button class="ghost" id="r-next">Next week →</button></div>${people.length ? `<div class="table-wrap"><table><thead><tr><th>Employee</th>${days.map((d) => `<th>${ROSTER_DAYS[new Date(`${d}T00:00:00Z`).getUTCDay()]} ${d.slice(8)}</th>`).join("")}</tr></thead><tbody>${people.map(([uid, name]) => `<tr><td>${esc(name)}</td>${days.map((d) => `<td>${cell(uid, d)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>` : empty("Nothing rostered this week", "People follow their standing shift rule and the company's weekly off.")}`;
    card.querySelector("#r-prev").onclick = () => (
      (start = addDaysTo(start, -7)),
      draw()
    );
    card.querySelector("#r-next").onclick = () => (
      (start = addDaysTo(start, 7)),
      draw()
    );
    card.querySelector("#set-roster")?.addEventListener("click", async () => {
      const staff = (await api("/admin/employees?limit=200&active=1")).items;
      dialog(
        "Set roster",
        `<div class="full"><div class="check-grid">${staff.map((p) => `<label class="check"><input type="checkbox" name="u${p.id}"> ${esc(p.name)}</label>`).join("")}</div></div>${input("from", "From", days[0], 'type="date" required')}${input("to", "To", days[6], 'type="date" required')}${sel(
          "what",
          "Set to",
          [
            ["policy", "A shift rule"],
            ["off", "Rest day"],
            ["clear", "Clear the roster"],
          ],
        )}${sel(
          "policy_id",
          "Shift rule",
          policies.map((p) => [
            p.id,
            `${p.name} (${p.start_time}–${p.earliest_out})`,
          ]),
        )}<div class="full"><span class="label">Only on these days (none = every day)</span><div class="actions">${ROSTER_DAYS.map((n, i) => `<label class="check"><input type="checkbox" name="d${i}"> ${n}</label>`).join("")}</div></div>`,
        async (b) => {
          const user_ids = staff
            .filter((p) => `u${p.id}` in b)
            .map((p) => p.id);
          if (!user_ids.length)
            throw new Error("Choose at least one employee.");
          const body = { user_ids, from: b.from, to: b.to };
          const weekdays = ROSTER_DAYS.map((_, i) => i).filter(
            (i) => `d${i}` in b,
          );
          if (weekdays.length) body.weekdays = weekdays;
          if (b.what === "off") body.off = true;
          else if (b.what === "policy") {
            if (!b.policy_id) throw new Error("Add a shift rule first.");
            body.policy_id = Number(b.policy_id);
          }
          const r = await api("/admin/roster", body);
          notice(`Updated ${r.days} day(s) for ${r.people} people.`);
        },
      );
    });
  };
  await draw();
}
async function myRosterCard(id) {
  const rows = await api("/my-roster");
  if (id !== renderId || !rows.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>My roster, next two weeks</h2>${rows.map((r) => `<div class="activity"><strong>${fmtDate(r.date)}</strong> · ${r.off ? "Rest day" : `${esc(r.policy_name || "")} (${r.start_time}–${r.earliest_out})`}</div>`).join("")}`;
  document.querySelector("#content").append(card);
}
