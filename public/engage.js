// Notifications bell, announcements, helpdesk, policies, insights dashboard.
const TICKET_STATUS = {
  open: "Open",
  in_progress: "In progress",
  resolved: "Resolved",
  closed: "Closed",
};
const TICKET_CATEGORY = {
  payroll: "Payroll",
  leave: "Leave",
  attendance: "Attendance",
  it: "IT",
  policy: "Policy",
  id_card: "ID card",
  certificate: "Certificate / NOC",
  other: "Other",
};
let bellTimer;

// ---- bell ------------------------------------------------------------------------------------------
async function bellRefresh() {
  const badge = document.querySelector("#bell-n");
  if (!badge) return clearInterval(bellTimer);
  try {
    const { unread } = await api("/notifications");
    badge.textContent = unread ? String(unread) : "";
    badge.classList.toggle("on", unread > 0);
  } catch {
    /* the bell is a convenience */
  }
}
function bellInit() {
  clearInterval(bellTimer);
  bellRefresh();
  bellTimer = setInterval(bellRefresh, 60000);
  document.querySelector("#bell")?.addEventListener("click", async () => {
    const { items, unread } = await api("/notifications");
    viewDialog(
      "Notifications",
      `${unread ? '<div class="actions"><button class="ghost" id="read-all">Mark all as read</button></div>' : ""}${
        items.length
          ? items
              .map(
                (n) =>
                  `<button class="notice-row ${n.read_at ? "" : "unread"}" data-n="${n.id}" data-link="${esc(n.link || "")}"><strong>${esc(n.title)}</strong>${n.body ? `<small>${esc(n.body)}</small>` : ""}<small>${time(n.created_at)}</small></button>`,
              )
              .join("")
          : empty(
              "Nothing yet",
              "Updates about your requests, payslips and announcements appear here.",
            )
      }`,
    );
    document
      .querySelector("dialog #read-all")
      ?.addEventListener("click", async () => {
        await api("/notifications/read", {});
        document.querySelector("dialog")?.remove();
        bellRefresh();
      });
    document.querySelectorAll("dialog [data-n]").forEach(
      (b) =>
        (b.onclick = async () => {
          await api("/notifications/read", { id: Number(b.dataset.n) });
          document.querySelector("dialog")?.remove();
          if (b.dataset.link) {
            page = b.dataset.link;
            await render();
          }
          bellRefresh();
        }),
    );
  });
}

// ---- front page: announcements and upcoming holidays ---------------------------------------------
// Announcements live on the front page, so people see them as soon as they sign in.
async function homeData() {
  const now = today(),
    year = Number(now.slice(0, 4));
  const [announcements, ...years] = await Promise.all([
    api("/announcements").catch(() => []),
    api(`/holidays?year=${year}`).catch(() => []),
    // Late in the year, the next year's first holidays are "upcoming" too.
    now.slice(5) >= "10-01"
      ? api(`/holidays?year=${year + 1}`).catch(() => [])
      : [],
  ]);
  return {
    announcements,
    holidays: years
      .flat()
      .filter((h) => h.date >= now)
      .slice(0, 8),
  };
}
function announcementsHtml(rows) {
  const manage = has("announcements.manage");
  return `<div class="card"><div class="card-head"><div><h2>Announcements</h2><p class="muted">News and notices from your company.</p></div>${manage ? '<button id="post">Post an announcement</button>' : ""}</div>${
    rows.length
      ? rows
          .map(
            (a) =>
              `<div class="announcement"><h3>${a.pinned ? "📌 " : ""}${esc(a.title)}</h3><p>${esc(a.body).replaceAll("\n", "<br>")}</p><small class="muted">${esc(a.author || "")} · ${time(a.created_at)}</small>${manage ? ` <button class="ghost" data-del="${a.id}">Remove</button>` : ""}</div>`,
          )
          .join("")
      : empty("No announcements", "Nothing has been posted.")
  }</div>`;
}
const holidaysHtml = (list) =>
  `<div class="card"><h2>Upcoming holidays</h2>${
    list.length
      ? list
          .map(
            (h) =>
              `<div class="kv"><span>${esc(h.name)}${h.optional ? " (optional)" : ""}</span><strong>${fmtDate(h.date)}</strong></div>`,
          )
          .join("")
      : '<p class="muted">No upcoming holidays have been added.</p>'
  }</div>`;
function announcementsWire() {
  document.querySelectorAll("[data-del]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(
            `/admin/announcements/${b.dataset.del}`,
            undefined,
            "DELETE",
          );
          render();
        })),
  );
  document.querySelector("#post")?.addEventListener("click", async () => {
    const org = await api("/admin/org");
    dialog(
      "Post an announcement",
      `${input("title", "Title", "", "required maxlength=120")}<label class="full">Message<textarea name="body" rows="5" maxlength="4000" required></textarea></label><label>Branch<select name="branch_id">${options(org.branches, null, "All branches")}</select></label><label>Department<select name="department_id">${options(org.departments, null, "All departments")}</select></label>${input("expires_on", "Show until (optional)", "", 'type="date"')}<label class="check"><input type="checkbox" name="pinned"> Pin to the top</label><label class="check"><input type="checkbox" name="email"> Also email people</label>`,
      async (b) => {
        const body = {
          title: b.title,
          body: b.body,
          pinned: "pinned" in b,
          email: "email" in b,
        };
        if (b.branch_id) body.branch_id = Number(b.branch_id);
        if (b.department_id) body.department_id = Number(b.department_id);
        if (b.expires_on) body.expires_on = b.expires_on;
        const r = await api("/admin/announcements", body);
        notice(`Posted to ${r.notified} people.`);
      },
    );
  });
}

// ---- helpdesk ----------------------------------------------------------------------------------------
const slaPill = (t) =>
  !t.sla_state
    ? "—"
    : `<span class="pill ${{ breached: "danger", missed: "danger", due: "neutral", met: "" }[t.sla_state]}">${{ breached: "Overdue", missed: "Missed", due: `Due ${time(t.due_at)}`, met: "On time" }[t.sla_state]}</span>`;
async function helpdeskPage(id) {
  const staff = has("helpdesk.manage");
  const [mine, queue] = await Promise.all([
    api("/tickets"),
    staff ? api("/admin/tickets") : [],
  ]);
  if (id !== renderId) return;
  const table = (rows, admin) =>
    rows.length
      ? `<div class="table-wrap"><table><thead><tr>${admin ? "<th>From</th>" : ""}<th>Subject</th><th>Category</th><th>Status</th><th>Response</th><th>Updated</th><th></th></tr></thead><tbody>${rows.map((t) => `<tr>${admin ? `<td>${esc(t.employee_name)}<small>${esc(t.employee_code || "")}</small></td>` : ""}<td>${t.priority === "high" ? '<span class="pill">High</span> ' : ""}${esc(t.subject)}</td><td>${TICKET_CATEGORY[t.category]}</td><td><span class="pill ${["resolved", "closed"].includes(t.status) ? "neutral" : ""}">${TICKET_STATUS[t.status]}</span></td><td>${slaPill(t)}</td><td>${time(t.updated_at)}</td><td><button class="secondary" data-ticket="${t.id}">Open</button></td></tr>`).join("")}</tbody></table></div>`
      : empty("Nothing here", "No tickets.");
  document.querySelector("#content").innerHTML =
    heading(
      "Helpdesk",
      "Ask HR or payroll a question and follow the answer.",
      `<div class="actions">${staff ? '<button class="secondary" id="sla-settings">Response times</button>' : ""}<button id="new-ticket">New ticket</button></div>`,
    ) +
    (staff
      ? `<div class="card"><h2>Open tickets from employees</h2>${table(queue, true)}</div>`
      : "") +
    `<div class="card"><h2>My tickets</h2>${table(mine, false)}</div>`;
  document
    .querySelector("#sla-settings")
    ?.addEventListener("click", async () => {
      const sla = await api("/admin/helpdesk/sla");
      dialog(
        "Response times",
        `<p class="full muted">How many hours HR has to resolve a ticket, by the priority the employee chose. Tickets past their time are flagged and listed first.</p>${input("low", "Low priority (hours)", sla.low, 'type="number" min="1" max="720"')}${input("normal", "Normal (hours)", sla.normal, 'type="number" min="1" max="720"')}${input("high", "High (hours)", sla.high, 'type="number" min="1" max="720"')}`,
        async (f) => {
          await api(
            "/admin/helpdesk/sla",
            {
              low: Number(f.low),
              normal: Number(f.normal),
              high: Number(f.high),
            },
            "PUT",
          );
          notice("Saved. It applies to new tickets.");
        },
      );
    });
  document
    .querySelectorAll("[data-ticket]")
    .forEach((b) => (b.onclick = () => ticketView(Number(b.dataset.ticket))));
  document.querySelector("#new-ticket").onclick = () =>
    dialog(
      "New ticket",
      `${input("subject", "Subject", "", "required maxlength=150")}${sel("category", "Category", Object.entries(TICKET_CATEGORY), "other")}${sel(
        "priority",
        "Priority",
        [
          ["normal", "Normal"],
          ["high", "High"],
          ["low", "Low"],
        ],
      )}<label class="full">Details<textarea name="body" rows="5" maxlength="3000" required></textarea></label>`,
      async (b) => {
        await api("/tickets", b);
        notice("Ticket sent. You will be notified when HR replies.");
      },
    );
}
async function ticketView(id) {
  const t = await api(`/tickets/${id}`);
  const staff = has("helpdesk.manage");
  viewDialog(
    t.subject,
    `<p class="muted">${esc(t.employee_name)} · ${TICKET_CATEGORY[t.category]} · <span class="pill">${TICKET_STATUS[t.status]}</span>${t.assigned_name ? ` · with ${esc(t.assigned_name)}` : ""}</p>${t.messages.map((m) => `<div class="activity ${m.internal ? "internal" : ""}"><strong>${esc(m.author)}</strong>${m.internal ? " · internal note" : ""}<br>${esc(m.body).replaceAll("\n", "<br>")}<br><small>${time(m.created_at)}</small></div>`).join("")}${
      t.status === "closed"
        ? ""
        : `<form id="reply"><label class="full">Reply<textarea name="body" rows="3" maxlength="3000" required></textarea></label>${staff ? '<label class="check"><input type="checkbox" name="internal"> Internal note (the employee will not see it)</label>' : ""}<div class="actions"><button type="submit">Send</button>${staff ? `${t.status !== "resolved" ? '<button type="button" class="secondary" id="resolve">Mark resolved</button>' : ""}<button type="button" class="ghost" id="close-ticket">Close</button>` : ""}</div></form>`
    }`,
  );
  const reload = () => ticketView(id);
  document
    .querySelector("dialog #reply")
    ?.addEventListener("submit", async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        await api(`/tickets/${id}/reply`, {
          body: f.get("body"),
          internal: f.has("internal"),
        });
        await reload();
        render();
      } catch (err) {
        notice(err.message, true);
      }
    });
  for (const [sel_, status] of [
    ["#resolve", "resolved"],
    ["#close-ticket", "closed"],
  ])
    document
      .querySelector(`dialog ${sel_}`)
      ?.addEventListener("click", async () => {
        await api(`/admin/tickets/${id}`, { status }, "PATCH");
        document.querySelector("dialog")?.remove();
        render();
      });
}

// ---- policies ----------------------------------------------------------------------------------------
async function policiesPage(id) {
  const manage = has("policies.manage");
  const [rows, admin] = await Promise.all([
    api("/policies"),
    manage ? api("/admin/policies") : [],
  ]);
  if (id !== renderId) return;
  const stats = new Map(admin.map((p) => [p.id, p]));
  document.querySelector("#content").innerHTML =
    heading(
      "Policies",
      "Company policies. Please read and acknowledge each one.",
      manage ? '<button id="new-policy">New policy</button>' : "",
    ) +
    (rows.length
      ? rows
          .map(
            (p) =>
              `<div class="card"><div class="card-head"><div><h2>${esc(p.title)} <small class="muted">v${p.version}</small></h2></div>${p.acknowledged_at ? `<span class="pill">Acknowledged ${fmtDate(p.acknowledged_at.slice(0, 10))}</span>` : `<span class="pill neutral">Needs your acknowledgement</span>`}</div><p>${esc(p.body).replaceAll("\n", "<br>")}</p>${p.acknowledged_at ? "" : `<button data-ack="${p.id}">I have read and agree</button>`}${manage ? ` <small class="muted">${stats.get(p.id)?.acknowledged ?? 0} of ${stats.get(p.id)?.people ?? 0} acknowledged</small> <button class="ghost" data-pending="${p.id}">Who is pending</button> <button class="ghost" data-edit="${p.id}">Edit</button>` : ""}</div>`,
          )
          .join("")
      : `<div class="card">${empty("No policies", "Policies your company publishes appear here.")}</div>`);
  document.querySelectorAll("[data-ack]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/policies/${b.dataset.ack}/acknowledge`, {});
          notice("Thank you. Your acknowledgement is recorded.");
          render();
        })),
  );
  document.querySelectorAll("[data-pending]").forEach(
    (b) =>
      (b.onclick = async () => {
        const list = await api(`/admin/policies/${b.dataset.pending}/pending`);
        viewDialog(
          "Not yet acknowledged",
          list.length
            ? list
                .map(
                  (p) =>
                    `<div class="activity">${esc(p.name)} <small>${esc(p.employee_code || "")}</small></div>`,
                )
                .join("")
            : empty("Everyone has acknowledged", "Nobody is pending."),
        );
      }),
  );
  document.querySelector("#new-policy")?.addEventListener("click", () =>
    dialog(
      "New policy",
      `${input("title", "Title", "", "required maxlength=120")}<label class="full">Policy text<textarea name="body" rows="10" maxlength="20000" required></textarea></label>`,
      async (b) => {
        await api("/admin/policies", b);
        notice("Published. Everyone has been asked to read it.");
      },
    ),
  );
  document.querySelectorAll("[data-edit]").forEach(
    (b) =>
      (b.onclick = () => {
        const p = rows.find((x) => x.id === Number(b.dataset.edit));
        dialog(
          `Edit ${p.title}`,
          `${input("title", "Title", p.title, "required maxlength=120")}<label class="full">Policy text<textarea name="body" rows="10" maxlength="20000" required>${esc(p.body)}</textarea></label><p class="full muted">Changing the text makes a new version that everyone must acknowledge again.</p>`,
          async (f) => {
            await api(`/admin/policies/${p.id}`, f, "PATCH");
            notice("Saved.");
          },
        );
      }),
  );
}

// ---- insights ----------------------------------------------------------------------------------------
// Bars are SVG rects sized by attributes; colour comes from CSS classes.
function barChart(
  rows,
  { label, value, cls = "bar", max, width = 520, height = 22 },
) {
  const top = max ?? Math.max(1, ...rows.map(value));
  return `<svg class="chart" viewBox="0 0 ${width} ${rows.length * (height + 6)}" role="img" aria-label="Bar chart">${rows
    .map((r, i) => {
      const y = i * (height + 6);
      const w = Math.max(0, (value(r) / top) * (width - 210));
      return `<text x="0" y="${y + height - 7}" class="chart-label">${esc(String(label(r)).slice(0, 24))}</text><rect x="150" y="${y}" width="${w}" height="${height}" rx="3" class="${cls}"></rect><text x="${156 + w}" y="${y + height - 7}" class="chart-value">${value(r)}</text>`;
    })
    .join("")}</svg>`;
}
function columnChart(rows, { label, series, width = 560, height = 150 }) {
  const top = Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key])));
  const slot = (width - 20) / rows.length;
  const bw = Math.max(4, slot / (series.length + 1));
  return `<svg class="chart" viewBox="0 0 ${width} ${height + 24}" role="img" aria-label="Column chart">${rows
    .map(
      (r, i) =>
        series
          .map((s, j) => {
            const h = (r[s.key] / top) * height;
            return `<rect x="${10 + i * slot + j * bw}" y="${height - h}" width="${bw - 1}" height="${h}" class="${s.cls}"><title>${esc(label(r))}: ${r[s.key]} ${s.name}</title></rect>`;
          })
          .join("") +
        `<text x="${10 + i * slot}" y="${height + 16}" class="chart-label">${esc(label(r))}</text>`,
    )
    .join(
      "",
    )}</svg><div class="legend">${series.map((s) => `<span><i class="swatch ${s.cls}"></i>${s.name}</span>`).join("")}</div>`;
}
async function insightsPage(id) {
  const [d, prefs] = await Promise.all([
    api("/admin/insights"),
    api("/dashboard-prefs"),
  ]);
  if (id !== renderId) return;
  const stat = (label, value, hint = "") =>
    `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${hint ? `<div class="muted">${hint}</div>` : ""}</div>`;
  const short = (m) =>
    new Date(`${m}-01T00:00:00Z`).toLocaleString("en-IN", {
      month: "short",
      timeZone: "UTC",
    });
  const stages = ["applied", "screening", "interview", "offer", "hired"];
  const day = (r) =>
    r.in_days === 0 ? "Today" : r.in_days === 1 ? "Tomorrow" : fmtDate(r.date);
  const list = (rows, line, none) =>
    rows.length
      ? rows.map((r) => `<div class="activity">${line(r)}</div>`).join("")
      : `<p class="muted">${none}</p>`;
  // Each widget: title shown in the customise list, and its HTML (null when it does not apply).
  const W = {
    stats: [
      "Key numbers",
      () =>
        `<div class="stats">${stat("Headcount", d.headcount.total)}${stat("Present today", d.attendance.today_present, `${d.attendance.on_leave_today} on leave`)}${stat("Attrition, 12 months", `${d.movement.attrition_percent}%`, `${d.movement.leavers_12m} left · ${d.movement.in_notice} serving notice`)}${stat("Pending leave requests", d.leave.pending)}${stat("Open positions", d.recruitment.open_positions)}${stat("Open helpdesk tickets", d.helpdesk.open)}</div>`,
    ],
    celebrations: [
      "Birthdays and anniversaries",
      () =>
        `<div class="grid-2"><div class="card"><h2>Birthdays, next 30 days</h2>${list(d.celebrations.birthdays, (r) => `<strong>${esc(r.name)}</strong> · ${day(r)}`, "None coming up.")}</div><div class="card"><h2>Work anniversaries, next 30 days</h2>${list(d.celebrations.anniversaries, (r) => `<strong>${esc(r.name)}</strong> · ${r.years} year${r.years === 1 ? "" : "s"} · ${day(r)}`, "None coming up.")}</div></div>`,
    ],
    joiners: [
      "New joiners",
      () =>
        `<div class="card"><h2>Joined in the last 30 days</h2>${list(d.celebrations.new_joiners, (r) => `<strong>${esc(r.name)}</strong> · ${fmtDate(r.date)}`, "Nobody has joined recently.")}</div>`,
    ],
    movement: [
      "Joiners and leavers",
      () =>
        `<div class="card"><h2>Joiners and leavers</h2>${columnChart(
          d.movement.months,
          {
            label: (r) => short(r.month),
            series: [
              { key: "joined", name: "Joined", cls: "bar" },
              { key: "left", name: "Left", cls: "bar-alt" },
            ],
          },
        )}</div>`,
    ],
    attendance: [
      "Attendance, last 14 days",
      () =>
        `<div class="card"><h2>Attendance, last 14 days</h2>${columnChart(d.attendance.series, { label: (r) => r.date.slice(8), series: [{ key: "present", name: "People punched in", cls: "bar" }] })}</div>`,
    ],
    departments: [
      "People by department",
      () =>
        `<div class="card"><h2>People by department</h2>${barChart(d.headcount.by_department, { label: (r) => r.name, value: (r) => r.n })}</div>`,
    ],
    branches: [
      "People by branch",
      () =>
        `<div class="card"><h2>People by branch</h2>${barChart(d.headcount.by_branch, { label: (r) => r.name, value: (r) => r.n })}</div>`,
    ],
    leave: [
      "Leave taken this year",
      () =>
        `<div class="card"><h2>Leave taken this year (days)</h2>${d.leave.taken_this_year.length ? barChart(d.leave.taken_this_year, { label: (r) => r.name, value: (r) => r.days }) : empty("No leave yet", "Approved leave appears here.")}</div>`,
    ],
    pipeline: [
      "Hiring pipeline",
      () =>
        `<div class="card"><h2>Hiring pipeline</h2>${barChart(
          stages.map((s) => ({
            name: STAGE[s],
            n: d.recruitment.stages[s] ?? 0,
          })),
          { label: (r) => r.name, value: (r) => r.n },
        )}</div>`,
    ],
    payroll: [
      "Payroll cost",
      d.payroll
        ? () =>
            `<div class="card"><h2>Payroll cost, last approved months</h2>${
              d.payroll.length
                ? `${columnChart(d.payroll, {
                    label: (r) => short(r.month),
                    series: [
                      { key: "gross", name: "Gross pay", cls: "bar" },
                      {
                        key: "employer_cost",
                        name: "Cost to company",
                        cls: "bar-alt",
                      },
                    ],
                  })}<div class="table-wrap"><table><thead><tr><th>Month</th><th>People</th><th>Gross</th><th>Net</th><th>Cost to company</th></tr></thead><tbody>${d.payroll.map((r) => `<tr><td>${monthLabel(r.month)}</td><td>${r.employees}</td><td>${inr(r.gross)}</td><td>${inr(r.net)}</td><td>${inr(r.employer_cost)}</td></tr>`).join("")}</tbody></table></div>`
                : empty(
                    "No approved payroll",
                    "Cost appears after the first approved run.",
                  )
            }</div>`
        : null,
    ],
  };
  // The saved layout, then any widgets it does not mention (so new ones appear), skipping ones this person cannot see.
  const saved = prefs.layout ?? [];
  const layout = [
    ...saved.filter((w) => W[w.id]),
    ...prefs.widgets
      .filter((w) => !saved.some((s) => s.id === w))
      .map((id) => ({
        id,
        visible: true,
      })),
  ].filter((w) => W[w.id][1]);
  document.querySelector("#content").innerHTML =
    heading(
      "Insights",
      `Company overview as of ${fmtDate(d.as_of)}.`,
      '<button class="secondary" id="customise">Customise</button>',
    ) +
    (layout
      .filter((w) => w.visible)
      .map((w) => W[w.id][1]())
      .join("") ||
      `<div class="card">${empty("Everything is hidden", "Use Customise to choose what to show.")}</div>`);
  document.querySelector("#customise").onclick = () => {
    let order = layout.map((w) => ({ ...w }));
    const draw = () => {
      const box = document.querySelector("dialog #widget-list");
      box.innerHTML = order
        .map(
          (w, i) =>
            `<div class="widget-row"><label class="check"><input type="checkbox" data-vis="${i}" ${w.visible ? "checked" : ""}> ${esc(W[w.id][0])}</label><span><button class="ghost" data-up="${i}" ${i === 0 ? "disabled" : ""} aria-label="Move up">↑</button><button class="ghost" data-down="${i}" ${i === order.length - 1 ? "disabled" : ""} aria-label="Move down">↓</button></span></div>`,
        )
        .join("");
      box
        .querySelectorAll("[data-vis]")
        .forEach(
          (c) =>
            (c.onchange = () =>
              (order[Number(c.dataset.vis)].visible = c.checked)),
        );
      box.querySelectorAll("[data-up]").forEach(
        (b) =>
          (b.onclick = () => {
            const i = Number(b.dataset.up);
            [order[i - 1], order[i]] = [order[i], order[i - 1]];
            draw();
          }),
      );
      box.querySelectorAll("[data-down]").forEach(
        (b) =>
          (b.onclick = () => {
            const i = Number(b.dataset.down);
            [order[i + 1], order[i]] = [order[i], order[i + 1]];
            draw();
          }),
      );
    };
    dialog(
      "Customise Insights",
      '<div class="full" id="widget-list"></div><p class="full muted">Your choice is saved for you only.</p>',
      async () => {
        await api(
          "/dashboard-prefs",
          { layout: order.map(({ id, visible }) => ({ id, visible })) },
          "PUT",
        );
        notice("Saved.");
      },
    );
    draw();
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "ghost";
    reset.textContent = "Reset to default";
    reset.onclick = async () => {
      await api("/dashboard-prefs", undefined, "DELETE");
      document.querySelector("dialog")?.remove();
      render();
    };
    document.querySelector("dialog .form-actions").prepend(reset);
  };
}

// ---- HR Command Centre -------------------------------------------------------------------------------
// One live page for leadership: headcount, movement, attendance, approvals and the
// workforce mix, refreshed every minute, plus reports emailed on a schedule.
const barList = (rows, total) =>
  rows.length
    ? rows
        .slice()
        .sort((a, b) => b.n - a.n)
        .map(
          (r) =>
            `<div class="bar-row"><span>${esc(r.name || "Not set")}</span><div class="bar"><i data-css="width:${total ? Math.max(2, Math.round((r.n / total) * 100)) : 0}%"></i></div><strong>${r.n}</strong></div>`,
        )
        .join("")
    : '<p class="muted">No data yet.</p>';
async function commandCentrePage(id) {
  const [d, sched, people] = await Promise.all([
    api("/admin/insights"),
    api("/admin/report-schedules"),
    api("/directory"),
  ]);
  if (id !== renderId) return;
  const total = d.headcount.total;
  const tiles = [
    ["Headcount", total, "Active employees"],
    ["Joined this month", d.this_month.joined, d.this_month.month],
    ["Left this month", d.this_month.left, d.this_month.month],
    ["Monthly attrition", `${d.this_month.attrition_percent}%`, "Leavers ÷ headcount"],
    ["12-month attrition", `${d.movement.attrition_percent}%`, `${d.movement.leavers_12m} left in 12 months`],
    ["Open positions", d.recruitment.open_positions, "Across open requisitions"],
    ["Present today", d.attendance.today_present, `of ${total}`],
    ["On leave today", d.attendance.on_leave_today, "Approved leave"],
    ["Leave awaiting approval", d.leave.pending, "All steps"],
    ["Open helpdesk tickets", d.helpdesk.open, "Open or in progress"],
  ];
  const name = new Map(people.map((p) => [p.id, p.name]));
  document.querySelector("#content").innerHTML =
    heading(
      "HR Command Centre",
      `Live view of the organisation as of ${fmtDate(d.as_of)}. Refreshes every minute.`,
      '<button class="secondary" id="cc-refresh">↻ Refresh</button>',
    ) +
    `<div class="stats">${tiles.map(([l, v, s]) => `<div class="stat"><div class="stat-label">${esc(l)}</div><div class="stat-value">${v}</div><small>${esc(s)}</small></div>`).join("")}</div>` +
    `<div class="grid-two"><div class="card"><h2>Headcount by department</h2>${barList(d.headcount.by_department, total)}</div><div class="card"><h2>Headcount by branch</h2>${barList(d.headcount.by_branch, total)}</div></div>` +
    `<div class="home-grid"><div class="card"><h2>Gender</h2>${barList(d.demographics.gender, total)}</div><div class="card"><h2>Age</h2>${barList(d.demographics.age, total)}</div><div class="card"><h2>Length of service</h2>${barList(d.demographics.tenure, total)}</div></div>` +
    `<div class="card"><h2>Joiners and leavers, last 12 months</h2><div class="table-wrap"><table><thead><tr><th>Month</th>${d.movement.months.map((m) => `<th>${esc(m.month.slice(5))}/${esc(m.month.slice(2, 4))}</th>`).join("")}</tr></thead><tbody><tr><td>Joined</td>${d.movement.months.map((m) => `<td>${m.joined}</td>`).join("")}</tr><tr><td>Left</td>${d.movement.months.map((m) => `<td>${m.left}</td>`).join("")}</tr></tbody></table></div></div>` +
    `<div class="card"><div class="card-head"><div><h2>Scheduled reports</h2><p class="muted">Emailed after 8 am on the chosen day. Recipients also see them under alerts.</p></div><button id="cc-add">Schedule a report</button></div>${
      sched.items.length
        ? `<div class="table-wrap"><table><thead><tr><th>Report</th><th>When</th><th>Sent to</th><th>Last sent</th><th></th></tr></thead><tbody>${sched.items
            .map(
              (s) =>
                `<tr><td>${esc(sched.reports[s.report] || s.report)}</td><td>${s.frequency === "daily" ? "Every day" : s.frequency === "weekly" ? `Every ${sched.weekdays[s.day]}` : `Monthly, day ${s.day}`}</td><td>${s.recipients.map((r) => esc(name.get(r) || "—")).join(", ")}</td><td>${s.last_sent_on ? fmtDate(s.last_sent_on) : "Not yet"}</td><td><button class="ghost" data-unsched="${s.id}">Remove</button></td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty("No scheduled reports", "Send the Command Centre summary to leadership every week, for example.")
    }</div>`;
  document.querySelector("#cc-refresh").onclick = render;
  // Live: redraw every minute while this page stays open.
  const timer = setInterval(() => {
    if (page !== "commandcentre" || id !== renderId || document.querySelector("dialog"))
      return page !== "commandcentre" || id !== renderId ? clearInterval(timer) : null;
    render();
  }, 60000);
  document.querySelectorAll("[data-unsched]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/admin/report-schedules/${b.dataset.unsched}`, undefined, "DELETE");
          await render();
        })),
  );
  document.querySelector("#cc-add").onclick = () =>
    dialog(
      "Schedule a report",
      `${sel("report", "Report", Object.entries(sched.reports))}${sel("frequency", "How often", [["weekly", "Weekly"], ["daily", "Daily"], ["monthly", "Monthly"]])}${sel("weekday", "Weekday (weekly)", sched.weekdays.map((w, i) => [i, w]), 1)}${input("monthday", "Day of the month (monthly)", 1, 'type="number" min="1" max="31"')}<div class="full"><strong>Send to</strong><div class="check-grid">${people
        .map(
          (p) =>
            `<label class="check"><input type="checkbox" name="to:${p.id}" ${p.id === me.id ? "checked" : ""}> ${esc(p.name)}</label>`,
        )
        .join("")}</div></div>`,
      async (f) => {
        await api("/admin/report-schedules", {
          report: f.report,
          frequency: f.frequency,
          day: f.frequency === "weekly" ? Number(f.weekday) : Number(f.monthday),
          recipients: Object.keys(f)
            .filter((k) => k.startsWith("to:"))
            .map((k) => Number(k.slice(3))),
        });
        notice("Report scheduled.");
      },
    );
}

// ---- Engagement gallery -------------------------------------------------------------------------------
// Event photos on the Home page. HR posts them; photos are shrunk in the browser to at
// most 1600 px wide and saved as JPEG so each stays well under the 1 MB limit.
const shrinkPhoto = (file) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.82).split(",")[1]);
    };
    img.onerror = () => reject(new Error("That file is not a photo."));
    img.src = url;
  });
async function galleryCard(id) {
  const g = await api("/gallery?limit=12").catch(() => ({ items: [], categories: [] }));
  if (id !== renderId) return;
  const manage = has("announcements.manage");
  // Each photo gets a steady scatter (tilt, offset, where it flies in from) worked out
  // from its id, so the layout stays the same between visits.
  const scatter = (id, i) => {
    const r = (n) => ((Math.sin(id * 9301 + n * 49297) + 1) / 2) % 1;
    return [
      `--tilt:${(r(1) * 14 - 7).toFixed(1)}deg`,
      `--dx:${(r(2) * 24 - 12).toFixed(0)}px`,
      `--dy:${(r(3) * 24 - 12).toFixed(0)}px`,
      `--fx:${(r(4) * 600 - 300).toFixed(0)}px`,
      `--fy:${(r(5) * 300 - 150).toFixed(0)}px`,
      `--fr:${(r(6) * 90 - 45).toFixed(0)}deg`,
      `--delay:${i * 90}ms`,
      `--float:${(5 + r(7) * 4).toFixed(1)}s`,
    ].join(";");
  };
  const card = document.createElement("div");
  card.className = "card gallery-card";
  // Floating light particles, each with its own place, size and speed.
  const particles = Array.from({ length: 22 }, (_, i) => {
    const r = (n) => (Math.sin((i + 1) * 7919 + n * 104729) + 1) / 2;
    return `<span data-css="left:${(r(1) * 100).toFixed(1)}%;top:${(r(2) * 100).toFixed(1)}%;--size:${(2 + r(3) * 5).toFixed(1)}px;--speed:${(6 + r(4) * 10).toFixed(1)}s;--wait:${(-r(5) * 10).toFixed(1)}s"></span>`;
  }).join("");
  card.innerHTML = `<div class="gallery-aurora" aria-hidden="true"></div><div class="gallery-particles" aria-hidden="true">${particles}</div><div class="card-head"><div><span class="gallery-kicker">Moments</span><h2>Engagement Gallery</h2></div>${manage ? '<button class="gallery-post" id="photo-add">+ Post a photo</button>' : ""}</div>${
    g.items.length
      ? `<div class="gallery scatter">${g.items
          .map(
            (p, i) =>
              `<button type="button" class="gallery-item" data-css="${scatter(p.id, i)}" data-photo="${p.id}"><span class="gallery-frame"><img src="/api/gallery/${p.id}/image" alt="${esc(p.title)}" loading="lazy"><span class="gallery-cap"><strong>${esc(p.title)}</strong><small>${esc(p.category)} · ${fmtDate(p.event_date)}${p.branch_name ? ` · ${esc(p.branch_name)}` : ""}</small></span></span></button>`,
          )
          .join("")}</div>`
      : '<p class="gallery-empty">Photos from HR days, celebrations and awards appear here.</p>'
  }`;
  document.querySelector("#content").append(card);
  // Photos tilt towards the pointer, in 3D.
  card.querySelectorAll(".gallery-item").forEach((b) => {
    b.onpointermove = (e) => {
      const r = b.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5;
      const y = (e.clientY - r.top) / r.height - 0.5;
      b.style.setProperty("--ry", `${(x * 24).toFixed(1)}deg`);
      b.style.setProperty("--rx", `${(-y * 24).toFixed(1)}deg`);
      b.style.setProperty("--gx", `${((x + 0.5) * 100).toFixed(0)}%`);
      b.style.setProperty("--gy", `${((y + 0.5) * 100).toFixed(0)}%`);
    };
    b.onpointerleave = () => {
      b.style.setProperty("--rx", "0deg");
      b.style.setProperty("--ry", "0deg");
    };
  });
  // A spotlight wanders from photo to photo while the page is open.
  const photos = [...card.querySelectorAll(".gallery-item")];
  if (photos.length > 1 && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    let lit = 0;
    const spot = setInterval(() => {
      if (!card.isConnected) return clearInterval(spot);
      photos[lit].classList.remove("lit");
      lit = (lit + 1 + Math.floor(Math.random() * (photos.length - 1))) % photos.length;
      photos[lit].classList.add("lit");
    }, 2600);
  }
  card.querySelectorAll("[data-photo]").forEach(
    (b) =>
      (b.onclick = () => {
        const p = g.items.find((x) => x.id === Number(b.dataset.photo));
        viewDialog(
          p.title,
          `<img class="gallery-full" src="/api/gallery/${p.id}/image" alt="${esc(p.title)}"><p class="muted">${esc(p.category)} · ${fmtDate(p.event_date)}${p.posted_by_name ? ` · posted by ${esc(p.posted_by_name)}` : ""}</p>${manage ? `<button class="ghost" id="photo-del">Remove photo</button>` : ""}`,
        );
        document.querySelector("#photo-del")?.addEventListener("click", (e) =>
          busy(e.target, async () => {
            await api(`/admin/gallery/${p.id}`, undefined, "DELETE");
            document.querySelector("dialog")?.remove();
            await render();
          }),
        );
      }),
  );
  card.querySelector("#photo-add")?.addEventListener("click", async () => {
    const org = await api("/admin/org");
    dialog(
      "Post a photo",
      `${input("title", "Title", "", 'required maxlength="120" placeholder="e.g. Diwali celebration, Jaipur HO"')}${sel("category", "Category", g.categories.map((c) => [c, c]))}${input("event_date", "Event date", today(), 'type="date" required')}<label>Branch<select name="branch_id">${options(org.branches, null, "Everyone")}</select></label><label class="full">Photo (JPG or PNG)<input type="file" name="photo" accept="image/jpeg,image/png" required></label>`,
      async (f) => {
        const file = document.querySelector("dialog input[name=photo]").files[0];
        if (!file) throw new Error("Choose a photo.");
        await api("/admin/gallery", {
          title: f.title,
          category: f.category,
          event_date: f.event_date,
          branch_id: f.branch_id ? Number(f.branch_id) : null,
          mime: "image/jpeg",
          data: await shrinkPhoto(file),
        });
        notice("Photo posted.");
      },
    );
  });
}
