// Branch budgets: a financial-year budget for every branch and the head office, by budget
// head, prepared and submitted by finance and approved by someone else; spending against it
// from payroll, approved claims and entries made here; and the manpower plan.
let budgetTab = "overview";
let budgetFy = null;
let budgetGroup = "zones";
let budgetSearch = "";
const BUDGET_TABS = {
  overview: "Budget vs actual",
  plan: "Budget plan",
  manpower: "Manpower plan",
  spending: "Spending",
  setup: "Setup",
};
const BUDGET_SOURCE = { payroll: "Payroll (employer cost)", claims: "Approved claims", manual: "Entered here" };
const BUDGET_FLAG = {
  over: ["danger", "Over budget"],
  near: ["warn", "90% used"],
  ok: ["", "Within budget"],
  no_budget: ["neutral", "No budget"],
  none: ["neutral", "—"],
};
const MONTH_COLS = ["apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "jan", "feb", "mar"];
// Rupees the way finance reads them: crore and lakh, the exact figure on hover.
const bgAmount = (n) => {
  const v = Math.round(n ?? 0);
  const abs = Math.abs(v);
  const text =
    abs >= 1e7 ? `₹${(v / 1e7).toFixed(2)} Cr` : abs >= 1e5 ? `₹${(v / 1e5).toFixed(2)} L` : inr(v);
  return `<span title="${esc(inr(v))}">${text}</span>`;
};
const bgFlag = (f) => `<span class="pill ${BUDGET_FLAG[f][0]}">${BUDGET_FLAG[f][1]}</span>`;
const bgUsed = (g) =>
  g.utilisation_pct == null
    ? "—"
    : `<progress class="meter" max="100" value="${Math.min(g.utilisation_pct, 100)}" aria-hidden="true"></progress> ${g.utilisation_pct}%`;
const bgMonth = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-IN", { month: "short", year: "2-digit" });
const bgQuery = (extra = {}) => new URLSearchParams({ fy: budgetFy, ...extra }).toString();

async function budgetsPage(id) {
  const plan = await api(`/admin/budgets${budgetFy ? `?fy=${budgetFy}` : ""}`);
  if (id !== renderId) return;
  budgetFy = plan.fy;
  const tabs = Object.entries(BUDGET_TABS).filter(([k]) => k !== "setup" || has("budget.manage") || has("org.manage"));
  if (!tabs.some(([k]) => k === budgetTab)) budgetTab = "overview";
  const years = [plan.current_fy - 2, plan.current_fy - 1, plan.current_fy, plan.current_fy + 1];
  if (!years.includes(plan.fy)) years.push(plan.fy);
  const ho = plan.branches.find((b) => b.head_office);
  document.querySelector("#content").innerHTML =
    heading(
      "Branch budgets",
      `${plan.branches.length} branches${ho ? `, head office ${ho.name}` : ""}. The financial year runs April to March.`,
      `<label class="budget-fy">Financial year<select id="budget-fy">${years
        .sort()
        .map((y) => `<option value="${y}" ${y === plan.fy ? "selected" : ""}>${y}-${String(y + 1).slice(2)}</option>`)
        .join("")}</select></label>`,
    ) +
    budgetStatusCard(plan) +
    `<div class="tabbar">${tabs
      .map(([k, l]) => `<button class="${k === budgetTab ? "" : "secondary"}" data-budget-tab="${k}" aria-pressed="${k === budgetTab}">${l}</button>`)
      .join("")}</div><div id="budget-body"><div class="card">Loading…</div></div>`;
  document.querySelector("#budget-fy").onchange = (e) => {
    budgetFy = Number(e.target.value);
    render();
  };
  document.querySelectorAll("[data-budget-tab]").forEach(
    (b) =>
      (b.onclick = () => {
        budgetTab = b.dataset.budgetTab;
        render();
      }),
  );
  wireBudgetStatus(plan);
  const body = document.querySelector("#budget-body");
  if (budgetTab === "overview") await budgetOverview(id, body, plan);
  else if (budgetTab === "plan") budgetPlan(body, plan);
  else if (budgetTab === "manpower") await budgetManpower(id, body, plan);
  else if (budgetTab === "spending") await budgetSpending(id, body, plan);
  else budgetSetup(body, plan);
}

// ---- status: draft → submitted → approved ------------------------------------------------------
function budgetStatusCard(p) {
  const who =
    p.status === "approved"
      ? `Approved by ${esc(p.approved_by_name || "—")} on ${fmtDate(p.approved_at)}. Changes now need a reason and are kept as revisions${p.revisions ? ` (${p.revisions} so far)` : ""}.`
      : p.status === "submitted"
        ? `Submitted by ${esc(p.submitted_by_name || "—")} on ${fmtDate(p.submitted_at)}. Someone with the right to approve budgets, other than the person who submitted it, approves it or sends it back.`
        : `Being prepared. Submit it for approval when every branch has its budget.${p.note ? ` Sent back: “${esc(p.note)}”` : ""}`;
  const actions = [
    p.status === "draft" && has("budget.manage") && '<button id="budget-submit">Submit for approval</button>',
    p.status === "submitted" && has("budget.approve") && p.submitted_by !== me.id && '<button id="budget-approve">Approve</button>',
    p.status === "submitted" && has("budget.approve") && '<button class="secondary" id="budget-return">Send back</button>',
    p.revisions && '<button class="ghost" id="budget-revisions">Revisions</button>',
  ].filter(Boolean);
  return `<div class="card budget-status"><div class="card-head"><div><h2>Budget ${esc(p.label)} <span class="pill ${p.status === "approved" ? "" : "neutral"}">${esc(p.status_label)}</span></h2><p class="muted">${who}</p></div><div class="actions">${actions.join("")}</div></div></div>`;
}
function wireBudgetStatus(p) {
  const act = (action, note) => api("/admin/budgets/status", { fy: p.fy, action, note });
  const submit = document.querySelector("#budget-submit");
  if (submit)
    submit.onclick = () =>
      busy(submit, async () => {
        await act("submit");
        notice("Submitted. The approvers have been told.");
        render();
      });
  const approve = document.querySelector("#budget-approve");
  if (approve)
    approve.onclick = () =>
      dialog(
        `Approve budget ${p.label}`,
        `<p class="full">This approves the budget for all ${p.branches.length} branches. Later changes will need a reason and are kept as revisions.</p><label class="full">Note (optional)<input name="note" maxlength="300"></label>`,
        async (f) => {
          await act("approve", f.note || undefined);
          notice("Budget approved.");
        },
      );
  document.querySelector("#budget-return")?.addEventListener("click", () =>
    dialog(
      "Send the budget back",
      '<label class="full">What needs to change<input name="note" maxlength="300" required></label>',
      async (f) => {
        await act("return", f.note);
        notice("Sent back to draft.");
      },
    ),
  );
  document.querySelector("#budget-revisions")?.addEventListener("click", async () => {
    const rows = await api(`/admin/budgets/revisions?fy=${p.fy}`);
    viewDialog(
      `Revisions to budget ${p.label}`,
      `<div class="table-wrap"><table><thead><tr><th>When</th><th>Branch</th><th>Head</th><th>From</th><th>To</th><th>Reason</th></tr></thead><tbody>${rows
        .map(
          (r) =>
            `<tr><td>${fmtDate(r.revised_at)}<small>${esc(r.revised_by_name || "")}</small></td><td>${esc(r.branch_name)}</td><td>${esc(r.head_name)}</td><td>${bgAmount(r.old_amount)}</td><td>${bgAmount(r.new_amount)}</td><td>${esc(r.reason)}</td></tr>`,
        )
        .join("")}</tbody></table></div>`,
    );
  });
}
const budgetLocked = (p) => p.status === "submitted";

// ---- budget vs actual ------------------------------------------------------------------------------
async function budgetOverview(id, body, plan) {
  const r = await api(`/admin/budgets/report?${bgQuery()}`);
  if (id !== renderId) return;
  const t = r.total;
  const over = r.branches.filter((b) => b.flag === "over");
  const near = r.branches.filter((b) => b.flag === "near");
  const rows = (budgetGroup === "branches" ? r.branches : r[budgetGroup]).filter(
    (g) => !budgetSearch || `${g.name} ${g.code ?? ""} ${g.zone ?? ""} ${g.region ?? ""}`.toLowerCase().includes(budgetSearch.toLowerCase()),
  );
  const chartRows = r.monthly.map((m) => [bgMonth(m.month), (m.budget / 1e5).toFixed(2), m.closed ? (m.actual / 1e5).toFixed(2) : "—"]);
  body.innerHTML = `${
    r.upto
      ? ""
      : `<div class="card"><p class="muted">${esc(r.label)} has not started yet, so there is no spending to compare. The budget plan is on the next tab.</p></div>`
  }<div class="stats budget-kpis">
      <div class="stat"><div class="stat-label">Budget for the year</div><div class="stat-value">${bgAmount(t.budget_fy)}</div><small class="muted">${r.heads.length} heads, ${plan.branches.length} branches</small></div>
      <div class="stat"><div class="stat-label">Budget to ${r.upto ? esc(bgMonth(r.upto)) : "date"}</div><div class="stat-value">${bgAmount(t.budget_ytd)}</div></div>
      <div class="stat"><div class="stat-label">Spent to date</div><div class="stat-value">${bgAmount(t.actual_ytd)}</div><small class="muted">${t.variance > 0 ? `${bgAmount(t.variance)} over` : `${bgAmount(-t.variance)} under`}</small></div>
      <div class="stat"><div class="stat-label">Branches over budget</div><div class="stat-value">${over.length}</div><small class="muted">${near.length} more have used 90%</small></div>
      <div class="stat"><div class="stat-label">Posts filled</div><div class="stat-value">${t.filled}${t.sanctioned ? ` / ${t.sanctioned}` : ""}</div><small class="muted">${t.vacant} vacant, ${t.open} being hired</small></div>
    </div>
    ${chartCard("Budget and spending by month", "₹ lakh, all branches you can see. Months after today show the budget only.", "budget-months", chartRows, ["Month", "Budget (₹ L)", "Spent (₹ L)"])}
    <div class="card"><div class="card-head"><div><h2>By budget head</h2><p class="muted">Spending comes from payroll, approved claims or entries on the Spending tab, as shown.</p></div></div><div class="table-wrap"><table><thead><tr><th>Head</th><th>Spending from</th><th>Budget for the year</th><th>Budget to date</th><th>Spent</th><th>Used</th><th></th></tr></thead><tbody>${r.heads
      .map((h) => {
        const c = t.heads[h.id];
        return `<tr><td>${esc(h.name)}<small>${esc(h.code)}</small></td><td>${BUDGET_SOURCE[h.source]}</td><td>${bgAmount(c.budget_fy)}</td><td>${bgAmount(c.budget_ytd)}</td><td>${bgAmount(c.actual_ytd)}</td><td>${bgUsed(c)}</td><td>${bgFlag(c.flag)}</td></tr>`;
      })
      .join("")}</tbody></table></div></div>
    <div class="card"><div class="card-head"><div><h2>By ${budgetGroup === "zones" ? "zone" : budgetGroup === "regions" ? "region" : "branch"}</h2><p class="muted">People count against the branch they are in today. The head office is shown on its own.</p></div><div class="actions"><button class="secondary" id="budget-csv">↓ CSV</button></div></div>
      <form class="filters" id="budget-filters"><label>Show<select name="group">${[["zones", "Zones"], ["regions", "Regions"], ["branches", "Branches"]].map(([v, l]) => `<option value="${v}" ${v === budgetGroup ? "selected" : ""}>${l}</option>`).join("")}</select></label><label>Search<input name="q" value="${esc(budgetSearch)}" placeholder="Name, code, zone or region"></label><button>Show</button></form>
      ${
        rows.length
          ? `<div class="table-wrap"><table><thead><tr><th>${budgetGroup === "branches" ? "Branch" : budgetGroup === "regions" ? "Region" : "Zone"}</th>${budgetGroup === "branches" ? "<th>Zone / region</th>" : "<th>Branches</th>"}<th>Budget to date</th><th>Spent</th><th>Over / under</th><th>Used</th><th>Posts</th><th></th></tr></thead><tbody>${rows
              .map(
                (g) =>
                  `<tr><td>${esc(g.name)}${g.head_office ? ' <span class="pill">Head office</span>' : ""}${g.code ? `<small>${esc(g.code)}</small>` : ""}</td><td>${budgetGroup === "branches" ? esc([g.zone, g.region].filter(Boolean).join(" / ") || "—") : g.branches}</td><td>${bgAmount(g.budget_ytd)}</td><td>${bgAmount(g.actual_ytd)}</td><td>${g.budget_ytd || g.actual_ytd ? `${g.variance > 0 ? "+" : ""}${bgAmount(g.variance)}` : "—"}</td><td>${bgUsed(g)}</td><td>${g.filled}${g.sanctioned ? ` / ${g.sanctioned}` : ""}${g.vacant ? `<small>${g.vacant} vacant</small>` : ""}</td><td>${bgFlag(g.flag)}</td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : empty("Nothing to show", budgetSearch ? "No match for that search." : "Add branches under Organization, then budgets on the Budget plan tab.")
      }</div>`;
  drawColumns(
    "budget-months",
    r.monthly.map((m) => ({
      label: bgMonth(m.month),
      values: [Math.round(m.budget / 1e3) / 100, m.closed ? Math.round(m.actual / 1e3) / 100 : 0],
      tip: `${bgMonth(m.month)}: budget ₹${(m.budget / 1e5).toFixed(2)} L${m.closed ? `, spent ₹${(m.actual / 1e5).toFixed(2)} L` : ""}`,
    })),
    [DASH.joined, DASH.left],
    { legend: ["Budget", "Spent"] },
  );
  chartTips();
  document.querySelector("#budget-filters").onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    budgetGroup = f.group;
    budgetSearch = f.q.trim();
    render();
  };
  const csv = document.querySelector("#budget-csv");
  csv.onclick = () =>
    busy(csv, () => download(`/admin/budgets/report?${bgQuery({ group: budgetGroup, format: "csv" })}`, `budget-${r.label}-${budgetGroup}.csv`));
}

// ---- budget plan -----------------------------------------------------------------------------------
function budgetPlan(body, p) {
  const edit = has("budget.manage") && !budgetLocked(p);
  const heads = p.heads.filter((h) => h.active);
  const list = p.branches.filter(
    (b) => !budgetSearch || `${b.name} ${b.code ?? ""} ${b.zone ?? ""} ${b.region ?? ""}`.toLowerCase().includes(budgetSearch.toLowerCase()),
  );
  const total = (b) => heads.reduce((s, h) => s + (p.lines[b.id]?.[h.id] ?? 0), 0);
  const colTotal = (h) => p.branches.reduce((s, b) => s + (p.lines[b.id]?.[h.id] ?? 0), 0);
  const missing = p.branches.filter((b) => b.active && !total(b)).length;
  body.innerHTML = `<div class="card"><div class="card-head"><div><h2>Budget plan ${esc(p.label)}</h2><p class="muted">Yearly budget by branch and head. Click an amount to change it or split it by month. ${missing ? `<strong>${missing} active branches have no budget yet.</strong>` : "Every active branch has a budget."}</p></div><div class="actions">${
    edit
      ? '<button class="ghost" id="plan-template">Download sheet</button><button class="secondary" id="plan-import">Import sheet</button><button class="secondary" id="plan-copy">Copy from another year</button>'
      : ""
  }</div></div>
  <form class="filters" id="plan-filter"><label>Search<input name="q" value="${esc(budgetSearch)}" placeholder="Branch, code, zone or region"></label><button>Show</button></form>
  ${
    list.length
      ? `<div class="table-wrap budget-grid"><table><thead><tr><th>Branch</th>${heads.map((h) => `<th class="num" title="${esc(h.name)}">${esc(h.code)}</th>`).join("")}<th class="num">Total</th><th class="num">Posts</th></tr></thead><tbody>${list
          .map(
            (b) =>
              `<tr><td>${esc(b.name)}${b.head_office ? ' <span class="pill">HO</span>' : ""}<small>${esc([b.code, b.zone, b.region].filter(Boolean).join(" · "))}</small></td>${heads
                .map((h) => {
                  const v = p.lines[b.id]?.[h.id] ?? 0;
                  return `<td class="num">${edit ? `<button type="button" class="ghost budget-cell" data-line="${b.id}:${h.id}" aria-label="${esc(`${b.name}, ${h.name}: ${inr(v)}. Change`)}">${v ? bgAmount(v) : "+"}</button>` : v ? bgAmount(v) : "—"}</td>`;
                })
                .join("")}<td class="num"><strong>${bgAmount(total(b))}</strong></td><td class="num">${p.posts[b.id] ?? "—"}</td></tr>`,
          )
          .join("")}<tr><td><strong>All branches</strong></td>${heads.map((h) => `<td class="num"><strong>${bgAmount(colTotal(h))}</strong></td>`).join("")}<td class="num"><strong>${bgAmount(heads.reduce((s, h) => s + colTotal(h), 0))}</strong></td><td></td></tr></tbody></table></div>`
      : empty("No branches", budgetSearch ? "No match for that search." : "Add branches under Organization first.")
  }</div>`;
  document.querySelector("#plan-filter").onsubmit = (e) => {
    e.preventDefault();
    budgetSearch = new FormData(e.target).get("q").trim();
    render();
  };
  if (!edit) return;
  body.querySelectorAll("[data-line]").forEach(
    (btn) =>
      (btn.onclick = async () => {
        const [branchId, headId] = btn.dataset.line.split(":").map(Number);
        const b = p.branches.find((x) => x.id === branchId);
        const h = heads.find((x) => x.id === headId);
        const line = await api(`/admin/budgets/line?${bgQuery({ branch_id: branchId, head_id: headId })}`);
        const annual = line.months.reduce((s, m) => s + m.amount, 0);
        dialog(
          `${b.name} · ${h.name}`,
          `${input("annual", "Yearly budget (₹), split evenly over 12 months", annual || "", 'type="number" min="0" step="1"')}<details class="full"><summary>Or set each month</summary><div class="form-grid budget-months">${line.months
            .map((m) => input(`m_${m.month}`, bgMonth(m.month), m.amount || "", 'type="number" min="0" step="1"'))
            .join("")}</div></details>${p.status === "approved" ? '<label class="full">Reason for the change (the budget is approved)<input name="reason" maxlength="300" required></label>' : ""}`,
          async (f) => {
            const months = line.months.map((m) => f[`m_${m.month}`]);
            const byMonth = months.some((v, i) => Number(v || 0) !== line.months[i].amount);
            const r = await api(
              "/admin/budgets/line",
              {
                fy: p.fy,
                branch_id: branchId,
                head_id: headId,
                ...(byMonth ? { months: months.map((v) => Number(v || 0)) } : { annual: Number(f.annual || 0) }),
                reason: f.reason || undefined,
              },
              "PUT",
            );
            notice(`${b.name}: ${h.name} set to ${inr(r.annual)} for the year.`);
          },
        );
      }),
  );
  document.querySelector("#plan-template").onclick = () =>
    sampleCsv(
      `budget-${p.label}.csv`,
      ["branch_code", "branch", "head", "annual", ...MONTH_COLS],
      p.branches
        .filter((b) => b.active)
        .flatMap((b) => heads.map((h) => [b.code ?? "", b.name, h.code, p.lines[b.id]?.[h.id] ?? "", ...MONTH_COLS.map(() => "")].map(csvField).join(",")))
        .join("\r\n"),
    );
  document.querySelector("#plan-import").onclick = () =>
    budgetImport({
      title: `Import budget ${p.label}`,
      help: "One row per branch and head. Use the branch code (or name) and the head code. Fill either annual (split evenly) or the twelve month columns apr … mar. Amounts are in rupees.",
      path: "/admin/budgets/import",
      extra: { fy: p.fy, kind: "lines" },
      cols: [["branch", "Branch"], ["head", "Head"], ["annual", "Yearly"]],
      needsReason: p.status === "approved",
    });
  document.querySelector("#plan-copy").onclick = () =>
    dialog(
      `Fill ${p.label} from another year`,
      `<label>Copy from<select name="from_fy">${[p.fy - 1, p.fy - 2, p.fy + 1].map((y) => `<option value="${y}">${y}-${String(y + 1).slice(2)}</option>`).join("")}</select></label>${input("change_pct", "Raise or lower by (%)", 10, 'type="number" min="-90" max="500" step="0.1"')}<p class="full muted">Every branch and head in that year is copied into this one, month by month, changed by the percentage. Amounts already in ${esc(p.label)} for the same branch and head are replaced.</p>`,
      async (f) => {
        const r = await api("/admin/budgets/copy", { fy: p.fy, from_fy: Number(f.from_fy), change_pct: Number(f.change_pct || 0) });
        notice(`${r.lines} budget lines filled.`);
      },
    );
}

// A CSV import with a check first: the file is checked, problems listed, then saved.
function budgetImport({ title, help, path, extra, cols, needsReason = false, after = null }) {
  const pick = Object.assign(document.createElement("input"), { type: "file", accept: ".csv,text/csv" });
  pick.onchange = async () => {
    const file = pick.files[0];
    if (!file) return;
    try {
      const rows = await csvRows(file);
      const check = await api(path, { ...extra, rows, dry_run: true });
      dialog(
        title,
        `<p class="full muted">${esc(help)}</p><p class="full"><strong>${esc(file.name)}</strong>: ${check.ok} rows ready${check.failed ? `, <strong>${check.failed} with problems</strong>. Fix them in the sheet and import it again; nothing is saved until every row is right.` : "."}</p><div class="full">${reportTable(check.report, cols)}</div>${!check.failed && needsReason ? '<label class="full">Reason for the change (the budget is approved)<input name="reason" maxlength="300" required></label>' : ""}`,
        async (f) => {
          if (check.failed) return;
          const r = await api(path, { ...extra, rows, reason: f.reason || undefined });
          notice(`${r.ok} rows saved.`);
          after?.();
        },
      );
      if (check.failed) document.querySelector("dialog [type=submit]").textContent = "Close";
    } catch (e) {
      notice(e.message, true);
    }
  };
  pick.click();
}

// ---- manpower plan ---------------------------------------------------------------------------------
async function budgetManpower(id, body, p) {
  const r = await api(`/admin/budgets/report?${bgQuery()}`);
  if (id !== renderId) return;
  const edit = has("budget.manage") && !budgetLocked(p);
  const list = r.branches.filter(
    (b) => b.id != null && (!budgetSearch || `${b.name} ${b.code ?? ""} ${b.zone ?? ""} ${b.region ?? ""}`.toLowerCase().includes(budgetSearch.toLowerCase())),
  );
  body.innerHTML = `<div class="card"><div class="card-head"><div><h2>Manpower plan ${esc(p.label)}</h2><p class="muted">Sanctioned posts by branch and designation, against the people there today and the openings being hired for. Total: ${r.total.filled} people, ${r.total.sanctioned} sanctioned posts, ${r.total.vacant} vacant.</p></div><div class="actions">${edit ? '<button class="ghost" id="posts-template">Download sheet</button><button class="secondary" id="posts-import">Import sheet</button>' : ""}</div></div>
  <form class="filters" id="posts-filter"><label>Search<input name="q" value="${esc(budgetSearch)}" placeholder="Branch, code, zone or region"></label><button>Show</button></form>
  ${
    list.length
      ? `<div class="table-wrap"><table><thead><tr><th>Branch</th><th class="num">Sanctioned</th><th class="num">People</th><th class="num">Being hired</th><th class="num">Vacant</th><th class="num">Above plan</th><th></th></tr></thead><tbody>${list
          .map(
            (b) =>
              `<tr><td>${esc(b.name)}${b.head_office ? ' <span class="pill">HO</span>' : ""}<small>${esc([b.code, b.zone, b.region].filter(Boolean).join(" · "))}</small></td><td class="num">${b.sanctioned || "—"}</td><td class="num">${b.filled}</td><td class="num">${b.open || "—"}</td><td class="num">${b.vacant ? `<span class="pill warn">${b.vacant}</span>` : "—"}</td><td class="num">${b.excess ? `<span class="pill danger">${b.excess}</span>` : "—"}</td><td><button type="button" class="${edit ? "secondary" : "ghost"}" data-posts="${b.id}">${edit ? "Posts…" : "View"}</button></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : empty("No branches", "Add branches under Organization first.")
  }</div>`;
  document.querySelector("#posts-filter").onsubmit = (e) => {
    e.preventDefault();
    budgetSearch = new FormData(e.target).get("q").trim();
    render();
  };
  body.querySelectorAll("[data-posts]").forEach(
    (btn) =>
      (btn.onclick = () =>
        busy(btn, async () => {
          const d = await api(`/admin/budgets/posts?${bgQuery({ branch_id: btn.dataset.posts })}`);
          const table = `<div class="table-wrap full"><table><thead><tr><th>Designation</th><th class="num">People</th><th class="num">Being hired</th><th>Sanctioned</th></tr></thead><tbody>${d.rows
            .map(
              (r) =>
                `<tr><td>${esc(r.name)}</td><td class="num">${r.filled}</td><td class="num">${r.open || "—"}</td><td>${edit ? `<input name="d_${r.designation_id}" type="number" min="0" max="10000" step="1" value="${r.sanctioned || ""}" aria-label="${esc(`Sanctioned ${r.name}`)}">` : r.sanctioned || "—"}</td></tr>`,
            )
            .join("")}</tbody></table></div>${d.no_designation ? `<p class="full muted">${d.no_designation} people here have no designation.</p>` : ""}`;
          if (!edit) return viewDialog(`Posts · ${d.branch.name}`, table);
          dialog(`Sanctioned posts · ${d.branch.name}`, table, async (f) => {
            await api(
              "/admin/budgets/posts",
              {
                fy: p.fy,
                branch_id: d.branch.id,
                rows: d.rows.map((r) => ({ designation_id: r.designation_id, sanctioned: Number(f[`d_${r.designation_id}`] || 0) })),
              },
              "PUT",
            );
            notice("Posts saved.");
          });
        })),
  );
  if (!edit) return;
  document.querySelector("#posts-template").onclick = async () => {
    const org = await api("/admin/org");
    sampleCsv(
      `manpower-${p.label}.csv`,
      ["branch_code", "branch", "designation", "sanctioned"],
      p.branches
        .filter((b) => b.active)
        .flatMap((b) => org.designations.map((d) => [b.code ?? "", b.name, d.name, ""].map(csvField).join(",")))
        .join("\r\n"),
    );
  };
  document.querySelector("#posts-import").onclick = () =>
    budgetImport({
      title: `Import manpower plan ${p.label}`,
      help: "One row per branch and designation: branch code (or name), designation name, sanctioned posts. Rows you leave out are not changed.",
      path: "/admin/budgets/import",
      extra: { fy: p.fy, kind: "posts" },
      cols: [["branch", "Branch"], ["designation", "Designation"], ["sanctioned", "Sanctioned"]],
    });
}

// ---- spending entered by hand --------------------------------------------------------------------
async function budgetSpending(id, body, p) {
  const rows = await api(`/admin/budgets/spend?fy=${p.fy}`);
  if (id !== renderId) return;
  const manual = p.heads.filter((h) => h.active && h.source === "manual");
  const auto = p.heads.filter((h) => h.active && h.source !== "manual");
  body.innerHTML = `<div class="card"><div class="card-head"><div><h2>Spending ${esc(p.label)}</h2><p class="muted">Enter spending for heads the HRMS does not record itself (${manual.map((h) => esc(h.name)).join(", ") || "none"}). ${auto.map((h) => `${esc(h.name)} comes from ${h.source === "payroll" ? "approved payroll" : "approved claims"}`).join("; ")}.</p></div><div class="actions">${has("budget.manage") && manual.length ? '<button id="spend-add">+ Add spending</button>' : ""}</div></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Branch</th><th>Head</th><th class="num">Amount</th><th>For</th><th></th></tr></thead><tbody>${rows
          .map(
            (s) =>
              `<tr><td>${fmtDate(s.spent_on)}</td><td>${esc(s.branch_name)}</td><td>${esc(s.head_name)}</td><td class="num">${inr(s.amount)}</td><td>${esc(s.description)}${s.reference ? `<small>Ref ${esc(s.reference)}</small>` : ""}<small>Entered by ${esc(s.created_by_name || "—")}</small></td><td>${has("budget.manage") ? `<button type="button" class="ghost" data-spend-del="${s.id}" aria-label="Remove this entry">Remove</button>` : ""}</td></tr>`,
          )
          .join("")}</tbody></table></div>${rows.length >= 500 ? '<p class="muted">Showing the latest 500.</p>' : ""}`
      : empty("No spending entered", "Entries appear here and count against the branch budget.")
  }</div>`;
  document.querySelector("#spend-add")?.addEventListener("click", () =>
    dialog(
      "Add spending",
      `<label>Branch<select name="branch_id" required>${p.branches.filter((b) => b.active).map((b) => `<option value="${b.id}">${esc(b.name)}${b.code ? ` (${esc(b.code)})` : ""}</option>`).join("")}</select></label>${sel("head_id", "Budget head", manual.map((h) => [String(h.id), h.name]))}${input("spent_on", "Date", today(), `type="date" max="${today()}" required`)}${input("amount", "Amount (₹)", "", 'type="number" min="1" step="1" required')}<label class="full">What it was for<input name="description" maxlength="300" required placeholder="e.g. Induction training, Kota branch"></label>${input("reference", "Bill or voucher number (optional)", "", 'maxlength="60"')}`,
      async (f) => {
        await api("/admin/budgets/spend", { ...f, branch_id: Number(f.branch_id), head_id: Number(f.head_id), amount: Number(f.amount) });
        notice("Spending added.");
      },
    ),
  );
  body.querySelectorAll("[data-spend-del]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          if (!confirm("Remove this spending entry? It is kept in the activity log.")) return;
          await api(`/admin/budgets/spend/${b.dataset.spendDel}`, undefined, "DELETE");
          notice("Entry removed.");
          render();
        })),
  );
}

// ---- setup -------------------------------------------------------------------------------------------
function budgetSetup(body, p) {
  const ho = p.branches.find((b) => b.head_office);
  body.innerHTML = `${
    has("org.manage")
      ? `<div class="card"><div class="card-head"><div><h2>Head office and zones</h2><p class="muted">The head office is shown on its own in every report. Zones and regions group branches; set them here for all branches at once from a sheet, or one by one under Organization → Branches.</p></div><div class="actions"><button class="ghost" id="groups-template">Download sheet</button><button class="secondary" id="groups-import">Import zones and regions</button></div></div><form class="filters" id="ho-form"><label>Head office<select name="branch_id">${p.branches.map((b) => `<option value="${b.id}" ${b.id === ho?.id ? "selected" : ""}>${esc(b.name)}${b.city ? `, ${esc(b.city)}` : ""}</option>`).join("")}</select></label><button>Save</button></form></div>`
      : ""
  }${
    has("budget.manage")
      ? `<div class="card"><div class="card-head"><div><h2>Budget heads</h2><p class="muted">The lines every branch budget is made of. One head can take its spending from payroll and one from approved claims; the rest are entered on the Spending tab.</p></div><div class="actions"><button id="head-add">+ Add head</button></div></div><div class="table-wrap"><table><thead><tr><th>Head</th><th>Code</th><th>Spending from</th><th>Status</th><th></th></tr></thead><tbody>${p.heads
          .map(
            (h) =>
              `<tr><td>${esc(h.name)}</td><td>${esc(h.code)}</td><td>${BUDGET_SOURCE[h.source]}</td><td><span class="pill ${h.active ? "" : "neutral"}">${h.active ? "In use" : "Retired"}</span></td><td><button type="button" class="secondary" data-head-edit="${h.id}">Edit</button></td></tr>`,
          )
          .join("")}</tbody></table></div></div>`
      : ""
  }`;
  const hoForm = document.querySelector("#ho-form");
  if (hoForm)
    hoForm.onsubmit = (e) => {
      e.preventDefault();
      busy(e.submitter, async () => {
        await api("/admin/budgets/head-office", { branch_id: Number(new FormData(hoForm).get("branch_id")) }, "PUT");
        notice("Head office saved.");
        render();
      });
    };
  document.querySelector("#groups-template")?.addEventListener("click", () =>
    sampleCsv(
      "branch-zones.csv",
      ["branch_code", "branch", "zone", "region"],
      p.branches.map((b) => [b.code ?? "", b.name, b.zone ?? "", b.region ?? ""].map(csvField).join(",")).join("\r\n"),
    ),
  );
  document.querySelector("#groups-import")?.addEventListener("click", () =>
    budgetImport({
      title: "Import zones and regions",
      help: "One row per branch: branch code (or name), zone, region. A blank zone or region clears it.",
      path: "/admin/budgets/branch-groups",
      extra: {},
      cols: [["branch", "Branch"], ["zone", "Zone"], ["region", "Region"]],
    }),
  );
  const headDialog = (h) =>
    dialog(
      h ? `Edit ${h.name}` : "Add a budget head",
      `${input("name", "Name", h?.name ?? "", 'maxlength="80" required placeholder="e.g. Branch rent"')}${input("code", "Code", h?.code ?? "", 'maxlength="12" required placeholder="e.g. RENT"')}${sel("source", "Spending from", Object.entries(BUDGET_SOURCE), h?.source ?? "manual")}${h ? sel("active", "Status", [["1", "In use"], ["0", "Retired"]], String(h.active)) : ""}`,
      async (f) => {
        const b = { name: f.name, code: f.code, source: f.source, ...(h ? { active: f.active === "1" } : {}) };
        await api(`/admin/budgets/heads${h ? `/${h.id}` : ""}`, b, h ? "PATCH" : "POST");
        notice("Budget head saved.");
      },
    );
  document.querySelector("#head-add")?.addEventListener("click", () => headDialog());
  body.querySelectorAll("[data-head-edit]").forEach(
    (b) => (b.onclick = () => headDialog(p.heads.find((h) => h.id === Number(b.dataset.headEdit)))),
  );
}
