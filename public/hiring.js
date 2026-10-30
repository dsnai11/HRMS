// Hiring and exits: openings, candidates, onboarding, assets, exits; employee-side views.
let hiringTab = "openings";
const HIRING_TABS = {
  openings: "Openings",
  candidates: "Candidates",
  board: "Pipeline board",
  insights: "Recruitment insights",
  templates: "Email templates",
  questions: "Question bank",
  credit: "Credit checks",
  onboarding: "Onboarding",
  assets: "Assets",
  exits: "Exits",
  changes: "Career changes",
};
const STAGE = {
  applied: "Applied",
  screening: "Screening",
  interview: "Interview",
  offer: "Offer",
  hired: "Hired",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
};
const OFFER_STATUS = {
  draft: "Draft",
  sent: "Sent",
  accepted: "Accepted",
  declined: "Declined",
  withdrawn: "Withdrawn",
};
const EXIT_KIND = {
  resignation: "Resignation",
  termination: "Termination",
  retirement: "Retirement",
  end_of_contract: "End of contract",
  absconding: "Absconding",
  other: "Other",
};
const EXIT_STATUS = {
  pending: "Waiting for HR",
  accepted: "In progress",
  rejected: "Not accepted",
  withdrawn: "Withdrawn",
  completed: "Completed",
};
const OWNER = {
  hr: "HR",
  manager: "Manager",
  employee: "Employee",
  it: "IT",
  finance: "Finance",
  admin: "Admin",
};
const REC = {
  strong_yes: "Strong yes",
  yes: "Yes",
  no: "No",
  strong_no: "Strong no",
};
const peopleList = async () =>
  (await api("/admin/employees?limit=200&active=1")).items;
const personSel = (name, label, people, selected = "") =>
  sel(
    name,
    label,
    people.map((p) => [
      p.id,
      `${p.name}${p.employee_code ? ` (${p.employee_code})` : ""}`,
    ]),
    selected,
  );
const stagePill = (s) =>
  `<span class="pill ${["rejected", "withdrawn"].includes(s) ? "neutral" : ""}">${STAGE[s] ?? s}</span>`;

async function hiringPage(id) {
  const html = await hiringTabHtml(hiringTab);
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Hiring & exits",
      "Openings, candidates, joining checklists, company assets and exits.",
    ) +
    `<div class="tabbar">${Object.entries(HIRING_TABS)
      .filter(
        ([k]) =>
          (k !== "assets" || has("assets.manage")) &&
          (k !== "credit" || has("credit.manage")),
      )
      .map(
        ([k, l]) =>
          `<button class="${k === hiringTab ? "" : "secondary"}" data-tab="${k}">${l}</button>`,
      )
      .join("")}</div><div id="tab">${html}</div>`;
  document
    .querySelectorAll("[data-tab]")
    .forEach(
      (b) => (b.onclick = () => ((hiringTab = b.dataset.tab), render())),
    );
  await hiringWire(hiringTab);
}

async function hiringTabHtml(tab) {
  if (tab === "openings") {
    const [rows, summary] = await Promise.all([
      api("/admin/openings"),
      api("/admin/recruitment/summary"),
    ]);
    return `${requisitionsCard(rows)}${careersCard()}<div class="stats"><div class="stat"><div class="stat-label">Open positions</div><div class="stat-value">${summary.open_positions}</div></div>${["applied", "screening", "interview", "offer", "hired"].map((s) => `<div class="stat"><div class="stat-label">${STAGE[s]}</div><div class="stat-value">${summary.stages[s] ?? 0}</div></div>`).join("")}</div><div class="card"><div class="card-head"><div><h2>Job openings</h2></div><button id="new-opening">New opening</button></div>${
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Department</th><th>Positions</th><th>In process</th><th>Filled</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((o) => `<tr><td>${esc(o.title)}<small>${esc(o.branch_name || "")}${o.hiring_manager_name ? ` · ${esc(o.hiring_manager_name)}` : ""}</small></td><td>${esc(o.department_name || "—")}</td><td>${o.positions}</td><td>${o.in_process}</td><td>${o.filled}</td><td><span class="pill ${o.status === "open" ? "" : "neutral"}">${esc(o.status.replace("_", " "))}</span>${o.published ? ' <span class="pill">Public</span>' : ""}${o.approval_status === "pending_approval" ? ' <span class="pill neutral">Needs approval</span>' : ""}</td><td><button class="secondary" data-opening="${o.id}" data-status="${o.status}">${o.status === "open" ? "Close" : "Reopen"}</button> <button class="ghost" data-add-cand="${o.id}">Add candidate</button> <button class="ghost" data-opening-details="${o.id}">Details</button> <button class="ghost" data-posting="${o.id}">Posting text</button></td></tr>`).join("")}</tbody></table></div>`
        : empty("No openings", "Create an opening, then add candidates to it.")
    }</div>`;
  }
  if (tab === "candidates") {
    const [rows, openings] = await Promise.all([
      api("/admin/candidates"),
      api("/admin/openings"),
    ]);
    hiringCache.openings = openings;
    return `<div class="card"><div class="card-head"><div><h2>Candidates</h2></div><button id="new-cand">Add candidate</button></div>${
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Opening</th><th>Stage</th><th>Source</th><th>Match</th><th>Updated</th><th></th></tr></thead><tbody>${rows.map((c) => `<tr><td>${esc(c.name)}<small>${esc(c.email || c.phone || "")}</small></td><td>${esc(c.opening_title || "—")}</td><td>${stagePill(c.stage)}</td><td>${esc(c.source || "—")}</td><td>${matchPill(c) || "—"}</td><td>${fmtDate(c.updated_at.slice(0, 10))}</td><td><button class="secondary" data-cand="${c.id}">Open</button></td></tr>`).join("")}</tbody></table></div>`
        : empty("No candidates", "Add candidates as they apply.")
    }</div>`;
  }
  if (["board", "insights", "templates", "questions", "credit"].includes(tab))
    return await recruitTabHtml(tab);
  if (tab === "onboarding") {
    const [people, template, pipeline, probation] = await Promise.all([
      api("/admin/onboarding"),
      api("/admin/onboarding/template"),
      api("/admin/onboarding/joiners"),
      has("changes.manage") ? api("/admin/probation") : [],
    ]);
    const [owners, joiningDocs] = await Promise.all([
      api("/admin/onboarding/owners"),
      api("/admin/joining-documents"),
    ]);
    return `${joiningSoonCard(pipeline.pending)}${readinessCard(pipeline.joined)}${probationCard(probation)}${ownersCard(owners)}${joiningDocsCard(joiningDocs)}<div class="card"><h2>New joiners</h2>${
      people.length
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Joining</th><th>Progress</th><th>Overdue</th><th></th></tr></thead><tbody>${people.map((p) => `<tr><td>${esc(p.name)}<small>${esc(p.employee_code || "")}</small></td><td>${fmtDate(p.date_of_joining)}</td><td>${p.done || 0} of ${p.total}</td><td>${p.overdue ? `<span class="pill">${p.overdue}</span>` : "—"}</td><td><button class="secondary" data-onboard="${p.id}" data-name="${esc(p.name)}">Checklist</button></td></tr>`).join("")}</tbody></table></div>`
        : empty(
            "Nobody is onboarding",
            "A checklist is created when you hire a candidate.",
          )
    }</div><div class="card"><div class="card-head"><div><h2>Joining checklist</h2><p class="muted">The tasks created for every new joiner. ${template.length ? "Your company's own list is in use." : "The standard list is used until you set up your own."}</p></div><div class="actions">${template.length ? "" : '<button class="secondary" id="seed-template">Start from standard list</button>'}<button id="add-template">Add a task</button></div></div>${
      template.length
        ? `<div class="table-wrap"><table><thead><tr><th>Task</th><th>Who</th><th>Due after joining</th><th></th></tr></thead><tbody>${template.map((t) => `<tr><td>${esc(t.title)}</td><td>${OWNER[t.owner]}</td><td>${t.due_days} days</td><td><button class="ghost" data-del-template="${t.id}">Remove</button></td></tr>`).join("")}</tbody></table></div>`
        : ""
    }</div>`;
  }
  if (tab === "assets") {
    const rows = await api("/admin/assets");
    return `<div class="card"><div class="card-head"><div><h2>Company assets</h2><p class="muted">Laptops, phones, cards and other items issued to people.</p></div><button id="new-asset">Add an asset</button></div>${
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Asset</th><th>Tag</th><th>Status</th><th>With</th><th></th></tr></thead><tbody>${rows.map((a) => `<tr><td>${esc(a.name)}<small>${esc(a.category || "")}</small></td><td>${esc(a.tag)}</td><td><span class="pill ${a.status === "available" ? "" : "neutral"}">${esc(a.status)}</span></td><td>${esc(a.assigned_name || "—")}</td><td>${a.status === "available" ? `<button class="secondary" data-assign="${a.id}">Issue</button>` : a.status === "assigned" ? `<button class="secondary" data-return="${a.id}">Receive back</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
        : empty("No assets", "Add assets to track who has what.")
    }</div>`;
  }
  if (tab === "changes") return await changesHtml();
  const rows = await api("/admin/exits");
  return `${await separationAdminHtml()}<div class="card"><div class="card-head"><div><h2>Exits</h2><p class="muted">Resignations and exits, with clearance and full and final settlement.</p></div><button id="new-exit">Start an exit</button></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Type</th><th>Notice given</th><th>Last day</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((x) => `<tr><td>${esc(x.employee_name)}<small>${esc(x.employee_code || "")} · ${esc(x.department_name || "")}</small></td><td>${EXIT_KIND[x.kind]}</td><td>${fmtDate(x.notice_given_on)}</td><td>${x.last_working_day ? fmtDate(x.last_working_day) : "—"}</td><td><span class="pill ${["rejected", "withdrawn", "completed"].includes(x.status) ? "neutral" : ""}">${EXIT_STATUS[x.status]}</span></td><td><button class="secondary" data-exit="${x.id}">Open</button></td></tr>`).join("")}</tbody></table></div>`
      : empty(
          "No exits",
          "Resignations from employees and exits you start appear here.",
        )
  }</div>`;
}
const hiringCache = {};

async function hiringWire(tab) {
  const on = (s, fn) =>
    document.querySelector(s)?.addEventListener("click", fn);
  const each = (s, fn) =>
    document.querySelectorAll(s).forEach((b) => (b.onclick = () => fn(b)));
  if (["board", "insights", "templates", "questions", "credit"].includes(tab)) {
    await recruitWire(tab);
  } else if (tab === "openings") {
    recruitOpeningsWire();
    on("#new-opening", openingDialog);
    each("[data-opening]", (b) =>
      busy(b, async () => {
        await api(
          `/admin/openings/${b.dataset.opening}`,
          { status: b.dataset.status === "open" ? "closed" : "open" },
          "PATCH",
        );
        render();
      }),
    );
    each("[data-add-cand]", (b) =>
      candidateDialogNew(Number(b.dataset.addCand)),
    );
  } else if (tab === "candidates") {
    on("#new-cand", () => candidateDialogNew(null));
    each("[data-cand]", (b) => candidateView(Number(b.dataset.cand)));
  } else if (tab === "onboarding") {
    each("[data-pre-cand]", (b) => candidateView(Number(b.dataset.preCand)));
    onboardingPlusWire();
    probationWire();
    each("[data-onboard]", (b) =>
      onboardingDialog(Number(b.dataset.onboard), b.dataset.name),
    );
    on("#seed-template", async () => {
      await api("/admin/onboarding/template/seed-defaults", {});
      render();
    });
    on("#add-template", () =>
      dialog(
        "Add a checklist task",
        `${input("title", "Task", "", "required maxlength=120")}${sel("owner", "Who does it", Object.entries(OWNER))}${input("due_days", "Due after joining (days)", 0, 'type="number" min="0" max="365"')}`,
        async (b) => {
          await api("/admin/onboarding/template", {
            title: b.title,
            owner: b.owner,
            due_days: Number(b.due_days),
          });
          notice("Added.");
        },
      ),
    );
    each("[data-del-template]", async (b) => {
      await api(
        `/admin/onboarding/template/${b.dataset.delTemplate}`,
        undefined,
        "DELETE",
      );
      render();
    });
  } else if (tab === "assets") {
    on("#new-asset", () =>
      dialog(
        "Add an asset",
        `${input("name", "Name", "", "required maxlength=100")}${input("tag", "Asset tag", "", "required maxlength=40")}${input("category", "Category", "", "maxlength=40")}`,
        async (b) => {
          await api("/admin/assets", {
            name: b.name,
            tag: b.tag,
            category: b.category || undefined,
          });
          notice("Asset added.");
        },
      ),
    );
    each("[data-assign]", async (b) => {
      const people = await peopleList();
      dialog(
        "Issue asset",
        personSel("user_id", "Issue to", people),
        async (f) => {
          await api(`/admin/assets/${b.dataset.assign}/assign`, {
            user_id: Number(f.user_id),
          });
          notice("Issued.");
        },
      );
    });
    each("[data-return]", (b) =>
      busy(b, async () => {
        await api(`/admin/assets/${b.dataset.return}/return`, {});
        notice("Received back.");
        render();
      }),
    );
  } else if (tab === "changes") {
    changesWire();
  } else {
    on("#new-exit", startExitDialog);
    each("[data-exit]", (b) => exitView(Number(b.dataset.exit)));
    separationAdminWire();
  }
}

async function openingDialog() {
  const [{ departments: deps, branches, designations: desigs }, people] =
    await Promise.all([api("/admin/org"), peopleList()]);
  dialog(
    "New opening",
    `${input("title", "Title", "", "required maxlength=100")}<label>Department<select name="department_id">${options(deps, null)}</select></label><label>Branch<select name="branch_id">${options(branches, null)}</select></label><label>Designation<select name="designation_id">${options(desigs, null)}</select></label>${input("positions", "Positions", 1, 'type="number" min="1" max="500"')}<label>Hiring manager<select name="hiring_manager_id">${options(people, null)}</select></label>${sel("employment_type", "Employment type", Object.entries(EMPLOYMENT))}<label class="full">Description<input name="description" maxlength="4000"></label>`,
    async (b) => {
      const body = {
        title: b.title,
        positions: Number(b.positions),
        employment_type: b.employment_type,
        description: b.description || undefined,
      };
      for (const k of [
        "department_id",
        "branch_id",
        "designation_id",
        "hiring_manager_id",
      ])
        if (b[k]) body[k] = Number(b[k]);
      await api("/admin/openings", body);
      notice("Opening created.");
    },
  );
}
async function candidateDialogNew(openingId) {
  const openings = (await api("/admin/openings")).filter(
    (o) => o.status === "open",
  );
  dialog(
    "Add a candidate",
    `${input("name", "Name", "", "required maxlength=100")}${input("email", "Email", "", 'type="email"')}${input("phone", "Phone")}<label>Opening<select name="opening_id"><option value="">— None —</option>${openings.map((o) => `<option value="${o.id}" ${o.id === openingId ? "selected" : ""}>${esc(o.title)}</option>`).join("")}</select></label>${input("source", "Source (referral, portal…)")}${input("expected_ctc", "Expected pay (₹ a year)", "", 'type="number" min="0"')}${input("notice_days", "Notice period (days)", "", 'type="number" min="0" max="365"')}${input("resume_url", "Resume link")}${input("qualification", "Qualification")}${input("experience_years", "Experience (years)", "", 'type="number" min="0" step="0.5"')}<label class="full">Skills, separated by commas<input name="skills" maxlength="600"></label><label class="full">Notes<input name="notes" maxlength="2000"></label>`,
    async (b) => {
      const body = {};
      for (const [k, v] of Object.entries(b))
        if (v !== "")
          body[k] = [
            "opening_id",
            "expected_ctc",
            "notice_days",
            "experience_years",
          ].includes(k)
            ? Number(v)
            : v;
      await api("/admin/candidates", body);
      notice("Candidate added.");
    },
  );
}

async function candidateView(id) {
  const c = await api(`/admin/candidates/${id}`);
  const live = ["applied", "screening", "interview", "offer"].includes(c.stage);
  const offer = c.offers.find((o) =>
    ["draft", "sent", "accepted"].includes(o.status),
  );
  const files = await api(`/admin/candidates/${id}/files`);
  const credit = has("credit.manage")
    ? await api(`/admin/candidates/${id}/credit`)
    : null;
  const pre =
    !c.user_id && c.offers.some((o) => ["sent", "accepted"].includes(o.status))
      ? await api(`/admin/candidates/${id}/preboarding`)
      : null;
  const html = `<p class="muted">${esc(c.email || "")} ${esc(c.phone || "")} · ${esc(c.opening_title || "No opening")} · ${stagePill(c.stage)}${c.user_id ? " · now an employee" : ""}</p>${matchPill(c)} ${c.qualification ? `<small>${esc(c.qualification)}</small>` : ""} ${c.experience_years != null ? `<small>${c.experience_years} yrs experience</small>` : ""}${JSON.parse(c.skills || "[]").length ? `<p><strong>Skills:</strong> ${JSON.parse(c.skills).map(esc).join(", ")}</p>` : ""}${files.map((f) => `<button class="ghost" data-cfile="${f.id}">View ${esc(f.name)}</button>`).join(" ")} <button class="ghost" id="edit-skills">Edit skills</button>${c.notes ? `<p>${esc(c.notes)}</p>` : ""}${c.resume_url ? `<p><a href="${esc(c.resume_url)}" target="_blank" rel="noopener noreferrer">Resume</a></p>` : ""}
    ${
      live
        ? `<div class="actions spaced">${["applied", "screening", "interview"]
            .filter((s) => s !== c.stage)
            .map(
              (s) =>
                `<button class="secondary" data-move="${s}">Move to ${STAGE[s]}</button>`,
            )
            .join(
              "",
            )}<button class="secondary" id="sched">Schedule interview</button>${offer ? "" : '<button class="secondary" id="new-offer">Make an offer</button>'}<button class="ghost" id="reject">Reject</button></div>`
        : ""
    }
    <h3>Interviews</h3>${c.interviews.length ? '<div class="actions"><button class="ghost" id="scorecard">Timeline and scorecard</button></div>' : ""}${c.interviews.length ? c.interviews.map((i) => `<div class="activity"><strong>${esc(i.round_name)}</strong> · ${esc(i.interviewer_name)} · ${new Date(i.scheduled_at).toLocaleString("en-IN")} · ${esc(i.status)}${i.rating ? `<br><small>${i.rating}/5 · ${REC[i.recommendation]} · ${esc(i.feedback || "")}</small>` : ""}${i.status === "scheduled" ? ` <button class="ghost" data-cancel-iv="${i.id}">Cancel</button>` : ""}</div>`).join("") : '<p class="muted">None yet.</p>'}
    <h3>Offers</h3>${c.offers.length ? c.offers.map((o) => `<div class="activity"><strong>${esc(o.designation)}</strong> · ${inr(o.monthly_gross)} a month · joins ${fmtDate(o.joining_date)} · ${OFFER_STATUS[o.status]}<br>${o.status === "draft" ? `<button class="ghost" data-offer="${o.id}" data-st="sent">Mark as sent</button>` : ""}${o.status === "sent" ? `<button class="ghost" data-offer="${o.id}" data-st="accepted">Accepted</button><button class="ghost" data-offer="${o.id}" data-st="declined">Declined</button>` : ""}${["draft", "sent", "accepted"].includes(o.status) && !c.user_id ? `<button class="ghost" data-offer="${o.id}" data-st="withdrawn">Withdraw</button>` : ""} <a class="button secondary" href="/letter.html?type=offer&id=${o.id}" target="_blank" rel="noopener">Offer letter</a></div>`).join("") : '<p class="muted">None yet.</p>'}
    ${pre ? preboardingPanel(pre) : ""}${credit && !c.user_id ? creditPanelHtml(credit) : ""}
    ${offer?.status === "accepted" && !c.user_id ? '<div class="actions spaced"><button id="hire">Hire and create the employee</button></div>' : ""}
    <h3>History</h3>${c.events.map((e) => `<div class="activity"><small>${time(e.created_at)} · ${esc(e.kind.replaceAll("_", " "))}${e.detail ? ` · ${esc(e.detail)}` : ""}${e.actor_name ? ` · ${esc(e.actor_name)}` : ""}</small></div>`).join("")}`;
  viewDialog(c.name, html);
  const reopen = () => candidateView(id);
  const on = (s, fn) =>
    document.querySelector(`dialog ${s}`)?.addEventListener("click", fn);
  document.querySelectorAll("dialog [data-move]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/admin/candidates/${id}/stage`, { stage: b.dataset.move });
          await reopen();
          render();
        })),
  );
  document.querySelectorAll("dialog [data-cancel-iv]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(
            `/admin/interviews/${b.dataset.cancelIv}`,
            { status: "cancelled" },
            "PATCH",
          );
          await reopen();
        })),
  );
  document.querySelectorAll("dialog [data-offer]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/admin/offers/${b.dataset.offer}/status`, {
            status: b.dataset.st,
          });
          await reopen();
          render();
        })),
  );
  wirePreboarding(id, pre, reopen);
  wireCredit(id, credit, reopen);
  document
    .querySelectorAll("dialog [data-cfile]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          openFile(`/api/admin/candidate-files/${b.dataset.cfile}`)),
    );
  on("#edit-skills", () =>
    dialog(
      "Skills and experience",
      `<label class="full">Skills, separated by commas<input name="skills" value="${esc(JSON.parse(c.skills || "[]").join(", "))}" maxlength="600"></label>${input("experience_years", "Experience (years)", c.experience_years ?? "", 'type="number" min="0" step="0.5"')}${input("qualification", "Qualification", c.qualification || "")}`,
      async (f) => {
        const r = await api(`/admin/candidates/${id}/rescore`, {
          skills: f.skills,
          experience_years:
            f.experience_years === "" ? null : Number(f.experience_years),
          qualification: f.qualification,
        });
        notice(
          r.match_score == null ? "Saved." : `Saved. Match ${r.match_score}%.`,
        );
      },
    ),
  );
  on("#reject", () =>
    dialog(
      "Close this candidate",
      `${sel("stage", "Outcome", [
        ["rejected", "Rejected"],
        ["withdrawn", "Withdrew"],
      ])}<label class="full">Reason<input name="reason" maxlength="300" required></label>`,
      async (b) => {
        await api(`/admin/candidates/${id}/stage`, b);
        notice("Updated.");
      },
    ),
  );
  on("#sched", () => interviewScheduleDialog(id, reopen));
  on("#scorecard", () => scorecardDialog(id));
  on("#new-offer", () =>
    dialog(
      "Make an offer",
      `${input("designation", "Designation", "", "required maxlength=100")}${input("monthly_gross", "Monthly gross (₹)", "", 'type="number" min="1" required')}${input("joining_date", "Joining date", "", 'type="date" required')}${input("valid_until", "Offer valid until", "", 'type="date"')}${input("probation_months", "Probation (months)", 6, 'type="number" min="0" max="24"')}<label class="full">Monthly salary breakup, one per line like <em>Basic: 24000</em> (leave empty for the standard split)<textarea name="breakup" rows="4"></textarea></label><label class="full">Note for the letter<input name="note" maxlength="1000"></label>`,
      async (b) => {
        await api(`/admin/candidates/${id}/offers`, {
          probation_months: Number(b.probation_months),
          breakup: b.breakup.trim()
            ? b.breakup
                .trim()
                .split("\n")
                .map((l) => {
                  const [name, amount] = l.split(":");
                  return {
                    name: (name || "").trim(),
                    monthly: Number((amount || "").replace(/[^0-9.]/g, "")),
                  };
                })
            : undefined,
          designation: b.designation,
          monthly_gross: Number(b.monthly_gross),
          joining_date: b.joining_date,
          valid_until: b.valid_until || undefined,
          note: b.note || undefined,
        });
        notice("Offer created. Open the letter to print it.");
        await reopen();
      },
    ),
  );
  on("#hire", async () => {
    const [
      { departments: deps, branches, designations: desigs, workplaces: sites },
      people,
    ] = await Promise.all([api("/admin/org"), peopleList()]);
    dialog(
      "Hire " + c.name,
      `${input("email", "Login email", c.email || "", 'type="email" required')}${input("password", "Temporary password", "", 'type="password" minlength="10" required')}<label>Workplace (for punching)<select name="workplace_id">${options(sites, null)}</select></label><label>Department<select name="department_id">${options(deps, null)}</select></label><label>Branch<select name="branch_id">${options(branches, null)}</select></label><label>Designation<select name="designation_id">${options(desigs, null)}</select></label><label>Reporting manager<select name="manager_id">${options(people, null)}</select></label><label>Onboarding buddy<select name="buddy_id">${options(people, null)}</select></label><label class="full">Workstation details for the welcome email (desk, laptop…)<input name="workstation" maxlength="300"></label><label class="check full"><input type="checkbox" name="send_welcome" checked> Email a welcome message with the login details to the candidate</label><label class="full">Credit check override note (only if a high-risk result is accepted)<input name="credit_override_note" maxlength="300"></label>${sel(
        "gender",
        "Gender",
        [
          ["", "—"],
          ["male", "Male"],
          ["female", "Female"],
          ["other", "Other"],
        ],
      )}`,
      async (b) => {
        const body = { email: b.email, password: b.password };
        for (const k of [
          "workplace_id",
          "department_id",
          "branch_id",
          "designation_id",
          "manager_id",
          "buddy_id",
        ])
          if (b[k]) body[k] = Number(b[k]);
        if (b.gender) body.gender = b.gender;
        if (b.credit_override_note)
          body.credit_override_note = b.credit_override_note;
        if (b.workstation) body.workstation = b.workstation;
        body.send_welcome = "send_welcome" in b;
        await api(`/admin/candidates/${id}/hire`, body);
        notice(
          "Hired. The onboarding checklist has been created; set their salary under Payroll.",
        );
      },
    );
  });
}

// ---- pre-boarding, joiners and probation --------------------------------------------------
const PRE_STATUS = {
  invited: "Invited",
  in_progress: "Filling in",
  submitted: "Submitted — review",
  verified: "Verified",
  changes_requested: "Changes requested",
};
async function openFile(url) {
  const res = await fetch(url, {
    headers: activeCompany ? { "X-Company-Id": String(activeCompany) } : {},
  });
  if (!res.ok)
    return notice(
      (await res.json()).error || "Could not open the document.",
      true,
    );
  const blobUrl = URL.createObjectURL(await res.blob());
  window.open(blobUrl, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
}
function joiningSoonCard(rows) {
  return `<div class="card"><div class="card-head"><div><h2>Joining soon</h2><p class="muted">Candidates with an offer out: where their offer and joining details stand.</p></div></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Joining</th><th>Offer</th><th>Joining details</th><th>Documents</th><th>Policies</th><th>Credit</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}<small>${esc(r.designation)}</small></td><td>${fmtDate(r.joining_date)}</td><td><span class="pill ${r.offer_status === "accepted" ? "" : "neutral"}">${OFFER_STATUS[r.offer_status]}</span></td><td>${r.preboarding_status ? `<span class="pill ${r.preboarding_status === "verified" ? "" : "neutral"}">${PRE_STATUS[r.preboarding_status]}</span>` : '<span class="muted">Not invited</span>'}</td><td>${r.docs ? `${r.docs_verified} of ${r.docs} verified` : "—"}</td><td>${r.agreements_required ? `${r.agreements_signed} of ${r.agreements_required} signed` : "—"}</td><td>${r.credit_risk ? `<span class="pill ${RISK_PILL[r.credit_risk]}">${{ low: "Low", medium: "Medium", high: "High" }[r.credit_risk]} risk</span>` : r.credit_consent ? "Consent given" : "—"}</td><td><button class="secondary" data-pre-cand="${r.candidate_id}">Open</button></td></tr>`).join("")}</tbody></table></div>`
      : empty("Nobody waiting to join", "Offers that are sent appear here.")
  }</div>`;
}
function probationCard(rows) {
  if (!has("changes.manage")) return "";
  return `<div class="card"><div class="card-head"><div><h2>Probation reviews</h2><p class="muted">Due within 45 days or overdue. Confirming records a confirmation and ends probation.</p></div></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Manager</th><th>Probation ends</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}<small>${esc(r.employee_code || "")} · joined ${fmtDate(r.date_of_joining)}</small></td><td>${esc(r.manager_name || "—")}</td><td>${fmtDate(r.probation_end_date)} ${r.overdue ? '<span class="pill">Overdue</span>' : ""}</td><td><button class="secondary" data-confirm="${r.user_id}">Confirm</button> <button class="ghost" data-extend="${r.user_id}" data-name="${esc(r.name)}">Extend</button></td></tr>`).join("")}</tbody></table></div>`
      : empty("No reviews due", "Nobody's probation ends in the next 45 days.")
  }</div>`;
}
function probationWire() {
  document.querySelectorAll("[data-confirm]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          const ch = await api("/admin/changes", {
            user_id: Number(b.dataset.confirm),
            kind: "confirmation",
            effective_date: today(),
          });
          await api(`/admin/changes/${ch.id}/apply`, {});
          notice("Confirmed. The employee has been told.");
          render();
        })),
  );
  document.querySelectorAll("[data-extend]").forEach(
    (b) =>
      (b.onclick = () =>
        dialog(
          `Extend probation · ${b.dataset.name}`,
          sel(
            "extend_months",
            "Extend by",
            [1, 2, 3, 6].map((m) => [m, `${m} month${m > 1 ? "s" : ""}`]),
          ),
          async (f) => {
            await api(`/admin/employees/${b.dataset.extend}/probation`, {
              extend_months: Number(f.extend_months),
            });
            notice("Probation extended and the employee told.");
          },
        )),
  );
}
function preboardingPanel(pre) {
  if (!pre.invited)
    return `<h3>Joining portal</h3><p class="muted">Send the candidate a private link to accept the offer, fill in their details and upload documents before day one.</p><div class="actions spaced"><button class="secondary" id="pre-invite">Invite to the joining portal</button></div>`;
  const f = pre.form;
  const rows = [
    ["Date of birth", f.date_of_birth && fmtDate(f.date_of_birth)],
    ["Gender", f.gender],
    ["Address", f.address],
    [
      "Emergency contact",
      f.emergency_name &&
        `${f.emergency_name} · ${f.emergency_phone || ""} ${f.emergency_relation ? `(${f.emergency_relation})` : ""}`,
    ],
    ["PAN", pre.sensitive.pan],
    ["UAN", pre.sensitive.uan],
    [
      "Bank",
      pre.sensitive.bank_account &&
        `${pre.sensitive.bank_name || ""} ${pre.sensitive.bank_account} · ${pre.sensitive.ifsc || ""}`,
    ],
  ].filter(([, v]) => v);
  return `<h3>Joining portal</h3><p><span class="pill ${pre.status === "verified" ? "" : "neutral"}">${PRE_STATUS[pre.status]}</span> <small class="muted">${pre.last_opened_at ? `Last opened ${time(pre.last_opened_at)}` : "Not opened yet"} · link ${pre.expired ? "expired" : `valid to ${fmtDate(pre.expires_at.slice(0, 10))}`}</small></p>${pre.hr_note ? `<p class="muted">Sent back: ${esc(pre.hr_note)}</p>` : ""}${rows.map(([k, v]) => `<div class="activity"><small>${k}</small><br>${esc(v)}</div>`).join("")}${
    pre.documents.length
      ? `<div class="table-wrap"><table><thead><tr><th>Document</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>${pre.documents.map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.kind.replace("_", " "))}</td><td><span class="pill ${d.verified ? "" : "neutral"}">${d.verified ? "Verified" : "Not verified"}</span></td><td><button class="secondary" data-pre-doc="${d.id}">View</button> <button class="ghost" data-pre-verify="${d.id}" data-on="${d.verified ? 0 : 1}">${d.verified ? "Unverify" : "Verify"}</button></td></tr>`).join("")}</tbody></table></div>`
      : '<p class="muted">No documents uploaded yet.</p>'
  }<div class="actions spaced">${pre.status === "submitted" ? '<button id="pre-approve">Approve details</button><button class="secondary" id="pre-changes">Ask for changes</button>' : ""}<button class="ghost" id="pre-invite">Send a new link</button></div>`;
}
function wirePreboarding(id, pre, reopen) {
  if (!pre) return;
  const on = (s, fn) =>
    document.querySelector(`dialog ${s}`)?.addEventListener("click", fn);
  on("#pre-invite", async () => {
    const r = await api(`/admin/candidates/${id}/preboarding/invite`, {});
    viewDialog(
      "Joining link",
      `<p>${r.emailed ? "The link has been emailed to the candidate. " : "Email is not set up, so send this link to the candidate yourself. "}It is valid for 30 days, and a new link replaces the old one.</p><label class="full">Link<input id="join-link" readonly value="${esc(r.link)}"></label><div class="actions spaced"><button class="secondary" id="copy-link">Copy link</button></div>`,
    );
    document.querySelector("dialog #copy-link").onclick = async () => {
      document.querySelector("dialog #join-link").select();
      await navigator.clipboard?.writeText(r.link).catch(() => {});
      notice("Copied.");
    };
  });
  document
    .querySelectorAll("dialog [data-pre-doc]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          openFile(
            `/api/admin/preboarding/documents/${b.dataset.preDoc}/file`,
          )),
    );
  document.querySelectorAll("dialog [data-pre-verify]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(
            `/admin/preboarding/documents/${b.dataset.preVerify}/verify`,
            {
              verified: b.dataset.on === "1",
            },
          );
          await reopen();
        })),
  );
  on("#pre-approve", async () => {
    try {
      await api(`/admin/candidates/${id}/preboarding/review`, {
        decision: "verified",
      });
      notice("Details approved.");
      await reopen();
    } catch (e) {
      notice(e.message, true);
    }
  });
  on("#pre-changes", () =>
    dialog(
      "Ask for changes",
      '<label class="full">What should the candidate correct?<input name="note" maxlength="500" required></label>',
      async (b) => {
        await api(`/admin/candidates/${id}/preboarding/review`, {
          decision: "changes_requested",
          note: b.note,
        });
        notice("Sent back to the candidate.");
      },
    ),
  );
}

async function onboardingDialog(userId, name) {
  const tasks = await api(`/admin/employees/${userId}/onboarding`);
  viewDialog(
    `Joining checklist · ${name}`,
    `${tasks.map((t) => `<label class="check"><input type="checkbox" data-task="${t.id}" ${t.done ? "checked" : ""}> ${esc(t.title)} <small>${OWNER[t.owner]} · due ${t.due_date ? fmtDate(t.due_date) : "—"}</small></label>`).join("")}<div class="actions"><button class="secondary" id="add-task">Add a task</button></div>`,
  );
  document.querySelectorAll("dialog [data-task]").forEach(
    (c) =>
      (c.onchange = async () => {
        await api(`/onboarding-tasks/${c.dataset.task}/done`, {
          done: c.checked,
        });
        render();
      }),
  );
  document.querySelector("dialog #add-task").onclick = () =>
    dialog(
      "Add a task",
      `${input("title", "Task", "", "required maxlength=120")}${sel("owner", "Who does it", Object.entries(OWNER))}${input("due_date", "Due date", "", 'type="date"')}`,
      async (b) => {
        await api(`/admin/employees/${userId}/onboarding`, {
          title: b.title,
          owner: b.owner,
          due_date: b.due_date || undefined,
        });
        await onboardingDialog(userId, name);
      },
    );
}

// ---- exits (HR) ------------------------------------------------------------------------------
async function startExitDialog() {
  const people = await peopleList();
  dialog(
    "Start an exit",
    `${personSel("user_id", "Employee", people)}${sel(
      "kind",
      "Type",
      Object.entries(EXIT_KIND).filter(([k]) => k !== "resignation"),
    )}${input("last_working_day", "Last working day", "", 'type="date" required')}${input("notice_given_on", "Notice date", today(), 'type="date"')}<label class="full">Reason<input name="reason" maxlength="500"></label>`,
    async (b) => {
      await api("/admin/exits", {
        user_id: Number(b.user_id),
        kind: b.kind,
        last_working_day: b.last_working_day,
        notice_given_on: b.notice_given_on || undefined,
        reason: b.reason || undefined,
      });
      notice("Exit started with a clearance checklist.");
    },
  );
}
async function exitView(id) {
  const x = await api(`/admin/exits/${id}`);
  const canPay = has("payroll.manage");
  let preview = null;
  if (x.status === "accepted" && !x.settlement && has("payroll.read"))
    preview = await api(`/admin/exits/${id}/settlement-preview`).catch(
      () => null,
    );
  const money = (l) =>
    `<div class="kv"><span>${esc(l.name)}${l.note ? `<small>${esc(l.note)}</small>` : ""}</span><strong>${l.kind === "deduction" ? "−" : ""}${inr(l.amount)}</strong></div>`;
  const html = `<p class="muted">${esc(x.employee_name)} · ${EXIT_KIND[x.kind]} · notice ${fmtDate(x.notice_given_on)} (${x.notice_days} days) · last day ${x.last_working_day ? fmtDate(x.last_working_day) : "to be set"} · <span class="pill">${EXIT_STATUS[x.status]}</span></p>${x.reason ? `<p>${esc(x.reason)}${x.requested_last_day ? ` (asked to leave on ${fmtDate(x.requested_last_day)})` : ""}</p>` : ""}${exitManagerViewHtml(x)}
  ${x.status === "pending" ? '<div class="actions"><button id="accept">Accept…</button> <button class="ghost" id="decline">Do not accept</button></div>' : ""}
  ${x.status === "accepted" ? `<h3>Clearance</h3>${x.clearance.map((c) => `<label class="check"><input type="checkbox" data-clear="${c.id}" ${c.cleared ? "checked" : ""}> ${esc(c.item)} <small>${esc(c.department)}</small></label>`).join("")}` : ""}
  ${x.status === "accepted" ? `<h3>Full and final settlement</h3>${x.settlement ? `<p class="muted">Posted to the ${monthLabel(x.settlement.pay_in_month)} payroll, where tax and net pay are worked out.</p>${x.settlement.data.lines.map(money).join("")}${x.settlement.data.info.map((i) => `<p class="muted">${esc(i)}</p>`).join("")}${canPay ? '<div class="actions"><button class="ghost" id="void-settle">Void and redo</button></div>' : ""}` : preview ? `${preview.lines.map(money).join("") || '<p class="muted">No earnings or recoveries calculated.</p>'}${preview.info.map((i) => `<p class="muted">${esc(i)}</p>`).join("")}${canPay ? '<div class="actions"><button id="post-settle">Post to payroll…</button></div>' : ""}` : '<p class="muted">Payroll staff prepare the settlement.</p>'}` : ""}
  ${x.status === "accepted" ? `<h3>Exit interview</h3><p class="muted">${x.interview_notes ? esc(x.interview_notes) : "Not recorded."}</p><div class="actions"><button class="secondary" id="interview">Record exit interview</button> <button class="secondary" id="change-lwd">Change last day</button> <button class="ghost" id="cancel-exit">Cancel exit</button> <button id="complete">Complete exit</button></div>` : ""}
  ${x.status === "completed" ? `<div class="actions spaced"><a class="button secondary" target="_blank" rel="noopener" href="/letter.html?type=exit&kind=relieving&id=${x.id}">Relieving letter</a> <a class="button secondary" target="_blank" rel="noopener" href="/letter.html?type=exit&kind=experience&id=${x.id}">Experience certificate</a></div>` : ""}`;
  viewDialog(`Exit · ${x.employee_name}`, html);
  const on = (s, fn) =>
    document.querySelector(`dialog ${s}`)?.addEventListener("click", fn);
  const reopen = () => exitView(id);
  document.querySelectorAll("dialog [data-clear]").forEach(
    (c) =>
      (c.onchange = async () => {
        try {
          await api(`/admin/exits/${id}/clearance/${c.dataset.clear}`, {
            cleared: c.checked,
          });
        } catch (e) {
          c.checked = !c.checked;
          notice(e.message, true);
        }
      }),
  );
  on("#accept", () =>
    dialog(
      "Accept resignation",
      `${input("last_working_day", "Last working day", addDaysStr(x.notice_given_on, x.notice_days), 'type="date" required')}<label class="check"><input type="checkbox" name="waive_notice"> Waive the notice shortfall</label><label class="full">Note<input name="note" maxlength="300"></label>`,
      async (b) => {
        await api(`/admin/exits/${id}/decide`, {
          decision: "accepted",
          last_working_day: b.last_working_day,
          waive_notice: "waive_notice" in b,
          note: b.note || undefined,
        });
        notice("Accepted.");
        await reopen();
      },
    ),
  );
  on("#decline", () =>
    dialog(
      "Do not accept",
      '<label class="full">Reason<input name="note" maxlength="300" required></label>',
      async (b) => {
        await api(`/admin/exits/${id}/decide`, {
          decision: "rejected",
          note: b.note,
        });
        notice("Updated.");
      },
    ),
  );
  on("#interview", () =>
    dialog(
      "Exit interview",
      `<label class="full">Notes<input name="notes" maxlength="3000" required value="${esc(x.interview_notes || "")}"></label>${input("reason", "Main reason for leaving", x.interview_reason || "")}${sel(
        "would_rejoin",
        "Would rejoin",
        [
          ["true", "Yes"],
          ["false", "No"],
        ],
      )}`,
      async (b) => {
        await api(`/admin/exits/${id}/interview`, {
          notes: b.notes,
          reason: b.reason || undefined,
          would_rejoin: b.would_rejoin === "true",
        });
        notice("Saved.");
        await reopen();
      },
    ),
  );
  on("#change-lwd", () =>
    dialog(
      "Change last working day",
      input(
        "last_working_day",
        "Last working day",
        x.last_working_day,
        'type="date" required',
      ),
      async (b) => {
        await api(
          `/admin/exits/${id}`,
          { last_working_day: b.last_working_day },
          "PATCH",
        );
        notice("Updated.");
        await reopen();
      },
    ),
  );
  on("#cancel-exit", async () => {
    if (!confirm("Cancel this exit?")) return;
    await api(`/admin/exits/${id}/cancel`, {});
    notice("Exit cancelled.");
    document.querySelector("dialog")?.remove();
    render();
  });
  on("#complete", async (e) =>
    busy(e.target, async () => {
      await api(`/admin/exits/${id}/complete`, {});
      notice("Exit completed. The login is now closed.");
      document.querySelector("dialog")?.remove();
      render();
    }).catch((err) => notice(err.message, true)),
  );
  on("#void-settle", async () => {
    await api(`/admin/exits/${id}/settlement`, undefined, "DELETE");
    notice("Settlement voided.");
    await reopen();
  });
  on("#post-settle", () =>
    dialog(
      "Post settlement to payroll",
      `${input("pay_in_month", "Pay with the salary of", preview.pay_in_month, 'type="month" required')}<p class="full muted">Adds these lines as one-off earnings and deductions to that month's payroll. Remove them from the draft run if they need to change.</p>${input("extra_name", "Extra payment or recovery (optional)", "")}${input("extra_amount", "Amount (₹)", "", 'type="number" min="1"')}${sel(
        "extra_kind",
        "Type",
        [
          ["earning", "Payment"],
          ["deduction", "Recovery"],
        ],
      )}`,
      async (b) => {
        await api(`/admin/exits/${id}/settlement`, {
          pay_in_month: b.pay_in_month,
          extras:
            b.extra_name && b.extra_amount
              ? [
                  {
                    kind: b.extra_kind,
                    name: b.extra_name,
                    amount: Number(b.extra_amount),
                  },
                ]
              : [],
        });
        notice("Posted to payroll.");
        await reopen();
      },
    ),
  );
}
const addDaysStr = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

// ---- employee: my employment (onboarding, assets, exit) -----------------------------------------
async function myEmploymentPage(id) {
  const [tasks, assets, exit, overview] = await Promise.all([
    api("/onboarding/mine"),
    api("/assets/mine"),
    api("/exit/mine"),
    api("/employment/overview"),
  ]);
  if (id !== renderId) return;
  const x = exit.exit;
  const live = x && ["pending", "accepted"].includes(x.status);
  document.querySelector("#content").innerHTML =
    heading(
      "My employment",
      "Your joining checklist, company items with you, and resignation.",
    ) +
    (overview.probation_end_date || overview.buddy
      ? `<div class="card"><h2>Settling in</h2>${overview.probation_end_date ? `<p>Your probation ends on <strong>${fmtDate(overview.probation_end_date)}</strong>. Your manager and HR will review it before then.</p>` : ""}${overview.buddy ? `<p>Your onboarding buddy is <strong>${esc(overview.buddy.name)}</strong>${overview.buddy.phone ? ` · ${esc(overview.buddy.phone)}` : ""}. Ask them anything.</p>` : ""}</div>`
      : "") +
    (tasks.length
      ? `<div class="card"><h2>Joining checklist</h2>${tasks.map((t) => `<label class="check"><input type="checkbox" data-task="${t.id}" ${t.done ? "checked" : ""} ${t.owner === "employee" ? "" : "disabled"}> ${esc(t.title)} <small>${OWNER[t.owner]}${t.due_date ? ` · due ${fmtDate(t.due_date)}` : ""}</small></label>`).join("")}</div>`
      : "") +
    `<div class="card"><h2>Company items with me</h2>${assets.length ? assets.map((a) => `<div class="activity"><strong>${esc(a.name)}</strong> · ${esc(a.tag)}<br><small>Since ${fmtDate(a.assigned_at.slice(0, 10))}</small></div>`).join("") : empty("Nothing issued", "Laptops, cards and other items issued to you will be listed here.")}</div>` +
    `<div class="card"><h2>Resignation</h2>${live ? `<p>${x.status === "pending" ? "Your resignation is waiting for HR." : `Accepted. Your last working day is <strong>${fmtDate(x.last_working_day)}</strong>.`}</p>${x.status === "pending" && x.initiated_by === "employee" ? '<div class="actions"><button class="ghost" id="withdraw">Withdraw resignation</button></div>' : ""}` : `${x ? `<p class="muted">Last exit: ${EXIT_STATUS[x.status]}.</p>` : ""}<p class="muted">The notice period is ${exit.notice_days} days.</p><div class="actions"><button class="secondary" id="resign">Resign</button></div>`}</div>`;
  document.querySelectorAll("[data-task]:not([disabled])").forEach(
    (c) =>
      (c.onchange = async () => {
        await api(`/onboarding-tasks/${c.dataset.task}/done`, {
          done: c.checked,
        });
        notice("Updated.");
      }),
  );
  document.querySelector("#withdraw")?.addEventListener("click", async () => {
    await api("/exit/withdraw", {});
    notice("Withdrawn.");
    render();
  });
  await myChangesCard(id);
  await myRosterCard(id);
  document.querySelector("#resign")?.addEventListener("click", () =>
    dialog(
      "Resign",
      `<p class="full muted">Your notice period is ${exit.notice_days} days. HR will confirm your last working day.</p>${input("requested_last_day", "Preferred last working day (optional)", "", `type="date" min="${today()}"`)}<label class="full">Reason<input name="reason" maxlength="500" required></label>`,
      async (b) => {
        await api("/exit/resign", {
          reason: b.reason,
          requested_last_day: b.requested_last_day || undefined,
        });
        notice("Your resignation has been sent to HR.");
      },
    ),
  );
}

// ---- approvals: interviews and onboarding tasks assigned to me -----------------------------------
async function hiringApprovals(id) {
  const [iv, tasks] = await Promise.all([
    api("/interviews/mine"),
    api("/onboarding/assigned"),
  ]);
  if (id !== renderId) return;
  const upcoming = iv.filter((i) => i.status === "scheduled");
  if (!upcoming.length && !tasks.length) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML =
    (upcoming.length
      ? `<h2>Interviews to give feedback on</h2><div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Round</th><th>When</th><th></th></tr></thead><tbody>${upcoming.map((i) => `<tr><td>${esc(i.candidate_name)}<small>${esc(i.opening_title || "")}</small></td><td>${esc(i.round_name)}</td><td>${new Date(i.scheduled_at).toLocaleString("en-IN")}</td><td>${i.resume_url ? `<a href="${esc(i.resume_url)}" target="_blank" rel="noopener noreferrer">Resume</a> ` : ""}<button class="secondary" data-feedback="${i.id}">Give feedback</button></td></tr>`).join("")}</tbody></table></div>`
      : "") +
    (tasks.length
      ? `<h2>Joining tasks for you</h2>${tasks.map((t) => `<label class="check"><input type="checkbox" data-mytask="${t.id}"> ${esc(t.title)} <small>${esc(t.employee_name)}${t.due_date ? ` · due ${fmtDate(t.due_date)}` : ""}</small></label>`).join("")}`
      : "");
  document.querySelector("#content").append(card);
  card.querySelectorAll("[data-mytask]").forEach(
    (c) =>
      (c.onchange = async () => {
        await api(`/onboarding-tasks/${c.dataset.mytask}/done`, {});
        notice("Done.");
        await loadMe();
      }),
  );
  card
    .querySelectorAll("[data-feedback]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          interviewDialog(Number(b.dataset.feedback), () => loadMe())),
    );
}
