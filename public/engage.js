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
              `<div class="kv"><span>${esc(h.name)}</span><strong>${fmtDate(h.date)}</strong></div>`,
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
