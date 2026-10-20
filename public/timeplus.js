// Comp-off, team leave calendar and shift templates.
const CO_STATUS = {
  pending: "Waiting",
  approved: "Approved",
  rejected: "Not approved",
  cancelled: "Cancelled",
};

// ---- employee: comp-off on the Time off page -------------------------------------------------------
async function compOffCard(id) {
  const d = await api("/comp-off/mine");
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="card-head"><div><h2>Comp-off</h2><p class="muted">Worked on a holiday or weekly off? Claim a day in lieu within 30 days. Once approved it is added to your Compensatory Off leave and must be used within ${d.valid_days} days. Balance: <strong>${d.balance}</strong> day(s).</p></div><button class="secondary" id="claim-co">Claim comp-off</button></div>${
    d.credits.length
      ? `<div class="table-wrap"><table><thead><tr><th>Worked on</th><th>Days</th><th>Status</th><th>Use by</th><th></th></tr></thead><tbody>${d.credits.map((c) => `<tr><td>${fmtDate(c.worked_on)}<small>${esc(c.reason)}</small></td><td>${c.days}</td><td><span class="pill ${c.status === "approved" ? "" : "neutral"}">${CO_STATUS[c.status]}</span>${c.decision_note ? `<small>${esc(c.decision_note)}</small>` : ""}${c.expired_days ? `<small>${c.expired_days} day(s) expired</small>` : ""}</td><td>${c.valid_until ? fmtDate(c.valid_until) : "—"}</td><td>${c.status === "pending" ? `<button class="ghost" data-cancel-co="${c.id}">Cancel</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : '<p class="muted">No claims yet.</p>'
  }`;
  document.querySelector("#content").append(card);
  card.querySelector("#claim-co").onclick = () =>
    dialog(
      "Claim comp-off",
      `${input("worked_on", "Day you worked", "", `type="date" max="${today()}" required`)}${sel(
        "days",
        "For",
        [
          ["1", "A full day"],
          ["0.5", "Half a day"],
        ],
      )}<label class="full">What did you work on?<input name="reason" maxlength="300" required></label><p class="full muted">The day must be a holiday or weekly off, and you must have completed attendance on it.</p>`,
      async (f) => {
        await api("/comp-off", {
          worked_on: f.worked_on,
          days: Number(f.days),
          reason: f.reason,
        });
        notice("Sent to your manager for approval.");
      },
    );
  card.querySelectorAll("[data-cancel-co]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/comp-off/${b.dataset.cancelCo}/cancel`, {});
          notice("Cancelled.");
          render();
        })),
  );
}

// ---- approver: comp-off claims on the Approvals page -------------------------------------------------
async function compOffApprovals(id) {
  const rows = await api("/comp-off/pending");
  if (id !== renderId || !rows.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Comp-off claims</h2><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Worked on</th><th>Days</th><th>Why</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.employee_name)}<small>${esc(r.employee_code || "")}</small></td><td>${fmtDate(r.worked_on)}</td><td>${r.days}</td><td>${esc(r.reason)}</td><td><button class="secondary" data-co-ok="${r.id}">Approve</button> <button class="ghost" data-co-no="${r.id}">Decline</button></td></tr>`).join("")}</tbody></table></div>`;
  document.querySelector("#content").append(card);
  card.querySelectorAll("[data-co-ok]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/comp-off/${b.dataset.coOk}/decision`, {
            decision: "approved",
          });
          notice("Approved. The leave balance was updated.");
          await loadMe();
          render();
        })),
  );
  card.querySelectorAll("[data-co-no]").forEach(
    (b) =>
      (b.onclick = () =>
        dialog(
          "Decline comp-off",
          '<label class="full">Reason<input name="note" maxlength="300" required></label>',
          async (f) => {
            await api(`/comp-off/${b.dataset.coNo}/decision`, {
              decision: "rejected",
              note: f.note,
            });
            notice("Declined.");
            await loadMe();
          },
        )),
  );
}

// ---- team leave calendar -------------------------------------------------------------------------------
let teamCalMonth = null;
async function teamCalendarPage(id) {
  teamCalMonth ||= thisMonth();
  const month = teamCalMonth;
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const dept = window.teamCalDept || "";
  const [cal, org] = await Promise.all([
    api(
      `/team/leave-calendar?from=${month}-01&to=${month}-${String(last).padStart(2, "0")}${dept ? `&department_id=${dept}` : ""}`,
    ),
    has("org.read") ? api("/admin/org") : { departments: [] },
  ]);
  if (id !== renderId) return;
  const lead = new Date(`${month}-01T00:00:00Z`).getUTCDay();
  const cells = Array.from(
    { length: lead },
    () => '<div class="day blank"></div>',
  );
  for (const d of cal.days)
    cells.push(
      `<div class="day team-day ${d.off ? "off" : ""} ${d.away.length && !d.off ? "has-away" : ""}"><b>${Number(d.date.slice(8))}</b>${d.holiday ? `<small>${esc(d.holiday)}</small>` : d.off ? "<small>Weekly off</small>" : `<small>${d.in_count} of ${cal.team_size} in</small>`}${d.away
        .slice(0, 3)
        .map(
          (a) =>
            `<span class="away ${a.pending ? "pending" : ""}" title="${esc(a.name)} · ${a.codes.join(", ")}${a.pending ? " (waiting for approval)" : ""}">${esc(a.name.split(" ")[0])}${a.half ? " ½" : ""}</span>`,
        )
        .join(
          "",
        )}${d.away.length > 3 ? `<small>+${d.away.length - 3} more</small>` : ""}</div>`,
    );
  document.querySelector("#content").innerHTML =
    heading(
      "Team calendar",
      "Who is away each day, and how many of your team are in.",
    ) +
    `<div class="card"><div class="card-head"><div><h2>${monthLabel(month)}</h2><p class="muted">${cal.team_size} people. Dashed names are leave waiting for approval; ½ is a half day.</p></div><div class="actions">${org.departments.length ? `<label class="inline">Department<select id="cal-dept"><option value="">All</option>${org.departments.map((d) => `<option value="${d.id}" ${String(d.id) === String(dept) ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label>` : ""}<button class="secondary" id="cal-prev">‹</button><button class="secondary" id="cal-next">›</button></div></div><div class="cal"><div class="dow">${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((x) => `<span>${x}</span>`).join("")}</div><div class="grid">${cells.join("")}</div></div></div>`;
  const go = (n) => () => ((teamCalMonth = shiftMonth(month, n)), render());
  document.querySelector("#cal-prev").onclick = go(-1);
  document.querySelector("#cal-next").onclick = go(1);
  document.querySelector("#cal-dept")?.addEventListener("change", (e) => {
    window.teamCalDept = e.target.value;
    render();
  });
}
