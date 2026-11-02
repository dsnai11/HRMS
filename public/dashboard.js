// The HR dashboard (Overview): today's attendance as the headline, what needs HR's attention,
// and the trends behind it. Charts are plain HTML marks sized from script (the page's
// security rules forbid inline style attributes, but setting element.style is allowed),
// each with hover and keyboard tooltips and a table view.
const DASH = { joined: "#2563c4", left: "#c8102e" };

async function hrDashboardPage(id) {
  const insightsOn = has("insights.read");
  const [stats, active, home, ins] = await Promise.all([
    api("/admin/overview"),
    api("/admin/active?limit=12"),
    homeData(),
    insightsOn ? api("/admin/insights").catch(() => null) : null,
  ]);
  if (id !== renderId) return;
  const headcount = ins?.headcount.total ?? stats.employees;
  const present = ins?.attendance.today_present ?? stats.attended;
  const rate = headcount ? Math.round((present / headcount) * 100) : 0;
  const hour = new Date().getHours();
  const hello = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const todayText = new Intl.DateTimeFormat("en-IN", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date());

  // Each tile opens the page where HR acts on it, when this person can open that page.
  const tile = (label, value, note, goto) =>
    `<${goto ? `button type="button" data-page="${goto}"` : "div"} class="stat dash-tile"><span class="stat-label">${label}</span><span class="stat-value">${value}</span><small>${note}</small>${goto ? '<span class="dash-go" aria-hidden="true">→</span>' : ""}</${goto ? "button" : "div"}>`;
  const pageIf = (perm, p) => (has(perm) ? p : null);
  const tiles = [
    tile("Working now", stats.active, "Open shifts right now", pageIf("attendance.read", "attendance")),
    ins && tile("On leave today", ins.attendance.on_leave_today, "Approved leave", pageIf("leave.read", "leaveadmin")),
    ins && tile("Leave waiting", ins.leave.pending, "Requests to approve", "approvals"),
    ins && tile("Open positions", ins.recruitment.open_positions, "Across open jobs", pageIf("recruitment.manage", "hiring")),
    ins && tile("Helpdesk open", ins.helpdesk.open, "Open or in progress", "helpdesk"),
    ins && tile("Serving notice", ins.movement.in_notice, "Exits accepted", pageIf("exit.manage", "hiring")),
  ].filter(Boolean);

  // What needs HR today, most urgent first; empty means all clear.
  const todo = [
    ins?.leave.pending && [`${plural(ins.leave.pending, "leave request")} waiting for a decision`, "approvals"],
    me.approvals_pending && [`${plural(me.approvals_pending, "item")} in your approvals inbox`, "approvals"],
    ins?.helpdesk.open && [`${plural(ins.helpdesk.open, "helpdesk ticket")} open`, "helpdesk"],
    ins && headcount && present < headcount * 0.5 && hour >= 11 && [`Only ${rate}% of people have punched in today`, pageIf("attendance.read", "attendance")],
    ins?.movement.in_notice && [`${plural(ins.movement.in_notice, "person")} serving notice: plan clearance and settlement`, pageIf("exit.manage", "hiring")],
    ins?.recruitment.open_positions && [`${plural(ins.recruitment.open_positions, "open position")} to fill`, pageIf("recruitment.manage", "hiring")],
  ].filter(Boolean);

  const c = ins?.celebrations;
  const soon = c
    ? [
        ...c.birthdays.slice(0, 4).map((b) => [b.name, `Birthday ${whenText(b.in_days, b.date)}`]),
        ...c.anniversaries.slice(0, 4).map((a) => [a.name, `${a.years} year${a.years === 1 ? "" : "s"} ${whenText(a.in_days, a.date)}`]),
        ...c.new_joiners.slice(0, 4).map((j) => [j.name, `Joined ${fmtDate(j.date)}`]),
      ]
    : [];

  document.querySelector("#content").innerHTML =
    `<div class="dash-head"><div><div class="eyebrow">HR dashboard</div><h1>${hello}, ${esc(me.name.split(" ")[0])}</h1><p class="muted">${todayText} · ${esc(me.company?.name || "")}</p></div><div class="actions">${has("employees.write") ? '<button class="secondary" data-page="employees">Add or find employee</button>' : ""}<button class="ghost" id="refresh">Refresh</button></div></div>` +
    `<section class="dash-top" aria-label="Today"><div class="card dash-hero"><span class="stat-label">Present today</span><div class="dash-hero-value"><span class="dash-big">${present}</span><span class="muted">of ${headcount} active employees</span></div><div class="dash-meter" role="img" aria-label="${rate}% of active employees present today"><span data-w="${rate}"></span></div><p class="muted">${rate}% attendance · ${stats.hours.toFixed(1)} hours worked so far</p></div><div class="dash-tiles">${tiles.join("")}</div></section>` +
    `<section class="grid-two dash-row"><div class="card"><div class="card-head"><div><h2>Needs your attention</h2><p class="muted">Most urgent first.</p></div></div>${
      todo.length
        ? `<ul class="dash-todo">${todo
            .map(
              ([text, goto]) =>
                `<li>${goto ? `<button type="button" class="dash-todo-item" data-page="${goto}"><span>${esc(text)}</span><span aria-hidden="true">→</span></button>` : `<span class="dash-todo-item">${esc(text)}</span>`}</li>`,
            )
            .join("")}</ul>`
        : '<p class="dash-clear"><strong>All clear.</strong> Nothing is waiting for HR right now.</p>'
    }</div>${
      ins
        ? chartCard(
            "Attendance, last 14 days",
            "People who punched in each day.",
            "chart-attendance",
            ins.attendance.series.map((d) => [fmtShort(d.date), d.present]),
            ["Day", "Present"],
          )
        : '<div class="card"><h2>Attendance trend</h2><p class="muted">Needs the Insights right.</p></div>'
    }</section>` +
    (ins
      ? `<section class="grid-two dash-row">${chartCard(
          "Headcount by department",
          `${headcount} active employees.`,
          "chart-departments",
          topWithOther(ins.headcount.by_department, 7).map((d) => [d.name || "No department", d.n]),
          ["Department", "Employees"],
        )}${chartCard(
          "Joiners and leavers, last 12 months",
          `${ins.movement.joiners_12m} joined · ${ins.movement.leavers_12m} left · ${ins.movement.attrition_percent}% attrition`,
          "chart-movement",
          ins.movement.months.map((m) => [fmtMonth(m.month), m.joined, m.left]),
          ["Month", "Joined", "Left"],
        )}</section><section class="grid-two dash-row">${chartCard(
          "Hiring pipeline",
          "Candidates at each stage.",
          "chart-hiring",
          ["applied", "screening", "interview", "offer", "hired"].map((s) => [s[0].toUpperCase() + s.slice(1), ins.recruitment.stages[s] ?? 0]),
          ["Stage", "Candidates"],
        )}<div class="card"><h2>Coming up</h2><p class="muted">Birthdays, work anniversaries and new joiners.</p>${
          soon.length
            ? `<ul class="dash-people">${soon.map(([n, t]) => `<li><span class="avatar">${initials(n)}</span><span><strong>${esc(n)}</strong><small>${esc(t)}</small></span></li>`).join("")}</ul>`
            : empty("Nothing this month", "Birthdays, anniversaries and joiners in the next 30 days appear here.")
        }</div></section>`
      : "") +
    `<section class="card dash-row"><div class="card-head"><div><h2>Who’s working now</h2><p class="muted">Latest punch of each open shift. Location is recorded only at punches.</p></div><span class="pill">${stats.active} working</span></div>${table(active)}${stats.active > active.length ? `<p class="muted">Showing the latest ${active.length}. See everyone under Administration → Attendance records.</p>` : ""}</section>` +
    `<section class="grid-two dash-row">${announcementsHtml(home.announcements)}${holidaysHtml(home.holidays)}</section>`;

  document.querySelector("#refresh").onclick = render;
  document.querySelectorAll("#content [data-page]").forEach(
    (b) =>
      (b.onclick = () => {
        page = b.dataset.page;
        render();
      }),
  );
  announcementsWire();
  document.querySelectorAll("#content [data-w]").forEach((el) => (el.style.width = `${el.dataset.w}%`));
  if (ins) {
    drawColumns("chart-attendance", ins.attendance.series.map((d) => ({ label: fmtShort(d.date), values: [d.present], tip: `${fmtDate(d.date)}: ${d.present} present` })), [DASH.left], { lastLabel: true });
    drawBars("chart-departments", topWithOther(ins.headcount.by_department, 7).map((d) => ({ label: d.name || "No department", value: d.n })));
    drawColumns(
      "chart-movement",
      ins.movement.months.map((m) => ({ label: fmtMonth(m.month), values: [m.joined, m.left], tip: `${fmtMonth(m.month)}: ${m.joined} joined, ${m.left} left` })),
      [DASH.joined, DASH.left],
      { legend: ["Joined", "Left"] },
    );
    drawBars("chart-hiring", ["applied", "screening", "interview", "offer", "hired"].map((s) => ({ label: s[0].toUpperCase() + s.slice(1), value: ins.recruitment.stages[s] ?? 0 })));
  }
  chartTips();
}

// ---- helpers --------------------------------------------------------------------------------
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fmtShort = (d) =>
  new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
const fmtMonth = (m) =>
  new Intl.DateTimeFormat("en-IN", { month: "short", year: "2-digit", timeZone: "UTC" }).format(new Date(`${m}-01T00:00:00Z`));
const whenText = (inDays, date) => (inDays === 0 ? "today" : inDays === 1 ? "tomorrow" : `on ${fmtShort(date)}`);
// The biggest groups, with the rest folded into "Other" so bars stay readable.
function topWithOther(rows, n) {
  const sorted = [...rows].sort((a, b) => b.n - a.n);
  if (sorted.length <= n + 1) return sorted;
  const rest = sorted.slice(n).reduce((s, r) => s + r.n, 0);
  return [...sorted.slice(0, n), { name: "Other", n: rest }];
}
// A chart card: the plot area is filled by script; the same numbers as a table below.
function chartCard(title, sub, chartId, rows, cols) {
  return `<div class="card dash-chart"><h2>${esc(title)}</h2><p class="muted">${esc(sub)}</p><div class="chart" id="${chartId}"></div><details class="chart-table"><summary>View as table</summary><div class="table-wrap"><table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details></div>`;
}
// A rounded, even axis top, so the middle gridline is a whole number of people.
const niceMax = (v) => {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const m = Math.ceil(v / p) * p;
  return m % 2 ? m + p : m;
};
// Columns over time: one or two series side by side, a hairline grid, a few axis labels.
function drawColumns(id, data, colors, { lastLabel = false, legend = null } = {}) {
  const box = document.getElementById(id);
  if (!box) return;
  const max = niceMax(Math.max(1, ...data.flatMap((d) => d.values)));
  const ticks = [0, max / 2, max];
  // About five axis labels, counted back from the latest so it is always labelled.
  const every = Math.ceil(data.length / 5);
  box.className = "chart chart-columns";
  box.innerHTML =
    (legend ? `<div class="chart-legend">${legend.map((l, i) => `<span><i data-color="${colors[i]}"></i>${esc(l)}</span>`).join("")}</div>` : "") +
    `<div class="chart-plot"><div class="chart-grid">${ticks.map((t) => `<div class="chart-gridline" data-at="${(t / max) * 100}"><span>${t}</span></div>`).join("")}</div><div class="chart-slots">${data
      .map(
        (d, i) =>
          `<div class="chart-slot" tabindex="0" data-tip="${esc(d.tip)}" aria-label="${esc(d.tip)}">${d.values
            .map((v, s) => `<div class="chart-col" data-h="${(v / max) * 100}" data-color="${colors[s]}">${lastLabel && i === data.length - 1 ? `<b>${v}</b>` : ""}</div>`)
            .join("")}<span class="chart-x">${(data.length - 1 - i) % every === 0 ? esc(d.label) : ""}</span></div>`,
      )
      .join("")}</div></div>`;
  box.querySelectorAll("[data-h]").forEach((el) => (el.style.height = `${el.dataset.h}%`));
  box.querySelectorAll("[data-at]").forEach((el) => (el.style.bottom = `${el.dataset.at}%`));
  box.querySelectorAll("[data-color]").forEach((el) => (el.style.background = el.dataset.color));
}
// Horizontal bars for comparing groups, value at the tip.
function drawBars(id, rows) {
  const box = document.getElementById(id);
  if (!box) return;
  const max = Math.max(1, ...rows.map((r) => r.value));
  box.className = "chart chart-bars";
  box.innerHTML = rows.length
    ? rows
        .map(
          (r) =>
            `<div class="chart-bar-row" tabindex="0" data-tip="${esc(`${r.label}: ${r.value}`)}" aria-label="${esc(`${r.label}: ${r.value}`)}"><span class="chart-bar-label">${esc(r.label)}</span><span class="chart-bar-track"><span class="chart-bar" data-w="${(r.value / max) * 100}"></span></span><span class="chart-bar-value">${r.value}</span></div>`,
        )
        .join("")
    : '<p class="muted">No data yet.</p>';
  // A non-zero value always shows at least a sliver.
  box.querySelectorAll("[data-w]").forEach((el) => {
    const w = Number(el.dataset.w);
    el.style.width = `${w > 0 ? Math.max(w, 1.5) : 0}%`;
  });
}
// One tooltip for every chart: follows the pointer, and shows on keyboard focus too.
function chartTips() {
  let tip = document.querySelector("#chart-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.id = "chart-tip";
    tip.setAttribute("role", "tooltip");
    tip.hidden = true;
    document.body.append(tip);
  }
  const show = (el) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8)}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8)}px`;
  };
  const hide = () => (tip.hidden = true);
  document.querySelectorAll("#content [data-tip]").forEach((el) => {
    el.onpointerenter = () => show(el);
    el.onpointerleave = hide;
    el.onfocus = () => show(el);
    el.onblur = hide;
  });
}
