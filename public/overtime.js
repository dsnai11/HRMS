// ---- Overtime: claim (employee), decide (manager), settings (payroll) ----
const OT_STATUS = { pending: "Waiting", approved: "Approved", rejected: "Not approved", cancelled: "Cancelled" };
const otTime = (m) => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;

async function overtimeCard(id) {
  const d = await api("/overtime");
  if (id !== renderId || (!d.settings.ot_enabled && !d.requests.length)) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Overtime</h2><p class="muted">Time worked after a full day, read from your punches. Claim it within ${d.settings.ot_claim_days} day(s); your manager approves it and it is paid with your salary.</p>${
    d.suggestions.length
      ? `<h3>Days you can claim</h3><div class="table-wrap"><table><thead><tr><th>Day</th><th>Punched out</th><th>Overtime</th><th></th></tr></thead><tbody>${d.suggestions
          .map((s) => `<tr><td>${fmtDate(s.date)}</td><td>${time(s.out_at)}</td><td>${otTime(s.minutes)}</td><td><button class="secondary" data-ot-claim="${s.date}" data-max="${s.minutes}">Claim</button></td></tr>`)
          .join("")}</tbody></table></div>`
      : d.settings.ot_enabled
        ? '<p class="muted">No unclaimed overtime in your recent punches.</p>'
        : ""
  }${
    d.requests.length
      ? `<h3>Your claims</h3><div class="table-wrap"><table><thead><tr><th>Day</th><th>Claimed</th><th>Approved</th><th>Status</th><th></th></tr></thead><tbody>${d.requests
          .map(
            (r) =>
              `<tr><td>${fmtDate(r.date)}<small>${esc(r.reason)}</small></td><td>${otTime(r.minutes_claimed)}</td><td>${r.minutes_approved ? otTime(r.minutes_approved) : "—"}</td><td><span class="pill ${r.status === "approved" ? "" : "neutral"}">${OT_STATUS[r.status]}</span>${r.paid_run_id ? "<small>paid</small>" : ""}${r.decision_note ? `<small>${esc(r.decision_note)}</small>` : ""}</td><td>${r.status === "pending" ? `<button class="ghost" data-ot-cancel="${r.id}">Cancel</button>` : ""}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : ""
  }`;
  document.querySelector("#content").append(card);
  card.querySelectorAll("[data-ot-claim]").forEach((b) =>
    b.addEventListener("click", () =>
      dialog(
        `Claim overtime for ${fmtDate(b.dataset.otClaim)}`,
        `${input("minutes", `Minutes (up to ${b.dataset.max})`, b.dataset.max, `type="number" min="${d.settings.ot_min_minutes}" max="${b.dataset.max}" required`)}<label class="full">What was the work?<input name="reason" maxlength="300" required></label>`,
        async (f) => {
          await api("/overtime", { date: b.dataset.otClaim, minutes: Number(f.minutes), reason: f.reason });
          notice("Sent to your manager.");
        },
      ),
    ),
  );
  card.querySelectorAll("[data-ot-cancel]").forEach((b) =>
    b.addEventListener("click", () =>
      busy(b, async () => {
        await api(`/overtime/${b.dataset.otCancel}/cancel`, {});
        render();
      }),
    ),
  );
}

async function overtimeApprovals(id) {
  const rows = await api("/overtime/pending");
  if (id !== renderId || !rows.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Overtime claims</h2><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Day</th><th>Claimed</th><th>Punches allow</th><th>Work</th><th></th></tr></thead><tbody>${rows
    .map(
      (r) =>
        `<tr><td>${esc(r.employee_name)}<small>${esc(r.employee_code || "")}</small></td><td>${fmtDate(r.date)}</td><td>${otTime(r.minutes_claimed)}</td><td>${otTime(r.eligible_minutes)}</td><td>${esc(r.reason)}</td><td><button class="secondary" data-ot-ok="${r.id}" data-claimed="${r.minutes_claimed}">Approve</button> <button class="ghost" data-ot-no="${r.id}">Reject</button></td></tr>`,
    )
    .join("")}</tbody></table></div>`;
  document.querySelector("#content").append(card);
  card.querySelectorAll("[data-ot-ok]").forEach((b) =>
    b.addEventListener("click", () =>
      dialog(
        "Approve overtime",
        input("minutes", `Minutes to pay (up to ${b.dataset.claimed})`, b.dataset.claimed, `type="number" min="1" max="${b.dataset.claimed}" required`),
        async (f) => {
          await api(`/overtime/${b.dataset.otOk}/decision`, { decision: "approved", minutes: Number(f.minutes) });
          notice("Approved. It will be paid in payroll.");
          await loadMe();
        },
      ),
    ),
  );
  card.querySelectorAll("[data-ot-no]").forEach((b) =>
    b.addEventListener("click", () =>
      dialog("Reject overtime", '<label class="full">Reason<input name="note" maxlength="300" required></label>', async (f) => {
        await api(`/overtime/${b.dataset.otNo}/decision`, { decision: "rejected", note: f.note });
        notice("Rejected.");
        await loadMe();
      }),
    ),
  );
}

async function overtimeSettingsCard(id) {
  if (!has("payroll.read")) return;
  const s = await api("/admin/overtime-settings");
  if (id !== renderId) return;
  const edit = has("payroll.manage") ? "" : "disabled";
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Overtime</h2><p class="muted">Counted only after a full day on a full working day, from the punches (work on holidays and weekly offs earns comp-off instead). Paid in payroll at the rate below times the hourly pay: monthly basic (or gross) ÷ (days × hours).</p>
    <form id="ot-form" class="form-grid"><label class="check full"><input type="checkbox" name="ot_enabled" ${s.ot_enabled ? "checked" : ""} ${edit}> Overtime on</label>
    ${input("ot_rate", "Rate (2 = double, as the Factories Act requires)", s.ot_rate, `type="number" min="1" max="3" step="0.25" ${edit}`)}
    ${sel("ot_basis", "Paid on", [["basic", "Basic pay"], ["gross", "Gross pay"]], s.ot_basis)}
    ${input("ot_days_per_month", "Days a month", s.ot_days_per_month, `type="number" min="20" max="31" ${edit}`)}
    ${input("ot_hours_per_day", "Hours a day", s.ot_hours_per_day, `type="number" min="4" max="12" step="0.5" ${edit}`)}
    ${input("ot_min_minutes", "Least minutes to count", s.ot_min_minutes, `type="number" min="15" max="240" ${edit}`)}
    ${input("ot_max_minutes", "Most minutes a day", s.ot_max_minutes, `type="number" min="30" max="720" ${edit}`)}
    ${input("ot_claim_days", "Days to claim it", s.ot_claim_days, `type="number" min="1" max="31" ${edit}`)}
    ${edit ? "" : '<div class="actions full"><button>Save</button></div>'}</form>`;
  document.querySelector("#content").append(card);
  card.querySelector("#ot-form").onsubmit = (e) => {
    e.preventDefault();
    const f = e.target;
    busy(e.submitter, async () => {
      await api(
        "/admin/overtime-settings",
        {
          ot_enabled: f.ot_enabled.checked,
          ot_rate: Number(f.ot_rate.value),
          ot_basis: f.ot_basis.value,
          ot_days_per_month: Number(f.ot_days_per_month.value),
          ot_hours_per_day: Number(f.ot_hours_per_day.value),
          ot_min_minutes: Number(f.ot_min_minutes.value),
          ot_max_minutes: Number(f.ot_max_minutes.value),
          ot_claim_days: Number(f.ot_claim_days.value),
        },
        "PATCH",
      );
      notice("Overtime settings saved.");
    });
  };
}
