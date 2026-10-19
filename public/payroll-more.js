// Payroll extras: loans and advances, reimbursement claims, bonus, gratuity, tax forms.
const CLAIM_STATUS = {
  pending: "Waiting",
  approved: "Approved, pays with next salary",
  rejected: "Rejected",
  paid: "Paid",
  cancelled: "Withdrawn",
};
const LOAN_STATUS = {
  active: "Active",
  closed: "Repaid",
  cancelled: "Cancelled",
};
const taxYearStart = () => {
  const [y, m] = today().split("-").map(Number);
  return m >= 4 ? y : y - 1;
};
const peopleOptions = async () =>
  (await api("/admin/payroll/salaries?limit=100"))?.items ?? [];

const MORE_TABS = {
  loans: {
    async html() {
      const loans = await api("/admin/payroll/loans");
      return `<div class="card"><div class="card-head"><div><h2>Loans & salary advances</h2><p class="muted">Interest-free. Each instalment is recovered from salary in its month; the loan closes when the last one is deducted.</p></div>${has("payroll.manage") ? '<button id="new-loan">Give a loan or advance</button>' : ""}</div>${
        loans.length
          ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Amount</th><th>Instalments</th><th>Starts</th><th>Outstanding</th><th>Status</th><th></th></tr></thead><tbody>${loans.map((l) => `<tr><td>${esc(l.employee_name)}<small>${esc(l.employee_code || "")}</small></td><td>${l.kind === "advance" ? "Advance" : "Loan"}</td><td>${inr(l.principal)}</td><td>${l.installments}</td><td>${monthLabel(l.start_month)}</td><td>${inr(l.outstanding)}</td><td><span class="pill ${l.status === "active" ? "" : "neutral"}">${LOAN_STATUS[l.status]}</span></td><td><button class="secondary" data-loan="${l.id}">Schedule</button></td></tr>`).join("")}</tbody></table></div>`
          : empty(
              "No loans",
              "Loans and advances you give will be tracked here.",
            )
      }</div>`;
    },
    wire() {
      document
        .querySelector("#new-loan")
        ?.addEventListener("click", async () => {
          const people = await peopleOptions();
          dialog(
            "Give a loan or advance",
            `${sel(
              "user_id",
              "Employee",
              people.map((p) => [p.id, `${p.name} (${p.employee_code || ""})`]),
            )}${sel("kind", "Type", [
              ["loan", "Loan"],
              ["advance", "Salary advance"],
            ])}${input("principal", "Amount (₹)", "", 'type="number" min="1" step="1" required')}${input("installments", "Number of instalments", 3, 'type="number" min="1" max="120" step="1" required')}${input("start_month", "First deduction", thisMonth(), 'type="month" required')}<label class="full">Note<input name="note" maxlength="300"></label>`,
            async (b) => {
              await api("/admin/payroll/loans", {
                user_id: Number(b.user_id),
                kind: b.kind,
                principal: Number(b.principal),
                installments: Number(b.installments),
                start_month: b.start_month,
                note: b.note || undefined,
              });
              notice("Saved. It will be recovered in payroll.");
            },
          );
        });
      document.querySelectorAll("[data-loan]").forEach(
        (b) =>
          (b.onclick = async () => {
            const l = await api(`/admin/payroll/loans/${b.dataset.loan}`);
            viewDialog(
              `${l.kind === "advance" ? "Advance" : "Loan"} schedule`,
              `<div class="kv-list">${l.schedule.map((s) => `<div class="kv"><span>${monthLabel(s.month)} · ${esc(s.status)}</span><strong>${inr(s.amount)}</strong></div>`).join("")}</div>${
                l.status === "active" && has("payroll.manage")
                  ? `<div class="actions"><button class="secondary" id="skip-loan">Skip an instalment</button> <button class="ghost" id="cancel-loan">Cancel the rest</button></div>`
                  : ""
              }`,
            );
            document
              .querySelector("#cancel-loan")
              ?.addEventListener("click", async () => {
                if (!confirm("Cancel all remaining instalments?")) return;
                await api(`/admin/payroll/loans/${l.id}`, undefined, "DELETE");
                document.querySelector("dialog")?.remove();
                notice("Loan cancelled.");
                render();
              });
            document
              .querySelector("#skip-loan")
              ?.addEventListener("click", () => {
                const pending = l.schedule.filter(
                  (s) => s.status === "pending",
                );
                dialog(
                  "Skip an instalment",
                  `${sel(
                    "month",
                    "Skip the one in",
                    pending.map((s) => [s.month, monthLabel(s.month)]),
                  )}<p class="full muted">It moves to the end of the schedule.</p>`,
                  async (f) => {
                    await api(`/admin/payroll/loans/${l.id}/skip`, {
                      month: f.month,
                    });
                    notice("Instalment moved to the end.");
                  },
                );
              });
          }),
      );
    },
  },

  claims: {
    async html() {
      const [types, claims] = await Promise.all([
        api("/admin/claim-types"),
        api("/admin/claims"),
      ]);
      return `<div class="card"><div class="card-head"><div><h2>Claim types</h2><p class="muted">Categories employees can claim against, with an optional yearly limit.</p></div>${has("payroll.manage") ? '<button id="new-claim-type">Add a claim type</button>' : ""}</div>${
        types.length
          ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Yearly limit</th><th>Taxable</th><th>Status</th><th></th></tr></thead><tbody>${types.map((t) => `<tr><td>${esc(t.name)}</td><td>${t.annual_limit ? inr(t.annual_limit) : "No limit"}</td><td>${yn(t.taxable)}</td><td><span class="pill ${t.active ? "" : "neutral"}">${t.active ? "Active" : "Inactive"}</span></td><td>${has("payroll.manage") ? `<button class="ghost" data-toggle-type="${t.id}" data-active="${t.active ? 1 : 0}">${t.active ? "Deactivate" : "Activate"}</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
          : empty("No claim types", "Add types such as Travel or Phone.")
      }</div><div class="card"><h2>Claims</h2>${
        claims.length
          ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Date</th><th>Amount</th><th>Details</th><th>Status</th></tr></thead><tbody>${claims.map((c) => `<tr><td>${esc(c.employee_name)}<small>${esc(c.employee_code || "")}</small></td><td>${esc(c.type_name)}</td><td>${fmtDate(c.expense_date)}</td><td>${inr(c.amount)}${c.approved_amount && c.approved_amount !== c.amount ? `<small>Approved ${inr(c.approved_amount)}</small>` : ""}</td><td>${esc(c.description)}${c.reference ? `<small>Bill ${esc(c.reference)}</small>` : ""}</td><td><span class="pill ${c.status === "rejected" || c.status === "cancelled" ? "neutral" : ""}">${CLAIM_STATUS[c.status]}</span></td></tr>`).join("")}</tbody></table></div>`
          : empty("No claims yet", "Employee claims appear here.")
      }</div>`;
    },
    wire() {
      document.querySelector("#new-claim-type")?.addEventListener("click", () =>
        dialog(
          "Add a claim type",
          `${input("name", "Name", "", "required maxlength=60")}${input("annual_limit", "Yearly limit per employee (₹, optional)", "", 'type="number" min="1" step="1"')}${sel(
            "taxable",
            "Tax treatment",
            [
              ["false", "Not taxable (reimbursement)"],
              ["true", "Taxable"],
            ],
          )}`,
          async (b) => {
            await api("/admin/claim-types", {
              name: b.name,
              annual_limit: b.annual_limit ? Number(b.annual_limit) : null,
              taxable: b.taxable === "true",
            });
            notice("Claim type added.");
          },
        ),
      );
      document.querySelectorAll("[data-toggle-type]").forEach(
        (b) =>
          (b.onclick = () =>
            busy(b, async () => {
              await api(
                `/admin/claim-types/${b.dataset.toggleType}`,
                { active: b.dataset.active !== "1" },
                "PATCH",
              );
              render();
            })),
      );
    },
  },

  yearend: {
    async html() {
      const year = taxYearStart();
      const [bonus, liability, settings] = await Promise.all([
        api(`/admin/payroll/bonus?year=${year}`),
        api("/admin/payroll/gratuity-liability"),
        api("/admin/payroll/settings"),
      ]);
      const label = `${year}-${String(year + 1).slice(2)}`;
      return `<div class="card"><div class="card-head"><div><h2>Statutory bonus ${label}</h2><p class="muted">Eligible: wages up to ₹21,000 a month and at least 30 days worked. Calculated on wages capped at the higher of ₹7,000 or the minimum wage, at ${bonus.rate}% (allowed range 8.33%–20%), from approved payroll runs of this financial year.</p></div><div class="actions"><button class="secondary" id="bonus-settings">Rate & minimum wage</button>${has("payroll.manage") && bonus.total ? '<button id="apply-bonus">Add to payroll</button>' : ""}</div></div>${
        bonus.rows.length
          ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Months paid</th><th>Days worked</th><th>Bonus base</th><th>Bonus</th></tr></thead><tbody>${bonus.rows.map((r) => `<tr><td>${esc(r.name)}<small>${esc(r.employee_code || "")}</small></td><td>${r.months_paid}</td><td>${r.days}</td><td>${r.eligible ? inr(r.base) : "—"}</td><td>${r.eligible ? `<strong>${inr(r.amount)}</strong>` : '<span class="pill neutral">Not eligible</span>'}</td></tr>`).join("")}</tbody></table></div><p class="muted">Total ${inr(bonus.total)}</p>`
          : empty(
              "No approved payroll yet",
              "Bonus is worked out from approved monthly runs.",
            )
      }</div><div class="card"><div class="card-head"><div><h2>Gratuity liability</h2><p class="muted">Fifteen days' wages for each completed year (a part over six months counts as a year), wages at least half of gross, capped at ₹20 lakh. Payable after 5 years (1 year for fixed-term).</p></div></div>${
        liability.rows.length
          ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Joined</th><th>Service</th><th>Wages</th><th>Provision to date</th><th>Payable today</th></tr></thead><tbody>${liability.rows.map((r) => (r.error ? `<tr><td>${esc(r.name)}</td><td colspan="5"><span class="pill neutral">${r.error === "no_salary" ? "No salary set" : "No joining date"}</span></td></tr>` : `<tr><td>${esc(r.name)}<small>${esc(r.employee_code || "")}</small></td><td>${fmtDate(r.joined)}</td><td>${Math.floor(r.service_months / 12)}y ${r.service_months % 12}m</td><td>${inr(r.wages)}</td><td>${inr(r.provision)}</td><td>${r.eligible ? `<strong>${inr(r.payable)}</strong>` : `<span class="pill neutral">After ${r.eligible_after_years ?? "—"} yrs</span>`}</td></tr>`)).join("")}</tbody></table></div><p class="muted">Provision ${inr(liability.provision)} · payable if everyone eligible left today ${inr(liability.payable_if_all_left)}</p>`
          : empty(
              "No employees",
              "Gratuity is worked out for active employees.",
            )
      }</div><div class="card"><div class="card-head"><div><h2>Leave encashment</h2><p class="muted">Pay out balance of leave types marked "Can be paid out" in Leave & holidays. Rate = ${settings.leaveEncashment.basis === "gross" ? "gross" : "basic"} ÷ ${settings.leaveEncashment.divisor}.</p></div><div class="actions"><button class="secondary" id="enc-settings">Encashment rate</button>${has("payroll.manage") ? '<button id="encash">Encash leave</button>' : ""}</div></div></div><div class="card"><div class="card-head"><div><h2>Tax forms (Form 130 and Form 138)</h2><p class="muted">Employee-wise salary and tax data for the financial year, and the quarterly deduction data, from approved runs and opening balances. File through the Income-tax utilities with this data.</p></div></div><div class="actions"><button class="secondary" data-form="130">↓ Form 130 data, ${label}</button>${[1, 2, 3, 4].map((q) => `<button class="secondary" data-form="138" data-q="${q}">↓ Form 138, Q${q}</button>`).join("")}</div></div>`;
    },
    wire() {
      const year = taxYearStart();
      document
        .querySelectorAll("[data-form]")
        .forEach(
          (b) =>
            (b.onclick = () =>
              busy(b, () =>
                download(
                  `/admin/payroll/tax-statement?year=${year}&form=${b.dataset.form}&format=csv${b.dataset.q ? `&quarter=${b.dataset.q}` : ""}`,
                  `form-${b.dataset.form}-${year}${b.dataset.q ? `-q${b.dataset.q}` : ""}.csv`,
                ),
              )),
        );
      document.querySelector("#apply-bonus")?.addEventListener("click", () =>
        dialog(
          "Add bonus to payroll",
          `${input("pay_in_month", "Pay with the salary of", thisMonth(), 'type="month" required')}<p class="full muted">One taxable earning is added per eligible employee. It can be removed from Adjustments while that month is a draft.</p>`,
          async (b) => {
            const r = await api("/admin/payroll/bonus", {
              year,
              pay_in_month: b.pay_in_month,
            });
            notice(`Bonus added for ${r.added} employee(s).`);
          },
        ),
      );
      document
        .querySelector("#bonus-settings")
        ?.addEventListener("click", async () => {
          const s = await api("/admin/payroll/settings");
          dialog(
            "Bonus settings",
            `${input("rate", "Bonus rate (%)", s.bonus.rate, 'type="number" min="8.33" max="20" step="0.01" required')}${input("minimumWage", "Minimum wage (₹ a month, 0 if none)", s.bonus.minimumWage, 'type="number" min="0" step="1"')}`,
            async (b) => {
              await api(
                "/admin/payroll/settings",
                {
                  bonus: {
                    rate: Number(b.rate),
                    minimumWage: Number(b.minimumWage || 0),
                  },
                },
                "PATCH",
              );
              notice("Saved.");
            },
          );
        });
      document
        .querySelector("#enc-settings")
        ?.addEventListener("click", async () => {
          const s = await api("/admin/payroll/settings");
          dialog(
            "Leave encashment rate",
            `${sel(
              "basis",
              "Per-day rate from",
              [
                ["basic", "Basic salary"],
                ["gross", "Gross salary"],
              ],
              s.leaveEncashment.basis,
            )}${input("divisor", "Divide by (days)", s.leaveEncashment.divisor, 'type="number" min="20" max="31" step="1" required')}`,
            async (b) => {
              await api(
                "/admin/payroll/settings",
                {
                  leaveEncashment: {
                    basis: b.basis,
                    divisor: Number(b.divisor),
                  },
                },
                "PATCH",
              );
              notice("Saved.");
            },
          );
        });
      document.querySelector("#encash")?.addEventListener("click", async () => {
        const [people, types] = await Promise.all([
          peopleOptions(),
          api("/admin/leave-types"),
        ]);
        const enc = types.filter((t) => t.encashable && t.active);
        if (!enc.length)
          return notice(
            "No leave type is marked as payable. Turn it on in Leave & holidays.",
            true,
          );
        dialog(
          "Encash leave",
          `${sel(
            "user_id",
            "Employee",
            people.map((p) => [p.id, `${p.name} (${p.employee_code || ""})`]),
          )}${sel(
            "leave_type_id",
            "Leave type",
            enc.map((t) => [t.id, t.name]),
          )}${input("days", "Days", "", 'type="number" min="0.5" step="0.5" required')}${input("pay_in_month", "Pay with the salary of", thisMonth(), 'type="month" required')}`,
          async (b) => {
            const r = await api(
              `/admin/employees/${b.user_id}/leave-encashment`,
              {
                leave_type_id: Number(b.leave_type_id),
                days: Number(b.days),
                pay_in_month: b.pay_in_month,
              },
            );
            notice(`${inr(r.amount)} will be paid (${inr(r.rate)} a day).`);
          },
        );
      });
    },
  },
};

// ---- approvals: reimbursement claims -----------------------------------------
async function claimsApprovals(id) {
  const rows = await api("/claims/inbox");
  if (id !== renderId || !rows.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Reimbursement claims</h2><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Date</th><th>Amount</th><th>Details</th><th></th></tr></thead><tbody>${rows.map((c) => `<tr><td>${esc(c.employee_name)}<small>${esc(c.employee_code || "")}</small></td><td>${esc(c.type_name)}</td><td>${fmtDate(c.expense_date)}</td><td>${inr(c.amount)}</td><td>${esc(c.description)}${c.reference ? `<small>Bill ${esc(c.reference)}</small>` : ""}</td><td><button class="secondary" data-claim="${c.id}" data-decision="approved">Approve</button> <button class="ghost" data-claim="${c.id}" data-decision="rejected">Reject</button></td></tr>`).join("")}</tbody></table></div>`;
  document.querySelector("#content").append(card);
  card.querySelectorAll("[data-claim]").forEach(
    (b) =>
      (b.onclick = () => {
        const c = rows.find((x) => x.id === Number(b.dataset.claim));
        const approving = b.dataset.decision === "approved";
        dialog(
          `${approving ? "Approve" : "Reject"} claim`,
          `<div class="full muted">${esc(c.employee_name)} · ${esc(c.type_name)} · ${inr(c.amount)}</div>${approving ? input("approved_amount", "Approve amount (₹)", c.amount, `type="number" min="1" max="${c.amount}" step="1"`) : ""}<label class="full">${approving ? "Note (optional)" : "Reason"}<input name="note" maxlength="300" ${approving ? "" : "required"}></label>`,
          async (f) => {
            await api(`/claims/${c.id}/decide`, {
              decision: b.dataset.decision,
              approved_amount: approving
                ? Number(f.approved_amount)
                : undefined,
              note: f.note || undefined,
            });
            notice(approving ? "Approved." : "Rejected.");
            await loadMe();
          },
        );
      }),
  );
}

// ---- employee: my claims and loans ------------------------------------------------
async function myClaimsPage(id) {
  const [claims, types, loans] = await Promise.all([
    api("/claims"),
    api("/claim-types"),
    api("/loans"),
  ]);
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Claims & loans",
      "Claim expenses to be reimbursed with your salary, and see your loan or advance.",
      types.length ? '<button id="new-claim">New claim</button>' : "",
    ) +
    `<div class="card"><h2>My claims</h2>${
      claims.length
        ? `<div class="table-wrap"><table><thead><tr><th>Type</th><th>Date</th><th>Amount</th><th>Details</th><th>Status</th><th></th></tr></thead><tbody>${claims.map((c) => `<tr><td>${esc(c.type_name)}</td><td>${fmtDate(c.expense_date)}</td><td>${inr(c.amount)}${c.approved_amount && c.approved_amount !== c.amount ? `<small>Approved ${inr(c.approved_amount)}</small>` : ""}</td><td>${esc(c.description)}${c.decision_note ? `<small>${esc(c.decision_note)}</small>` : ""}</td><td><span class="pill ${c.status === "rejected" || c.status === "cancelled" ? "neutral" : ""}">${CLAIM_STATUS[c.status]}</span></td><td>${c.status === "pending" ? `<button class="ghost" data-withdraw="${c.id}">Withdraw</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : empty(
            "No claims",
            types.length
              ? "Use New claim to ask for a reimbursement."
              : "Your company has not set up claim types yet.",
          )
    }</div><div class="card"><h2>My loans & advances</h2>${
      loans.length
        ? loans
            .map(
              (l) =>
                `<div class="activity"><strong>${l.kind === "advance" ? "Advance" : "Loan"} ${inr(l.principal)}</strong> · ${LOAN_STATUS[l.status]}<br><small>${l.schedule.map((s) => `${monthLabel(s.month)} ${inr(s.amount)} (${esc(s.status)})`).join(" · ")}</small></div>`,
            )
            .join("")
        : empty("No loans", "You have no loan or advance.")
    }</div>`;
  document.querySelector("#new-claim")?.addEventListener("click", () =>
    dialog(
      "New claim",
      `${sel(
        "claim_type_id",
        "Type",
        types.map((t) => [
          t.id,
          t.annual_limit
            ? `${t.name} (limit ${inr(t.annual_limit)} a year)`
            : t.name,
        ]),
      )}${input("expense_date", "Expense date", today(), `type="date" max="${today()}" required`)}${input("amount", "Amount (₹)", "", 'type="number" min="1" step="1" required')}${input("reference", "Bill / receipt number", "", "maxlength=120")}<label class="full">What was it for<input name="description" maxlength="300" required></label>`,
      async (b) => {
        await api("/claims", {
          claim_type_id: Number(b.claim_type_id),
          expense_date: b.expense_date,
          amount: Number(b.amount),
          description: b.description,
          reference: b.reference || undefined,
        });
        notice("Claim sent for approval.");
        await loadMe();
      },
    ),
  );
  document.querySelectorAll("[data-withdraw]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/claims/${b.dataset.withdraw}`, undefined, "DELETE");
          notice("Claim withdrawn.");
          render();
        })),
  );
}
