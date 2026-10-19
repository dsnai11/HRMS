// Payroll: runs, salaries, structure, statutory settings, adjustments, payslips.
const inr = (n) =>
  `₹${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n ?? 0)}`;
const WARNINGS = {
  negative_net_pay: "Net pay is negative",
  no_paid_days: "No paid days",
  deductions_over_50_percent: "Deductions exceed half of pay",
  pf_wages_raised_to_50_percent: "PF wages raised to 50% of pay (labour codes)",
  attendance_not_counted_for_some_days:
    "Some days fall before attendance was counted",
  no_attendance: "No attendance record",
  no_branch_state_for_pt:
    "Branch has no state, so professional tax was not applied",
};
const RUN_STATUS = { draft: "Draft", approved: "Approved", paid: "Paid" };
let payrollTab = "runs";
let payrollRun = null;
const PAYROLL_TABS = {
  runs: "Payroll runs",
  salaries: "Salaries",
  structure: "Salary structure",
  statutory: "Statutory & settings",
  adjustments: "Adjustments",
  loans: "Loans & advances",
  claims: "Reimbursements",
  yearend: "Bonus, gratuity & tax forms",
};

function viewDialog(title, html) {
  document.querySelector("dialog")?.remove();
  const d = document.createElement("dialog");
  d.innerHTML = `<h2>${esc(title)}</h2>${html}<div class="form-actions"><button type="button" class="secondary" id="close">Close</button></div>`;
  document.body.append(d);
  d.showModal();
  d.querySelector("#close").onclick = () => d.remove();
}

async function payrollPage(id) {
  const tab = payrollTab;
  const html =
    payrollRun && tab === "runs"
      ? await payrollRunHtml(payrollRun)
      : await payrollTabHtml(tab);
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Payroll",
      "Salaries, statutory deductions and monthly pay. Review every run before approving.",
    ) +
    `<div class="tabbar">${Object.entries(PAYROLL_TABS)
      .map(
        ([k, l]) =>
          `<button class="${k === tab ? "" : "secondary"}" data-tab="${k}">${l}</button>`,
      )
      .join("")}</div><div id="tab">${html}</div>`;
  document
    .querySelectorAll("[data-tab]")
    .forEach(
      (b) =>
        (b.onclick = () => (
          (payrollTab = b.dataset.tab),
          (payrollRun = null),
          render()
        )),
    );
  await payrollWire(tab);
}

const payrollCache = {};
async function payrollTabHtml(tab) {
  if (MORE_TABS[tab]) return await MORE_TABS[tab].html();
  if (tab === "runs") {
    const runs = await api("/admin/payroll/runs");
    return `<div class="card"><div class="card-head"><div><h2>Payroll runs</h2><p class="muted">Run a month after it has ended. Attendance and approved leave feed pay days.</p></div>${has("payroll.manage") ? `<div class="actions"><input type="month" id="run-month" value="${shiftMonth(thisMonth(), -1)}"><button id="new-run">Run payroll</button></div>` : ""}</div>${
      runs.length
        ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Status</th><th>Employees</th><th>Gross</th><th>Deductions</th><th>Net pay</th><th>Employer cost</th><th></th></tr></thead><tbody>${runs.map((r) => `<tr><td>${monthLabel(r.month)}</td><td><span class="pill ${r.status === "draft" ? "neutral" : ""}">${RUN_STATUS[r.status]}</span></td><td>${r.employees}${r.skipped.length ? `<small>${r.skipped.length} without salary</small>` : ""}</td><td>${inr(r.gross)}</td><td>${inr(r.deductions)}</td><td><strong>${inr(r.net)}</strong></td><td>${inr(r.employer_cost)}</td><td><button class="secondary" data-open-run="${r.id}">Open</button></td></tr>`).join("")}</tbody></table></div>`
        : empty("No payroll runs", "Set up salaries, then run the first month.")
    }</div>`;
  }
  if (tab === "salaries") {
    const data = await api("/admin/payroll/salaries?limit=100");
    payrollCache.salaries = data.items;
    return `<div class="card"><div class="card-head"><div><h2>Salaries</h2><p class="muted">The current monthly gross for each employee. A revision keeps the history.</p></div></div>${
      data.items.length
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Monthly gross</th><th>Effective from</th><th>Tax regime</th><th>PF</th><th>ESI</th><th></th></tr></thead><tbody>${data.items.map((e) => `<tr><td>${esc(e.name)}<small>${esc(e.employee_code || "")} · ${esc(e.department_name || "")}</small></td><td>${e.monthly_gross ? `<strong>${inr(e.monthly_gross)}</strong>` : '<span class="pill neutral">No salary</span>'}</td><td>${e.effective_from ? fmtDate(e.effective_from) : "—"}</td><td>${esc(e.tax_regime || "—")}</td><td>${e.monthly_gross ? yn(e.pf_applicable) : "—"}</td><td>${e.monthly_gross ? yn(e.esi_applicable) : "—"}</td><td>${has("payroll.manage") ? `<button class="secondary" data-salary="${e.id}">${e.monthly_gross ? "Revise" : "Set salary"}</button> <button class="ghost" data-private="${e.id}">Bank & IDs</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : empty("No employees", "Add employees first.")
    }</div>`;
  }
  if (tab === "structure") {
    const comps = await api("/admin/payroll/components");
    payrollCache.components = comps;
    return `<div class="card"><div class="card-head"><div><h2>Salary structure</h2><p class="muted">How a monthly gross splits into components. Exactly one component must be the balancing figure. Basic at 50% of gross satisfies the labour codes' wage definition by itself.</p></div>${has("payroll.manage") ? '<div class="actions"><button class="secondary" id="seed-comps">Add standard structure</button><button id="add-comp">+ Add component</button></div>' : ""}</div>${
      comps.length
        ? `<div class="table-wrap"><table><thead><tr><th>Component</th><th>Calculation</th><th>Basic / DA</th><th>Taxable</th><th>ESI wages</th><th>Status</th><th></th></tr></thead><tbody>${comps.map((c) => `<tr><td>${esc(c.name)}<small>${esc(c.code)}</small></td><td>${{ percent_of_gross: `${c.value}% of gross`, percent_of_basic: `${c.value}% of basic`, fixed: `${inr(c.value)} fixed`, balance: "Balance (gross minus the rest)" }[c.calc]}</td><td>${yn(c.is_basic)}</td><td>${yn(c.taxable)}</td><td>${yn(c.esi_wage)}</td><td><span class="pill ${c.active ? "" : "neutral"}">${c.active ? "Active" : "Inactive"}</span></td><td>${has("payroll.manage") ? `<button class="secondary" data-edit-comp="${c.id}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : empty(
            "No components",
            "Add the standard structure (Basic, HRA, Special allowance) to begin.",
          )
    }</div>`;
  }
  if (tab === "statutory") {
    const [s, slabs, presets, opening] = await Promise.all([
      api("/admin/payroll/settings"),
      api("/admin/payroll/pt-slabs"),
      api("/admin/payroll/pt-presets"),
      api(`/admin/payroll/opening?tax_year=${taxYearNow()}`),
    ]);
    payrollCache.settings = s;
    payrollCache.slabs = slabs;
    const chk = (path, label, hint = "") =>
      `<label class="check"><input type="checkbox" name="${path}" ${path.split(".").reduce((o, k) => o[k], s) ? "checked" : ""}> <span>${label}${hint ? `<small>${hint}</small>` : ""}</span></label>`;
    const states = [...new Set(slabs.map((x) => x.state))];
    return (
      `<div class="card"><h2>Statutory deductions</h2>${!s.encryption_configured ? '<div class="callout">Bank, PAN and UAN details cannot be stored yet: the server needs a <code>DATA_ENCRYPTION_KEY</code> setting.</div>' : ""}<form id="stat-form" class="stack">${chk("pf.enabled", "Provident fund (EPF, EPS, EDLI)", "12% employee and employer on PF wages; wage ceiling ₹25,000 from 17 Sep 2026")}${chk("pf.restrictToCeiling", "Limit PF to the statutory wage ceiling", "Turn off to contribute on full PF wages")}${chk("pf.applyWageCode50Rule", "Apply the labour codes' 50% wage rule", "PF wages are at least half of total pay")}${chk("esi.enabled", "ESI", "0.75% employee and 3.25% employer for wages up to ₹21,000")}${chk("pt.enabled", "Professional tax", "From the state slabs below, by the employee's branch state")}${chk("tds.enabled", "Income tax (TDS on salary)", "Annual projection; new regime by default")}${chk("approval.separateApprover", "Require a different person to approve", "The person who prepared a run cannot approve it")}${has("payroll.manage") ? "<div><button>Save settings</button></div>" : ""}</form><p class="muted">These are reference rules for your payroll team or CA to confirm; they are not legal advice. Rates are in <code>server/payroll/statutory.js</code>.</p></div>` +
      `<div class="card"><div class="card-head"><div><h2>Professional tax slabs</h2><p class="muted">Rajasthan, Delhi, Uttar Pradesh and some other states levy none. Presets are starting points; confirm against your state's notification.</p></div>${has("payroll.manage") ? `<div class="actions"><select id="pt-preset">${presets.map((p) => `<option>${esc(p)}</option>`).join("")}</select><button class="secondary" id="load-preset">Load preset</button><button id="add-slab">+ Add slab</button></div>` : ""}</div>${
        slabs.length
          ? `<div class="table-wrap"><table><thead><tr><th>State</th><th>Salary from</th><th>Up to</th><th>Tax / month</th><th>Applies to</th><th></th></tr></thead><tbody>${slabs.map((x) => `<tr><td>${esc(x.state)}</td><td>${inr(x.from_amount)}</td><td>${x.to_amount === null ? "No limit" : inr(x.to_amount)}</td><td>${inr(x.amount)}</td><td>${esc([x.gender, x.month ? `month ${x.month}` : ""].filter(Boolean).join(" · ") || "Everyone")}</td><td>${has("payroll.manage") ? `<button class="ghost" data-del-slab="${x.id}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div><p class="muted">States with slabs: ${states.map(esc).join(", ")}. An employee's state is taken from their branch.</p>`
          : empty("No slabs", "Without slabs no professional tax is deducted.")
      }</div>` +
      `<div class="card"><div class="card-head"><div><h2>Opening balances ${taxYearNow()}–${String((taxYearNow() + 1) % 100).padStart(2, "0")}</h2><p class="muted">Taxable income and tax already recorded before you started using payroll here, so the year's tax projects correctly.</p></div>${has("payroll.manage") ? '<button id="add-opening">+ Add opening balance</button>' : ""}</div>${
        opening.length
          ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Taxable income so far</th><th>Tax deducted so far</th></tr></thead><tbody>${opening.map((o) => `<tr><td>${esc(o.employee_name)}<small>${esc(o.employee_code || "")}</small></td><td>${inr(o.taxable_income)}</td><td>${inr(o.tds_deducted)}</td></tr>`).join("")}</tbody></table></div>`
          : empty(
              "No opening balances",
              "Needed when you start part-way through the tax year.",
            )
      }</div>`
    );
  }
  const month = payrollCache.adjMonth ?? shiftMonth(thisMonth(), -1);
  payrollCache.adjMonth = month;
  const [adj, org] = await Promise.all([
    api(`/admin/payroll/adjustments?month=${month}`),
    api("/admin/org"),
  ]);
  payrollCache.people = org.managers;
  return `<div class="card"><div class="card-head"><div><h2>Adjustments</h2><p class="muted">One-off earnings and deductions for a month (bonus, arrears, advance recovery). They are picked up when the run is computed.</p></div><div class="actions"><input type="month" id="adj-month" value="${month}">${has("payroll.manage") ? '<button id="add-adj">+ Add adjustment</button>' : ""}</div></div>${
    adj.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Description</th><th>Type</th><th>Amount</th><th>Taxable</th><th></th></tr></thead><tbody>${adj.map((a) => `<tr><td>${esc(a.employee_name)}<small>${esc(a.employee_code || "")}</small></td><td>${esc(a.name)}</td><td>${esc(a.kind)}</td><td>${inr(a.amount)}</td><td>${a.kind === "earning" ? yn(a.taxable) : "—"}</td><td>${has("payroll.manage") ? `<button class="ghost" data-del-adj="${a.id}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : empty("No adjustments", "Nothing extra for this month.")
  }</div>`;
}
const taxYearNow = () => {
  const [y, m] = thisMonth().split("-").map(Number);
  return m >= 4 ? y : y - 1;
};

async function payrollRunHtml(runId) {
  const d = await api(`/admin/payroll/runs/${runId}`);
  payrollCache.run = d;
  const { run, totals, items } = d;
  const exports = [
    ["register", "Payroll register"],
    ["pf", "PF (ECR data)"],
    ["ecr", "PF ECR upload file"],
    ["esi", "ESI"],
    ["esic", "ESIC upload file"],
    ["pf_challan", "PF challan summary"],
    ["lwf", "Labour welfare fund"],
    ["esi_challan", "ESI challan summary"],
    ["pt", "Professional tax"],
    ...(run.status !== "draft" ? [["bank", "Bank file"]] : []),
  ];
  return (
    `<div class="card"><div class="card-head"><div><button class="ghost" id="back-runs">← All runs</button><h2>${monthLabel(run.month)} · <span class="pill ${run.status === "draft" ? "neutral" : ""}">${RUN_STATUS[run.status]}</span></h2><p class="muted">${run.status === "draft" ? "Draft: review the figures, adjust, and recompute until they are right. Nothing is visible to employees yet." : "Approved runs are locked and payslips are visible to employees."}</p></div><div class="actions">${run.status === "draft" && has("payroll.manage") ? '<button class="secondary" id="recompute">Recompute</button>' : ""}${run.status === "draft" && has("payroll.approve") ? '<button id="approve">Approve</button>' : ""}${run.status === "approved" && has("payroll.manage") ? '<button id="mark-paid">Mark paid</button>' : ""}${run.status === "draft" && has("payroll.manage") ? '<button class="ghost" id="delete-run">Delete draft</button>' : ""}</div></div>` +
    `<div class="stats"><div class="stat"><div class="stat-label">Employees</div><div class="stat-value">${totals.employees}</div></div><div class="stat"><div class="stat-label">Gross pay</div><div class="stat-value small">${inr(totals.gross)}</div></div><div class="stat featured"><div class="stat-label">Net pay</div><div class="stat-value small">${inr(totals.net)}</div></div><div class="stat"><div class="stat-label">Employer cost</div><div class="stat-value small">${inr(totals.employer_cost)}</div></div></div>` +
    (run.skipped.length
      ? `<div class="callout">${run.skipped.length} active employee(s) have no salary set and are not in this run: ${run.skipped
          .slice(0, 8)
          .map((s) => esc(s.name))
          .join(", ")}${run.skipped.length > 8 ? "…" : ""}.</div>`
      : "") +
    `<div class="actions spaced">${exports.map(([t, l]) => `<button class="secondary" data-export="${t}">↓ ${l}</button>`).join("")}</div>` +
    (items.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Paid days</th><th>Gross</th><th>Deductions</th><th>Net pay</th><th>Notes</th><th></th></tr></thead><tbody>${items.map((i) => `<tr><td>${esc(i.name)}<small>${esc(i.employee_code || "")} · ${esc(i.department_name || "")}</small></td><td>${i.paid_days}${i.lop_days ? `<small>${i.lop_days} lost</small>` : ""}</td><td>${inr(i.gross)}</td><td>${inr(i.deductions)}</td><td><strong>${inr(i.net)}</strong></td><td>${i.warnings.map((w) => `<span class="pill">${esc(WARNINGS[w] || w)}</span>`).join(" ") || "—"}</td><td><button class="secondary" data-item="${i.user_id}">Breakdown</button></td></tr>`).join("")}</tbody></table></div>`
      : empty("Nobody to pay", "Set salaries for employees, then recompute.")) +
    "</div>"
  );
}
const payrollRunHtmlCache = {};
function breakdownHtml(d) {
  const rows = (list) =>
    list
      .map(
        (x) =>
          `<div class="kv"><span>${esc(x.name)}</span><strong>${inr(x.amount)}</strong></div>`,
      )
      .join("") || '<p class="muted">None</p>';
  const e = d.employer;
  return `<div class="muted">${esc(d.employee.name)} · ${esc(d.employee.employee_code || "")} · ${monthLabel(d.month)}</div><p class="muted">Paid ${d.paid_days} of ${d.days_in_month} days${d.lop_days ? ` (${d.lop_days} lost)` : ""}</p><h3>Earnings</h3>${rows(d.earnings)}<div class="kv"><span><strong>Gross</strong></span><strong>${inr(d.gross_earnings)}</strong></div><h3>Deductions</h3>${rows(d.deductions)}<div class="kv"><span><strong>Net pay</strong></span><strong>${inr(d.net_pay)}</strong></div><h3>Employer contributions</h3>${rows(
    [
      { name: "EPF", amount: e.pf_epf },
      { name: "EPS", amount: e.pf_eps },
      { name: "EDLI", amount: e.edli },
      { name: "PF admin charges", amount: e.pf_admin },
      { name: "ESI", amount: e.esi },
    ].filter((x) => x.amount),
  )}<div class="kv"><span><strong>Employer cost</strong></span><strong>${inr(d.employer_cost)}</strong></div>${d.pf ? `<h3>Provident fund</h3><p class="muted">PF wages ${inr(d.pf.wages)} · contribution base ${inr(d.pf.base)}</p>` : ""}${d.tds ? `<h3>Income tax</h3><p class="muted">${esc(d.tds.regime)} regime, ${d.tds.tax_year}: projected income ${inr(d.tds.projected_income)}, deductions ${inr(d.tds.deductions)}, taxable ${inr(d.tds.taxable_income)}, annual tax ${inr(d.tds.annual_tax)}, already deducted ${inr(d.tds.already_deducted)}, ${d.tds.months_left} month(s) left.</p>` : ""}${d.warnings.length ? `<h3>Notes</h3><p>${d.warnings.map((w) => `<span class="pill">${esc(WARNINGS[w] || w)}</span>`).join(" ")}</p>` : ""}`;
}

async function payrollWire(tab) {
  const on = (s, fn) =>
    document.querySelector(s)?.addEventListener("click", fn);
  const reload = async () => render();
  if (MORE_TABS[tab]) return MORE_TABS[tab].wire();
  if (tab === "runs" && payrollRun) {
    const run = payrollCache.run.run;
    on("#back-runs", () => ((payrollRun = null), render()));
    const act = (sel_, path, body, msg, confirmText) =>
      on(sel_, (e) => {
        if (confirmText && !confirm(confirmText)) return;
        busy(e.target, async () => {
          const r = await api(
            `/admin/payroll/runs/${run.id}${path}`,
            body,
            e.target.dataset.method || "POST",
          );
          notice(msg);
          if (e.target.id === "delete-run") payrollRun = null;
          await reload();
        });
      });
    act("#recompute", "/recompute", {}, "Recomputed.");
    act(
      "#approve",
      "/approve",
      {},
      "Approved. Payslips are now visible to employees.",
      `Approve ${monthLabel(run.month)} payroll? It will be locked and payslips will be visible to employees.`,
    );
    on("#mark-paid", () =>
      dialog(
        "Mark as paid",
        input("paid_on", "Paid on", today(), 'type="date" required'),
        async (b) => {
          await api(`/admin/payroll/runs/${run.id}/paid`, b);
          notice("Marked paid.");
        },
      ),
    );
    on("#delete-run", (e) => {
      if (confirm("Delete this draft run?"))
        busy(e.target, async () => {
          await api(`/admin/payroll/runs/${run.id}`, undefined, "DELETE");
          payrollRun = null;
          notice("Draft deleted.");
          await reload();
        });
    });
    document
      .querySelectorAll("[data-export]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            busy(b, () =>
              download(
                `/admin/payroll/runs/${run.id}/export?type=${b.dataset.export}`,
                `payroll-${b.dataset.export}-${run.month}.${b.dataset.export === "ecr" ? "txt" : "csv"}`,
              ),
            )),
      );
    document
      .querySelectorAll("[data-item]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            busy(b, async () =>
              viewDialog(
                "Pay breakdown",
                breakdownHtml(
                  await api(
                    `/admin/payroll/runs/${run.id}/items/${b.dataset.item}`,
                  ),
                ),
              ),
            )),
      );
    return;
  }
  if (tab === "runs") {
    document
      .querySelectorAll("[data-open-run]")
      .forEach(
        (b) =>
          (b.onclick = () => (
            (payrollRun = Number(b.dataset.openRun)),
            render()
          )),
      );
    on("#new-run", (e) =>
      busy(e.target, async () => {
        const r = await api("/admin/payroll/runs", {
          month: document.querySelector("#run-month").value,
        });
        payrollRun = r.id;
        notice(`Computed ${r.computed} employee(s).`);
        await reload();
      }),
    );
  } else if (tab === "salaries") {
    document
      .querySelectorAll("[data-salary]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            salaryDialog(
              payrollCache.salaries.find(
                (x) => x.id === Number(b.dataset.salary),
              ),
            )),
      );
    document
      .querySelectorAll("[data-private]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            privateDialog(
              payrollCache.salaries.find(
                (x) => x.id === Number(b.dataset.private),
              ),
            )),
      );
  } else if (tab === "structure") {
    on("#seed-comps", (e) =>
      busy(e.target, async () => {
        const r = await api("/admin/payroll/components/seed-defaults", {});
        notice(r.created ? "Standard structure added." : "Already in place.");
        await reload();
      }),
    );
    on("#add-comp", () => componentDialog());
    document
      .querySelectorAll("[data-edit-comp]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            componentDialog(
              payrollCache.components.find(
                (c) => c.id === Number(b.dataset.editComp),
              ),
            )),
      );
  } else if (tab === "statutory") {
    document.querySelector("#stat-form")?.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(e.submitter, async () => {
        const f = new FormData(e.target),
          get = (k) => f.get(k) === "on";
        await api(
          "/admin/payroll/settings",
          {
            pf: {
              enabled: get("pf.enabled"),
              restrictToCeiling: get("pf.restrictToCeiling"),
              applyWageCode50Rule: get("pf.applyWageCode50Rule"),
            },
            esi: { enabled: get("esi.enabled") },
            pt: { enabled: get("pt.enabled") },
            tds: { enabled: get("tds.enabled") },
            approval: { separateApprover: get("approval.separateApprover") },
          },
          "PATCH",
        );
        notice("Settings saved.");
      });
    });
    on("#load-preset", (e) =>
      busy(e.target, async () => {
        const st = document.querySelector("#pt-preset").value;
        if (!confirm(`Replace ${st}'s slabs with the preset?`)) return;
        await api("/admin/payroll/pt-slabs/preset", { state: st });
        notice(`${st} slabs loaded.`);
        await reload();
      }),
    );
    on("#add-slab", () =>
      dialog(
        "Add a professional-tax slab",
        `${input("state", "State", "", "required maxlength=60")}${input("from_amount", "Salary from", "", 'type="number" min="0" required')}${input("to_amount", "Up to (blank = no limit)", "", 'type="number" min="0"')}${input("amount", "Tax per month", "", 'type="number" min="0" required')}${sel(
          "gender",
          "Applies to",
          [
            ["", "Everyone"],
            ["male", "Men"],
            ["female", "Women"],
          ],
        )}${input("month", "Only in month (1–12, optional)", "", 'type="number" min="1" max="12"')}`,
        async (b) => {
          for (const k of ["from_amount", "to_amount", "amount", "month"])
            b[k] = b[k] === "" ? null : Number(b[k]);
          b.gender ||= null;
          await api("/admin/payroll/pt-slabs", b);
          notice("Slab added.");
        },
      ),
    );
    document.querySelectorAll("[data-del-slab]").forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            await api(
              `/admin/payroll/pt-slabs/${b.dataset.delSlab}`,
              undefined,
              "DELETE",
            );
            notice("Slab removed.");
            await reload();
          })),
    );
    on("#add-opening", async () => {
      const org = await api("/admin/org");
      dialog(
        "Opening balance",
        `${sel(
          "user_id",
          "Employee",
          org.managers.map((m) => [
            m.id,
            `${m.name}${m.employee_code ? ` (${m.employee_code})` : ""}`,
          ]),
        )}${input("tax_year", "Tax year starting", taxYearNow(), 'type="number" required')}${input("taxable_income", "Taxable income so far (₹)", "", 'type="number" min="0" required')}${input("tds_deducted", "Tax deducted so far (₹)", 0, 'type="number" min="0" required')}`,
        async (b) => {
          for (const k of [
            "user_id",
            "tax_year",
            "taxable_income",
            "tds_deducted",
          ])
            b[k] = Number(b[k]);
          await api("/admin/payroll/opening", b);
          notice("Opening balance saved.");
        },
      );
    });
  } else {
    document.querySelector("#adj-month").onchange = (e) => (
      (payrollCache.adjMonth = e.target.value),
      render()
    );
    on("#add-adj", () =>
      dialog(
        "Add an adjustment",
        `${sel(
          "user_id",
          "Employee",
          payrollCache.people.map((m) => [
            m.id,
            `${m.name}${m.employee_code ? ` (${m.employee_code})` : ""}`,
          ]),
        )}${sel("kind", "Type", [
          ["earning", "Earning (bonus, arrears…)"],
          ["deduction", "Deduction (advance, recovery…)"],
        ])}${input("name", "Description", "", 'required maxlength="80"')}${input("amount", "Amount (₹)", "", 'type="number" min="1" required')}${sel(
          "taxable",
          "Taxable earning?",
          [
            ["true", "Yes"],
            ["false", "No (reimbursement)"],
          ],
        )}`,
        async (b) => {
          b.user_id = Number(b.user_id);
          b.amount = Number(b.amount);
          b.taxable = b.taxable === "true";
          b.month = payrollCache.adjMonth;
          await api("/admin/payroll/adjustments", b);
          notice("Adjustment added. Recompute the run to include it.");
        },
      ),
    );
    document.querySelectorAll("[data-del-adj]").forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, async () => {
            await api(
              `/admin/payroll/adjustments/${b.dataset.delAdj}`,
              undefined,
              "DELETE",
            );
            notice("Adjustment removed.");
            await reload();
          })),
    );
  }
}

function componentDialog(c) {
  dialog(
    c ? "Edit component" : "Add component",
    `${input("name", "Name", c?.name || "", 'required maxlength="60"')}${c ? "" : input("code", "Code", "", 'required maxlength="12" placeholder="CONV"')}${sel(
      "calc",
      "Calculation",
      [
        ["percent_of_gross", "% of gross"],
        ["percent_of_basic", "% of basic"],
        ["fixed", "Fixed amount"],
        ["balance", "Balance (gross minus the rest)"],
      ],
      c?.calc || "fixed",
    )}${input("value", "Value (percent or amount)", c?.value ?? 0, 'type="number" min="0" step="0.01"')}${sel(
      "is_basic",
      "Counts as basic / DA",
      [
        ["false", "No"],
        ["true", "Yes"],
      ],
      String(Boolean(c?.is_basic)),
    )}${sel(
      "taxable",
      "Taxable",
      [
        ["true", "Yes"],
        ["false", "No"],
      ],
      String(c ? Boolean(c.taxable) : true),
    )}${sel(
      "esi_wage",
      "Counts for ESI wages",
      [
        ["true", "Yes"],
        ["false", "No"],
      ],
      String(c ? Boolean(c.esi_wage) : true),
    )}${
      c
        ? sel(
            "active",
            "Status",
            [
              ["true", "Active"],
              ["false", "Inactive"],
            ],
            String(Boolean(c.active)),
          )
        : ""
    }`,
    async (b) => {
      for (const k of ["is_basic", "taxable", "esi_wage", "active"])
        if (k in b) b[k] = b[k] === "true";
      b.value = Number(b.value);
      await api(
        c ? `/admin/payroll/components/${c.id}` : "/admin/payroll/components",
        b,
        c ? "PATCH" : "POST",
      );
      notice("Component saved.");
    },
  );
}

function salaryDialog(e) {
  const first = `${thisMonth()}-01`;
  dialog(
    `Salary for ${e.name}`,
    `${input("effective_from", "Effective from", first, 'type="date" required')}${input("monthly_gross", "Monthly gross (₹)", e.monthly_gross || "", 'type="number" min="1" step="1" required')}<div class="full" id="preview"><p class="muted">Enter a gross to preview the components.</p></div>${sel(
      "tax_regime",
      "Tax regime",
      [
        ["new", "New regime (default)"],
        ["old", "Old regime"],
      ],
      e.tax_regime || "new",
    )}${input("declared_deductions", "Declared deductions, old regime (₹ a year)", 0, 'type="number" min="0"')}<label class="check"><input type="checkbox" name="pf_applicable" ${e.monthly_gross ? (e.pf_applicable ? "checked" : "") : "checked"}> PF applies</label><label class="check"><input type="checkbox" name="eps_eligible" checked> Eligible for EPS (pension)</label><label class="check"><input type="checkbox" name="esi_applicable" ${e.esi_applicable ? "checked" : ""}> ESI applies (wages up to ₹21,000)</label><label class="check"><input type="checkbox" name="pt_applicable" checked> Professional tax applies</label><label class="full">Note<input name="note" maxlength="300"></label>`,
    async (b) => {
      const body = {
        effective_from: b.effective_from,
        monthly_gross: Number(b.monthly_gross),
        tax_regime: b.tax_regime,
        declared_deductions: Number(b.declared_deductions || 0),
        note: b.note || undefined,
      };
      for (const k of [
        "pf_applicable",
        "eps_eligible",
        "esi_applicable",
        "pt_applicable",
      ])
        body[k] = k in b;
      await api(`/admin/employees/${e.id}/salary`, body);
      notice("Salary saved.");
    },
  );
  const gross = document.querySelector("dialog [name=monthly_gross]");
  let timer;
  const preview = async () => {
    const box = document.querySelector("dialog #preview");
    if (!box || !gross.value) return;
    try {
      const lines = await api("/admin/payroll/salary-preview", {
        monthly_gross: Number(gross.value),
      });
      box.innerHTML = `<div class="kv-list">${lines.map((l) => `<div class="kv"><span>${esc(l.name)}</span><strong>${inr(l.amount)}</strong></div>`).join("")}</div>`;
    } catch (err) {
      box.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
    }
  };
  gross.oninput = () => (
    clearTimeout(timer),
    (timer = setTimeout(preview, 300))
  );
  preview();
}

async function privateDialog(e) {
  const r = await api(`/admin/employees/${e.id}/private`);
  const d = r.data;
  if (!r.encryption_configured)
    return notice(
      "The server needs a DATA_ENCRYPTION_KEY setting before bank and ID details can be stored.",
      true,
    );
  dialog(
    `Bank & IDs for ${e.name}`,
    `<p class="full muted">Stored encrypted. Existing values are masked; type a new value to replace one, or leave a field as it is to keep it.</p>${input("account_holder", "Account holder", d.account_holder || "", 'maxlength="100"')}${input("bank_name", "Bank", d.bank_name || "", 'maxlength="60"')}${input("bank_account", "Account number", "", `placeholder="${esc(d.bank_account || "")}" inputmode="numeric"`)}${input("ifsc", "IFSC", d.ifsc || "", 'maxlength="11"')}${input("pan", "PAN", "", `placeholder="${esc(d.pan || "")}" maxlength="10"`)}${input("uan", "UAN (PF)", "", `placeholder="${esc(d.uan || "")}" maxlength="12"`)}${input("esi_ip", "ESI number", "", `placeholder="${esc(d.esi_ip || "")}" maxlength="17"`)}`,
    async (b) => {
      const body = Object.fromEntries(
        Object.entries(b).filter(
          ([k, v]) =>
            v !== "" || ["account_holder", "bank_name", "ifsc"].includes(k),
        ),
      );
      await api(`/admin/employees/${e.id}/private`, body, "PUT");
      notice("Details saved.");
    },
  );
}

// ---- employee payslips ---------------------------------------------------------------
async function payslipsPage(id) {
  const list = await api("/payslips");
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Payslips",
      "Your monthly payslips, available once payroll is approved.",
    ) +
    `<div class="card">${
      list.length
        ? `<div class="table-wrap"><table><thead><tr><th>Month</th><th>Gross</th><th>Deductions</th><th>Net pay</th><th>Status</th><th></th></tr></thead><tbody>${list.map((p) => `<tr><td>${monthLabel(p.month)}</td><td>${inr(p.gross)}</td><td>${inr(p.deductions)}</td><td><strong>${inr(p.net)}</strong></td><td><span class="pill ${p.status === "paid" ? "" : "neutral"}">${p.status === "paid" ? `Paid ${p.paid_on ? fmtDate(p.paid_on) : ""}` : "Approved"}</span></td><td><a class="button secondary" href="/payslip.html?run=${p.run_id}" target="_blank" rel="noopener">View / print</a></td></tr>`).join("")}</tbody></table></div>`
        : empty(
            "No payslips yet",
            "Payslips appear here after your company approves each month's payroll.",
          )
    }</div>`;
  await taxStatementCard(id);
}
