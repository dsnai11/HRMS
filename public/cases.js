// ---- Raise a concern (everyone) and Cases (HR for grievances, committees for POSH and whistleblower) ----
let caseOptions = null;
const CASE_STATUS = { open: "Open", investigating: "Investigating", resolved: "Resolved", closed: "Closed" };
const caseThread = (messages) =>
  messages.length
    ? messages
        .map(
          (m) =>
            `<div class="activity ${m.internal ? "internal" : ""}"><strong>${esc(m.author || (m.from_reporter ? "Reporter" : ""))}</strong>${m.internal ? ' <span class="pill neutral">internal note</span>' : ""}<br>${esc(m.body).replaceAll("\n", "<br>")}<br><small>${time(m.created_at)}</small></div>`,
        )
        .join("")
    : '<p class="muted">No messages yet.</p>';

async function concernsPage(id) {
  caseOptions ??= await api("/cases/options");
  const mine = await api("/cases/mine");
  if (id !== renderId) return;
  const kinds = caseOptions;
  document.querySelector("#content").innerHTML =
    heading(
      "Raise a concern",
      "Grievances go to HR. POSH complaints go only to the Internal Committee, and whistleblower reports only to the vigilance committee. Nobody you name in a case can see it.",
      '<button id="case-new">Raise a concern</button>',
    ) +
    `<div class="card"><h2>Your cases</h2>${
      mine.length
        ? mine
            .map(
              (c) =>
                `<div class="activity"><strong>${esc(c.code)} · ${esc(kinds[c.kind].label)}</strong> <span class="pill ${c.status === "resolved" || c.status === "closed" ? "neutral" : ""}">${CASE_STATUS[c.status]}</span><br>${esc(c.subject)}<br><small>${esc(c.category)} · raised ${time(c.created_at)}</small>${c.outcome ? `<p><strong>Outcome:</strong> ${esc(c.outcome)}</p>` : ""} <button class="ghost" data-case-open="${c.id}">Open</button></div>`,
            )
            .join("")
        : empty("No cases", "Anything you raise appears here, with replies.")
    }</div>
    <div class="card"><h2>Follow an anonymous report</h2><p class="muted">Anonymous reports are not linked to you. Use the code and key you were shown when you sent it.</p>
      <form id="case-follow" class="form-grid">${input("code", "Case code", "", 'required maxlength="20" autocomplete="off"')}${input("key", "Key", "", 'required maxlength="60" autocomplete="off"')}<div class="actions full"><button>Open</button></div></form><div id="case-followed"></div></div>`;

  const showCase = (c, reply) => {
    viewDialog(
      `${c.code} · ${kinds[c.kind].label}`,
      `<p><strong>${esc(c.subject)}</strong><br><small>${esc(c.category)} · ${CASE_STATUS[c.status]}${c.anonymous ? " · anonymous" : ""}</small></p><p>${esc(c.description).replaceAll("\n", "<br>")}</p>${c.outcome ? `<div class="callout"><strong>Outcome:</strong> ${esc(c.outcome)}</div>` : ""}<h3>Messages</h3>${caseThread(c.messages)}${
        c.status === "closed"
          ? '<p class="muted">This case is closed.</p>'
          : '<form id="case-reply" class="form-grid"><label class="full">Your message<textarea name="body" rows="3" maxlength="3000" required></textarea></label><div class="actions full"><button>Send</button></div></form>'
      }`,
    );
    document.querySelector("dialog #case-reply")?.addEventListener("submit", (e) => {
      e.preventDefault();
      busy(e.submitter, async () => {
        await reply(e.target.body.value);
        document.querySelector("dialog")?.remove();
        notice("Sent.");
        render();
      });
    });
  };
  document.querySelectorAll("[data-case-open]").forEach((b) =>
    b.addEventListener("click", () => {
      const c = mine.find((x) => x.id === Number(b.dataset.caseOpen));
      showCase(c, (body) => api(`/cases/${c.id}/reply`, { body }));
    }),
  );
  document.querySelector("#case-follow").onsubmit = (e) => {
    e.preventDefault();
    const f = { code: e.target.code.value.trim(), key: e.target.key.value.trim() };
    busy(e.submitter, async () => {
      const c = await api("/cases/follow", f);
      showCase(c, (body) => api("/cases/follow/reply", { ...f, body }));
    });
  };

  document.querySelector("#case-new").onclick = () => {
    const kindOpts = Object.entries(kinds).map(([k, v]) => [k, v.label]);
    let result = null;
    dialog(
      "Raise a concern",
      `${sel("kind", "Type", kindOpts)}<label>Category<select name="category"></select></label>
       ${input("subject", "Subject", "", 'required maxlength="150"')}${input("incident_date", "Date it happened (if one day)", "", `type="date" max="${today()}"`)}
       <label class="full">What happened<textarea name="description" rows="5" maxlength="5000" required></textarea></label>
       <label class="full">Person involved (optional)<input name="who" id="case-who" maxlength="200" placeholder="Type a name to search" autocomplete="off"><input type="hidden" name="against_user_id"></label><div class="full" id="case-who-found"></div>
       <label class="check full"><input type="checkbox" name="anonymous" value="1"> Send anonymously (you get a code and key to follow it; nobody, including us, can tell it was you)</label>
       <p class="full muted" id="case-note"></p>`,
      async (f) => {
        result = await api("/cases", {
          kind: f.kind,
          category: f.category,
          subject: f.subject,
          description: f.description,
          incident_date: f.incident_date || null,
          against_user_id: f.against_user_id ? Number(f.against_user_id) : null,
          against_text: f.who || null,
          anonymous: f.anonymous === "1",
        });
        setTimeout(() =>
          viewDialog(
            "Your case was sent",
            result.follow_key
              ? `<p>Keep these safe. They are the only way to follow this anonymous report, and they will not be shown again.</p><div class="codes"><code>${esc(result.code)}</code> <code>${esc(result.follow_key)}</code></div>`
              : `<p>Your case number is <strong>${esc(result.code)}</strong>. You will be told when it moves on, and you can see replies here.</p>`,
          ),
        );
      },
    );
    const d = document.querySelector("dialog");
    const kindSel = d.querySelector('[name="kind"]'),
      catSel = d.querySelector('[name="category"]'),
      anon = d.querySelector('[name="anonymous"]'),
      note = d.querySelector("#case-note");
    const fill = () => {
      const k = kinds[kindSel.value];
      catSel.innerHTML = k.categories.map((c) => `<option>${esc(c)}</option>`).join("");
      anon.disabled = !k.anonymous;
      if (!k.anonymous) anon.checked = false;
      note.textContent =
        kindSel.value === "posh"
          ? "A POSH complaint goes only to the Internal Committee, which must complete its inquiry within 90 days. It needs your name, and stays confidential to the committee."
          : kindSel.value === "whistleblower"
            ? "Goes only to the vigilance committee. You are protected against any retaliation for a report made in good faith."
            : "Goes to HR. Expect a first reply within 30 days.";
    };
    kindSel.onchange = fill;
    fill();
    const who = d.querySelector("#case-who"),
      found = d.querySelector("#case-who-found"),
      hidden = d.querySelector('[name="against_user_id"]');
    let timer;
    who.oninput = () => {
      hidden.value = "";
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (who.value.trim().length < 2) return (found.innerHTML = "");
        const people = await api(`/chat/people?q=${encodeURIComponent(who.value.trim())}`);
        found.innerHTML = people
          .slice(0, 8)
          .map((p) => `<button type="button" class="ghost" data-who="${p.id}" data-name="${esc(p.name)}">${esc(p.name)}${p.employee_code ? ` (${esc(p.employee_code)})` : ""}</button>`)
          .join(" ");
        found.querySelectorAll("[data-who]").forEach(
          (b) =>
            (b.onclick = () => {
              hidden.value = b.dataset.who;
              who.value = b.dataset.name;
              found.innerHTML = "";
            }),
        );
      }, 250);
    };
  };
}

// ---- handlers ----------------------------------------------------------------------------------------
const caseFilter = { kind: "", status: "" };
async function casesPage(id) {
  caseOptions ??= await api("/cases/options");
  const handles = (me.case_kinds ?? []).length > 0;
  const data = handles
    ? await api(`/admin/cases?${new URLSearchParams(Object.entries(caseFilter).filter(([, v]) => v))}`)
    : { kinds: [], cases: [] };
  if (id !== renderId) return;
  const kinds = caseOptions;
  document.querySelector("#content").innerHTML =
    heading(
      "Cases",
      "Grievances, POSH complaints and whistleblower reports you handle. You never see a case that names you or that you raised. Every time you open a case it is in the activity log.",
    ) +
    (handles
      ? `<div class="card"><div class="pm-bar">${sel("kind", "Type", [["", "All I handle"], ...data.kinds.map((k) => [k, kinds[k].label])], caseFilter.kind)}${sel("status", "Status", [["", "Any"], ...Object.entries(CASE_STATUS)], caseFilter.status)}</div><div id="case-list"></div></div>`
      : '<div class="card"><p class="muted">You do not handle any kind of case. Grievances need the Cases right; POSH and whistleblower cases go to the committees named below.</p></div>');
  document.querySelectorAll(".pm-bar select").forEach(
    (s) =>
      (s.onchange = () => {
        caseFilter[s.name] = s.value;
        render();
      }),
  );
  if (handles)
    pagedList(document.querySelector("#case-list"), data.cases, {
      head: "<tr><th>Case</th><th>Subject</th><th>Raised by</th><th>Status</th><th>Due</th><th>With</th><th></th></tr>",
      row: (c) =>
        `<tr><td>${esc(c.code)}<small>${esc(kinds[c.kind].label)}</small></td><td>${esc(c.subject)}<small>${esc(c.category)}</small></td><td>${c.anonymous ? '<span class="pill neutral">Anonymous</span>' : esc(c.reporter_name || "—")}</td><td><span class="pill ${c.status === "resolved" || c.status === "closed" ? "neutral" : ""}">${CASE_STATUS[c.status]}</span></td><td>${fmtDate(c.due_date)}${c.overdue ? ' <span class="pill">overdue</span>' : ""}</td><td>${esc(c.assigned_name || "—")}</td><td><button class="secondary" data-case="${c.id}">Open</button></td></tr>`,
      text: (c) => `${c.code} ${c.subject} ${c.category} ${c.reporter_name || ""} ${CASE_STATUS[c.status]}`,
      label: "cases",
      placeholder: "Search code, subject or person",
      wire: (el) =>
        el.querySelectorAll("[data-case]").forEach((b) => b.addEventListener("click", () => busy(b, () => openCase(Number(b.dataset.case))))),
    });
  if (has("roles.assign")) await caseCommitteesCard(id);
}

async function openCase(caseId) {
  const c = await api(`/admin/cases/${caseId}`);
  const kinds = caseOptions;
  const person = (p) => (p ? `${esc(p.name)}${p.employee_code ? ` (${esc(p.employee_code)})` : ""}` : "—");
  viewDialog(
    `${c.code} · ${kinds[c.kind].label}`,
    `<div class="kv"><span class="muted">Raised by</span><strong>${c.anonymous ? "Anonymous" : person(c.reporter)}</strong></div>
     <div class="kv"><span class="muted">Person involved</span><strong>${c.against ? person(c.against) : esc(c.against_text || "—")}</strong></div>
     <div class="kv"><span class="muted">Category</span><strong>${esc(c.category)}</strong></div>
     <div class="kv"><span class="muted">Incident date</span><strong>${c.incident_date ? fmtDate(c.incident_date) : "—"}</strong></div>
     <div class="kv"><span class="muted">Due</span><strong>${fmtDate(c.due_date)}</strong></div>
     <h3>${esc(c.subject)}</h3><p>${esc(c.description).replaceAll("\n", "<br>")}</p>
     <h3>Messages</h3>${caseThread(c.messages)}
     ${
       c.status === "closed"
         ? `<div class="callout"><strong>Closed.</strong> ${esc(c.outcome || "")}</div>`
         : `<form id="case-msg" class="form-grid"><label class="full">Message<textarea name="body" rows="3" maxlength="3000" required></textarea></label><label class="check full"><input type="checkbox" name="internal" checked> Internal note (only handlers see it)</label><div class="actions full"><button>Add</button></div></form>
            <h3>Status</h3><form id="case-status" class="form-grid">${sel("status", "Status", Object.entries(CASE_STATUS), c.status)}${sel("assigned_to", "Handled by", [["", "Not assigned"], ...c.handlers.map((h) => [h.id, h.name])], c.assigned_to ?? "")}<label class="full">Outcome (needed to resolve or close; the reporter sees it)<textarea name="outcome" rows="3" maxlength="3000">${esc(c.outcome || "")}</textarea></label><div class="actions full"><button>Save</button></div></form>`
     }`,
  );
  const d = document.querySelector("dialog");
  d.querySelector("#case-msg")?.addEventListener("submit", (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api(`/admin/cases/${c.id}/messages`, { body: e.target.body.value, internal: e.target.internal.checked });
      await openCase(c.id);
    });
  });
  d.querySelector("#case-status")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    busy(e.submitter, async () => {
      await api(
        `/admin/cases/${c.id}`,
        { status: f.status.value, assigned_to: f.assigned_to.value ? Number(f.assigned_to.value) : null, ...(f.outcome.value.trim() ? { outcome: f.outcome.value.trim() } : {}) },
        "PATCH",
      );
      document.querySelector("dialog")?.remove();
      notice("Saved.");
      render();
    });
  });
}

async function caseCommitteesCard(id) {
  const c = await api("/admin/case-committees");
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  const block = (kind, title, text) =>
    `<h3>${title}</h3><p class="muted">${text}</p><div class="cr-saved" data-members="${kind}">${c[kind].map((p) => `<span class="cr-chip">${esc(p.name)}${p.employee_code ? `<small>${esc(p.employee_code)}</small>` : ""}<button type="button" class="ghost" data-drop="${kind}:${p.id}" aria-label="Remove ${esc(p.name)}">✕</button></span>`).join("") || '<span class="muted">Nobody yet.</span>'}</div><div class="actions"><input type="search" data-add="${kind}" placeholder="Add a member: search name or code" autocomplete="off"></div><div data-found="${kind}"></div>`;
  card.innerHTML = `<h2>Committees</h2>${block("posh", "Internal Committee (POSH)", "Under the POSH Act: a senior woman employee presides, at least half the members are women, and one member is from an outside organisation working on women's issues (add them as an employee record with no rights).")}${block("whistleblower", "Vigilance committee (whistleblower)", "Usually the vigilance officer and members of the audit committee. Reports go only to them.")}`;
  document.querySelector("#content").append(card);
  const save = (kind, ids) => api(`/admin/case-committees/${kind}`, { user_ids: ids }, "PUT").then(() => render());
  card.querySelectorAll("[data-drop]").forEach((b) =>
    b.addEventListener("click", () => {
      const [kind, uid] = b.dataset.drop.split(":");
      busy(b, () => save(kind, c[kind].map((p) => p.id).filter((x) => x !== Number(uid))));
    }),
  );
  card.querySelectorAll("[data-add]").forEach((inp) => {
    let timer;
    inp.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const kind = inp.dataset.add;
        const out = card.querySelector(`[data-found="${kind}"]`);
        if (inp.value.trim().length < 2) return (out.innerHTML = "");
        const r = await api(`/admin/employees?q=${encodeURIComponent(inp.value.trim())}&limit=8`);
        const rows = r.items ?? [];
        out.innerHTML = (Array.isArray(rows) ? rows : [])
          .map((p) => `<button type="button" class="ghost" data-pick="${p.id}">${esc(p.name)}${p.employee_code ? ` (${esc(p.employee_code)})` : ""}</button>`)
          .join(" ");
        out.querySelectorAll("[data-pick]").forEach((b) =>
          b.addEventListener("click", () => busy(b, () => save(kind, [...new Set([...c[kind].map((p) => p.id), Number(b.dataset.pick)])]))),
        );
      }, 250);
    });
  });
}
