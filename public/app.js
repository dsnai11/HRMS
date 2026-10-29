const app = document.querySelector("#app");
// The security policy blocks style="" in markup, so per-element values (a bar's width,
// a photo's tilt) travel as data-css and are applied through the style API here.
function applyStyles(root = document) {
  root.querySelectorAll("[data-css]").forEach((el) => {
    for (const decl of el.dataset.css.split(";")) {
      const i = decl.indexOf(":");
      if (i > 0)
        el.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    }
    el.removeAttribute("data-css");
  });
}
new MutationObserver(() => applyStyles()).observe(document.documentElement, {
  childList: true,
  subtree: true,
});
let config = { company: "Company", timezone: "Asia/Kolkata" },
  me,
  page = "overview",
  activeCompany = null,
  companies = [];
const has = (permission) => me?.permissions?.includes(permission);
// Sign-in returns only the user; the full picture (permissions, company) comes from /me.
async function loadMe() {
  const p = await api("/me");
  me = {
    ...p.user,
    permissions: p.permissions,
    is_manager: p.is_manager,
    approvals_pending: p.approvals_pending,
    company: p.company,
  };
  companies = me.role === "super_admin" ? await api("/admin/companies") : [];
}
const landing = () => (has("attendance.read") ? "overview" : "mine");
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const initials = (name) =>
  esc(
    name
      .split(" ")
      .map((n) => n[0])
      .slice(0, 2)
      .join("")
      .toUpperCase(),
  );
const time = (value) =>
  value
    ? new Intl.DateTimeFormat("en-IN", {
        timeZone: config.timezone,
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "short",
      }).format(new Date(value))
    : "—";
const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
async function api(path, body, method = "POST") {
  const res = await fetch(`/api${path}`, {
    ...(body !== undefined || method !== "POST" ? { method } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: {
      "Content-Type": "application/json",
      ...(activeCompany ? { "X-Company-Id": String(activeCompany) } : {}),
    },
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") {
      me = null;
      activeCompany = null;
      login();
    }
    throw Object.assign(new Error(data.error || "Request failed."), {
      code: data.code,
    });
  }
  return data;
}
// Downloads go through fetch so the selected company is honoured.
async function download(path, filename) {
  const res = await fetch(`/api${path}`, {
    headers: activeCompany ? { "X-Company-Id": String(activeCompany) } : {},
  });
  if (!res.ok) throw new Error((await res.json()).error || "Download failed.");
  const url = URL.createObjectURL(await res.blob());
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: filename,
  });
  a.click();
  URL.revokeObjectURL(url);
}
let noticeTimer;
function notice(message, error = false) {
  const el = document.querySelector("#notice");
  el.textContent = message;
  el.className = error ? "error" : "";
  el.style.display = "block";
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => (el.style.display = "none"), 7000);
}
async function busy(button, fn) {
  button.disabled = true;
  try {
    await fn();
  } catch (e) {
    notice(e.message, true);
  } finally {
    button.disabled = false;
  }
}
const brand = (name = me?.company?.name || config.company) =>
  `<div class="brand"><span class="brand-icon">${esc(name.trim()[0]?.toUpperCase() || "H")}</span><div>${esc(name)}<small>PEOPLE & WORKPLACE</small></div></div>`;
const empty = (title, description) =>
  `<div class="empty"><div class="empty-icon">◎</div><strong>${esc(title)}</strong>${esc(description)}</div>`;
function login() {
  if (config.setupRequired) return setup();
  app.innerHTML = `<div class="login"><section class="login-story">${brand()}<div><div class="eyebrow">${esc(config.company)}</div><h1>Employee Engagement Portal</h1><p>Creating a great place to work.</p></div><footer class="muted">© ${new Date().getFullYear()}, ${esc(config.company)}</footer></section><section class="login-panel"><h2>Sign In</h2><p class="muted">Use your company email and password.</p><form id="login"><label>Email address<input type="email" name="email" autocomplete="username" placeholder="you@company.com" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button>Sign in →</button><a href="#" id="forgot" class="forgot">Forgot password?</a></form><p class="login-footer">Employees: use the credentials provided by your administrator.<br>Location is requested only when you punch in or out.</p></section></div>`;
  document.querySelector("#forgot")?.addEventListener("click", forgotDialog);
  document.querySelector("#login").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      let data;
      try {
        data = await api("/login", Object.fromEntries(new FormData(e.target)));
      } catch (err) {
        if (err.code === "totp_required") {
          if (!e.target.code) {
            e.target
              .querySelector("button")
              .insertAdjacentHTML(
                "beforebegin",
                '<label>Authenticator code or recovery code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="12" required></label>',
              );
          }
          e.target.code.focus();
        }
        throw err;
      }
      me = data.user;
      await loadMe();
      page = landing();
      await render();
    });
  };
}
// Search box in the top bar: finds anyone in the company from any page. HR opens
// the person's 360° profile; everyone else sees what the directory shows.
function peopleSearch() {
  const box = document.querySelector("#people-q");
  const out = document.querySelector("#people-out");
  if (!box) return;
  let timer, found = [];
  const close = () => (out.hidden = true);
  box.oninput = () => {
    clearTimeout(timer);
    const q = box.value.trim();
    if (!q) return close();
    timer = setTimeout(async () => {
      found = await api(`/directory?q=${encodeURIComponent(q)}`).catch(() => []);
      if (box.value.trim() !== q) return;
      out.innerHTML = found.length
        ? found
            .slice(0, 12)
            .map(
              (p, i) =>
                `<button type="button" data-hit="${i}"><span class="avatar">${initials(p.name)}</span><span><strong>${esc(p.name)}</strong><small>${esc([p.designation_name, p.department_name, p.branch_name].filter(Boolean).join(" · ") || p.employee_code || "")}</small></span></button>`,
            )
            .join("") +
          (found.length > 12
            ? `<button type="button" data-all>See all ${found.length} in the directory →</button>`
            : "")
        : '<p class="muted">Nobody found.</p>';
      out.hidden = false;
      out.querySelectorAll("[data-hit]").forEach(
        (b) =>
          (b.onclick = () => {
            const p = found[Number(b.dataset.hit)];
            close();
            if (has("employees.read")) return profile360Dialog(p.id, p.name);
            viewDialog(
              p.name,
              `<p class="muted">${esc([p.designation_name, p.department_name].filter(Boolean).join(" · "))}</p>${[
                ["Employee code", p.employee_code],
                ["Branch", p.branch_name],
                ["Reports to", p.manager_name],
                ["Phone", p.phone],
                ["Email", p.email],
              ]
                .filter(([, v]) => v)
                .map(
                  ([k, v]) =>
                    `<div class="kv"><span>${k}</span><strong>${esc(v)}</strong></div>`,
                )
                .join(
                  "",
                )}${p.email || p.phone ? "" : '<p class="muted">Contact details are visible to HR and their manager.</p>'}`,
            );
          }),
      );
      out.querySelector("[data-all]")?.addEventListener("click", () => {
        close();
        page = "directory";
        render().then(() => {
          const q2 = document.querySelector("#dir-q");
          if (q2) {
            q2.value = q;
            q2.dispatchEvent(new Event("input"));
          }
        });
      });
    }, 250);
  };
  box.onkeydown = (e) => e.key === "Escape" && close();
  // The top bar is redrawn on every page; close clicks are wired once.
  if (peopleSearch.wired) return;
  peopleSearch.wired = true;
  document.addEventListener("click", (e) => {
    const list = document.querySelector("#people-out");
    if (list && !e.target.closest(".people-search")) list.hidden = true;
  });
}
function setup() {
  app.innerHTML = `<div class="login"><section class="login-story">${brand()}<div><div class="eyebrow">${esc(config.company)}</div><h1>Your workspace<br>starts here.</h1><p>Create your administrator account to add workplaces and employees.</p></div></section><section class="login-panel"><h2>Set up your workspace</h2><p class="muted">Use the private setup code provided with your deployment.</p><form id="setup"><label>Setup code<input type="password" name="setupToken" required autocomplete="off"></label><label>Your name<input name="name" required maxlength="150"></label><label>Administrator email<input name="email" type="email" required autocomplete="username"></label><label>Password (12+ characters)<input name="password" type="password" minlength="12" maxlength="128" required autocomplete="new-password"></label><button>Create administrator</button></form></section></div>`;
  document.querySelector("#setup").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api("/setup", Object.fromEntries(new FormData(e.target)));
      config.setupRequired = false;
      notice("Administrator created. Sign in to continue.");
      login();
    });
  };
}
// The menu, grouped the way Laxmi's earlier HR portal grouped it: Home, then
// Attendance, Leave, TDS, Employee and so on, each opening to its pages.
function navGroups() {
  const staff = me.role !== "super_admin";
  const approver = me.is_manager || has("leave.approve") || me.approvals_pending;
  return [
    ["Home", "⌂", [staff && ["mine", "Home"]]],
    ["Overview", "◫", [has("attendance.read") && ["overview", "Overview"]]],
    [
      "Attendance",
      "▤",
      [
        staff && ["myattendance", "My Attendance"],
        me.is_manager && ["team", "Supervisor"],
        (me.is_manager || has("leave.approve")) && ["teamcal", "Team calendar"],
      ],
    ],
    [
      "Leave",
      "☼",
      [
        staff && ["timeoff", "My Leaves"],
        approver && [
          "approvals",
          me.approvals_pending
            ? `Supervisor (${me.approvals_pending})`
            : "Supervisor",
        ],
      ],
    ],
    ["TDS", "❒", [staff && ["payslips", "Payslips & Declarations"]]],
    [
      "Employee",
      "♙",
      [
        ["profile", "My Profile"],
        staff && ["myemployment", "My Employment"],
        ["directory", "Directory"],
        ["orgchart", "Org chart"],
      ],
    ],
    ["Documents", "▥", [["documents", "Documents"], ["policies", "Policies"]]],
    ["PMR", "★", [staff && ["performance", "Performance"]]],
    [
      "Recruitment",
      "✚",
      [
        staff && ["refer", "Refer A Candidate"],
        me.is_manager &&
          !has("recruitment.manage") && ["requisitions", "Requisitions"],
      ],
    ],
    ["LMS", "✎", [staff && ["learning", "My Courses"]]],
    ["Reimbursement", "₹", [staff && ["myclaims", "My Claim"]]],
    [
      "Connect",
      "✆",
      [
        staff && ["chat", 'Messages<span id="chat-n" class="nav-n"></span>'],
        (staff || has("bot.manage")) && ["laxmi", "Ask Laxmi"],
        ["helpdesk", "Helpdesk"],
      ],
    ],
    [
      "Administration",
      "⚙",
      [
        has("insights.read") && ["commandcentre", "HR Command Centre"],
        has("insights.read") && ["insights", "Insights"],
        (has("employees.read") || has("attendance.read") || has("leave.read") || has("payroll.read")) && [
          "customreports",
          "Custom reports",
        ],
        has("employees.read") && ["employees", "Employees"],
        has("org.read") && ["organization", "Organization"],
        has("attendance.read") && ["attendance", "Attendance records"],
        has("org.read") && ["workplaces", "Workplaces"],
        has("attendance.read") && ["muster", "Monthly muster"],
        has("leave.manage") && ["leaveadmin", "Leave & holidays"],
        has("payroll.read") && ["payroll", "Payroll"],
        (has("recruitment.manage") || has("exit.manage")) && [
          "hiring",
          "Hiring & exits",
        ],
        has("recruitment.manage") && ["rms", "RMS (resumes)"],
        has("devices.manage") && ["devices", "Devices"],
        has("roles.assign") && ["roles", "Roles & rights"],
        has("security.read") && ["security", "Security"],
        has("audit.read") && ["audit", "Activity log"],
      ],
    ],
  ]
    .map(([label, icon, items]) => [label, icon, items.filter(Boolean)])
    .filter(([, , items]) => items.length);
}
let navOpen = null;
function shell() {
  const groups = navGroups();
  const current = groups.find(([, , items]) =>
    items.some(([id]) => id === page),
  )?.[0];
  if (navOpen === null || current !== navOpen) navOpen = current ?? null;
  const scope = activeCompany || me.company_id;
  const nav = groups
    .map(([label, icon, items]) =>
      items.length === 1 && ["Home", "Overview"].includes(label)
        ? `<button data-page="${items[0][0]}" class="${page === items[0][0] ? "selected" : ""}"><span class="nav-icon">${icon}</span>${items[0][1]}</button>`
        : `<button type="button" class="nav-group ${label === navOpen ? "open" : ""}" data-group="${esc(label)}" aria-expanded="${label === navOpen}"><span class="nav-icon">${icon}</span>${esc(label)}<span class="chev">›</span></button><div class="nav-sub" ${label === navOpen ? "" : "hidden"}>${items.map(([id, text]) => `<button data-page="${id}" class="${page === id ? "selected" : ""}">${text}</button>`).join("")}</div>`,
    )
    .join("");
  const sub = [me.employee_code, me.designation].filter(Boolean);
  app.innerHTML = `<div class="layout"><aside class="sidebar">${brand()}<nav class="nav">${nav}</nav><div class="sidebar-foot"><strong>${esc(me.company?.name || config.company)}</strong>${esc(config.timezone)}</div></aside><main class="main"><header class="topbar"><div class="topbar-left">${me.role === "super_admin" ? "" : '<div class="people-search"><input id="people-q" type="search" placeholder="Search people across the company" aria-label="Search people" autocomplete="off"><div id="people-out" class="people-out" hidden></div></div>'}</div><div class="user">${companies.length > 1 ? `<select id="company" aria-label="Company">${companies.map((c) => `<option value="${c.id}" ${c.id === scope ? "selected" : ""}>${esc(c.name)}${c.active ? "" : " (inactive)"}</option>`).join("")}</select>` : ""}<button class="ghost bell" id="bell" aria-label="Notifications">🔔<span id="bell-n" class="bell-n"></span></button><div class="me-menu"><button type="button" class="me-button" id="me-button" aria-haspopup="true" aria-expanded="false"><span class="avatar">${initials(me.name)}</span><span class="me-text"><strong>${esc(sub[0] || me.name)}</strong><small>${esc(sub[1] || (sub[0] ? me.name : ""))}</small></span><span class="chev">⌄</span></button><div class="me-drop" id="me-drop" hidden><div class="me-name">${esc(me.name)}</div><button type="button" data-page="profile">Personal Information</button><button type="button" id="password">Change Password</button><button type="button" id="logout">Log Out</button></div></div></div></header><section class="content" id="content"><div class="loading">Loading…</div></section><footer class="foot">© ${new Date().getFullYear()}, ${esc(me.company?.name || config.company)}</footer></main></div>`;
  document.querySelectorAll("[data-group]").forEach(
    (b) =>
      (b.onclick = () => {
        const opening = navOpen !== b.dataset.group;
        navOpen = opening ? b.dataset.group : "";
        document.querySelectorAll("[data-group]").forEach((g) => {
          const on = opening && g === b;
          g.classList.toggle("open", on);
          g.setAttribute("aria-expanded", on);
          g.nextElementSibling.hidden = !on;
        });
      }),
  );
  const drop = document.querySelector("#me-drop");
  document.querySelector("#me-button").onclick = (e) => {
    e.stopPropagation();
    drop.hidden = !drop.hidden;
    e.currentTarget.setAttribute("aria-expanded", !drop.hidden);
  };
  if (!shell.wired) {
    shell.wired = true;
    document.addEventListener("click", (e) => {
      const d = document.querySelector("#me-drop");
      if (d && !e.target.closest(".me-menu")) d.hidden = true;
    });
  }
  bellInit();
  chatInit();
  peopleSearch();
  document.querySelector("#company")?.addEventListener("change", async (e) => {
    activeCompany =
      Number(e.target.value) === me.company_id ? null : Number(e.target.value);
    try {
      await loadMe();
    } catch (err) {
      notice(err.message, true);
    }
    await render();
  });
  document.querySelectorAll("[data-page]").forEach(
    (b) =>
      (b.onclick = () => {
        page = b.dataset.page;
        render();
      }),
  );
  document.querySelector("#logout").onclick = (e) =>
    busy(e.target, async () => {
      await api("/logout", {});
      me = null;
      activeCompany = null;
      login();
    });
  document.querySelector("#password").onclick = () => passwordDialog();
}
function heading(title, subtitle, action = "") {
  return `<div class="heading"><div><div class="eyebrow">People operations</div><h1>${esc(title)}</h1><p class="muted">${esc(subtitle)}</p></div>${action}</div>`;
}
const reasonLabels = {
  late_in: "late in",
  early_out: "left early",
  missed_out: "no punch-out",
};
function dayCell(s) {
  const reasons = JSON.parse(s.half_day_reasons || "[]")
    .map((r) => reasonLabels[r] || r)
    .join(", ");
  const origin = {
    regularized: "corrected",
    on_duty: "on duty",
    work_from_home: "work from home",
  }[s.source];
  if (origin && s.day_type)
    return `<span class="pill ${s.day_type === "half_day" ? "" : "neutral"}">${s.day_type === "half_day" ? "Half day" : "Full day"}</span><small>${origin}</small>`;
  if (s.day_type === "half_day")
    return `<span class="pill">Half day</span><small>${esc(reasons)}${s.out_at ? "" : " · still working"}</small>`;
  if (s.day_type === "full_day")
    return `<span class="pill neutral">Full day</span>`;
  return s.required_out_at
    ? `<small>Out after ${time(s.required_out_at)} for a full day</small>`
    : "—";
}
function table(rows) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Workplace</th><th>Punch in</th><th>Punch out</th><th>Hours</th><th>Status</th><th>Day</th><th>GPS records</th><th>Selfie</th></tr></thead><tbody>${rows.map((s) => `<tr><td><div class="person"><span class="avatar">${initials(s.employee_name || me.name)}</span><div>${esc(s.employee_name || me.name)}<small>${esc(s.email || me.email)}</small></div></div></td><td>${esc(s.workplace_name)}</td><td>${time(s.in_at)}</td><td>${time(s.out_at)}</td><td>${(((s.out_at ? Date.parse(s.out_at) : Date.now()) - Date.parse(s.in_at)) / 3600000).toFixed(2)}</td><td><span class="pill ${s.out_at ? "neutral" : ""}">${s.out_at ? "Completed" : "Working"}</span></td><td>${dayCell(s)}</td><td><a href="https://www.google.com/maps?q=${s.in_latitude},${s.in_longitude}" target="_blank" rel="noreferrer">In · ±${Math.round(s.in_accuracy)}m ↗</a>${s.out_at ? `<small><a href="https://www.google.com/maps?q=${s.out_latitude},${s.out_longitude}" target="_blank" rel="noreferrer">Out · ±${Math.round(s.out_accuracy)}m ↗</a></small>` : ""}</td><td>${Number(s.selfies) && has("attendance.read") && s.employee_name ? `<button class="ghost" data-selfie="${s.id}">View</button>` : "—"}</td></tr>`).join("")}</tbody></table></div>`
    : empty("No attendance records yet", "Recorded punches will appear here.");
}
let renderId = 0;
async function render() {
  const id = ++renderId;
  // Announcements are on the front page (older alerts still link to the old page).
  if (page === "announcements") page = landing();
  shell();
  if (me.must_change_password) {
    document.querySelector("#content").innerHTML =
      heading(
        "Set your password",
        "Change your temporary password to activate your account.",
      ) + '<button id="change-now">Change password</button>';
    document.querySelector("#change-now").onclick = () => passwordDialog(true);
    passwordDialog(true);
    return;
  }
  try {
    if (page === "mine") return await employeeView(id);
    if (page === "myattendance") return await myAttendancePage(id);
    if (page === "profile") return await profileView(id);
    if (page === "team") return await teamView(id);
    if (page === "timeoff") return await timeOffPage(id);
    if (page === "approvals") return await approvalsPage(id);
    if (page === "leaveadmin") return await leaveAdminPage(id);
    if (page === "muster") return await musterPage(id);
    if (page === "payroll") return await payrollPage(id);
    if (page === "payslips") return await payslipsPage(id);
    if (page === "myclaims") return await myClaimsPage(id);
    if (page === "myemployment") return await myEmploymentPage(id);
    if (page === "insights") return await insightsPage(id);
    if (page === "customreports") return await customReportsPage(id);
    if (page === "performance") return await performancePage(id);
    if (page === "learning") return await learningPage(id);
    if (page === "requisitions") return await requisitionsPage(id);
    if (page === "directory") return await directoryPage(id);
    if (page === "orgchart") return await orgChartPage(id);
    if (page === "teamcal") return await teamCalendarPage(id);
    if (page === "refer") return await referPage(id);
    if (page === "documents") return await documentsPage(id);
    if (page === "roles") return await rolesPage(id);
    if (page === "commandcentre") return await commandCentrePage(id);
    if (page === "rms") return await rmsPage(id);
    if (page === "helpdesk") return await helpdeskPage(id);
    if (page === "policies") return await policiesPage(id);
    if (page === "chat") return await chatPage(id);
    if (page === "laxmi") return await laxmiPage(id);
    if (page === "hiring") return await hiringPage(id);
    if (page === "overview") {
      const [stats, active, sites, home] = await Promise.all([
        api("/admin/overview"),
        api("/admin/active"),
        api("/admin/workplaces"),
        homeData(),
      ]);
      if (id !== renderId) return;
      document.querySelector("#content").innerHTML =
        heading(
          "A clear view of your workplace",
          "Your team’s attendance, at a glance.",
          `<button class="secondary" id="refresh">↻ Refresh</button>`,
        ) +
        `<div class="stats">${[
          ["Active employees", stats.employees, "Enabled company accounts"],
          ["Working now", stats.active, "Open shifts across all dates"],
          [
            "Attended today",
            stats.attended,
            "Distinct employees who punched in",
          ],
          [
            "Hours today",
            stats.hours.toFixed(1),
            "Shifts started today · includes active time",
          ],
        ]
          .map(
            ([label, value, desc], i) =>
              `<div class="stat ${i === 1 ? "featured" : ""}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div><small>${desc}</small></div>`,
          )
          .join(
            "",
          )}</div><div class="grid-two">${announcementsHtml(home.announcements)}${holidaysHtml(home.holidays)}</div><div class="card"><div class="card-head"><div><h2>Who’s working now</h2><p class="muted">Most recent punch location. No continuous tracking.</p></div><span class="pill">${stats.active} active shifts</span></div>${table(active)}</div><div class="grid-two"><div class="card"><h2>Your workplaces</h2>${sites.length ? sites.map((s) => `<div class="site"><h3>${esc(s.name)}</h3><p class="muted">${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}</p><span class="pill neutral">${s.radius} m radius</span></div>`).join("") : empty("Set up your first workplace", "Open Workplaces to define an attendance boundary.")}</div><div class="card"><div class="eyebrow">Designed for trust</div><h2>Right place. Right record.</h2><p class="muted">Employees punch in and out inside their assigned workplace. Every punch records server time and a fresh GPS reading.</p><div class="callout">Location is captured only at attendance events. GPS uncertainty must fit inside the workplace boundary.</div></div></div>`;
      document.querySelector("#refresh").onclick = render;
      announcementsWire();
    } else if (page === "employees") {
      await employeesPage(id);
      await importPeopleCard(id);
    } else if (page === "organization") {
      await organizationPage(id);
    } else if (page === "workplaces") {
      const sites = await api("/admin/workplaces");
      if (id !== renderId) return;
      document.querySelector("#content").innerHTML =
        heading(
          "Workplaces",
          "Define where your employees can begin and end their day.",
          has("workplaces.manage")
            ? '<button id="add">+ Add workplace</button>'
            : "",
        ) +
        `<div class="card">${sites.length ? sites.map((s) => `<div class="site"><h3>${esc(s.name)}</h3><p class="muted">${s.branch_name ? `${esc(s.branch_name)} · ` : ""}${s.latitude}, ${s.longitude} · Maximum GPS uncertainty ${s.max_accuracy} m</p><span class="pill">${s.radius} m allowed radius</span> <a href="https://www.google.com/maps?q=${s.latitude},${s.longitude}" target="_blank" rel="noreferrer">View on map ↗</a></div>`).join("") : empty("A place to start", "Add your office coordinates and the allowed attendance radius.")}</div><p class="muted">Workplace boundaries are fixed after creation. Add a new workplace to change a boundary, then reassign employees after their shifts end.</p>`;
      document
        .querySelector("#add")
        ?.addEventListener("click", () => workplaceDialog());
      await selfieSettingCard(id);
      await shiftPolicyCard(id);
      await rosterCard(id);
      await importCard(id);
    } else if (page === "attendance") {
      document.querySelector("#content").innerHTML =
        heading(
          "Attendance records",
          `Dates use ${config.timezone}. Records are grouped by punch-in date.`,
        ) +
        `<div class="card"><form class="filters" id="filters"><label>From<input type="date" name="from" value="${today()}" required></label><label>To<input type="date" name="to" value="${today()}" required></label><button>Apply filters</button><button type="button" class="secondary" id="export">↓ Export CSV</button></form></div><div class="card" id="records">Loading records…</div>`;
      let query = new URLSearchParams(
        new FormData(document.querySelector("#filters")),
      );
      const load = async () => {
        const rows = await api(`/admin/attendance?${query}`);
        if (id === renderId)
          document.querySelector("#records").innerHTML = table(rows);
      };
      document.querySelector("#filters").onsubmit = (e) => {
        e.preventDefault();
        busy(e.submitter, async () => {
          query = new URLSearchParams(new FormData(e.target));
          await load();
        });
      };
      document.querySelector("#export").onclick = (e) =>
        busy(e.target, () =>
          download(`/admin/export?${query}`, "attendance.csv"),
        );
      await load();
    } else if (page === "devices") {
      const devices = await api("/admin/devices");
      if (id !== renderId) return;
      const pendingCount = devices.filter((d) => d.status === "pending").length;
      document.querySelector("#content").innerHTML =
        heading(
          "Registered phones",
          "Each employee can record attendance from one approved phone. Approve a phone only after confirming the employee just registered it.",
        ) +
        `<div class="card"><div class="card-head"><div><h2>Phones</h2><p class="muted">Approving a new phone replaces the employee's current one.</p></div><span class="pill ${pendingCount ? "" : "neutral"}">${pendingCount} awaiting approval</span></div>${
          devices.length
            ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Phone</th><th>Registered</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>${devices
                .map(
                  (d) =>
                    `<tr><td>${esc(d.employee_name)}<br><small>${esc(d.email)}</small></td><td>${esc([d.platform, d.model].filter(Boolean).join(" · "))}</td><td>${time(d.registered_at)}</td><td>${time(d.last_seen_at)}</td><td><span class="pill ${d.status === "approved" ? "" : "neutral"}">${esc(d.status)}</span></td><td>${d.status !== "approved" ? `<button class="secondary" data-device="${d.id}" data-status="approved">Approve</button> ` : ""}${d.status !== "revoked" ? `<button class="ghost" data-device="${d.id}" data-status="revoked">Remove</button>` : ""}</td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : empty(
                "No phones registered",
                "Phones appear here when employees sign in to the mobile app.",
              )
        }</div>`;
      document.querySelectorAll("[data-device]").forEach(
        (b) =>
          (b.onclick = () =>
            busy(b, async () => {
              await api(
                `/admin/devices/${b.dataset.device}`,
                { status: b.dataset.status },
                "PATCH",
              );
              notice(
                b.dataset.status === "approved"
                  ? "Phone approved."
                  : "Phone removed.",
              );
              await render();
            })),
      );
    } else if (page === "security") {
      const events = await api("/admin/security-events");
      if (id !== renderId) return;
      const labels = {
        mock_location: "Mock location",
        emulator: "Emulator",
        rooted_device: "Rooted device",
        impossible_travel: "Impossible travel",
        repeated_exact_coordinates: "Identical coordinates",
        web_punch_blocked: "Web punch attempt",
        device_unknown: "Unknown phone",
        device_pending: "Unapproved phone",
        device_revoked: "Removed phone",
        outside_geofence: "Outside workplace",
        gps_accuracy: "Weak GPS",
        stale_location: "Stale location",
      };
      document.querySelector("#content").innerHTML =
        heading(
          "Security events",
          "Refused punch attempts and punches with warning signs. Review anything unusual with the employee.",
        ) +
        `<div class="card">${
          events.length
            ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Employee</th><th>Action</th><th>Result</th><th>Signals</th><th>Detail</th></tr></thead><tbody>${events
                .map(
                  (e) =>
                    `<tr><td>${time(e.created_at)}</td><td>${esc(e.employee_name)}</td><td>${esc(e.action ?? "—")}</td><td><span class="pill ${e.outcome === "accepted" ? "neutral" : ""}">${esc(e.outcome)}</span></td><td>${JSON.parse(
                      e.flags,
                    )
                      .map((f) => esc(labels[f] || f))
                      .join(
                        ", ",
                      )}</td><td><small>${esc(e.reason ?? "")}</small></td></tr>`,
                )
                .join("")}</tbody></table></div>`
            : empty("Nothing to review", "No refused or flagged punches yet.")
        }</div>`;
    } else {
      const [logs, store] = await Promise.all([
        api("/admin/audit"),
        api("/admin/storage"),
      ]);
      if (id !== renderId) return;
      const mb = (n) => (n / 1048576).toFixed(n >= 104857600 ? 0 : 1);
      document.querySelector("#content").innerHTML =
        heading(
          "Activity log",
          "Latest 100 account, workplace, and attendance events.",
        ) +
        `<div class="card"><h2>Storage</h2><p>${mb(store.database_bytes)} MB of ${mb(store.limit_bytes)} MB used (${store.percent}%)${store.percent >= 80 ? ' <span class="pill">Nearly full</span>' : ""}</p><p class="muted">${store.documents.count} documents (${mb(store.documents.bytes)} MB) · ${store.selfies.count} punch selfies (${mb(store.selfies.bytes)} MB, deleted after 90 days).</p></div>` +
        `<div class="card">${logs.map((l) => `<div class="activity"><strong>${esc(l.actor_name)}</strong> · ${esc(l.action.replaceAll("_", " "))}<br><small>${time(l.created_at)} · ${esc(l.detail)}</small></div>`).join("") || empty("No events yet", "Activity will appear here.")}</div>`;
    }
  } catch (e) {
    notice(e.message, true);
    if (id === renderId && document.querySelector("#content"))
      document.querySelector("#content").innerHTML =
        '<p class="error-text">This view could not be loaded. Please refresh or sign in again.</p>';
  }
}
function dialog(title, fields, onSubmit, mandatory = false) {
  document.querySelector("dialog")?.remove();
  const d = document.createElement("dialog");
  d.innerHTML = `<h2>${esc(title)}</h2><form><div class="form-grid">${fields}</div><p class="error-text" id="form-error" role="alert"></p><div class="form-actions">${mandatory ? "" : '<button type="button" class="secondary" id="cancel">Cancel</button>'}<button type="submit">Save</button></div></form>`;
  document.body.append(d);
  d.showModal();
  d.querySelector("#cancel")?.addEventListener("click", () => d.remove());
  if (mandatory) d.oncancel = (e) => e.preventDefault();
  d.querySelector("form").onsubmit = async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      await onSubmit(Object.fromEntries(new FormData(e.target)));
      d.remove();
      await render();
    } catch (err) {
      d.querySelector("#form-error").textContent = err.message;
    } finally {
      e.submitter.disabled = false;
    }
  };
}
const EMPLOYMENT = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
  intern: "Intern",
  consultant: "Consultant",
};
const ROLE_LABELS = {
  super_admin: "Platform owner",
  admin: "Admin",
  hr: "HR",
  payroll: "Payroll",
  employee: "Employee",
  custom: "Custom role",
};
const roleLabel = (p) =>
  p.role === "custom"
    ? p.custom_role_name || ROLE_LABELS.custom
    : ROLE_LABELS[p.role] || p.role;
const assignable = () =>
  me.role === "super_admin"
    ? ["employee", "hr", "payroll", "admin", "super_admin"]
    : me.role === "admin"
      ? ["employee", "hr", "payroll", "admin"]
      : ["employee"];
// The role picker's choices: built-in roles, then the company's own roles as "custom:<id>".
const roleChoices = (roles, customRoles = []) => [
  ...roles.map((r) => [r, ROLE_LABELS[r]]),
  ...(roles.includes("admin")
    ? customRoles.map((r) => [`custom:${r.id}`, `${r.name} (custom)`])
    : []),
];
const options = (items, selected, blank = "— None —") =>
  `<option value="">${esc(blank)}</option>${items.map((o) => `<option value="${o.id}" ${o.id === selected ? "selected" : ""}>${esc(o.name)}${o.employee_code ? ` (${esc(o.employee_code)})` : ""}</option>`).join("")}`;
const input = (name, label, value = "", extra = "") =>
  `<label>${label}<input name="${name}" value="${esc(value)}" ${extra}></label>`;

async function employeesPage(id) {
  const org = await api("/admin/org");
  org.custom = await api("/custom-fields");
  org.roles = has("roles.assign") ? (await api("/admin/roles")).custom : [];
  if (id !== renderId) return;
  const limit = 25;
  let offset = 0;
  document.querySelector("#content").innerHTML =
    heading(
      "Your people",
      "Employee records, roles and reporting lines.",
      has("employees.write") ? '<button id="add">+ Add employee</button>' : "",
    ) +
    `<div class="card"><form class="filters" id="filters"><label>Search<input name="q" placeholder="Name, email or code"></label><label>Department<select name="department_id">${options(org.departments, null, "All")}</select></label><label>Branch<select name="branch_id">${options(org.branches, null, "All")}</select></label><label>Status<select name="active"><option value="1">Active</option><option value="0">Inactive</option><option value="">All</option></select></label><button>Search</button></form></div><div class="card" id="list">Loading…</div>`;
  const form = document.querySelector("#filters");
  const load = async () => {
    const params = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (v) params.set(k, v);
    params.set("limit", limit);
    params.set("offset", offset);
    const data = await api(`/admin/employees?${params}`);
    if (id !== renderId) return;
    const rows = data.items;
    document.querySelector("#list").innerHTML = rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Reports to</th><th>Workplace</th><th>Role</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((e) => `<tr><td><div class="person"><span class="avatar">${initials(e.name)}</span><div>${esc(e.name)}<small>${esc(e.employee_code || "")} · ${esc(e.email)}</small></div></div></td><td>${esc(e.department_name || "—")}<small>${esc(e.designation_name || "")}</small></td><td>${esc(e.manager_name || "—")}</td><td>${esc(e.workplace_name || "—")}</td><td>${esc(roleLabel(e))}</td><td><span class="pill ${e.active ? "" : "neutral"}">${e.active ? "Active" : "Inactive"}</span></td><td>${has("employees.write") ? `<button class="secondary" data-edit="${e.id}">Manage</button> <button class="ghost" data-p360="${e.id}" data-name="${esc(e.name)}">360°</button>` : ""}${has("employees.read") ? ` <button class="ghost" data-details="${e.id}" data-name="${esc(e.name)}">Details</button>` : ""}</td></tr>`).join("")}</tbody></table></div><div class="pager"><span class="muted">${offset + 1}–${offset + rows.length} of ${data.total}</span><button class="secondary" id="prev" ${offset ? "" : "disabled"}>← Previous</button><button class="secondary" id="next" ${offset + limit < data.total ? "" : "disabled"}>Next →</button></div>`
      : empty("No employees found", "Adjust the search or add an employee.");
    document
      .querySelector("#prev")
      ?.addEventListener("click", () =>
        busy(
          document.querySelector("#prev"),
          async () => ((offset -= limit), await load()),
        ),
      );
    document
      .querySelector("#next")
      ?.addEventListener("click", () =>
        busy(
          document.querySelector("#next"),
          async () => ((offset += limit), await load()),
        ),
      );
    document
      .querySelectorAll("[data-p360]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            profile360Dialog(Number(b.dataset.p360), b.dataset.name)),
      );
    document.querySelectorAll("[data-details]").forEach(
      (b) =>
        (b.onclick = () =>
          busy(b, () =>
            employeeDetailsDialog(Number(b.dataset.details), b.dataset.name),
          )),
    );
    document
      .querySelectorAll("[data-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            busy(b, async () =>
              employeeDialog(
                org,
                await api(`/admin/employees/${b.dataset.edit}`),
              ),
            )),
      );
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    offset = 0;
    busy(e.submitter, load);
  };
  document
    .querySelector("#add")
    ?.addEventListener("click", () => employeeDialog(org));
  await load();
}

function employeeDialog(org, e) {
  const roles = assignable();
  const current =
    e?.role === "custom" ? `custom:${e.custom_role_id}` : e?.role || "employee";
  dialog(
    e ? "Manage employee" : "Add employee",
    `<div class="full"><strong>Account</strong></div>${e ? `<div class="full muted">${esc(e.email)}</div>${input("name", "Full name", e.name, 'maxlength="150" required')}` : `${input("name", "Full name", "", 'maxlength="150" required')}${input("email", "Email", "", 'type="email" required')}`}<label>${e ? "Reset password (optional)" : "Temporary password"}<input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" ${e ? "" : "required"}></label>${roles.length > 1 && has("roles.assign") ? `<label>Role<select name="role">${roleChoices(roles, org.roles).map(([v, label]) => `<option value="${v}" ${v === current ? "selected" : ""}>${esc(label)}</option>`).join("")}</select></label>` : ""}${e ? `<label>Account status<select name="active"><option value="true" ${e.active ? "selected" : ""}>Active</option><option value="false" ${e.active ? "" : "selected"}>Inactive</option></select></label>` : ""}<div class="full"><strong>Job</strong></div>${input("employee_code", "Employee code", e?.employee_code || "", 'maxlength="30" placeholder="Auto-generated"')}<label>Employment type<select name="employment_type"><option value="">—</option>${Object.entries(
      EMPLOYMENT,
    )
      .map(
        ([k, v]) =>
          `<option value="${k}" ${k === e?.employment_type ? "selected" : ""}>${v}</option>`,
      )
      .join(
        "",
      )}</select></label><label>Department<select name="department_id">${options(org.departments, e?.department_id)}</select></label><label>Designation<select name="designation_id">${options(org.designations, e?.designation_id)}</select></label><label>Branch<select name="branch_id">${options(org.branches, e?.branch_id)}</select></label><label>Attendance workplace<select name="workplace_id">${options(org.workplaces, e?.workplace_id)}</select></label><label>Reports to<select name="manager_id">${options(
      org.managers.filter((m) => m.id !== e?.id),
      e?.manager_id,
    )}</select></label>${input("date_of_joining", "Date of joining", e?.date_of_joining || "", 'type="date"')}${input("division", "Division", e?.division || "", 'maxlength="80"')}${input("section", "Section", e?.section || "", 'maxlength="80"')}${input("employee_level", "Employee level", e?.employee_level || "", 'maxlength="40" placeholder="e.g. L3"')}${input("job_title_code", "Job title code", e?.job_title_code || "", 'maxlength="30"')}${orgExtraFields(org, e)}<div class="full"><strong>Personal</strong></div>${input("phone", "Phone", e?.phone || "", 'maxlength="20"')}${input("date_of_birth", "Date of birth", e?.date_of_birth || "", 'type="date"')}<label>Gender<select name="gender"><option value="">—</option>${["male", "female", "other"].map((g) => `<option value="${g}" ${g === e?.gender ? "selected" : ""}>${g[0].toUpperCase() + g.slice(1)}</option>`).join("")}</select></label>${input("address", "Address", e?.address || "", 'maxlength="300"')}<div class="full"><strong>Emergency contact</strong></div>${input("emergency_name", "Name", e?.emergency_name || "", 'maxlength="100"')}${input("emergency_phone", "Phone", e?.emergency_phone || "", 'maxlength="20"')}${input("emergency_relation", "Relation", e?.emergency_relation || "", 'maxlength="50"')}`,
    async (b) => {
      for (const k of [
        "department_id",
        "designation_id",
        "branch_id",
        "workplace_id",
        "manager_id",
        "grade_id",
        "cost_centre_id",
        "business_unit_id",
      ])
        b[k] = b[k] ? Number(b[k]) : null;
      b.custom = collectCustom(b);
      if (b.role?.startsWith("custom:")) {
        b.custom_role_id = Number(b.role.slice(7));
        b.role = "custom";
      }
      if (e) {
        b.active = b.active === "true";
        if (!b.password) delete b.password;
        if (!b.employee_code) delete b.employee_code;
      } else if (!b.employee_code) delete b.employee_code;
      await api(
        e ? `/admin/employees/${e.id}` : "/admin/employees",
        b,
        e ? "PATCH" : "POST",
      );
      notice(e ? "Employee updated." : "Employee created.");
    },
  );
}

const ORG_TABS = {
  departments: {
    label: "Departments",
    noun: "department",
    columns: [["code", "Code"]],
  },
  designations: { label: "Designations", noun: "designation", columns: [] },
  grades: {
    label: "Grades",
    noun: "grade",
    columns: [
      ["level", "Level"],
      ["salary_min", "Pay from"],
      ["salary_max", "Pay up to"],
    ],
  },
  cost_centres: {
    label: "Cost centres",
    noun: "cost centre",
    columns: [["code", "Code"]],
  },
  business_units: {
    label: "Business units",
    noun: "business unit",
    columns: [["code", "Code"]],
  },
  customfields: { label: "Custom fields", special: true },
  terms: { label: "Terms", special: true },
  branches: {
    label: "Branches",
    noun: "branch",
    columns: [
      ["code", "Code"],
      ["city", "City"],
      ["state", "State"],
    ],
  },
};
let orgTab = "departments";
async function organizationPage(id) {
  const tabs = {
    ...ORG_TABS,
    ...(me.role === "super_admin"
      ? {
          companies: {
            label: "Companies",
            noun: "company",
            columns: [["code", "Code"]],
          },
        }
      : {}),
  };
  if (!tabs[orgTab]) orgTab = "departments";
  const spec = tabs[orgTab];
  if (spec.special) return await orgSpecialPage(id, tabs);
  const rows = await api(`/admin/${orgTab}`);
  if (id !== renderId) return;
  const manage =
    orgTab === "companies" ? has("companies.manage") : has("org.manage");
  document.querySelector("#content").innerHTML =
    heading(
      "Organization",
      "Companies, branches, departments and designations.",
      manage ? `<button id="add">+ Add ${spec.noun}</button>` : "",
    ) +
    `<div class="tabbar">${Object.entries(tabs)
      .map(
        ([k, t]) =>
          `<button class="${k === orgTab ? "" : "secondary"}" data-tab="${k}">${t.label}</button>`,
      )
      .join(
        "",
      )}</div><div class="card">${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th>${spec.columns.map(([, l]) => `<th>${l}</th>`).join("")}<th>Employees</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}</td>${spec.columns.map(([k]) => `<td>${esc(r[k] || "—")}</td>`).join("")}<td>${r.employees ?? 0}</td><td><span class="pill ${r.active ? "" : "neutral"}">${r.active ? "Active" : "Inactive"}</span></td><td>${manage ? `<button class="secondary" data-edit="${r.id}">Edit</button>` : ""}</td></tr>`).join("")}</tbody></table></div>` : empty(`No ${spec.label.toLowerCase()} yet`, "Add the first one to get started.")}</div>`;
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => (b.onclick = () => ((orgTab = b.dataset.tab), render())));
  const open = (row) => orgDialog(orgTab, spec, row);
  document.querySelector("#add")?.addEventListener("click", () => open());
  document
    .querySelectorAll("[data-edit]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          open(rows.find((r) => r.id === Number(b.dataset.edit)))),
    );
}
function orgDialog(kind, spec, row) {
  const fields = {
    code: ["Code", 20],
    city: ["City", 80],
    state: ["State", 80],
    level: ["Level (1 is lowest)", 3],
    salary_min: ["Pay from (₹ a year)", 12],
    salary_max: ["Pay up to (₹ a year)", 12],
  };
  dialog(
    `${row ? "Edit" : "Add"} ${spec.noun}`,
    `${input("name", "Name", row?.name || "", 'maxlength="150" required')}${spec.columns.map(([k]) => (kind === "companies" && row && k === "code" ? "" : input(k, fields[k][0], row?.[k] ?? "", `${["level", "salary_min", "salary_max"].includes(k) ? 'type="number" min="0"' : `maxlength="${fields[k][1]}"`} ${kind === "companies" ? "required" : ""}`))).join("")}${kind === "branches" ? input("address", "Address", row?.address || "", 'maxlength="300"') : ""}${row ? `<label>Status<select name="active"><option value="true" ${row.active ? "selected" : ""}>Active</option><option value="false" ${row.active ? "" : "selected"}>Inactive</option></select></label>` : ""}`,
    async (b) => {
      if (row) b.active = b.active === "true";
      for (const k of ["level", "salary_min", "salary_max"])
        if (k in b) b[k] = b[k] === "" ? null : Number(b[k]);
      await api(
        `/admin/${kind}${row ? `/${row.id}` : ""}`,
        b,
        row ? "PATCH" : "POST",
      );
      if (kind === "companies") await loadMe();
      notice(`${spec.noun[0].toUpperCase() + spec.noun.slice(1)} saved.`);
    },
  );
}

async function profileView(id) {
  const p = await api("/profile");
  if (id !== renderId) return;
  const row = (label, value) =>
    `<div class="kv"><span class="muted">${label}</span><strong>${esc(value || "—")}</strong></div>`;
  document.querySelector("#content").innerHTML =
    heading(
      "My profile",
      "Your details as held by HR.",
      '<button class="secondary" id="edit">Edit contact details</button>',
    ) +
    `<div class="card"><h2>${esc(p.name)}</h2><p class="muted">${esc(p.designation_name || "")}${p.designation_name && p.department_name ? " · " : ""}${esc(p.department_name || "")}</p>${row("Employee code", p.employee_code)}${row("Email", p.email)}${row("Role", roleLabel({ ...p, custom_role_name: p.custom_role_name ?? me.role_name }))}${row("Reports to", p.manager_name)}${row("Branch", p.branch_name)}${row("Workplace", p.workplace_name)}${row("Division", p.division)}${row("Section", p.section)}${row("Employee level", p.employee_level)}${row("Job title code", p.job_title_code)}${row("Employment", EMPLOYMENT[p.employment_type])}${row("Date of joining", p.date_of_joining)}</div><div class="card"><h2>Contact</h2>${row("Phone", p.phone)}${row("Address", p.address)}${row("Emergency contact", [p.emergency_name, p.emergency_relation, p.emergency_phone].filter(Boolean).join(" · "))}</div><p class="muted">To change your name, email, department or other job details, contact HR.</p>`;
  await securityCard(id);
  await myDetailsCard(id);
  await bankCard(id);
  await profile360Card(id);
  document.querySelector("#edit").onclick = () =>
    dialog(
      "Edit contact details",
      `${input("phone", "Phone", p.phone || "", 'maxlength="20"')}${input("address", "Address", p.address || "", 'maxlength="300"')}${input("emergency_name", "Emergency contact name", p.emergency_name || "", 'maxlength="100"')}${input("emergency_phone", "Emergency contact phone", p.emergency_phone || "", 'maxlength="20"')}${input("emergency_relation", "Relation", p.emergency_relation || "", 'maxlength="50"')}`,
      async (b) => {
        await api("/profile", b, "PATCH");
        notice("Contact details updated.");
      },
    );
}

async function teamView(id) {
  const members = await api("/team/members");
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "My team",
      "People who report to you, directly or through others.",
    ) +
    `<div class="card"><h2>Members</h2><div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>Relation</th><th>Status</th></tr></thead><tbody>${members.map((m) => `<tr><td>${esc(m.name)}<small>${esc(m.employee_code || "")} · ${esc(m.email)}</small></td><td>${esc(m.department_name || "—")}<small>${esc(m.designation_name || "")}</small></td><td>${m.direct ? "Direct report" : "Indirect"}</td><td><span class="pill ${m.active ? "" : "neutral"}">${m.active ? "Active" : "Inactive"}</span></td></tr>`).join("")}</tbody></table></div></div><div class="card"><form class="filters" id="filters"><label>From<input type="date" name="from" value="${today()}" required></label><label>To<input type="date" name="to" value="${today()}" required></label><button>Show attendance</button></form></div><div class="card" id="records">Loading…</div>`;
  const load = async (query) => {
    const rows = await api(`/team/attendance?${query}`);
    if (id === renderId)
      document.querySelector("#records").innerHTML = table(rows);
  };
  document.querySelector("#filters").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, () => load(new URLSearchParams(new FormData(e.target))));
  };
  await load(new URLSearchParams({ from: today(), to: today() }));
}
function workplaceDialog() {
  dialog(
    "Add a workplace",
    '<label class="full">Workplace name<input name="name" maxlength="150" placeholder="Head office" required></label><label>Latitude<input name="latitude" type="number" step="any" min="-90" max="90" required></label><label>Longitude<input name="longitude" type="number" step="any" min="-180" max="180" required></label><button type="button" class="secondary full" id="use-location">Use my current location</button><label>Allowed radius (metres)<input name="radius" type="number" min="25" max="2000" value="150" required></label><label>Maximum GPS uncertainty (metres)<input name="max_accuracy" type="number" min="5" max="100" value="50" required></label><p class="muted full">Confirm the coordinates on a map before saving. The GPS uncertainty circle must fit within the allowed radius.</p>',
    async (b) => {
      for (const k of ["latitude", "longitude", "radius", "max_accuracy"])
        b[k] = Number(b[k]);
      await api("/admin/workplaces", b);
      notice("Workplace created.");
    },
  );
  document.querySelector("#use-location").onclick = (e) =>
    busy(e.target, async () => {
      const loc = await getLocation();
      document.querySelector("[name=latitude]").value = loc.latitude;
      document.querySelector("[name=longitude]").value = loc.longitude;
    });
}
function passwordDialog(mandatory = false) {
  dialog(
    "Change password",
    '<label class="full">Current password<input type="password" name="currentPassword" autocomplete="current-password" required></label><label class="full">New password<input type="password" name="newPassword" minlength="12" maxlength="128" autocomplete="new-password" required></label>',
    async (b) => {
      await api("/password", b);
      me.must_change_password = false;
      notice("Password changed.");
    },
    mandatory,
  );
}
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation)
      return reject(new Error("This device does not support location."));
    navigator.geolocation.getCurrentPosition(
      (p) =>
        resolve({
          latitude: p.coords.latitude,
          longitude: p.coords.longitude,
          accuracy: p.coords.accuracy,
          timestamp: p.timestamp,
        }),
      (e) =>
        reject(
          new Error(
            e.code === 1
              ? "Location permission is required to record attendance."
              : "Could not get a fresh GPS reading. Move outdoors and retry.",
          ),
        ),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  });
}
// ---- Home: the page employees land on ----------------------------------------------------------
// Laid out like the company's previous HR portal: employee search on top, then cards for
// leave balance, announcements, holidays, birthdays, the org structure and today.
const dmy = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const LEAVE_DOTS = ["#222", "#c95bb8", "#d9303e", "#1e9be0", "#2f9d62", "#e08a1e", "#6b5bd6"];
const crumb = (text) => `<div class="crumb"><span>${esc(text)}</span></div>`;
const personRow = (p, right = "") =>
  `<div class="person-row"><span class="avatar">${initials(p.name)}</span><div><strong>${esc(p.name)}</strong><small>${esc(p.designation || "")}</small><small>${esc(p.branch || "")}</small></div>${right ? `<span class="when">${right}</span>` : ""}</div>`;

async function employeeView(id) {
  const year = Number(today().slice(0, 4));
  const [home, bal, profile, news] = await Promise.all([
    api("/home"),
    api("/leave/balances").catch(() => []),
    api("/me"),
    homeData(),
  ]);
  const holidays = await api(`/holidays?year=${year}`).catch(() => []);
  if (id !== renderId) return;
  const open = profile.openShift;
  const done = profile.todayShift;
  const counted = bal.filter((b) => !b.unlimited);
  const leaveCard = `<div class="card"><h2>My Leave Balance</h2><div class="lb-row"><span>Leave Summary For Year</span><strong>${year}</strong></div><div class="card-body">${
    bal.length
      ? bal
          .map(
            (b, i) =>
              `<div class="lb-row"><div data-css="color:${LEAVE_DOTS[i % LEAVE_DOTS.length]}"><span class="dot dot-current"></span><span class="lb-name">${esc(b.code ? `${b.code} (${b.name})` : b.name)}</span><small>${b.unlimited ? "No limit" : `${b.available} Leaves`}</small></div><span class="applied">${b.pending || 0} Applied</span></div>`,
          )
          .join("")
      : '<p class="muted">HR has not set up leave for you yet.</p>'
  }</div><div class="lb-total"><span>Total:</span><span>${counted.reduce((n, b) => n + Number(b.available || 0), 0)} Days</span></div></div>`;
  const manage = has("announcements.manage");
  const feed = [
    ...news.announcements.map(
      (a) =>
        `<div class="feed-item"><span class="feed-icon">📣</span><div><strong>${a.pinned ? "📌 " : ""}${esc(a.title)}</strong>${esc(a.body).replaceAll("\n", "<br>")}<small>${esc(a.author || "")} · ${time(a.created_at)}${manage ? ` · <button class="link" data-del="${a.id}">Remove</button>` : ""}</small></div></div>`,
    ),
    ...home.joiners.map(
      (j) =>
        `<div class="feed-item"><span class="feed-icon">👤</span><div><strong>New Employee</strong>${esc(j.name)}${j.employee_code ? ` (${esc(j.employee_code)})` : ""} has joined${j.department ? ` in ${esc(j.department)} department` : ""}<small>${fmtDate(j.date_of_joining)}</small></div></div>`,
    ),
  ];
  const announceCard = `<div class="card"><div class="card-head"><h2>Company Announcement</h2>${manage ? '<button class="secondary" id="post">Post</button>' : ""}</div><div class="card-body">${feed.length ? feed.join("") : '<p class="muted">No announcements yet.</p>'}</div></div>`;
  const holidayRows = (optional) => {
    const list = holidays.filter((h) => Boolean(h.optional) === optional);
    return list.length
      ? list
          .map(
            (h) =>
              `<div class="person-row"><span class="feed-icon">✦</span><div><strong>${esc(h.name)}</strong><small>${dmy(h.date)}</small></div><span class="when">${esc(h.branch || "")}<small>Branch</small></span></div>`,
          )
          .join("")
      : `<p class="muted">No ${optional ? "optional " : ""}holidays added for ${year}.</p>`;
  };
  const holidayCard = `<div class="card"><h2>Holiday List</h2><div class="tabs-line"><button type="button" class="on" data-hol="fixed">Fixed Holiday</button><button type="button" data-hol="optional">Optional Holiday</button></div><div class="card-body" id="hol-list">${holidayRows(false)}</div></div>`;
  const birthdayCard = `<div class="card"><h2>Birthdays 🎉</h2><div class="card-body">${
    home.birthdays.length
      ? home.birthdays
          .map((p) => personRow(p, `${p.day} ${MONTHS[home.month - 1]}`))
          .join("")
      : `<p class="muted">No birthdays in ${MONTHS[home.month - 1]}.</p>`
  }</div></div>`;
  const node = (p, cls = "") =>
    `<div class="org-node ${cls}"><strong>${esc(p.name)}</strong><small>${esc(p.designation || p.employee_code || "")}</small></div>`;
  const orgCard = `<div class="card"><h2>Organisation Structure</h2><div class="card-body"><div class="org-box">${home.org.manager ? `${node(home.org.manager)}<div class="org-line"></div>` : ""}${home.me ? node(home.me, "me") : ""}${home.org.reports.length ? `<div class="org-line"></div><div class="org-reports">${home.org.reports.map((p) => node(p)).join("")}</div>` : ""}</div><p class="muted center"><a href="#" id="see-org">Open the full org chart →</a></p></div></div>`;
  const todayCard = `<div class="card"><h2>Today</h2><div class="card-body"><span class="pill ${open ? "" : "neutral"}">${open ? "Working now" : done ? "Punched out" : "Not punched in"}</span><h3>${esc(open?.workplace_name || profile.workplace?.name || "No workplace assigned")}</h3><p class="muted">${open ? `Signed in at ${time(open.in_at)}.` : done ? `Worked ${time(done.in_at)} – ${time(done.out_at)}.` : "Attendance is marked from the company mobile app at your workplace."}</p><button class="secondary" data-page-go="myattendance">My Attendance →</button></div></div>`;
  document.querySelector("#content").innerHTML =
    crumb("Home") +
    `<div class="card"><h2>Employee Search</h2><form id="emp-search"><div class="search-row"><input name="code" placeholder="Code" aria-label="Employee code"><input name="name" placeholder="Name" aria-label="Name"></div><div class="actions"><button>Search</button></div></form><div id="emp-results"></div></div>` +
    `<div class="home-grid">${leaveCard}${announceCard}${holidayCard}${birthdayCard}${orgCard}${todayCard}</div>`;
  announcementsWire();
  await galleryCard(id);
  document.querySelectorAll("[data-hol]").forEach(
    (b) =>
      (b.onclick = () => {
        document
          .querySelectorAll("[data-hol]")
          .forEach((x) => x.classList.toggle("on", x === b));
        document.querySelector("#hol-list").innerHTML = holidayRows(
          b.dataset.hol === "optional",
        );
      }),
  );
  document.querySelector("#see-org").onclick = (e) => {
    e.preventDefault();
    page = "orgchart";
    render();
  };
  document.querySelector("[data-page-go]").onclick = (e) => {
    page = e.currentTarget.dataset.pageGo;
    render();
  };
  document.querySelector("#emp-search").onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const code = String(f.get("code")).trim().toLowerCase();
    const name = String(f.get("name")).trim().toLowerCase();
    if (!code && !name) return;
    busy(e.submitter, async () => {
      const rows = (
        await api(`/directory?q=${encodeURIComponent(code || name)}`)
      ).filter(
        (p) =>
          (!code || (p.employee_code || "").toLowerCase().includes(code)) &&
          (!name || p.name.toLowerCase().includes(name)),
      );
      document.querySelector("#emp-results").innerHTML = rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Name</th><th>Designation</th><th>Department</th><th>Branch</th><th>Contact</th></tr></thead><tbody>${rows.map((p) => `<tr><td>${esc(p.employee_code || "—")}</td><td>${esc(p.name)}</td><td>${esc(p.designation_name || "—")}</td><td>${esc(p.department_name || "—")}</td><td>${esc(p.branch_name || "—")}</td><td>${p.phone ? `<a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ""}<small>${esc(p.email || "")}</small></td></tr>`).join("")}</tbody></table></div>`
        : '<p class="muted">Nobody found.</p>';
    });
  };
}

// ---- My Attendance: who I am, a live clock, and my day-by-day record ------------------------------
async function myAttendancePage(id) {
  const [home, profile, shifts] = await Promise.all([
    api("/home"),
    api("/me"),
    api("/shifts"),
  ]);
  if (id !== renderId) return;
  const p = home.me || {};
  const hhmm = (ms) =>
    `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}`;
  const status = (s) =>
    !s.out_at
      ? ["Working", "W"]
      : s.day_type === "half_day"
        ? ["Half Day", "HD"]
        : ["Present", "P"];
  let size = 10,
    pageNo = 0;
  const draw = () => {
    const rows = shifts.slice(pageNo * size, pageNo * size + size);
    const pages = Math.max(1, Math.ceil(shifts.length / size));
    document.querySelector("#att-table").innerHTML = shifts.length
      ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Workplace</th><th>Sign-In-Time</th><th>Sign-Out-Time</th><th>Present Hours (HH:MM)</th><th>Att. Status</th><th>Status</th></tr></thead><tbody>${rows
          .map((s) => {
            const [label, code] = status(s);
            return `<tr><td>${fmtDate(s.in_at.slice(0, 10))}</td><td>${esc(s.workplace_name || "—")}</td><td>${time(s.in_at)}</td><td>${s.out_at ? time(s.out_at) : "—"}</td><td>${s.out_at ? hhmm(Date.parse(s.out_at) - Date.parse(s.in_at)) : "—"}</td><td>${label}</td><td><span class="pill ${code === "P" ? "" : "neutral"}">${code}</span></td></tr>`;
          })
          .join(
            "",
          )}</tbody></table></div><div class="pager"><button class="secondary" id="att-prev" ${pageNo ? "" : "disabled"}>Prev</button><button class="secondary" id="att-next" ${pageNo + 1 < pages ? "" : "disabled"}>Next</button><span class="muted">Page ${pageNo + 1} of ${pages}</span><select id="att-size" aria-label="Rows per page">${[10, 20, 30, 40, 50].map((n) => `<option ${n === size ? "selected" : ""}>${n}</option>`).join("")}</select></div>`
      : empty("No attendance yet", "Your punches from the mobile app appear here.");
    document.querySelector("#att-prev")?.addEventListener("click", () => {
      pageNo -= 1;
      draw();
    });
    document.querySelector("#att-next")?.addEventListener("click", () => {
      pageNo += 1;
      draw();
    });
    document.querySelector("#att-size")?.addEventListener("change", (e) => {
      size = Number(e.target.value);
      pageNo = 0;
      draw();
    });
  };
  const open = profile.openShift;
  document.querySelector("#content").innerHTML =
    crumb("Attendance / My Attendance") +
    `<div class="card"><h2>Attendance Details</h2><div class="emp-strip"><span class="avatar">${initials(p.name || me.name)}</span><div><strong>${esc(p.name || me.name)}</strong></div><div>${esc(p.employee_code || "—")}<small>Employee Code</small></div><div>${esc(p.department || "—")}<small>Department</small></div><div>${esc(p.designation || "—")}<small>Designation</small></div><div>${esc(p.branch || profile.workplace?.name || "—")}<small>Location</small></div><div class="clock" id="att-clock"></div></div><p class="muted">${open ? `Already signed in at ${time(open.in_at)}.` : "Not signed in. Attendance is marked from the company mobile app."}</p></div><div class="card" id="att-table"></div>`;
  const tick = () => {
    const c = document.querySelector("#att-clock");
    if (!c) return clearInterval(timer);
    c.textContent = new Intl.DateTimeFormat("en-GB", {
      timeZone: config.timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date());
  };
  const timer = setInterval(tick, 1000);
  tick();
  draw();
}
// Start once every deferred script has run (they share this page's scope); an early
// start could use a function from a later script before it exists.
document.addEventListener("DOMContentLoaded", async () => {
  try {
    config = await api("/config");
    if (resetFromLink()) return;
    await loadMe();
    page = landing();
    await render();
  } catch {
    login();
  }
});
