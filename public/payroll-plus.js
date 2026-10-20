// Payroll extras: tax declarations (employee and payroll), cost report against budget, year to date.
const DECL_STATUS = {
  draft: "Draft",
  submitted: "With payroll",
  verified: "Verified",
  changes_requested: "Changes needed",
};
const toB64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("The file could not be read."));
    r.readAsDataURL(file);
  });

// ---- employee: year to date and tax declaration on the Payslips page ----------------------------------
async function ytdCard(id) {
  const d = await api("/payslips/ytd");
  if (id !== renderId || !d.months.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Year to date · ${d.label}</h2><div class="stats"><div class="stat"><div class="stat-label">Gross earned</div><div class="stat-value">${inr(d.total.gross)}</div></div><div class="stat"><div class="stat-label">Deductions</div><div class="stat-value">${inr(d.total.deductions)}</div></div><div class="stat"><div class="stat-label">Net pay</div><div class="stat-value">${inr(d.total.net)}</div></div><div class="stat"><div class="stat-label">Tax deducted</div><div class="stat-value">${inr(d.total.tds)}</div></div></div>`;
  document.querySelector("#content").append(card);
}

async function declarationCard(id) {
  const d = await api("/tax-declaration");
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  const decl = d.declaration;
  const cmp = d.comparison;
  card.innerHTML = `<div class="card-head"><div><h2>Investment declaration · ${d.label}</h2><p class="muted">Tell payroll about tax-saving investments so less tax is deducted each month. Choose the old regime only if the deductions below make it cheaper. Attach proof where you can; payroll verifies it.${d.open ? "" : " <strong>Declarations are closed right now.</strong>"}</p></div><div class="actions">${decl ? `<span class="pill ${decl.status === "verified" ? "" : "neutral"}">${DECL_STATUS[decl.status]}</span>` : ""}${d.editable ? '<button class="secondary" id="edit-decl">Edit</button>' : ""}${d.editable && decl && d.items.length ? '<button id="submit-decl">Submit to payroll</button>' : ""}</div></div>${decl?.review_note ? `<p class="join-note">Payroll says: ${esc(decl.review_note)}</p>` : ""}${
    cmp
      ? `<div class="stats"><div class="stat"><div class="stat-label">Estimated yearly tax · new regime</div><div class="stat-value">${inr(cmp.new)}</div></div><div class="stat"><div class="stat-label">Old regime with your deductions (${inr(cmp.declared)})</div><div class="stat-value">${inr(cmp.old)}</div></div></div><p class="muted">A rough estimate from your current gross, before payroll's own calculation. ${cmp.old < cmp.new ? "The old regime looks cheaper for you." : "The new regime looks cheaper for you."}</p>`
      : ""
  }${
    d.items.length
      ? `<div class="table-wrap"><table><thead><tr><th>Section</th><th>Details</th><th>Declared</th><th>Counted</th><th>Proof</th><th>Status</th></tr></thead><tbody>${d.items.map((i) => `<tr><td>${esc(i.section)}</td><td>${esc(i.description || "—")}</td><td>${inr(i.amount)}</td><td>${i.status === "verified" ? inr(i.verified_amount) : i.status === "rejected" ? "—" : `${inr(i.amount)} (provisional)`}</td><td>${esc(i.proof_name || "—")}</td><td><span class="pill ${i.status === "verified" ? "" : "neutral"}">${i.status}</span>${i.note ? `<small>${esc(i.note)}</small>` : ""}</td></tr>`).join("")}</tbody></table></div><p class="muted">Counted in total: <strong>${inr(d.allowed.total)}</strong> (limits per section are applied).${decl?.regime === "new" ? " You are on the new regime, so these deductions do not reduce tax." : ""}</p>`
      : '<p class="muted">Nothing declared yet.</p>'
  }`;
  document.querySelector("#content").append(card);
  card
    .querySelector("#edit-decl")
    ?.addEventListener("click", () => declarationDialog(d));
  card.querySelector("#submit-decl")?.addEventListener("click", (e) =>
    busy(e.target, async () => {
      await api("/tax-declaration/submit", {});
      notice("Submitted to payroll.");
      render();
    }),
  );
}

function declarationDialog(d) {
  let n = 0;
  const row = (it = {}) => {
    const k = ++n;
    return `<div class="card builder-row" data-row><label>Section<select name="s_${k}">${d.sections.map((s) => `<option value="${s.key}" ${it.section === s.key ? "selected" : ""}>${esc(s.key)} · ${esc(s.label)}${s.cap ? ` (up to ${inr(s.cap)})` : ""}</option>`).join("")}</select></label>${input(`a_${k}`, "Amount for the year (₹)", it.amount ?? "", 'type="number" min="0" required')}<label class="full">Details<input name="d_${k}" value="${esc(it.description || "")}" maxlength="150"></label><label class="full">Proof (PDF, JPG or PNG up to 2 MB)${it.proof_name ? ` — currently: ${esc(it.proof_name)}` : ""}<input type="file" name="f_${k}" accept="application/pdf,image/jpeg,image/png"></label><input type="hidden" name="o_${k}" value="${it.document_id ?? ""}"><button type="button" class="ghost" data-remove-row>Remove</button></div>`;
  };
  dialog(
    "Investment declaration",
    `<label class="full">Tax regime<select name="regime"><option value="new" ${d.declaration?.regime !== "old" ? "selected" : ""}>New regime (no deductions)</option><option value="old" ${d.declaration?.regime === "old" ? "selected" : ""}>Old regime (with deductions)</option></select></label><div class="full" id="decl-rows">${d.items.map(row).join("")}</div><div class="full actions"><button type="button" class="secondary" id="add-decl-row">Add an item</button></div>`,
    async (f, form) => {
      const items = [];
      for (const k of Object.keys(f)
        .filter((x) => x.startsWith("s_"))
        .map((x) => x.slice(2))) {
        let docId = f[`o_${k}`] ? Number(f[`o_${k}`]) : null;
        const file = document.querySelector(`dialog [name=f_${k}]`)?.files[0];
        if (file) {
          if (file.size > 2 * 1024 * 1024)
            throw new Error("Each proof can be up to 2 MB.");
          if (
            !["application/pdf", "image/jpeg", "image/png"].includes(file.type)
          )
            throw new Error("Use a PDF, JPG or PNG proof.");
          docId = (
            await api("/documents", {
              kind: "other",
              name: `Tax proof ${f[`s_${k}`]}`,
              mime: file.type,
              data: await toB64(file),
            })
          ).id;
        }
        items.push({
          section: f[`s_${k}`],
          amount: Number(f[`a_${k}`]),
          description: f[`d_${k}`] || undefined,
          document_id: docId ?? undefined,
        });
      }
      await api("/tax-declaration", { regime: f.regime, items }, "PUT");
      notice("Saved. Submit it to payroll when you are ready.");
    },
  );
  const dlg = document.querySelector("dialog");
  dlg.classList.add("wide");
  const wireRows = () =>
    dlg
      .querySelectorAll("[data-remove-row]")
      .forEach((b) => (b.onclick = () => b.closest("[data-row]").remove()));
  dlg.querySelector("#add-decl-row").onclick = () => {
    dlg.querySelector("#decl-rows").insertAdjacentHTML("beforeend", row());
    wireRows();
  };
  wireRows();
}

// ---- payroll: declarations to review ---------------------------------------------------------------------
MORE_TABS.declarations = {
  async html() {
    const d = await api("/admin/tax-declarations");
    return `<div class="card"><div class="card-head"><div><h2>Tax declarations · ${d.label}</h2><p class="muted">${d.rows.length} of ${d.people} people have declared. Pending amounts count provisionally until you verify the proof; verified amounts replace them. Employees on the new regime are unaffected.</p></div>${has("payroll.manage") ? `<button class="secondary" id="toggle-window">${d.open ? "Close declarations" : "Reopen declarations"}</button>` : ""}</div>${
      d.rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Regime</th><th>Items</th><th>To verify</th><th>Status</th><th></th></tr></thead><tbody>${d.rows.map((r) => `<tr><td>${esc(r.name)}<small>${esc(r.employee_code || "")}</small></td><td>${r.regime}</td><td>${r.items}</td><td>${r.pending_items}</td><td><span class="pill ${r.status === "verified" ? "" : "neutral"}">${DECL_STATUS[r.status]}</span></td><td><button class="secondary" data-review-decl="${r.id}">${r.status === "submitted" ? "Review" : "Open"}</button></td></tr>`).join("")}</tbody></table></div>`
        : empty(
            "No declarations yet",
            "Employees declare from their Payslips page.",
          )
    }</div>`;
  },
  async wire() {
    document
      .querySelector("#toggle-window")
      ?.addEventListener("click", async () => {
        const cur = await api("/admin/tax-declarations");
        await api(
          "/admin/tax-declarations/settings",
          { open: !cur.open },
          "PUT",
        );
        notice(
          cur.open ? "Declarations are closed." : "Declarations are open.",
        );
        render();
      });
    document.querySelectorAll("[data-review-decl]").forEach((b) => {
      b.onclick = async () => {
        const d = await api(`/admin/tax-declarations/${b.dataset.reviewDecl}`);
        const editable =
          d.declaration.status === "submitted" && has("payroll.manage");
        viewDialog(
          `Declaration · ${d.employee.name}`,
          `<p class="muted">Regime: ${d.declaration.regime}. Counted in total: ${inr(d.allowed.total)}${d.comparison ? ` · estimated yearly tax old ${inr(d.comparison.old)} / new ${inr(d.comparison.new)}` : ""}</p><form id="review-form"><div class="table-wrap"><table><thead><tr><th>Section</th><th>Declared</th><th>Proof</th><th>Decision</th><th>Verified amount</th></tr></thead><tbody>${d.items.map((i) => `<tr data-item="${i.id}"><td>${esc(i.section)}<small>${esc(i.description || "")}</small></td><td>${inr(i.amount)}</td><td>${i.document_id ? `<button type="button" class="ghost" data-proof="${i.id}">View</button>` : "—"}</td><td><select name="st_${i.id}" ${editable ? "" : "disabled"}>${["pending", "verified", "rejected"].map((s) => `<option ${i.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></td><td><input name="va_${i.id}" type="number" min="0" max="${i.amount}" value="${i.verified_amount ?? i.amount}" ${editable ? "" : "disabled"}></td></tr>`).join("")}</tbody></table></div>${editable ? '<label class="full">Note to the employee (required if asking for changes)<input name="note" maxlength="500"></label><p class="error-text" id="rv-error" role="alert"></p><div class="actions spaced"><button type="submit" data-decision="verified">Approve</button><button type="submit" class="secondary" data-decision="changes_requested">Ask for changes</button></div>' : ""}</form>`,
        );
        document
          .querySelectorAll("dialog [data-proof]")
          .forEach(
            (p) =>
              (p.onclick = () =>
                openFile(
                  `/api/admin/tax-declarations/items/${p.dataset.proof}/proof`,
                )),
          );
        const form = document.querySelector("dialog #review-form");
        if (!editable) return;
        form.onsubmit = async (e) => {
          e.preventDefault();
          const decision = e.submitter.dataset.decision;
          const f = Object.fromEntries(new FormData(form));
          try {
            await api(`/admin/tax-declarations/${d.declaration.id}/review`, {
              decision,
              note: f.note || undefined,
              items: d.items.map((i) => ({
                id: i.id,
                status: f[`st_${i.id}`],
                verified_amount: Number(f[`va_${i.id}`]),
              })),
            });
            document.querySelector("dialog")?.remove();
            notice("Saved.");
            render();
          } catch (err) {
            document.querySelector("dialog #rv-error").textContent =
              err.message;
          }
        };
      };
    });
  },
};
PAYROLL_TABS.declarations = "Tax declarations";

// ---- payroll: cost report against budget -------------------------------------------------------------------
let costFilter = { group: "department", from: "", to: "" };
const COST_GROUPS = {
  department: "Department",
  cost_centre: "Cost centre",
  business_unit: "Business unit",
  branch: "Branch",
  grade: "Grade",
  employment_type: "Employment type",
};
MORE_TABS.costs = {
  async html() {
    const m = new Date().toISOString().slice(0, 7);
    costFilter.to ||= m;
    costFilter.from ||=
      `${m.slice(0, 4)}-04` > m
        ? `${Number(m.slice(0, 4)) - 1}-04`
        : `${m.slice(0, 4)}-04`;
    const q = new URLSearchParams(costFilter);
    const r = await api(`/admin/payroll/cost-report?${q}`);
    const money = (v) => (v == null ? "—" : inr(v));
    const max = Math.max(...r.groups.map((g) => g.employer_cost), 1);
    return `<div class="card"><div class="card-head"><div><h2>Payroll cost report</h2><p class="muted">Employer cost from approved and paid payroll, grouped as you choose, against budget. People are grouped by where they are assigned today.</p></div><div class="actions">${r.budgets_supported && has("payroll.manage") ? '<button class="secondary" id="set-budget">Set budget</button>' : ""}<a class="button secondary" id="cost-csv" href="/api/admin/payroll/cost-report?${new URLSearchParams({ ...costFilter, format: "csv" })}">↓ CSV</a></div></div>
    <form class="filters" id="cost-form"><label>Group by<select name="group">${Object.entries(
      COST_GROUPS,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${k === costFilter.group ? "selected" : ""}>${v}</option>`,
      )
      .join(
        "",
      )}</select></label><label>From<input type="month" name="from" value="${costFilter.from}"></label><label>To<input type="month" name="to" value="${costFilter.to}"></label><button type="submit">Show</button></form>${
      r.groups.length
        ? `<svg class="funnel" viewBox="0 0 600 ${r.groups.slice(0, 10).length * 30}" role="img" aria-label="Employer cost by ${r.group_label}">${r.groups
            .slice(0, 10)
            .map(
              (g, i) =>
                `<text x="0" y="${i * 30 + 19}" class="funnel-label">${esc(g.name.slice(0, 18))}</text><rect x="130" y="${i * 30 + 5}" width="${Math.max((g.employer_cost / max) * 400, 2)}" height="20" rx="4" class="funnel-bar"/>${g.budget ? `<rect x="${130 + Math.min((g.budget / max) * 400, 440)}" y="${i * 30 + 2}" width="3" height="26" class="budget-mark"/>` : ""}`,
            )
            .join(
              "",
            )}</svg><div class="table-wrap"><table><thead><tr><th>${r.group_label}</th><th>People</th><th>Gross</th><th>Net pay</th><th>TDS</th><th>Employer cost</th>${r.budgets_supported ? "<th>Budget</th><th>Over / under</th>" : ""}</tr></thead><tbody>${r.groups.map((g) => `<tr><td>${esc(g.name)}</td><td>${g.employees}</td><td>${money(g.gross)}</td><td>${money(g.net)}</td><td>${money(g.tds)}</td><td>${money(g.employer_cost)}</td>${r.budgets_supported ? `<td>${money(g.budget || null)}</td><td>${g.variance == null ? "—" : `<span class="pill ${g.variance > 0 ? "danger" : ""}">${g.variance > 0 ? "+" : ""}${inr(g.variance)} (${g.variance_pct}%)</span>`}</td>` : ""}</tr>`).join("")}<tr><td><strong>Total</strong></td><td></td><td>${money(r.total.gross)}</td><td>${money(r.total.net)}</td><td>${money(r.total.tds)}</td><td><strong>${money(r.total.employer_cost)}</strong></td>${r.budgets_supported ? `<td>${money(r.total.budget || null)}</td><td></td>` : ""}</tr></tbody></table></div>`
        : empty(
            "No payroll in that period",
            "Approve a payroll run first, or widen the months.",
          )
    }</div>`;
  },
  async wire() {
    document.querySelector("#cost-form").onsubmit = (e) => {
      e.preventDefault();
      costFilter = Object.fromEntries(new FormData(e.target));
      render();
    };
    document
      .querySelector("#cost-csv")
      ?.addEventListener("click", async (e) => {
        e.preventDefault();
        await download(
          `/admin/payroll/cost-report?${new URLSearchParams({ ...costFilter, format: "csv" })}`,
          `payroll-cost-${costFilter.group}.csv`,
        );
      });
    document
      .querySelector("#set-budget")
      ?.addEventListener("click", async () => {
        const group = costFilter.group;
        const rows = await api(
          `/admin/payroll/budgets?group=${group}&month=${costFilter.to}`,
        );
        dialog(
          `Set ${COST_GROUPS[group].toLowerCase()} budget`,
          `<label>${COST_GROUPS[group]}<select name="ref_id">${rows.map((r) => `<option value="${r.ref_id}">${esc(r.name)}${r.amount ? ` (now ${inr(r.amount)})` : ""}</option>`).join("")}</select></label>${input("amount", "Monthly budget (₹)", "", 'type="number" min="0" required')}${input("from", "From month", costFilter.from, 'type="month" required')}${input("to", "To month", costFilter.to, 'type="month" required')}<p class="full muted">The same amount is set for each month in the range.</p>`,
          async (f) => {
            const r = await api(
              "/admin/payroll/budgets",
              {
                group,
                ref_id: Number(f.ref_id),
                amount: Number(f.amount),
                from: f.from,
                to: f.to,
              },
              "PUT",
            );
            notice(`Budget set for ${r.months} month(s).`);
          },
        );
      });
  },
};
PAYROLL_TABS.costs = "Cost report";
