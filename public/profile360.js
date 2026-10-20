// Org chart, 360° profile, custom fields, grades and renamed terms.
let chartRoots = null;

// ---- extra employee fields (grade, cost centre, business unit, custom fields) ---------------------
function orgExtraFields(org, e) {
  const vals = JSON.parse(e?.custom || "{}");
  const custom = (org.custom || [])
    .map((d) => {
      const v = vals[d.key] ?? "";
      const name = `cf_${d.key}`;
      const req = d.required ? "required" : "";
      if (d.type === "select")
        return `<label>${esc(d.label)}<select name="${name}" ${req}><option value="">—</option>${d.options.map((o) => `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select></label>`;
      return input(
        name,
        d.label,
        v,
        `${req} ${d.type === "date" ? 'type="date"' : d.type === "number" ? 'type="number" step="any"' : 'maxlength="300"'}`,
      );
    })
    .join("");
  return `<div class="full"><strong>Grade and cost</strong></div><label>Grade<select name="grade_id">${options(org.grades || [], e?.grade_id)}</select></label><label>Cost centre<select name="cost_centre_id">${options(org.cost_centres || [], e?.cost_centre_id)}</select></label><label>Business unit<select name="business_unit_id">${options(org.business_units || [], e?.business_unit_id)}</select></label>${custom ? `<div class="full"><strong>Other details</strong></div>${custom}` : ""}`;
}
function collectCustom(b) {
  const custom = {};
  for (const k of Object.keys(b))
    if (k.startsWith("cf_")) {
      custom[k.slice(3)] = b[k];
      delete b[k];
    }
  return custom;
}

// ---- organisation chart -----------------------------------------------------------------------------
async function orgChartPage(id) {
  const data = await api("/org-chart");
  if (id !== renderId) return;
  const byMgr = new Map();
  for (const p of data.people) {
    const k = p.manager_id ?? 0;
    if (!byMgr.has(k)) byMgr.set(k, []);
    byMgr.get(k).push(p);
  }
  // Open the path down to the signed-in person, collapse the rest.
  const byId = new Map(data.people.map((p) => [p.id, p]));
  const open = new Set();
  for (let p = byId.get(data.me); p; p = byId.get(p.manager_id)) open.add(p.id);
  const node = (p, depth) => {
    const kids = byMgr.get(p.id) || [];
    const card = `<div class="chart-card ${p.id === data.me ? "me" : ""}"><span class="avatar">${initials(p.name)}</span><div><strong>${esc(p.name)}</strong><small>${esc(p.designation || "")}${p.designation && p.department ? " · " : ""}${esc(p.department || "")}</small></div>${kids.length ? `<button class="ghost" data-toggle="${p.id}" aria-expanded="${open.has(p.id)}">${kids.length} ${kids.length === 1 ? "report" : "reports"}</button>` : ""}</div>`;
    return `<li data-node="${p.id}">${card}${kids.length ? `<ul class="chart-kids" ${open.has(p.id) ? "" : "hidden"}>${kids.map((k) => node(k, depth + 1)).join("")}</ul>` : ""}</li>`;
  };
  const roots = byMgr.get(0) || [];
  document.querySelector("#content").innerHTML =
    heading(
      "Organisation chart",
      "Who reports to whom. Select a person's reports to expand.",
    ) +
    `<div class="card"><div class="actions"><input id="chart-q" placeholder="Find a person" aria-label="Find a person"><button class="secondary" id="expand-all">Expand all</button><button class="secondary" id="collapse-all">Collapse all</button></div><ul class="chart">${roots.map((r) => node(r, 0)).join("") || '<li class="muted">No people yet.</li>'}</ul></div>`;
  const kidsOf = (li) => li.querySelector(":scope > .chart-kids");
  document.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = () => {
      const ul = kidsOf(b.closest("li"));
      ul.hidden = !ul.hidden;
      b.setAttribute("aria-expanded", String(!ul.hidden));
    };
  });
  const setAll = (show) =>
    document.querySelectorAll(".chart-kids").forEach((ul) => {
      ul.hidden = !show;
      ul.parentElement
        .querySelector(":scope > .chart-card [data-toggle]")
        ?.setAttribute("aria-expanded", String(show));
    });
  document.querySelector("#expand-all").onclick = () => setAll(true);
  document.querySelector("#collapse-all").onclick = () => setAll(false);
  document.querySelector("#chart-q").oninput = (e) => {
    const q = e.target.value.trim().toLowerCase();
    document
      .querySelectorAll(".chart li")
      .forEach((li) => li.classList.remove("hit"));
    if (!q) return;
    for (const li of document.querySelectorAll(".chart li[data-node]")) {
      const p = byId.get(Number(li.dataset.node));
      if (
        p.name.toLowerCase().includes(q) ||
        (p.employee_code || "").toLowerCase().includes(q)
      ) {
        li.classList.add("hit");
        for (
          let up = li.parentElement;
          up && up.classList.contains("chart-kids");
          up = up.parentElement.parentElement
        )
          up.hidden = false;
      }
    }
    document
      .querySelector(".chart li.hit")
      ?.scrollIntoView({ block: "center" });
  };
}

// ---- 360° profile -----------------------------------------------------------------------------------
const P360 = {
  education: {
    label: "Education",
    cols: [
      ["degree", "Degree"],
      ["institute", "Institute"],
      ["year", "Year"],
      ["score", "Score"],
    ],
    verify: true,
  },
  experience: {
    label: "Work experience",
    cols: [
      ["employer", "Employer"],
      ["role", "Role"],
      ["from_date", "From"],
      ["to_date", "To"],
    ],
    verify: true,
  },
  certifications: {
    label: "Certifications",
    cols: [
      ["name", "Certification"],
      ["issuer", "Issued by"],
      ["issued_on", "Issued"],
      ["expires_on", "Expires"],
    ],
    verify: true,
  },
  skills: {
    label: "Skills",
    cols: [
      ["skill", "Skill"],
      ["level", "Level"],
    ],
    verify: false,
  },
};
const P360_FIELDS = {
  education: () =>
    `${input("degree", "Degree", "", "required maxlength=120")}${input("institute", "Institute")}${input("year", "Year", "", "maxlength=4")}${input("score", "Score")}`,
  experience: () =>
    `${input("employer", "Employer", "", "required maxlength=150")}${input("role", "Role")}${input("from_date", "From (YYYY-MM)", "", "maxlength=10")}${input("to_date", "To (YYYY-MM)", "", "maxlength=10")}<label class="full">Reason for leaving<input name="reason" maxlength="200"></label>`,
  certifications: () =>
    `${input("name", "Certification", "", "required maxlength=150")}${input("issuer", "Issued by")}${input("issued_on", "Issued on", "", 'type="date"')}${input("expires_on", "Expires on", "", 'type="date"')}`,
  skills: () =>
    `${input("skill", "Skill", "", "required maxlength=60")}${sel(
      "level",
      "Level",
      [
        ["beginner", "Beginner"],
        ["intermediate", "Intermediate"],
        ["expert", "Expert"],
      ],
      "intermediate",
    )}`,
};
function profile360Html(d, { hr }) {
  const mineView = d.employee.id === me.id;
  return `${Object.entries(P360)
    .map(
      ([k, s]) =>
        `<div class="card"><div class="card-head"><div><h2>${s.label}</h2></div>${mineView || hr ? `<button class="secondary" data-p360-add="${k}">Add</button>` : ""}</div>${
          d[k].length
            ? `<div class="table-wrap"><table><thead><tr>${s.cols.map(([, l]) => `<th>${l}</th>`).join("")}${s.verify ? "<th>Status</th>" : ""}<th></th></tr></thead><tbody>${d[k].map((r) => `<tr>${s.cols.map(([c]) => `<td>${esc(r[c] || "—")}</td>`).join("")}${s.verify ? `<td>${r.verified_at ? '<span class="pill">Verified</span>' : '<span class="pill neutral">Not verified</span>'}</td>` : ""}<td>${s.verify && hr && !r.verified_at ? `<button class="ghost" data-p360-verify="${k}:${r.id}">Verify</button> ` : ""}${hr || (mineView && !r.verified_at) ? `<button class="ghost" data-p360-del="${k}:${r.id}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
            : '<p class="muted">Nothing added yet.</p>'
        }</div>`,
    )
    .join(
      "",
    )}${d.custom.length ? `<div class="card"><h2>Other details</h2>${d.custom.map((c) => `<div class="kv"><span class="muted">${esc(c.label)}</span><strong>${esc(c.value ?? "—")}</strong></div>`).join("")}</div>` : ""}`;
}
function wire360(scope, userId, reload) {
  scope.querySelectorAll("[data-p360-add]").forEach((b) => {
    b.onclick = () =>
      dialog(
        `Add · ${P360[b.dataset.p360Add].label}`,
        P360_FIELDS[b.dataset.p360Add](),
        async (f) => {
          const body = Object.fromEntries(
            Object.entries(f).filter(([, v]) => v !== ""),
          );
          if (userId !== me.id) body.user_id = userId;
          await api(`/profile360/${b.dataset.p360Add}`, body);
          notice("Added.");
          await reload?.();
        },
      );
  });
  scope.querySelectorAll("[data-p360-verify]").forEach((b) => {
    b.onclick = () =>
      busy(b, async () => {
        const [k, id] = b.dataset.p360Verify.split(":");
        await api(`/profile360/${k}/${id}/verify`, {});
        await reload?.();
      });
  });
  scope.querySelectorAll("[data-p360-del]").forEach((b) => {
    b.onclick = () =>
      busy(b, async () => {
        const [k, id] = b.dataset.p360Del.split(":");
        await api(`/profile360/${k}/${id}`, undefined, "DELETE");
        await reload?.();
      });
  });
}
// On the employee's own profile page.
async function profile360Card(id) {
  const d = await api("/profile360");
  if (id !== renderId) return;
  const holder = document.createElement("div");
  holder.innerHTML = `<h2 class="section-title">My 360° profile</h2><p class="muted">Add your education, experience, skills and certifications. HR verifies what you add.</p><div id="p360">${profile360Html(d, { hr: false })}</div>`;
  document.querySelector("#content").append(holder);
  const reload = async () => {
    const fresh = await api("/profile360");
    holder.querySelector("#p360").innerHTML = profile360Html(fresh, {
      hr: false,
    });
    wire360(holder, me.id, reload);
  };
  wire360(holder, me.id, reload);
}
// HR opens someone's 360° profile from the employee list.
async function profile360Dialog(userId, name) {
  const load = async () => {
    const d = await api(`/profile360?user_id=${userId}`);
    viewDialog(
      `360° profile · ${name}`,
      `<div id="p360">${profile360Html(d, { hr: has("employees.write") })}</div>`,
    );
    wire360(document.querySelector("dialog"), userId, load);
  };
  await load();
}

// ---- Organization page extras: custom fields and renamed terms --------------------------------------
async function orgSpecialPage(id, tabs) {
  const tabbar = `<div class="tabbar">${Object.entries(tabs)
    .map(
      ([k, t]) =>
        `<button class="${k === orgTab ? "" : "secondary"}" data-tab="${k}">${t.label}</button>`,
    )
    .join("")}</div>`;
  let body = "";
  if (orgTab === "customfields") {
    const rows = await api("/admin/custom-fields");
    body = `<div class="card"><div class="card-head"><div><h2>Custom fields</h2><p class="muted">Extra details you want on every employee record, such as project code, site or mobilisation status. They appear when you add or edit an employee. Required fields are enforced there.</p></div><button id="add-field">Add a field</button></div>${
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Label</th><th>Type</th><th>Options</th><th>Required</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.label)}${r.active ? "" : ' <span class="pill neutral">Off</span>'}</td><td>${r.type}</td><td>${esc(r.options.join(", ") || "—")}</td><td>${r.required ? "Yes" : "No"}</td><td><button class="ghost" data-edit-field="${r.id}">Edit</button></td></tr>`).join("")}</tbody></table></div>`
        : empty(
            "No custom fields",
            "Add the details your company tracks beyond the standard record.",
          )
    }</div>`;
    if (id !== renderId) return;
    document.querySelector("#content").innerHTML =
      heading(
        "Organization",
        "Companies, branches, departments and designations.",
      ) +
      tabbar +
      body;
    const fieldForm = (r = {}) =>
      `${input("label", "Label", r.label || "", "required maxlength=80")}${sel(
        "type",
        "Type",
        [
          ["text", "Text"],
          ["number", "Number"],
          ["date", "Date"],
          ["select", "Choice"],
        ],
        r.type || "text",
      )}<label class="full">Choices, separated by commas (for a choice field)<input name="options" value="${esc((r.options || []).join(", "))}"></label>${input("position", "Order", r.position ?? 0, 'type="number" min="0"')}<label class="check"><input type="checkbox" name="required" ${r.required ? "checked" : ""}> Required</label>${r.id ? `<label class="check"><input type="checkbox" name="active" ${r.active ? "checked" : ""}> Show on the employee form</label>` : ""}`;
    document.querySelector("#add-field").onclick = () =>
      dialog("Add a custom field", fieldForm(), async (f) => {
        await api("/admin/custom-fields", {
          label: f.label,
          type: f.type,
          options: f.options,
          position: Number(f.position),
          required: "required" in f,
        });
        notice("Added.");
      });
    document.querySelectorAll("[data-edit-field]").forEach((b) => {
      b.onclick = () => {
        const r = rows.find((x) => x.id === Number(b.dataset.editField));
        dialog(`Edit · ${r.label}`, fieldForm(r), async (f) => {
          await api(
            `/admin/custom-fields/${r.id}`,
            {
              label: f.label,
              type: f.type,
              options: f.options,
              position: Number(f.position),
              required: "required" in f,
              active: "active" in f,
            },
            "PATCH",
          );
          notice("Saved.");
        });
      };
    });
  } else {
    const current = me.company?.labels || {};
    body = `<div class="card"><h2>Rename terms</h2><p class="muted">Use your own words for the headings and menus. Only titles, labels and buttons change; names and records stay as they are. Leave a box empty to keep the standard word.</p><form id="labels-form"><div class="form-grid">${TERMS.map((t) => input(`t_${t}`, `${t} is called`, current[t] || "", "maxlength=40")).join("")}</div><div class="actions spaced"><button type="submit">Save</button></div></form></div>`;
    if (id !== renderId) return;
    document.querySelector("#content").innerHTML =
      heading(
        "Organization",
        "Companies, branches, departments and designations.",
      ) +
      tabbar +
      body;
    document.querySelector("#labels-form").onsubmit = async (e) => {
      e.preventDefault();
      const labels = {};
      for (const t of TERMS) {
        const v = e.target.elements[`t_${t}`].value.trim();
        if (v) labels[t] = v;
      }
      try {
        await api("/admin/labels", { labels }, "PUT");
        await loadMe();
        notice("Saved. Some pages update when you open them again.");
        render();
      } catch (err) {
        notice(err.message, true);
      }
    };
  }
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => (b.onclick = () => ((orgTab = b.dataset.tab), render())));
}

// ---- renamed terms ---------------------------------------------------------------------------------
const TERMS = [
  "Employee",
  "Department",
  "Designation",
  "Branch",
  "Workplace",
  "Grade",
  "Cost centre",
  "Business unit",
  "Manager",
  "Leave",
];
const LABEL_SELECTOR =
  "th, h1, h2, h3, legend, label, button, .nav-label, .eyebrow, .stat-label";
function applyLabels(root) {
  const map = me?.company?.labels;
  if (!map || !Object.keys(map).length || !root?.querySelectorAll) return;
  const rules = Object.entries(map).flatMap(([from, to]) => [
    [new RegExp(`\\b${from}(s?)\\b`, "g"), (m, s) => to + s],
    [
      new RegExp(`\\b${from.toLowerCase()}(s?)\\b`, "g"),
      (m, s) => to.toLowerCase() + s,
    ],
  ]);
  const targets = [
    ...(root.matches?.(LABEL_SELECTOR) ? [root] : []),
    ...root.querySelectorAll(LABEL_SELECTOR),
  ];
  for (const el of targets)
    for (const n of el.childNodes)
      if (n.nodeType === 3) {
        let t = n.nodeValue;
        for (const [re, fn] of rules) t = t.replace(re, fn);
        if (t !== n.nodeValue) n.nodeValue = t;
      }
}
new MutationObserver((records) => {
  for (const r of records)
    for (const n of r.addedNodes) if (n.nodeType === 1) applyLabels(n);
}).observe(document.documentElement, { childList: true, subtree: true });
