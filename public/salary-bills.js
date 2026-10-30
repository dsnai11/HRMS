// Bills against bill-backed salary components (fuel, telephone…): the employee adds them on the
// Payslips page; payroll verifies them on its own tab. Verified bills lower TDS.
const BILL_STATUS = {
  pending: "With payroll",
  verified: "Verified",
  rejected: "Not accepted",
  cancelled: "Withdrawn",
};

// ---- employee ------------------------------------------------------------------------------------
async function salaryBillsCard(id) {
  const d = await api("/salary-bills");
  if (id !== renderId || !d.components.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="card-head"><div><h2>Reimbursement bills · ${d.label}</h2><p class="muted">These parts of your salary are tax-free up to the bills payroll verifies, at most a year's worth. Bills waiting for verification do not lower tax yet.</p></div><button id="add-bill">Add a bill</button></div><div class="stats">${d.components
    .map(
      (c) =>
        `<div class="stat"><div class="stat-label">${esc(c.name)} · up to ${inr(c.yearly)} a year</div><div class="stat-value">${inr(c.exempt)}</div><small class="muted">tax-free so far${c.pending ? ` · ${inr(c.pending)} waiting` : ""}</small></div>`,
    )
    .join("")}</div>${
    d.bills.length
      ? `<div class="table-wrap"><table><thead><tr><th>Bill</th><th>For</th><th>Amount</th><th>Status</th><th></th></tr></thead><tbody>${d.bills
          .map(
            (b) =>
              `<tr><td>${fmtDate(b.bill_date)}${b.bill_no ? ` · ${esc(b.bill_no)}` : ""}<small>${esc(b.description)}</small></td><td>${esc(b.component_name)}</td><td>${inr(b.amount)}${b.status === "verified" && b.verified_amount < b.amount ? `<small>${inr(b.verified_amount)} accepted</small>` : ""}</td><td><span class="pill ${b.status === "verified" ? "" : "neutral"}">${BILL_STATUS[b.status]}</span>${b.note ? `<small>${esc(b.note)}</small>` : ""}</td><td>${b.status === "pending" ? `<button class="ghost" data-bill-cancel="${b.id}">Withdraw</button>` : ""}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<p class="muted">No bills added this year.</p>'
  }`;
  document.querySelector("#content").append(card);
  card.querySelector("#add-bill").onclick = () =>
    dialog(
      "Add a bill",
      `${sel(
        "component_id",
        "Reimbursement",
        d.components.map((c) => [String(c.id), c.name]),
      )}${input("bill_date", "Bill date", today(), `type="date" max="${today()}" required`)}${input("amount", "Amount (₹)", "", 'type="number" min="1" step="0.01" required')}${input("bill_no", "Bill number (optional)", "", 'maxlength="60"')}<label class="full">What it is for<input name="description" maxlength="300" placeholder="Petrol for field visits, October" required></label><label class="full">Copy of the bill (PDF, JPG or PNG, up to 2 MB)<input type="file" name="file" accept="application/pdf,image/jpeg,image/png"></label>`,
      async (f) => {
        let documentId;
        const file = document.querySelector("dialog [name=file]")?.files[0];
        if (file) {
          if (file.size > 2 * 1024 * 1024)
            throw new Error("The bill copy can be up to 2 MB.");
          if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type))
            throw new Error("Use a PDF, JPG or PNG copy.");
          documentId = (
            await api("/documents", {
              kind: "other",
              name: `Bill ${f.bill_date}${f.bill_no ? ` ${f.bill_no}` : ""}`,
              mime: file.type,
              data: await toB64(file),
            })
          ).id;
        }
        await api("/salary-bills", {
          component_id: Number(f.component_id),
          bill_date: f.bill_date,
          amount: Number(f.amount),
          bill_no: f.bill_no || undefined,
          description: f.description,
          document_id: documentId,
        });
        notice("Bill added. Payroll will verify it.");
      },
    );
  card.querySelectorAll("[data-bill-cancel]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/salary-bills/${b.dataset.billCancel}/cancel`, {});
          notice("Bill withdrawn.");
          render();
        })),
  );
}

// ---- payroll -------------------------------------------------------------------------------------
let billFilter = "pending";
MORE_TABS.salarybills = {
  async html() {
    const d = await api(`/admin/salary-bills${billFilter ? `?status=${billFilter}` : ""}`);
    return `<div class="card"><div class="card-head"><div><h2>Reimbursement bills · ${d.tax_year}-${String(d.tax_year + 1).slice(2)}</h2><p class="muted">Bills against bill-backed components. Verified amounts are tax-free, up to a year of the component; mark components as bill-backed on the Salary structure tab.</p></div><label>Show<select id="bill-filter">${[["pending", "Waiting"], ["verified", "Verified"], ["rejected", "Not accepted"], ["", "All"]].map(([v, l]) => `<option value="${v}" ${v === billFilter ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>${
      d.items.length
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Bill</th><th>For</th><th>Amount</th><th>Copy</th><th>Status</th><th></th></tr></thead><tbody>${d.items
            .map(
              (b) =>
                `<tr><td>${esc(b.employee_name)}<small>${esc(b.employee_code || "")}</small></td><td>${fmtDate(b.bill_date)}${b.bill_no ? ` · ${esc(b.bill_no)}` : ""}<small>${esc(b.description)}</small></td><td>${esc(b.component_name)}</td><td>${inr(b.amount)}${b.status === "verified" && b.verified_amount < b.amount ? `<small>${inr(b.verified_amount)} accepted</small>` : ""}</td><td>${b.document_id ? `<button type="button" class="ghost" data-bill-proof="${b.id}">View</button>` : "—"}</td><td><span class="pill ${b.status === "verified" ? "" : "neutral"}">${BILL_STATUS[b.status]}</span>${b.verified_by_name ? `<small>${esc(b.verified_by_name)}</small>` : ""}</td><td>${b.status === "pending" && has("payroll.manage") && b.user_id !== me.id ? `<button class="secondary" data-bill-verify="${b.id}">Verify…</button>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty("No bills", "Employees add bills from their Payslips page.")
    }</div>`;
  },
  async wire() {
    const items = (await api(`/admin/salary-bills${billFilter ? `?status=${billFilter}` : ""}`)).items;
    document.querySelector("#bill-filter").onchange = (e) => {
      billFilter = e.target.value;
      render();
    };
    document.querySelectorAll("[data-bill-proof]").forEach(
      (b) => (b.onclick = () => openFile(`/api/admin/salary-bills/${b.dataset.billProof}/proof`)),
    );
    document.querySelectorAll("[data-bill-verify]").forEach((btn) => {
      const b = items.find((x) => x.id === Number(btn.dataset.billVerify));
      btn.onclick = () =>
        dialog(
          `Bill · ${b.employee_name}`,
          `<p class="muted full">${esc(b.component_name)} · ${fmtDate(b.bill_date)} · ${inr(b.amount)} · ${esc(b.description)}</p>${sel("decision", "Decision", [["verified", "Verify"], ["rejected", "Do not accept"]])}${input("verified_amount", "Amount accepted (₹)", b.amount, `type="number" min="0" max="${b.amount}" step="0.01"`)}<label class="full">Note to the employee (needed for a lower amount or a rejection)<input name="note" maxlength="300"></label>`,
          async (f) => {
            await api(`/admin/salary-bills/${b.id}/verify`, {
              decision: f.decision,
              verified_amount: f.decision === "verified" ? Number(f.verified_amount) : undefined,
              note: f.note || undefined,
            });
            notice("Saved.");
          },
        );
    });
  },
};
PAYROLL_TABS.salarybills = "Reimbursement bills";
