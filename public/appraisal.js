// Appraisal phases, core competencies and goal change history, used by the Performance page.
const PHASE = { mid_year: "Mid-year check-in", year_end: "Year-end evaluation" };
const GOAL_FIELD = {
  title: "Goal",
  description: "Details",
  weight: "Weight",
  due_date: "Due date",
  progress: "Progress",
  status: "Status",
};

// The overall rating: optional at mid-year.
const phaseRatingSel = (phase) =>
  sel(
    "rating",
    phase === "mid_year" ? "Overall rating (optional at mid-year)" : "Overall rating (5 is best)",
    [...(phase === "mid_year" ? [["", "No rating"]] : []), ...[1, 2, 3, 4, 5].map((n) => [n, n])],
    phase === "mid_year" ? "" : 3,
  );
// Competency rows for a review, as form fields named c_<id> (and cc_<id> for the manager's note).
async function competencyFields(reviewId, side) {
  const rows = await api(`/reviews/${reviewId}/competencies`);
  if (!rows.length) return "";
  return `<div class="full"><h3>Core competencies</h3>${rows
    .map(
      (c) =>
        `<div class="form-grid">${sel(
          `c_${c.competency_id}`,
          `${esc(c.name)}${side === "manager" && c.self_rating ? ` · self ${c.self_rating}/5` : ""}`,
          [1, 2, 3, 4, 5].map((n) => [n, n]),
          (side === "manager" ? c.manager_rating : c.self_rating) ?? 3,
        )}${side === "manager" ? input(`cc_${c.competency_id}`, "Note (optional)", c.manager_comment || "", 'maxlength="500"') : `<p class="muted">${esc(c.description || "")}</p>`}</div>`,
    )
    .join("")}</div>`;
}
async function saveCompetencies(reviewId, f) {
  const ratings = Object.keys(f)
    .filter((k) => /^c_\d+$/.test(k))
    .map((k) => ({
      competency_id: Number(k.slice(2)),
      rating: Number(f[k]),
      comment: f[`cc_${k.slice(2)}`] || undefined,
    }));
  if (ratings.length) await api(`/reviews/${reviewId}/competencies`, { ratings }, "PUT");
}
async function competencyResultsDialog(reviewId, title) {
  const rows = await api(`/reviews/${reviewId}/competencies`);
  viewDialog(
    title,
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Competency</th><th>Self</th><th>Manager</th></tr></thead><tbody>${rows
          .map(
            (c) =>
              `<tr><td>${esc(c.name)}</td><td>${c.self_rating ?? "—"}</td><td>${c.manager_rating ?? "—"}${c.manager_comment ? `<small>${esc(c.manager_comment)}</small>` : ""}</td></tr>`,
          )
          .join("")}</tbody></table></div><p class="muted">Your manager's ratings appear once HR releases the result.</p>`
      : empty("No competencies", "HR has not set core competencies."),
  );
}
async function goalHistoryDialog(goalId) {
  const d = await api(`/goals/${goalId}/history`);
  const show = (field, v) =>
    v == null || v === ""
      ? "—"
      : field === "due_date"
        ? fmtDate(v)
        : field === "weight" || field === "progress"
          ? `${v}%`
          : esc(v);
  viewDialog(
    `Changes · ${d.goal.title}`,
    d.changes.length
      ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>By</th><th>What</th><th>Before</th><th>After</th></tr></thead><tbody>${d.changes
          .map(
            (c) =>
              `<tr><td>${time(c.changed_at)}</td><td>${esc(c.changed_by_name)}</td><td>${GOAL_FIELD[c.field] || esc(c.field)}</td><td>${show(c.field, c.old_value)}</td><td>${show(c.field, c.new_value)}</td></tr>`,
          )
          .join("")}</tbody></table></div><p class="muted">Set on ${time(d.goal.created_at)}.</p>`
      : `<p class="muted">Not changed since it was set on ${time(d.goal.created_at)}.</p>`,
  );
}

// ---- HR: the competency list -------------------------------------------------------------------
async function competenciesHtml() {
  const rows = await api("/competencies");
  return `<div class="card"><div class="card-head"><div><h2>Core competencies</h2><p class="muted">Rated in every review, by the employee and then the manager. Retiring one keeps past ratings.</p></div><button id="new-comp">Add a competency</button></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Competency</th><th>Order</th><th>Status</th><th></th></tr></thead><tbody>${rows
          .map(
            (c) =>
              `<tr><td>${esc(c.name)}${c.description ? `<small>${esc(c.description)}</small>` : ""}</td><td>${c.sort_order}</td><td><span class="pill ${c.active ? "" : "neutral"}">${c.active ? "In use" : "Retired"}</span></td><td><button class="ghost" data-comp-toggle="${c.id}" data-on="${c.active}">${c.active ? "Retire" : "Use again"}</button></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : empty("No competencies", "Add the behaviours every review should rate, such as customer focus or integrity.")
  }</div>`;
}
function competenciesWire() {
  document.querySelector("#new-comp")?.addEventListener("click", () =>
    dialog(
      "Add a competency",
      `${input("name", "Name", "", 'required maxlength="80"')}${input("sort_order", "Order", 0, 'type="number" min="0" max="1000"')}<label class="full">What good looks like<input name="description" maxlength="500"></label>`,
      async (f) => {
        await api("/admin/competencies", {
          name: f.name,
          sort_order: Number(f.sort_order || 0),
          description: f.description || undefined,
        });
        notice("Added.");
      },
    ),
  );
  document.querySelectorAll("[data-comp-toggle]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/admin/competencies/${b.dataset.compToggle}`, { active: b.dataset.on !== "1" }, "PATCH");
          render();
        })),
  );
}
