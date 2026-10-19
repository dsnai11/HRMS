// Documents, performance (goals, reviews, training), and account security.
const DOC_KIND = {
  id_proof: "ID proof",
  address_proof: "Address proof",
  pan: "PAN card",
  education: "Education",
  experience: "Experience letter",
  bank: "Bank proof",
  offer_letter: "Offer letter",
  other: "Other",
};
const REVIEW_STATUS = {
  pending_self: "Waiting for self-review",
  pending_manager: "Waiting for manager",
  completed: "Complete",
};
const kb = (n) =>
  n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(n / 1024))} KB`;
const readAsBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("The file could not be read."));
    r.readAsDataURL(file);
  });

// ---- documents ---------------------------------------------------------------------------------
async function openDocument(id) {
  const res = await fetch(`/api/documents/${id}/file`, {
    headers: activeCompany ? { "X-Company-Id": String(activeCompany) } : {},
  });
  if (!res.ok)
    return notice(
      (await res.json()).error || "Could not open the document.",
      true,
    );
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function docTable(rows, { canVerify, canDelete }) {
  return rows.length
    ? `<div class="table-wrap"><table><thead><tr><th>Document</th><th>Type</th><th>Size</th><th>Added</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((d) => `<tr><td>${esc(d.name)}</td><td>${DOC_KIND[d.kind]}</td><td>${kb(d.size)}</td><td>${fmtDate(d.created_at.slice(0, 10))}</td><td>${d.verified_at ? `<span class="pill">Verified${d.verified_by_name ? ` by ${esc(d.verified_by_name)}` : ""}</span>` : '<span class="pill neutral">Not verified</span>'}</td><td><button class="secondary" data-open-doc="${d.id}">View</button>${canVerify && !d.verified_at ? ` <button class="ghost" data-verify-doc="${d.id}">Verify</button>` : ""}${canDelete(d) ? ` <button class="ghost" data-del-doc="${d.id}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
    : empty("No documents", "Uploaded documents appear here.");
}
function wireDocs(scope, reload) {
  scope
    .querySelectorAll("[data-open-doc]")
    .forEach((b) => (b.onclick = () => openDocument(b.dataset.openDoc)));
  scope.querySelectorAll("[data-verify-doc]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/documents/${b.dataset.verifyDoc}/verify`, {});
          reload();
        })),
  );
  scope.querySelectorAll("[data-del-doc]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          if (!confirm("Remove this document?")) return;
          await api(`/documents/${b.dataset.delDoc}`, undefined, "DELETE");
          reload();
        })),
  );
}
function uploadDialog(userId) {
  dialog(
    "Add a document",
    `${sel("kind", "Type", Object.entries(DOC_KIND))}${input("name", "Name", "", "required maxlength=120")}<label class="full">File (PDF, JPG or PNG, up to 2 MB)<input type="file" name="file" accept="application/pdf,image/jpeg,image/png" required></label>`,
    async (b) => {
      const file = document.querySelector("dialog input[type=file]").files[0];
      if (!file) throw new Error("Choose a file.");
      if (file.size > 2 * 1024 * 1024)
        throw new Error("Files can be up to 2 MB.");
      await api("/documents", {
        user_id: userId,
        kind: b.kind,
        name: b.name,
        mime: file.type,
        data: await readAsBase64(file),
      });
      notice("Document added.");
    },
  );
}
async function documentsPage(id) {
  const manage = has("employees.write");
  const mine = await api("/documents");
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading(
      "Documents",
      "Your identity, address and other documents kept with HR.",
      '<button id="add-doc">Add a document</button>',
    ) +
    `<div class="card"><h2>My documents</h2><div id="mine">${docTable(mine, { canVerify: false, canDelete: (d) => !d.verified_at })}</div></div>` +
    (manage
      ? '<div class="card"><h2>Employee documents</h2><div class="actions spaced"><select id="who"></select><button class="secondary" id="load-who">Show</button><button class="ghost" id="missing">Who is missing documents</button></div><div id="theirs"></div></div>'
      : "");
  document.querySelector("#add-doc").onclick = () => uploadDialog(undefined);
  wireDocs(document.querySelector("#mine"), () => render());
  if (!manage) return;
  const people = (await api("/admin/employees?limit=200&active=1")).items;
  document.querySelector("#who").innerHTML = people
    .map(
      (p) =>
        `<option value="${p.id}">${esc(p.name)} (${esc(p.employee_code || "")})</option>`,
    )
    .join("");
  const show = async () => {
    const uid = Number(document.querySelector("#who").value);
    const rows = await api(`/documents?user_id=${uid}`);
    const box = document.querySelector("#theirs");
    box.innerHTML = `<div class="actions"><button class="secondary" id="add-for">Add for this person</button></div>${docTable(rows, { canVerify: true, canDelete: () => true })}`;
    box.querySelector("#add-for").onclick = () => uploadDialog(uid);
    wireDocs(box, show);
  };
  document.querySelector("#load-who").onclick = show;
  document.querySelector("#missing").onclick = async () => {
    const rows = await api("/admin/documents/missing");
    viewDialog(
      "Missing ID, address and PAN documents",
      rows.length
        ? rows
            .map(
              (p) =>
                `<div class="activity">${esc(p.name)} <small>${esc(p.employee_code || "")} · ${p.missing.map((k) => DOC_KIND[k]).join(", ")}</small></div>`,
            )
            .join("")
        : empty("All on file", "Everyone has the required documents."),
    );
  };
}

// ---- account security (on My profile) ---------------------------------------------------------------
async function securityCard(id) {
  const [tf, sessions] = await Promise.all([api("/2fa"), api("/sessions")]);
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<h2>Sign-in security</h2><div class="kv"><span class="muted">Two-factor login (browser)</span><strong>${tf.enabled ? `On · ${tf.recovery_codes_left} recovery codes left` : "Off"}</strong></div>${tf.available ? `<div class="actions">${tf.enabled ? '<button class="ghost" id="tf-off">Turn off</button>' : '<button class="secondary" id="tf-on">Turn on with an authenticator app</button>'}</div>` : '<p class="muted">Not available until the server has DATA_ENCRYPTION_KEY set.</p>'}<h3>Where you are signed in</h3>${sessions.map((s) => `<div class="activity"><strong>${s.current ? "This browser" : "Another sign-in"}</strong> · ${esc(s.ip || "")}<br><small>${esc((s.agent || "").slice(0, 90))} · ${s.created_at ? time(s.created_at) : ""}</small>${s.current ? "" : ` <button class="ghost" data-rev="${s.id}">Sign out</button>`}</div>`).join("")}${sessions.length > 1 ? '<div class="actions"><button class="secondary" id="rev-others">Sign out everywhere else</button></div>' : ""}`;
  document.querySelector("#content").append(card);
  card.querySelectorAll("[data-rev]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/sessions/${b.dataset.rev}`, undefined, "DELETE");
          render();
        })),
  );
  card.querySelector("#rev-others")?.addEventListener("click", (e) =>
    busy(e.target, async () => {
      await api("/sessions/revoke-others", {});
      notice("Signed out everywhere else.");
      render();
    }),
  );
  card.querySelector("#tf-off")?.addEventListener("click", () =>
    dialog(
      "Turn off two-factor login",
      input("password", "Your password", "", 'type="password" required'),
      async (b) => {
        await api("/2fa/disable", { password: b.password });
        notice("Two-factor login is off.");
      },
    ),
  );
  card.querySelector("#tf-on")?.addEventListener("click", async () => {
    const s = await api("/2fa/setup", {});
    dialog(
      "Turn on two-factor login",
      `<p class="full muted">In your authenticator app (Google Authenticator, Microsoft Authenticator, Authy) add an account with this key. Choose "time based".</p><div class="full"><code class="secret">${esc(s.secret.match(/.{1,4}/g).join(" "))}</code></div>${input("code", "Code from the app", "", 'inputmode="numeric" maxlength="6" required')}`,
      async (b) => {
        const r = await api("/2fa/enable", { code: b.code });
        viewDialog(
          "Save your recovery codes",
          `<p>Each code works once if you lose your phone. They will not be shown again.</p><div class="codes">${r.recovery_codes.map((c) => `<code>${c}</code>`).join(" ")}</div>`,
        );
      },
    );
  });
}

// ---- performance ---------------------------------------------------------------------------------------
let perfTab = "mine";
const perfCache = {};
async function performancePage(id) {
  const manage = has("performance.manage");
  const tabs = {
    mine: "My goals & reviews",
    ...(me.is_manager ? { team: "My team's reviews" } : {}),
    feedback: "Feedback",
    training: "Training",
    ...(manage
      ? { cycles: "Review cycles", trainings: "Manage training", kras: "KRAs" }
      : {}),
  };
  if (!tabs[perfTab]) perfTab = "mine";
  const html = await perfHtml(perfTab);
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading("Performance", "Goals, reviews and training.") +
    `<div class="tabbar">${Object.entries(tabs)
      .map(
        ([k, l]) =>
          `<button class="${k === perfTab ? "" : "secondary"}" data-tab="${k}">${l}</button>`,
      )
      .join("")}</div><div id="tab">${html}</div>`;
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => (b.onclick = () => ((perfTab = b.dataset.tab), render())));
  perfWire(perfTab);
}
const goalRows = (goals, mine) =>
  goals.length
    ? `<div class="table-wrap"><table><thead><tr><th>Goal</th><th>Weight</th><th>Due</th><th>Progress</th><th></th></tr></thead><tbody>${goals.map((g) => `<tr><td>${esc(g.title)}${g.description ? `<small>${esc(g.description)}</small>` : ""}</td><td>${g.weight}%</td><td>${g.due_date ? fmtDate(g.due_date) : "—"}</td><td><span class="pill ${g.status === "active" ? "neutral" : ""}">${g.status === "done" ? "Done" : g.status === "dropped" ? "Dropped" : `${g.progress}%`}</span></td><td>${g.status === "active" ? `<button class="secondary" data-progress="${g.id}" data-now="${g.progress}">Update</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
    : empty(
        "No goals",
        mine ? "Add a goal, or ask your manager to set some." : "No goals yet.",
      );
async function perfHtml(tab) {
  if (tab === "mine") {
    const [goals, reviews] = await Promise.all([
      api("/goals"),
      api("/reviews/mine"),
    ]);
    return `<div class="card"><div class="card-head"><div><h2>My goals</h2></div><button id="new-goal">Add a goal</button></div>${goalRows(goals, true)}</div><div class="card"><h2>My reviews</h2>${reviews.length ? reviews.map((r) => `<div class="activity"><strong>${esc(r.cycle_name)}</strong> · <span class="pill ${r.status === "completed" ? "" : "neutral"}">${REVIEW_STATUS[r.status]}</span>${r.self_rating ? `<br><small>Your rating ${r.self_rating}/5 · ${esc(r.self_comment || "")}</small>` : ""}${r.manager_rating ? `<br><small>Manager rating ${r.manager_rating}/5 · ${esc(r.manager_comment || "")}</small>` : r.status === "completed" ? "<br><small>Your manager's rating will be shared by HR.</small>" : ""}${r.status === "pending_self" && r.cycle_status === "open" ? ` <button data-self="${r.id}">Write self-review</button>` : ""}</div>`).join("") : empty("No reviews", "Reviews appear when HR starts a cycle.")}</div>`;
  }
  if (tab === "team") {
    const rows = await api("/reviews/team");
    return `<div class="card"><h2>Reviews waiting for you</h2>${rows.length ? rows.map((r) => `<div class="activity"><strong>${esc(r.employee_name)}</strong> · ${esc(r.cycle_name)}<br><small>Self-rating ${r.self_rating}/5 · ${esc(r.self_comment || "")}</small> <button data-mgr="${r.id}" data-name="${esc(r.employee_name)}">Review</button> <button class="ghost" data-goals-of="${r.user_id}" data-name="${esc(r.employee_name)}">See goals</button></div>`).join("") : empty("Nothing waiting", "Self-reviews from your team appear here.")}</div>`;
  }
  if (tab === "feedback") {
    const [got, given] = await Promise.all([
      api("/feedback/received"),
      api("/feedback/given"),
    ]);
    const fb = (f, who) =>
      `<div class="activity"><strong>${esc(who)}</strong> · <span class="pill ${f.kind === "improve" ? "neutral" : ""}">${{ praise: "Praise", improve: "To improve", note: "Note" }[f.kind]}</span>${f.shared ? "" : ' <span class="pill neutral">Private</span>'}<br>${esc(f.body)}<br><small>${time(f.created_at)}</small></div>`;
    return `<div class="card"><div class="card-head"><div><h2>Feedback for me</h2></div><button id="give-fb">Give feedback</button></div>${got.length ? got.map((f) => fb(f, f.from_name)).join("") : empty("Nothing yet", "Feedback from colleagues and managers appears here.")}</div><div class="card"><h2>Feedback I gave</h2>${given.length ? given.map((f) => fb(f, `To ${f.to_name}`)).join("") : empty("Nothing yet", "Recognise a colleague or help them improve.")}</div>`;
  }
  if (tab === "kras") {
    const [rows, org] = await Promise.all([
      api("/admin/kras"),
      api("/admin/org"),
    ]);
    perfCache.org = org;
    return `<div class="card"><div class="card-head"><div><h2>KRAs by designation</h2><p class="muted">Key result areas for a role. Apply them to someone to create their goals.</p></div><div class="actions"><button class="secondary" id="apply-kra">Apply to an employee</button><button id="new-kra">Add a KRA</button></div></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Designation</th><th>KRA</th><th>Weight</th><th></th></tr></thead><tbody>${rows.map((k) => `<tr><td>${esc(k.designation_name)}</td><td>${esc(k.title)}${k.description ? `<small>${esc(k.description)}</small>` : ""}</td><td>${k.weight}%</td><td><button class="ghost" data-del-kra="${k.id}">Remove</button></td></tr>`).join("")}</tbody></table></div>` : empty("No KRAs", "Add the key result areas for each designation.")}</div>`;
  }
  if (tab === "training") {
    const rows = await api("/trainings/mine");
    return `<div class="card"><h2>My training</h2>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Hours</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((t) => `<tr><td>${esc(t.title)}${t.mandatory ? ' <span class="pill">Mandatory</span>' : ""}</td><td>${t.hours}</td><td>${t.due_date ? fmtDate(t.due_date) : "—"}</td><td><span class="pill ${t.status === "completed" ? "" : "neutral"}">${t.status === "completed" ? `Done ${fmtDate(t.completed_on)}${t.score != null ? ` · ${t.score}%` : ""}` : "To do"}</span></td><td>${t.status === "assigned" && !t.mandatory ? `<button class="secondary" data-done-train="${t.id}">Mark done</button>` : t.status === "assigned" ? "<small>Confirmed by your manager or HR</small>" : ""}</td></tr>`).join("")}</tbody></table></div>` : empty("No training", "Courses assigned to you appear here.")}</div>`;
  }
  if (tab === "cycles") {
    const rows = await api("/admin/review-cycles");
    return `<div class="card"><div class="card-head"><div><h2>Review cycles</h2><p class="muted">Starting a cycle opens a self-review for every active employee.</p></div><button id="new-cycle">Start a cycle</button></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Cycle</th><th>Period</th><th>Completed</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((c) => `<tr><td>${esc(c.name)}</td><td>${fmtDate(c.start_date)} – ${fmtDate(c.end_date)}</td><td>${c.completed} of ${c.reviews}</td><td><span class="pill ${c.status === "open" ? "" : "neutral"}">${c.status}</span></td><td><button class="secondary" data-cycle="${c.id}" data-name="${esc(c.name)}">Open</button></td></tr>`).join("")}</tbody></table></div>` : empty("No cycles", "Start the first review cycle.")}</div>`;
  }
  const rows = await api("/admin/trainings");
  return `<div class="card"><div class="card-head"><div><h2>Training</h2></div><button id="new-training">Assign training</button></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Hours</th><th>Due</th><th>Completed</th><th></th></tr></thead><tbody>${rows.map((t) => `<tr><td>${esc(t.title)}${t.mandatory ? ' <span class="pill">Mandatory</span>' : ""}</td><td>${t.hours}</td><td>${t.due_date ? fmtDate(t.due_date) : "—"}</td><td>${t.completed} of ${t.assigned}</td><td><button class="secondary" data-train="${t.id}" data-name="${esc(t.title)}">Records</button></td></tr>`).join("")}</tbody></table></div>` : empty("No training", "Assign a course to everyone or to selected people.")}</div>`;
}
function perfWire(tab) {
  const on = (s, fn) =>
    document.querySelector(s)?.addEventListener("click", fn);
  const each = (s, fn) =>
    document.querySelectorAll(s).forEach((b) => (b.onclick = () => fn(b)));
  const ratingSel = (value = 3) =>
    sel(
      "rating",
      "Rating (5 is best)",
      [1, 2, 3, 4, 5].map((n) => [n, n]),
      value,
    );
  each("[data-progress]", (b) =>
    dialog(
      "Update progress",
      input(
        "progress",
        "Progress (%)",
        b.dataset.now,
        'type="number" min="0" max="100" required',
      ),
      async (f) => {
        await api(
          `/goals/${b.dataset.progress}`,
          { progress: Number(f.progress) },
          "PATCH",
        );
        notice("Updated.");
      },
    ),
  );
  on("#new-goal", () =>
    dialog(
      "Add a goal",
      `${input("title", "Goal", "", "required maxlength=150")}<label class="full">Details<input name="description" maxlength="1000"></label>${input("weight", "Weight (%)", 20, 'type="number" min="0" max="100"')}${input("due_date", "Due date", "", 'type="date"')}`,
      async (b) => {
        await api("/goals", {
          title: b.title,
          description: b.description || undefined,
          weight: Number(b.weight),
          due_date: b.due_date || undefined,
        });
        notice("Goal added.");
      },
    ),
  );
  each("[data-self]", (b) =>
    dialog(
      "Self-review",
      `${ratingSel()}<label class="full">How did the period go?<textarea name="comment" rows="5" maxlength="2000" required></textarea></label>`,
      async (f) => {
        await api(`/reviews/${b.dataset.self}/self`, {
          rating: Number(f.rating),
          comment: f.comment,
        });
        notice("Sent to your manager.");
        await loadMe();
      },
    ),
  );
  each("[data-mgr]", (b) =>
    dialog(
      `Review of ${b.dataset.name}`,
      `${ratingSel()}<label class="full">Your assessment<textarea name="comment" rows="5" maxlength="2000" required></textarea></label>`,
      async (f) => {
        await api(`/reviews/${b.dataset.mgr}/manager`, {
          rating: Number(f.rating),
          comment: f.comment,
        });
        notice("Review saved. HR will release the result.");
      },
    ),
  );
  each("[data-goals-of]", async (b) => {
    const goals = await api(`/goals?user_id=${b.dataset.goalsOf}`);
    viewDialog(`${b.dataset.name}'s goals`, goalRows(goals, false));
  });
  on("#give-fb", async () => {
    const people = (await api("/directory")).filter((p) => p.id !== me.id);
    dialog(
      "Give feedback",
      `<label>To<select name="to_user">${people.map((p) => `<option value="${p.id}">${esc(p.name)}${p.designation_name ? ` (${esc(p.designation_name)})` : ""}</option>`).join("")}</select></label>${sel(
        "kind",
        "Type",
        [
          ["praise", "Praise"],
          ["improve", "Something to improve"],
          ["note", "Note"],
        ],
      )}<label class="full">Feedback<textarea name="body" rows="4" maxlength="1500" required></textarea></label><label class="check"><input type="checkbox" name="private"> Private: only their managers and HR see it, not them</label>`,
      async (b) => {
        await api("/feedback", {
          to_user: Number(b.to_user),
          kind: b.kind,
          body: b.body,
          shared: !("private" in b),
        });
        notice("Sent.");
      },
    );
  });
  on("#new-kra", () =>
    dialog(
      "Add a KRA",
      `<label>Designation<select name="designation_id">${options(perfCache.org.designations, null, "—")}</select></label>${input("title", "Key result area", "", "required maxlength=150")}<label class="full">Details<input name="description" maxlength="1000"></label>${input("weight", "Weight (%)", 20, 'type="number" min="0" max="100"')}`,
      async (b) => {
        if (!b.designation_id) throw new Error("Choose a designation.");
        await api("/admin/kras", {
          designation_id: Number(b.designation_id),
          title: b.title,
          description: b.description || undefined,
          weight: Number(b.weight),
        });
        notice("Added.");
      },
    ),
  );
  each("[data-del-kra]", (b) =>
    busy(b, async () => {
      await api(`/admin/kras/${b.dataset.delKra}`, undefined, "DELETE");
      render();
    }),
  );
  on("#apply-kra", async () => {
    const people = (await api("/admin/employees?limit=200&active=1")).items;
    dialog(
      "Apply KRAs",
      `<label>Employee<select name="user_id">${people.map((p) => `<option value="${p.id}">${esc(p.name)}${p.designation_name ? ` (${esc(p.designation_name)})` : ""}</option>`).join("")}</select></label><p class="full muted">Creates goals from the KRAs of their designation, skipping any they already have.</p>`,
      async (b) => {
        const r = await api(`/admin/employees/${b.user_id}/apply-kras`, {});
        notice(`${r.added} goal(s) created, ${r.skipped} already existed.`);
      },
    );
  });
  each("[data-done-train]", (b) =>
    busy(b, async () => {
      await api(`/trainings/records/${b.dataset.doneTrain}/complete`, {});
      render();
    }),
  );
  on("#new-cycle", () =>
    dialog(
      "Start a review cycle",
      `${input("name", "Name", `FY ${taxYearStart()}-${String(taxYearStart() + 1).slice(2)}`, "required maxlength=80")}${input("start_date", "Period start", `${taxYearStart()}-04-01`, 'type="date" required')}${input("end_date", "Period end", `${taxYearStart() + 1}-03-31`, 'type="date" required')}`,
      async (b) => {
        const r = await api("/admin/review-cycles", b);
        notice(`Started for ${r.reviews} people.`);
      },
    ),
  );
  each("[data-cycle]", async (b) => {
    const rows = await api(`/admin/review-cycles/${b.dataset.cycle}/reviews`);
    viewDialog(
      `${b.dataset.name} reviews`,
      `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Manager</th><th>Self</th><th>Manager rating</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.employee_name)}</td><td>${esc(r.manager_name || "—")}</td><td>${r.self_rating ?? "—"}</td><td>${r.manager_rating ?? "—"}</td><td>${REVIEW_STATUS[r.status]}${r.released ? " · released" : ""}</td><td>${r.status === "completed" && !r.released ? `<button class="ghost" data-release="${r.id}">Release</button>` : ""}</td></tr>`).join("")}</tbody></table></div><div class="actions"><button class="ghost" id="close-cycle">Close this cycle</button></div>`,
    );
    document.querySelectorAll("dialog [data-release]").forEach(
      (x) =>
        (x.onclick = () =>
          busy(x, async () => {
            await api(`/admin/reviews/${x.dataset.release}/release`, {});
            x.remove();
          })),
    );
    document.querySelector("dialog #close-cycle").onclick = async () => {
      await api(`/admin/review-cycles/${b.dataset.cycle}/close`, {});
      document.querySelector("dialog")?.remove();
      render();
    };
  });
  on("#new-training", () =>
    dialog(
      "Assign training",
      `${input("title", "Course", "", "required maxlength=150")}${input("hours", "Hours", 1, 'type="number" min="0.25" step="0.25"')}${input("due_date", "Due date", "", 'type="date"')}<label class="check"><input type="checkbox" name="mandatory"> Mandatory (completion confirmed by manager or HR)</label><p class="full muted">Assigned to everyone in the company.</p>`,
      async (b) => {
        const r = await api("/admin/trainings", {
          title: b.title,
          hours: Number(b.hours),
          due_date: b.due_date || undefined,
          mandatory: "mandatory" in b,
        });
        notice(`Assigned to ${r.assigned} people.`);
      },
    ),
  );
  each("[data-train]", async (b) => {
    const rows = await api(`/admin/trainings/${b.dataset.train}/records`);
    viewDialog(
      b.dataset.name,
      `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Status</th><th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.employee_name)}</td><td>${r.status === "completed" ? `Done ${fmtDate(r.completed_on)}` : "To do"}</td><td>${r.status === "assigned" ? `<button class="ghost" data-confirm="${r.id}">Mark done</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`,
    );
    document.querySelectorAll("dialog [data-confirm]").forEach(
      (x) =>
        (x.onclick = () =>
          busy(x, async () => {
            await api(`/trainings/records/${x.dataset.confirm}/complete`, {});
            x.remove();
          })),
    );
  });
}
