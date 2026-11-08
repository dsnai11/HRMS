// Branch budgets → Salary by branch: the branch-wise salary distribution sheet, worked out by
// the HRMS every month. Each person's salary is on the branches they cover (from the reporting
// lines), shared by AUM. Nothing needs to be entered here.
let saMonth = null;
let saSearch = "";
const SA_HOW = { own: "Own branch", aum: "Shared by AUM", equal: "Shared equally (no AUM)" };
const saMonthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
const saWhen = (iso) => (iso ? new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");
const saPeople = (n) => `${n} ${n === 1 ? "person" : "people"}`;
const saAum = (v) => (v == null ? "—" : `₹${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`);

async function saTab(id, body) {
  const v = await api(`/admin/salary-allocation${saMonth ? `?month=${saMonth}` : ""}`);
  if (id !== renderId) return;
  saMonth = v.month;
  const today = new Date().toISOString().slice(0, 7);
  const months = [...new Set([today, ...v.months, v.month])].sort().reverse();
  const run = v.run;
  const issues = run?.issues ?? [];
  const list = v.branches
    .filter((b) => !saSearch || `${b.name} ${b.code ?? ""} ${b.state ?? ""}`.toLowerCase().includes(saSearch.toLowerCase()))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  const source = !run
    ? "Not worked out yet."
    : run.salary_source === "payroll"
      ? "Salaries from the approved payroll run (employer cost)."
      : "Salaries from each person's monthly gross; once the month's payroll run is approved, its employer cost is used instead.";
  const feed = v.feed.configured
    ? v.feed.last?.error
      ? `AUM: the loan system feed failed (${esc(v.feed.last.error)}); the latest AUM held is used.`
      : `AUM comes from the loan system automatically${v.feed.last ? `, last read ${saWhen(v.feed.last.at)}` : ""}.`
    : `AUM: ${v.aum_month ? `using the figures for ${esc(saMonthLabel(v.aum_month))}` : "none yet"}. The loan system feed is not connected yet (AUM_FEED_URL).`;
  body.innerHTML = `<div class="card"><div class="card-head"><div><h2>Salary by branch, ${esc(saMonthLabel(v.month))}</h2><p class="muted">Each person's salary is put on the branches they cover. Branch staff count fully to their branch. Managers who cover several branches (their team sits in them) are shared across those branches in proportion to each branch's AUM. This is worked out by itself every hour for this month and last month, from the reporting lines, salaries and AUM; nothing needs to be entered.</p></div>
      <div class="actions"><label>Month<select id="sa-month">${months.map((m) => `<option value="${m}" ${m === v.month ? "selected" : ""}>${esc(saMonthLabel(m))}</option>`).join("")}</select></label></div></div>
      <p class="muted">${source} ${feed}${run ? ` Last worked out ${saWhen(run.ran_at)}.` : ""}</p></div>
    <div class="stats budget-kpis">
      <div class="stat"><div class="stat-label">Salary on branches</div><div class="stat-value">${bgAmount(v.total)}</div><small class="muted">${saPeople(run ? run.people : 0)}</small></div>
      <div class="stat"><div class="stat-label">Shared by AUM</div><div class="stat-value">${v.shared_people}</div><small class="muted">people covering more than one branch</small></div>
      <div class="stat"><div class="stat-label">Total AUM</div><div class="stat-value">${saAum(Math.round(v.total_aum * 100) / 100)}</div><small class="muted">${v.branches.filter((b) => b.aum != null).length} of ${v.branches.length} branches</small></div>
      <div class="stat"><div class="stat-label">Needs attention</div><div class="stat-value">${issues.length}</div><small class="muted">${issues.length ? "see below" : "nothing missing"}</small></div>
    </div>
    ${issues.length ? `<div class="card"><h2>Needs attention</h2><ul>${issues.map(saIssue).join("")}</ul></div>` : ""}
    <div class="card"><div class="card-head"><div><h2>Branches</h2><p class="muted">Choose a branch to see whose salary is on it and how much.</p></div><div class="actions"><button class="secondary" id="sa-csv">↓ Excel (CSV)</button>${has("budget.manage") ? '<button class="ghost" id="sa-recalc">Work out again now</button><button class="ghost" id="sa-sheet">Load from budget sheet</button>' : ""}</div></div>
      <form class="filters" id="sa-filters"><label>Search<input name="q" value="${esc(saSearch)}" placeholder="Branch, code or state"></label><button>Show</button></form>
      ${
        list.length
          ? `<div class="table-wrap"><table><thead><tr><th>Branch</th><th>State</th><th>AUM</th><th>Own staff</th><th>Shared</th><th>Total salary</th></tr></thead><tbody>${list
              .map(
                (b) =>
                  `<tr><td><button class="link" data-sa-branch="${b.id}">${esc(b.name)}</button>${b.code ? `<small>${esc(b.code)}</small>` : ""}</td><td>${esc(b.state || "—")}</td><td>${saAum(b.aum)}${b.aum_month && b.aum_month !== v.month ? `<small>${esc(saMonthLabel(b.aum_month))}</small>` : ""}</td><td>${bgAmount(b.own)}<small>${saPeople(b.own_people)}</small></td><td>${bgAmount(b.shared)}<small>${saPeople(b.shared_people)}</small></td><td><strong>${bgAmount(b.total)}</strong></td></tr>`,
              )
              .join("")}</tbody></table></div>`
          : empty("No branches", saSearch ? "No match for that search." : "Branches appear here once they are added.")
      }</div>`;
  document.querySelector("#sa-month").onchange = (e) => {
    saMonth = e.target.value;
    render();
  };
  document.querySelector("#sa-filters").onsubmit = (e) => {
    e.preventDefault();
    saSearch = new FormData(e.target).get("q").trim();
    render();
  };
  const csv = document.querySelector("#sa-csv");
  csv.onclick = () => busy(csv, () => download(`/admin/salary-allocation/export?month=${v.month}`, `salary-by-branch-${v.month}.csv`));
  document.querySelectorAll("[data-sa-branch]").forEach((b) => (b.onclick = () => saBranchDialog(Number(b.dataset.saBranch), v.month)));
  const recalc = document.querySelector("#sa-recalc");
  if (recalc)
    recalc.onclick = () =>
      busy(recalc, async () => {
        await api("/admin/salary-allocation/recalculate", { month: v.month });
        notice("Worked out again.");
        render();
      });
  const sheet = document.querySelector("#sa-sheet");
  if (sheet) sheet.onclick = () => saSheetDialog(v.month);
}

function saIssue(i) {
  if (i.kind === "no_salary") return `<li>${i.count} ${i.count === 1 ? "person" : "people"}: ${esc(i.text)} <small>${esc(i.names.join(", "))}${i.count > i.names.length ? "…" : ""}</small></li>`;
  if (i.kind === "no_aum") return `<li>${esc(i.name || "A branch")}: ${esc(i.text)}</li>`;
  return `<li>${esc(i.name)}${i.code ? ` (${esc(i.code)})` : ""}: ${esc(i.text)}</li>`;
}

async function saBranchDialog(branchId, month) {
  const r = await api(`/admin/salary-allocation/branch/${branchId}?month=${month}`);
  const total = r.people.reduce((s, p) => s + p.amount, 0);
  dialog(
    `${r.branch.name}, ${saMonthLabel(month)}`,
    `<p class="full">Salary on this branch: <strong>${bgAmount(total)}</strong> from ${r.people.length} people.</p>${
      r.people.length
        ? `<div class="full table-wrap"><table><thead><tr><th>Person</th><th>How</th><th>Share</th><th>On this branch</th></tr></thead><tbody>${r.people
            .map(
              (p) =>
                `<tr><td>${esc(p.name)}<small>${esc([p.employee_code, p.designation, p.home_branch].filter(Boolean).join(" · "))}</small></td><td>${SA_HOW[p.basis]}${p.basis === "own" ? "" : `<small>across ${p.branches} branches</small>`}</td><td>${p.basis === "own" ? "100%" : `${(p.share * 100).toFixed(1)}%`}<small>of ${bgAmount(p.salary)}</small></td><td>${bgAmount(p.amount)}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : '<p class="full muted">Nobody\'s salary is on this branch for the month.</p>'
    }`,
    async () => {},
  );
}

// One-time start: the branch-wise salary sheet gives the month's AUM, adds branches not in the
// HRMS yet, and records the branches people without a team cover.
function saSheetDialog(month) {
  let payload = null;
  let preview = null;
  dialog(
    "Load from the budget sheet",
    `<p class="full muted">Choose the branch-wise salary distribution sheet (.xlsx) with Branch and AUM columns and the employee code columns (BM, SBM, CM, RSM/ASM, FPR, Team Leader, Credit, ACM, RCM, Legal…). It loads the month's AUM, adds branches the HRMS does not have yet, and records which branches each listed person covers. Salaries are not taken from the sheet: they come from the HRMS. You see what it will do first.</p><label class="full">Sheet<input type="file" id="sa-file" accept=".xlsx"></label><div class="full" id="sa-report"></div>`,
    async () => {
      if (!preview) throw new Error("Choose the sheet first.");
      const r = await api("/admin/salary-allocation/sheet", { ...payload, dry_run: false });
      saMonth = r.month;
      notice(`Loaded AUM for ${r.branches} branches for ${saMonthLabel(r.month)}${r.new_branches.length ? `, added ${r.new_branches.length} branches` : ""}, and worked out the month.`);
    },
  );
  const out = document.querySelector("dialog #sa-report");
  document.querySelector("dialog #sa-file").onchange = async (e) => {
    payload = preview = null;
    const file = e.target.files[0];
    if (!file) return (out.innerHTML = "");
    out.innerHTML = '<p class="muted">Reading the sheet…</p>';
    try {
      const sheets = await dgXlsxSheets(file);
      let found = null;
      for (const rows of sheets) {
        const at = rows.findIndex((r) => r.cells.some((c) => /^branch$/i.test(String(c).trim())) && r.cells.some((c) => /^aum$/i.test(String(c).trim())));
        if (at >= 0) {
          found = { header: rows[at].cells, rows: rows.slice(at + 1).map((r) => r.cells) };
          break;
        }
      }
      if (!found) throw new Error("The sheet needs columns headed Branch and AUM.");
      payload = { ...found, month: null };
      preview = await api("/admin/salary-allocation/sheet", { ...payload, dry_run: true });
      out.innerHTML = `<p>For <strong>${esc(saMonthLabel(preview.month))}</strong>: ${preview.branches} branches, total AUM ${saAum(preview.total_aum)}.</p>
        <ul><li>${preview.new_branches.length ? `${preview.new_branches.length} branches will be added: ${esc(preview.new_branches.slice(0, 12).join(", "))}${preview.new_branches.length > 12 ? "…" : ""}` : "Every branch is already in the HRMS."}</li>
        <li>${preview.people_found} people found by employee code; their branches will be recorded.</li>
        ${preview.codes_not_found_count ? `<li>${preview.codes_not_found_count} employee codes are not in the HRMS yet (for example ${esc(preview.codes_not_found.slice(0, 8).join(", "))}). Their salaries are worked out once they are added as employees.</li>` : ""}</ul>`;
    } catch (err) {
      out.innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
    }
  };
}
