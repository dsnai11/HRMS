const app = document.querySelector("#app");
let config = { company: "Laxmi India Finance Ltd.", timezone: "Asia/Kolkata" },
  me,
  page = "overview";
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
    ...(body !== undefined
      ? {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") {
      me = null;
      login();
    }
    throw new Error(data.error || "Request failed.");
  }
  return data;
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
const brand = () =>
  `<div class="brand"><span class="brand-icon">L</span><div>Laxmi India<small>PEOPLE & WORKPLACE</small></div></div>`;
const empty = (title, description) =>
  `<div class="empty"><div class="empty-icon">◎</div><strong>${esc(title)}</strong>${esc(description)}</div>`;
function login() {
  if (config.setupRequired) return setup();
  app.innerHTML = `<div class="login"><section class="login-story">${brand()}<div><div class="eyebrow">${esc(config.company)}</div><h1>Every workday.<br>In the right place.</h1><p>A connected workplace starts with clarity. Attendance, people, and working hours — together in one space.</p></div><footer class="muted">Built around your people.</footer></section><section class="login-panel"><div class="eyebrow">Your workspace</div><h2>Welcome back</h2><p class="muted">Sign in with your company account.</p><form id="login"><label>Email address<input type="email" name="email" autocomplete="username" placeholder="you@company.com" required></label><label>Password<input type="password" name="password" autocomplete="current-password" required></label><button>Sign in →</button></form><p class="login-footer">Employees: use the credentials provided by your administrator.<br>Location is requested only when you punch in or out.</p></section></div>`;
  document.querySelector("#login").onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const data = await api(
        "/login",
        Object.fromEntries(new FormData(e.target)),
      );
      me = data.user;
      page = me.role === "admin" ? "overview" : "attendance";
      await render();
    });
  };
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
function shell() {
  const items =
    me.role === "admin"
      ? [
          ["overview", "◫", "Overview"],
          ["employees", "♙", "Employees"],
          ["attendance", "▤", "Attendance"],
          ["workplaces", "◎", "Workplaces"],
          ["devices", "▣", "Devices"],
          ["security", "⚠", "Security"],
          ["audit", "≡", "Activity log"],
        ]
      : [["attendance", "◎", "My attendance"]];
  app.innerHTML = `<div class="layout"><aside class="sidebar">${brand()}<div class="nav-label">WORKSPACE</div><nav class="nav">${items.map(([id, icon, label]) => `<button data-page="${id}" class="${page === id ? "selected" : ""}"><span class="nav-icon">${icon}</span>${label}</button>`).join("")}</nav><div class="sidebar-foot"><strong>${esc(config.company)}</strong>Location-verified attendance<br>${esc(config.timezone)}</div></aside><main class="main"><header class="topbar"><span>${me.role === "admin" ? "Admin workspace" : "Employee workspace"}</span><div class="user"><span class="avatar">${initials(me.name)}</span><span class="name">${esc(me.name)}</span><button class="ghost" id="password">Password</button><button class="ghost" id="logout">Sign out</button></div></header><section class="content" id="content"><div class="loading">Loading…</div></section></main></div>`;
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
      login();
    });
  document.querySelector("#password").onclick = () => passwordDialog();
}
function heading(title, subtitle, action = "") {
  return `<div class="heading"><div><div class="eyebrow">People operations</div><h1>${esc(title)}</h1><p class="muted">${esc(subtitle)}</p></div>${action}</div>`;
}
const reasonLabels = { late_in: "late in", early_out: "left early" };
function dayCell(s) {
  const reasons = JSON.parse(s.half_day_reasons || "[]")
    .map((r) => reasonLabels[r] || r)
    .join(", ");
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
    ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Workplace</th><th>Punch in</th><th>Punch out</th><th>Hours</th><th>Status</th><th>Day</th><th>GPS records</th></tr></thead><tbody>${rows.map((s) => `<tr><td><div class="person"><span class="avatar">${initials(s.employee_name || me.name)}</span><div>${esc(s.employee_name || me.name)}<small>${esc(s.email || me.email)}</small></div></div></td><td>${esc(s.workplace_name)}</td><td>${time(s.in_at)}</td><td>${time(s.out_at)}</td><td>${(((s.out_at ? Date.parse(s.out_at) : Date.now()) - Date.parse(s.in_at)) / 3600000).toFixed(2)}</td><td><span class="pill ${s.out_at ? "neutral" : ""}">${s.out_at ? "Completed" : "Working"}</span></td><td>${dayCell(s)}</td><td><a href="https://www.google.com/maps?q=${s.in_latitude},${s.in_longitude}" target="_blank" rel="noreferrer">In · ±${Math.round(s.in_accuracy)}m ↗</a>${s.out_at ? `<small><a href="https://www.google.com/maps?q=${s.out_latitude},${s.out_longitude}" target="_blank" rel="noreferrer">Out · ±${Math.round(s.out_accuracy)}m ↗</a></small>` : ""}</td></tr>`).join("")}</tbody></table></div>`
    : empty("No attendance records yet", "Recorded punches will appear here.");
}
let renderId = 0;
async function render() {
  const id = ++renderId;
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
    if (me.role === "employee") return await employeeView(id);
    if (page === "overview") {
      const [stats, active, sites] = await Promise.all([
        api("/admin/overview"),
        api("/admin/active"),
        api("/admin/workplaces"),
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
          )}</div><div class="card"><div class="card-head"><div><h2>Who’s working now</h2><p class="muted">Most recent punch location. No continuous tracking.</p></div><span class="pill">${stats.active} active shifts</span></div>${table(active)}</div><div class="grid-two"><div class="card"><h2>Your workplaces</h2>${sites.length ? sites.map((s) => `<div class="site"><h3>${esc(s.name)}</h3><p class="muted">${s.latitude.toFixed(5)}, ${s.longitude.toFixed(5)}</p><span class="pill neutral">${s.radius} m radius</span></div>`).join("") : empty("Set up your first workplace", "Open Workplaces to define an attendance boundary.")}</div><div class="card"><div class="eyebrow">Designed for trust</div><h2>Right place. Right record.</h2><p class="muted">Employees punch in and out inside their assigned workplace. Every punch records server time and a fresh GPS reading.</p><div class="callout">Location is captured only at attendance events. GPS uncertainty must fit inside the workplace boundary.</div></div></div>`;
      document.querySelector("#refresh").onclick = render;
    } else if (page === "employees") {
      const [employees, sites] = await Promise.all([
        api("/admin/employees"),
        api("/admin/workplaces"),
      ]);
      if (id !== renderId) return;
      document.querySelector("#content").innerHTML =
        heading(
          "Your people",
          "Manage employee access and assigned workplaces.",
          '<button id="add">+ Add employee</button>',
        ) +
        `<div class="card">${employees.length ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Email</th><th>Workplace</th><th>Status</th><th></th></tr></thead><tbody>${employees.map((e) => `<tr><td>${esc(e.name)}</td><td>${esc(e.email)}</td><td>${esc(e.workplace_name)}</td><td><span class="pill ${e.active ? "" : "neutral"}">${e.active ? "Active" : "Inactive"}</span></td><td><button class="secondary" data-edit="${e.id}">Manage</button></td></tr>`).join("")}</tbody></table></div>` : empty("Your team starts here", "Add a workplace, then invite employees by sharing their temporary credentials securely.")}</div>`;
      document.querySelector("#add").onclick = () =>
        sites.length
          ? employeeDialog(sites)
          : notice("Create a workplace first.", true);
      document.querySelectorAll("[data-edit]").forEach(
        (b) =>
          (b.onclick = () =>
            employeeDialog(
              sites,
              employees.find((e) => e.id === Number(b.dataset.edit)),
            )),
      );
    } else if (page === "workplaces") {
      const sites = await api("/admin/workplaces");
      if (id !== renderId) return;
      document.querySelector("#content").innerHTML =
        heading(
          "Workplaces",
          "Define where your employees can begin and end their day.",
          '<button id="add">+ Add workplace</button>',
        ) +
        `<div class="card">${sites.length ? sites.map((s) => `<div class="site"><h3>${esc(s.name)}</h3><p class="muted">${s.latitude}, ${s.longitude} · Maximum GPS uncertainty ${s.max_accuracy} m</p><span class="pill">${s.radius} m allowed radius</span> <a href="https://www.google.com/maps?q=${s.latitude},${s.longitude}" target="_blank" rel="noreferrer">View on map ↗</a></div>`).join("") : empty("A place to start", "Add your office coordinates and the allowed attendance radius.")}</div><p class="muted">Workplace boundaries are fixed after creation. Add a new workplace to change a boundary, then reassign employees after their shifts end.</p>`;
      document.querySelector("#add").onclick = workplaceDialog;
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
      document.querySelector("#export").onclick = () => {
        window.location.href = `/api/admin/export?${query}`;
      };
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
      const logs = await api("/admin/audit");
      if (id !== renderId) return;
      document.querySelector("#content").innerHTML =
        heading(
          "Activity log",
          "Latest 100 account, workplace, and attendance events.",
        ) +
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
function employeeDialog(sites, employee) {
  dialog(
    employee ? "Manage employee" : "Add employee",
    `${employee ? `<div class="full muted">${esc(employee.name)} · ${esc(employee.email)}</div>` : '<label>Full name<input name="name" maxlength="150" required></label><label>Email<input name="email" type="email" required></label>'}<label class="full">Assigned workplace<select name="workplace_id">${sites.map((s) => `<option value="${s.id}" ${s.id === employee?.workplace_id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label>${employee ? `<label>Account status<select name="active"><option value="true" ${employee.active ? "selected" : ""}>Active</option><option value="false" ${!employee.active ? "selected" : ""}>Inactive</option></select></label>` : ""}<label class="full">${employee ? "Reset password (optional)" : "Temporary password"}<input name="password" type="password" minlength="12" maxlength="128" autocomplete="new-password" ${employee ? "" : "required"}></label><p class="muted full">Use at least 12 characters. Share credentials securely; the employee must change their temporary password at first sign-in.</p>`,
    async (b) => {
      b.workplace_id = Number(b.workplace_id);
      if (employee) {
        b.active = b.active === "true";
        if (!b.password) delete b.password;
      }
      await api(
        employee ? `/admin/employees/${employee.id}` : "/admin/employees",
        b,
        employee ? "PATCH" : "POST",
      );
      notice(employee ? "Employee updated." : "Employee created.");
    },
  );
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
async function employeeView(id) {
  const [profile, shifts] = await Promise.all([api("/me"), api("/shifts")]);
  if (id !== renderId) return;
  const open = profile.openShift;
  document.querySelector("#content").innerHTML =
    heading(`Hello, ${me.name.split(" ")[0]}`, "Your workday, in one place.") +
    `<div class="card punch-card"><span class="pill ${open ? "" : "neutral"}">${open ? "You are working" : "Not punched in"}</span><div class="big-clock">${open ? "Your shift is in progress" : "Ready for your day?"}</div><h2>${esc(open?.workplace_name || profile.workplace?.name || "No workplace assigned")}</h2><p class="muted">${open ? `Started ${time(open.in_at)}. Punch out at the same workplace${open.required_out_at ? ` after ${time(open.required_out_at)} for a full day` : ""}.` : `Punch in within ${profile.workplace?.radius || "—"} metres of your assigned workplace.`}</p><div class="callout">Attendance is recorded only from the company mobile app, at your assigned workplace.</div></div><div class="card"><h2>My recent attendance</h2>${table(shifts)}</div>`;
}
(async () => {
  try {
    config = await api("/config");
    const profile = await api("/me");
    me = profile.user;
    await render();
  } catch {
    login();
  }
})();
