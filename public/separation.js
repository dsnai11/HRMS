// Separation by the manager: absconding, a manager's request to separate someone, and the
// manager's view on a team member's resignation. HR sees the requests above the exits list;
// managers see their part on the My team page.
const SEP_KIND = { termination: "Termination", absconding: "Absconding" };
const SEP_STATUS = {
  pending: "Waiting for HR",
  approved: "Approved",
  rejected: "Not approved",
  cancelled: "Cancelled",
};
const MANAGER_VIEW = { accept: "Accept", retain: "Try to retain" };
const lastSeen = (r) =>
  r.last_seen_on ? fmtDate(r.last_seen_on) : "Never punched in";

// ---- HR ------------------------------------------------------------------------------------------
async function separationAdminHtml() {
  const pending = await api("/admin/separations?status=pending");
  return `<div class="card"><div class="card-head"><div><h2>Separation requests from managers</h2><p class="muted">Approving one starts the exit with its clearance checklist.</p></div><button class="secondary" id="absconding">Not coming to work…</button></div>${
    pending.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Reason</th><th>Asked by</th><th></th></tr></thead><tbody>${pending
          .map(
            (r) =>
              `<tr><td>${esc(r.employee_name)}<small>${esc(r.employee_code || "")} · ${esc(r.department_name || "")}</small></td><td>${SEP_KIND[r.kind]}${r.last_seen_on ? `<small>Last at work ${fmtDate(r.last_seen_on)}</small>` : ""}</td><td>${esc(r.reason)}${r.proposed_last_day ? `<small>Proposed last day ${fmtDate(r.proposed_last_day)}</small>` : ""}</td><td>${esc(r.requested_by_name)}<small>${fmtDate(r.created_at.slice(0, 10))}</small></td><td>${r.requested_by === me.id ? '<span class="muted">Another HR person decides</span>' : `<button class="secondary" data-sep-approve="${r.id}">Approve…</button> <button class="ghost" data-sep-reject="${r.id}">Do not approve</button>`}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : '<p class="muted">No requests waiting.</p>'
  }</div>`;
}
function separationAdminWire() {
  document.querySelector("#absconding")?.addEventListener("click", () =>
    abscondingDialog("/admin/absconding"),
  );
  document.querySelectorAll("[data-sep-approve]").forEach(
    (b) =>
      (b.onclick = async () => {
        const r = (await api("/admin/separations?status=pending")).find(
          (x) => x.id === Number(b.dataset.sepApprove),
        );
        if (!r) return render();
        dialog(
          `Approve separation · ${r.employee_name}`,
          `${input("last_working_day", "Last working day", r.proposed_last_day || r.last_seen_on || today(), 'type="date" required')}<label class="full">Note<input name="note" maxlength="500"></label><p class="muted full">The notice period is waived. Record show-cause notices and replies on the employee's documents.</p>`,
          async (f) => {
            await api(`/admin/separations/${r.id}/decide`, {
              decision: "approved",
              last_working_day: f.last_working_day,
              note: f.note || undefined,
            });
            notice("Approved. The exit has started.");
          },
        );
      }),
  );
  document.querySelectorAll("[data-sep-reject]").forEach(
    (b) =>
      (b.onclick = () =>
        dialog(
          "Do not approve",
          '<label class="full">Reason, shared with the manager<input name="note" maxlength="500" required></label>',
          async (f) => {
            await api(`/admin/separations/${b.dataset.sepReject}/decide`, {
              decision: "rejected",
              note: f.note,
            });
            notice("Updated.");
          },
        )),
  );
}
async function abscondingDialog(path, onAsk) {
  const show = async (days) => {
    const d = await api(`${path}?days=${days}`);
    const body = document.querySelector("dialog #abs-list");
    if (!body) return;
    body.innerHTML = d.items.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Last punch-in</th>${onAsk ? "<th></th>" : "<th>Manager</th>"}</tr></thead><tbody>${d.items
          .map(
            (r) =>
              `<tr><td>${esc(r.name)}<small>${esc(r.employee_code || "")}</small></td><td>${esc(r.department_name || "—")}</td><td>${lastSeen(r)}</td>${
                onAsk
                  ? `<td>${r.request_id ? '<span class="pill neutral">With HR</span>' : `<button class="secondary" data-abs-ask="${r.id}" data-seen="${r.last_seen_on || ""}">Ask HR to separate…</button>`}</td>`
                  : `<td>${esc(r.manager_name || "—")}${r.request_id ? '<small>Request with HR</small>' : ""}</td>`
              }</tr>`,
          )
          .join("")}</tbody></table></div>`
      : empty("Everyone is accounted for", `No one has gone ${days} days without a punch-in or approved leave.`);
    body.querySelectorAll("[data-abs-ask]").forEach(
      (b) => (b.onclick = () => onAsk(Number(b.dataset.absAsk), b.dataset.seen)),
    );
  };
  viewDialog(
    "Not coming to work",
    `<p class="muted">Active people with no punch-in and no approved leave since the start of the period. Weekly offs and holidays are counted, so check before acting.</p><form class="filters" id="abs-form"><label>Days without attendance<input type="number" name="days" min="3" max="90" value="7" required></label><button>Show</button></form><div id="abs-list">Loading…</div>`,
  );
  document.querySelector("dialog #abs-form").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, () => show(Number(new FormData(e.target).get("days"))));
  };
  await show(7);
}
function exitManagerViewHtml(x) {
  if (!x.manager_view) return "";
  return `<p class="muted">Manager's view: <strong>${MANAGER_VIEW[x.manager_view]}</strong>${x.manager_last_day ? ` · suggested last day ${fmtDate(x.manager_last_day)}` : ""}${x.manager_note ? ` · ${esc(x.manager_note)}` : ""}</p>`;
}

// ---- Manager -------------------------------------------------------------------------------------
async function teamSeparationHtml() {
  const [resignations, requests] = await Promise.all([
    api("/team/resignations"),
    api("/team/separations"),
  ]);
  const resRows = resignations
    .map(
      (x) =>
        `<tr><td>${esc(x.employee_name)}<small>${esc(x.employee_code || "")} · ${esc(x.department_name || "")}</small></td><td>${fmtDate(x.notice_given_on)}${x.requested_last_day ? `<small>Asked to leave ${fmtDate(x.requested_last_day)}</small>` : ""}</td><td>${esc(x.reason || "")}</td><td>${x.manager_view ? `${MANAGER_VIEW[x.manager_view]}<small>${esc(x.manager_note || "")}</small>` : "—"}</td><td>${x.status === "pending" ? `<button class="secondary" data-res-review="${x.id}">${x.manager_view ? "Change view" : "Give your view"}</button>` : `<span class="pill neutral">${EXIT_STATUS_TEAM[x.status] || x.status}</span>`}</td></tr>`,
    )
    .join("");
  const reqRows = requests
    .map(
      (r) =>
        `<tr><td>${esc(r.employee_name)}</td><td>${SEP_KIND[r.kind]}</td><td>${fmtDate(r.created_at.slice(0, 10))}</td><td><span class="pill ${r.status === "pending" ? "" : "neutral"}">${SEP_STATUS[r.status]}</span>${r.decision_note ? `<small>${esc(r.decision_note)}</small>` : ""}</td><td>${r.status === "pending" ? `<button class="ghost" data-sep-cancel="${r.id}">Cancel</button>` : ""}</td></tr>`,
    )
    .join("");
  return `<div class="card"><div class="card-head"><div><h2>Resignations in my team</h2><p class="muted">Tell HR whether to accept or try to keep the person. HR makes the decision.</p></div></div>${
    resRows
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Resigned on</th><th>Reason</th><th>Your view</th><th></th></tr></thead><tbody>${resRows}</tbody></table></div>`
      : '<p class="muted">No resignations in the last six months.</p>'
  }</div><div class="card"><div class="card-head"><div><h2>Separation</h2><p class="muted">Ask HR to separate a team member for misconduct or for not coming to work.</p></div><div class="actions"><button class="secondary" id="team-absconding">Not coming to work…</button> <button class="secondary" id="team-separate">Ask HR to separate…</button></div></div>${
    reqRows
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Asked on</th><th>Status</th><th></th></tr></thead><tbody>${reqRows}</tbody></table></div>`
      : '<p class="muted">You have not raised any requests.</p>'
  }</div>`;
}
const EXIT_STATUS_TEAM = {
  accepted: "Accepted by HR",
  rejected: "Not accepted",
  withdrawn: "Withdrawn",
  completed: "Left",
};
function teamSeparationWire(members) {
  const team = members.filter((m) => m.active);
  const ask = (userId = "", seen = "") =>
    dialog(
      "Ask HR to separate",
      `${sel(
        "user_id",
        "Employee",
        team.map((m) => [String(m.id), `${m.name}${m.employee_code ? ` (${m.employee_code})` : ""}`]),
        String(userId),
      )}${sel("kind", "Type", Object.entries(SEP_KIND), seen ? "absconding" : "termination")}${input("last_seen_on", "Last day at work (needed for absconding)", seen, `type="date" max="${today()}"`)}${input("proposed_last_day", "Proposed last day (optional)", "", 'type="date"')}<label class="full">Reason and what has been tried (calls, warnings, notices)<textarea name="reason" maxlength="1000" rows="4" required></textarea></label>`,
      async (f) => {
        await api("/team/separations", {
          user_id: Number(f.user_id),
          kind: f.kind,
          reason: f.reason,
          last_seen_on: f.last_seen_on || undefined,
          proposed_last_day: f.proposed_last_day || undefined,
        });
        notice("Sent to HR.");
      },
    );
  document.querySelector("#team-separate")?.addEventListener("click", () => ask());
  document.querySelector("#team-absconding")?.addEventListener("click", () =>
    abscondingDialog("/team/absconding", (userId, seen) => ask(userId, seen)),
  );
  document.querySelectorAll("[data-sep-cancel]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/team/separations/${b.dataset.sepCancel}/cancel`, {});
          notice("Request cancelled.");
          render();
        })),
  );
  document.querySelectorAll("[data-res-review]").forEach(
    (b) =>
      (b.onclick = () =>
        dialog(
          "Your view on this resignation",
          `${sel("view", "Recommendation", Object.entries(MANAGER_VIEW))}${input("last_day", "Suggested last day (optional)", "", 'type="date"')}<label class="full">Note for HR (required when you want to retain)<textarea name="note" maxlength="500" rows="3"></textarea></label>`,
          async (f) => {
            await api(`/team/resignations/${b.dataset.resReview}/review`, {
              view: f.view,
              note: f.note || undefined,
              last_day: f.last_day || undefined,
            });
            notice("Your view was sent to HR.");
          },
        )),
  );
}
