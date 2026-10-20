// Recruitment extras: pipeline board, insights, email templates, requisitions, opening details.
const BOARD_STAGES = [
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
];
const TEMPLATE_VARS =
  "{{name}}, {{position}}, {{company}}, {{details}}, {{link}}, {{track}}";
let boardOpening = "";

const matchPill = (c) =>
  c.match_score == null
    ? ""
    : `<span class="pill ${c.opening_min_score && c.match_score < c.opening_min_score ? "neutral" : ""}" title="Skill and experience match">${c.match_score}% match</span>`;

async function recruitTabHtml(tab) {
  if (tab === "board") {
    const [cands, openings] = await Promise.all([
      api(
        `/admin/candidates${boardOpening ? `?opening_id=${boardOpening}` : ""}`,
      ),
      api("/admin/openings"),
    ]);
    return `<div class="card"><div class="card-head"><div><h2>Pipeline board</h2><p class="muted">Drag a candidate to a column to move them. Offers and hiring are done from the candidate.</p></div><label class="inline">Opening<select id="board-opening"><option value="">All openings</option>${openings.map((o) => `<option value="${o.id}" ${String(o.id) === String(boardOpening) ? "selected" : ""}>${esc(o.title)}</option>`).join("")}</select></label></div><div class="board">${BOARD_STAGES.map(
      (s) =>
        `<div class="board-col" data-stage="${s}"><h3>${STAGE[s]} <small>${cands.filter((c) => c.stage === s).length}</small></h3>${cands
          .filter((c) => c.stage === s)
          .map(
            (c) =>
              `<div class="board-card" draggable="true" data-card="${c.id}" data-stage="${c.stage}"><strong>${esc(c.name)}</strong><small>${esc(c.opening_title || "No opening")}${c.source ? ` · ${esc(c.source)}` : ""}</small>${matchPill(c)}</div>`,
          )
          .join("")}</div>`,
    ).join("")}</div></div>`;
  }
  if (tab === "insights") {
    const a = await api("/admin/recruitment/analytics");
    const max = Math.max(...a.funnel.map((f) => f.count), 1);
    const stat = (l, v) =>
      `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v ?? "—"}</div></div>`;
    return `<div class="stats">${stat(
      "Open positions",
      a.open_positions.reduce((n, o) => n + o.positions - o.filled, 0),
    )}${stat("Avg days to hire", a.avg_days_to_hire)}${stat("Avg days to fill", a.avg_days_to_fill)}${stat("Days to first interview", a.avg_days_to_first_interview)}${stat("Offer acceptance", a.offer_acceptance_rate == null ? null : `${a.offer_acceptance_rate}%`)}${stat("Requisitions waiting", a.pending_requisitions)}</div>
    <div class="card"><h2>Hiring funnel</h2><svg class="funnel" viewBox="0 0 600 ${a.funnel.length * 36}" role="img" aria-label="Hiring funnel">${a.funnel.map((f, i) => `<text x="0" y="${i * 36 + 22}" class="funnel-label">${f.stage}</text><rect x="110" y="${i * 36 + 6}" width="${Math.max((f.count / max) * 420, 2)}" height="22" rx="4" class="funnel-bar"/><text x="${116 + (f.count / max) * 420}" y="${i * 36 + 22}" class="funnel-label">${f.count}</text>`).join("")}</svg></div>
    <div class="card"><h2>Source of hire</h2>${a.sources.length ? `<div class="table-wrap"><table><thead><tr><th>Source</th><th>Candidates</th><th>Hired</th></tr></thead><tbody>${a.sources.map((s) => `<tr><td>${esc(s.source)}</td><td>${s.candidates}</td><td>${s.hired}</td></tr>`).join("")}</tbody></table></div>` : empty("No data", "Sources appear as candidates are added.")}</div>
    <div class="card"><h2>Open positions</h2>${a.open_positions.length ? `<div class="table-wrap"><table><thead><tr><th>Role</th><th>Days open</th><th>Positions</th><th>In process</th><th>Filled</th></tr></thead><tbody>${a.open_positions.map((o) => `<tr><td>${esc(o.title)}</td><td>${o.days_open}</td><td>${o.positions}</td><td>${o.candidates}</td><td>${o.filled}</td></tr>`).join("")}</tbody></table></div>` : empty("Nothing open", "Open positions appear here.")}</div>${await interviewAnalyticsHtml()}`;
  }
  if (tab === "questions") return await questionBankHtml();
  if (tab === "credit") return await creditTabHtml();
  const rows = await api("/admin/recruitment/templates");
  return `<div class="card"><h2>Candidate emails</h2><p class="muted">Sent automatically when a candidate applies, is invited to interview, is not taken forward, or receives an offer. They go out only when email is set up on the server; otherwise the candidate's timeline notes that nothing was sent. You can use: ${TEMPLATE_VARS}.</p>${rows.map((t) => `<div class="activity"><strong>${esc(t.label)}</strong> ${t.enabled ? "" : '<span class="pill neutral">Off</span>'}<br><small>${esc(t.subject)}</small><br><button class="secondary" data-template="${t.key}">Edit</button></div>`).join("")}</div>`;
}

async function recruitWire(tab) {
  if (tab === "board") {
    document.querySelector("#board-opening").onchange = (e) => {
      boardOpening = e.target.value;
      render();
    };
    document.querySelectorAll("[data-card]").forEach((card) => {
      card.ondragstart = (e) =>
        e.dataTransfer.setData("text/plain", card.dataset.card);
      card.onclick = () => candidateView(Number(card.dataset.card));
    });
    document.querySelectorAll(".board-col").forEach((col) => {
      col.ondragover = (e) => e.preventDefault();
      col.ondrop = async (e) => {
        e.preventDefault();
        const id = Number(e.dataTransfer.getData("text/plain"));
        const stage = col.dataset.stage;
        const card = document.querySelector(`[data-card="${id}"]`);
        if (!card || card.dataset.stage === stage) return;
        if (stage === "offer") return candidateView(id);
        if (stage === "hired")
          return notice(
            "Hire from the candidate once the offer is accepted.",
            true,
          );
        if (stage === "rejected")
          return dialog(
            "Close this candidate",
            '<label class="full">Reason<input name="reason" maxlength="300" required></label>',
            async (b) => {
              await api(`/admin/candidates/${id}/stage`, {
                stage,
                reason: b.reason,
              });
              notice("Updated.");
            },
          );
        try {
          await api(`/admin/candidates/${id}/stage`, { stage });
          render();
        } catch (err) {
          notice(err.message, true);
        }
      };
    });
    return;
  }
  if (tab === "questions") return questionBankWire();
  if (tab === "credit") return creditTabWire();
  document.querySelectorAll("[data-template]").forEach((b) => {
    b.onclick = async () => {
      const t = (await api("/admin/recruitment/templates")).find(
        (x) => x.key === b.dataset.template,
      );
      dialog(
        `Email · ${t.label}`,
        `${input("subject", "Subject", t.subject, "required maxlength=200")}<label class="full">Message<textarea name="body" rows="9" maxlength="4000" required>${esc(t.body)}</textarea></label><label class="check"><input type="checkbox" name="enabled" ${t.enabled ? "checked" : ""}> Send this email automatically</label><p class="full muted">Variables: ${TEMPLATE_VARS}</p>`,
        async (f) => {
          await api(
            `/admin/recruitment/templates/${t.key}`,
            { subject: f.subject, body: f.body, enabled: "enabled" in f },
            "PUT",
          );
          notice("Saved.");
        },
      );
    };
  });
}

// ---- openings: requisitions to approve, details, careers link ------------------------------------
function requisitionsCard(openings) {
  const pending = openings.filter(
    (o) => o.approval_status === "pending_approval",
  );
  if (!pending.length) return "";
  return `<div class="card"><h2>Requisitions waiting for approval</h2><div class="table-wrap"><table><thead><tr><th>Role</th><th>Raised by</th><th>Positions</th><th>Why</th><th></th></tr></thead><tbody>${pending.map((o) => `<tr><td>${esc(o.title)}<small>${[o.qualifications, o.min_experience_years && `${o.min_experience_years}+ yrs`, (o.salary_min || o.salary_max) && `₹${o.salary_min || ""}–${o.salary_max || ""}`].filter(Boolean).map(esc).join(" · ")}</small></td><td>${esc(o.hiring_manager_name || "—")}</td><td>${o.positions}</td><td>${esc(o.justification || "—")}</td><td><button class="secondary" data-req-ok="${o.id}">Approve</button> <button class="ghost" data-req-no="${o.id}">Decline</button></td></tr>`).join("")}</tbody></table></div></div>`;
}
function careersCard() {
  const link = `${location.origin}/careers.html?c=${activeCompany || me.company_id}`;
  return `<div class="card"><div class="card-head"><div><h2>Careers page</h2><p class="muted">Anyone can apply here without a login. Share this link on LinkedIn, Naukri, WhatsApp or your website; each opening you publish appears on it. Use <em>Posting text</em> on an opening to copy a ready-made advert.</p></div><div class="actions"><button class="secondary" id="copy-careers" data-link="${esc(link)}">Copy link</button><a class="button secondary" target="_blank" rel="noopener" href="${esc(link)}">Open page</a></div></div></div>`;
}
function recruitOpeningsWire() {
  const on = (s, fn) =>
    document.querySelector(s)?.addEventListener("click", fn);
  on("#copy-careers", async (e) => {
    await navigator.clipboard?.writeText(e.target.dataset.link).catch(() => {});
    notice("Copied.");
  });
  document.querySelectorAll("[data-req-ok]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/admin/openings/${b.dataset.reqOk}/approval`, {
            decision: "approved",
          });
          notice("Approved. The opening is now open.");
          render();
        })),
  );
  document.querySelectorAll("[data-req-no]").forEach(
    (b) =>
      (b.onclick = () =>
        dialog(
          "Decline requisition",
          '<label class="full">Reason for the manager<input name="note" maxlength="500" required></label>',
          async (f) => {
            await api(`/admin/openings/${b.dataset.reqNo}/approval`, {
              decision: "rejected",
              note: f.note,
            });
            notice("Declined.");
          },
        )),
  );
  document
    .querySelectorAll("[data-opening-details]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          openingDetailsDialog(Number(b.dataset.openingDetails))),
    );
  document.querySelectorAll("[data-posting]").forEach((b) => {
    b.onclick = async () => {
      const p = await api(`/admin/openings/${b.dataset.posting}/posting`);
      viewDialog(
        "Posting text",
        `<p class="muted">${p.published ? "Published on your careers page." : "Not published on the careers page yet. Use Details to publish it."} Copy this into LinkedIn, Naukri or WhatsApp.</p><label class="full"><textarea id="posting" rows="12" readonly>${esc(p.text)}</textarea></label><div class="actions spaced"><button class="secondary" id="copy-post">Copy text</button></div>`,
      );
      document.querySelector("dialog #copy-post").onclick = async () => {
        await navigator.clipboard?.writeText(p.text).catch(() => {});
        notice("Copied.");
      };
    };
  });
}
async function openingDetailsDialog(id) {
  const o = (await api("/admin/openings")).find((x) => x.id === id);
  dialog(
    `Details · ${o.title}`,
    `${input("qualifications", "Qualifications", o.qualifications || "", "maxlength=1000")}${input("location", "Location", o.location || "", "maxlength=120")}${input("min_experience_years", "Minimum experience (years)", o.min_experience_years ?? "", 'type="number" min="0" max="60" step="0.5"')}${input("closing_date", "Closing date", o.closing_date || "", 'type="date"')}${input("salary_min", "Pay from (₹ a year)", o.salary_min ?? "", 'type="number" min="0"')}${input("salary_max", "Pay up to (₹ a year)", o.salary_max ?? "", 'type="number" min="0"')}<label class="full">Skills needed, separated by commas<input name="skills" value="${esc(JSON.parse(o.skills || "[]").join(", "))}" maxlength="600"></label>${input("min_score", "Flag candidates below this match (%)", o.min_score, 'type="number" min="0" max="100"')}<label class="check"><input type="checkbox" name="published" ${o.published ? "checked" : ""} ${o.approval_status === "approved" ? "" : "disabled"}> Show on the careers page</label>`,
    async (f) => {
      const num = (v) => (v === "" ? null : Number(v));
      await api(
        `/admin/openings/${id}/details`,
        {
          qualifications: f.qualifications,
          location: f.location,
          min_experience_years: num(f.min_experience_years),
          closing_date: f.closing_date || null,
          salary_min: num(f.salary_min),
          salary_max: num(f.salary_max),
          skills: f.skills,
          min_score: Number(f.min_score || 0),
          published: "published" in f,
        },
        "PATCH",
      );
      notice("Saved. Candidates were re-scored against the skills.");
    },
  );
}

// ---- manager: raise and follow requisitions ------------------------------------------------------
async function requisitionsPage(id) {
  const rows = await api("/requisitions/mine");
  if (id !== renderId) return;
  const STATUS = {
    pending_approval: "Waiting for HR",
    approved: "Approved",
    rejected: "Declined",
  };
  document.querySelector("#content").innerHTML =
    heading("Requisitions", "Ask for a new hire and follow its progress.") +
    `<div class="card"><div class="card-head"><div><h2>My requisitions</h2></div><button id="new-req">Raise a requisition</button></div>${
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Role</th><th>Positions</th><th>Status</th><th>Candidates</th><th>Filled</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.title)}${r.approval_note ? `<small>${esc(r.approval_note)}</small>` : ""}</td><td>${r.positions}</td><td><span class="pill ${r.approval_status === "approved" ? "" : "neutral"}">${STATUS[r.approval_status]}</span></td><td>${r.candidates}</td><td>${r.filled}</td></tr>`).join("")}</tbody></table></div>`
        : empty("No requisitions", "Raise one when you need to hire.")
    }</div>`;
  document.querySelector("#new-req").onclick = async () => {
    dialog(
      "Raise a job requisition",
      `${input("title", "Role", "", "required maxlength=100")}${input("positions", "Positions", 1, 'type="number" min="1" max="500"')}${sel("employment_type", "Employment type", Object.entries(EMPLOYMENT))}${input("min_experience_years", "Minimum experience (years)", "", 'type="number" min="0" step="0.5"')}${input("qualifications", "Qualifications", "", "maxlength=1000")}${input("salary_min", "Pay from (₹ a year)", "", 'type="number" min="0"')}${input("salary_max", "Pay up to (₹ a year)", "", 'type="number" min="0"')}<label class="full">Skills needed, separated by commas<input name="skills" maxlength="600"></label><label class="full">Why is this hire needed?<input name="justification" maxlength="1000" required></label>`,
      async (f) => {
        const body = {
          title: f.title,
          positions: Number(f.positions),
          employment_type: f.employment_type,
          justification: f.justification,
          skills: f.skills,
        };
        for (const k of ["min_experience_years", "salary_min", "salary_max"])
          if (f[k] !== "") body[k] = Number(f[k]);
        if (f.qualifications) body.qualifications = f.qualifications;
        const r = await api("/requisitions", body);
        notice(
          r.approval_status === "approved"
            ? "Opening created."
            : "Sent to HR for approval.",
        );
      },
    );
  };
}

// ---- interviews: panel scheduling, interviewer view, scorecard, question bank -----------------------
const Q_CATEGORY = {
  technical: "Technical",
  behavioural: "Behavioural",
  situational: "Situational",
  domain: "Domain-specific",
};
const Q_DIFFICULTY = { easy: "Easy", medium: "Medium", hard: "Hard" };
const TL_STATE = {
  upcoming: "Upcoming",
  partial: "Partly reviewed",
  complete: "All feedback in",
  feedback_overdue: "Feedback overdue",
  cancelled: "Cancelled",
};

async function interviewScheduleDialog(candidateId, onDone) {
  const people = await peopleList();
  dialog(
    "Schedule an interview",
    `${input("round_name", "Round", "Round 1", "required maxlength=60")}${input("scheduled_at", "Date and time", "", 'type="datetime-local" required')}${sel(
      "mode",
      "Mode",
      [
        ["in_person", "In person"],
        ["phone", "Phone"],
        ["video", "Video"],
      ],
    )}${input("duration_minutes", "Minutes", 60, 'type="number" min="10" max="480"')}<label class="full">Place or meeting link<input name="location" maxlength="300"></label><fieldset class="full"><legend>Panel (choose one or more)</legend><div class="panel-pick">${people.map((p) => `<label class="check"><input type="checkbox" name="iv_${p.id}"> ${esc(p.name)}${p.employee_code ? ` (${esc(p.employee_code)})` : ""}</label>`).join("")}</div></fieldset><p class="full muted">Four or five questions from your question bank for this department are chosen automatically. Panel members and the candidate get a calendar invite by email when email is set up.</p>`,
    async (f) => {
      const ids = Object.keys(f)
        .filter((k) => k.startsWith("iv_"))
        .map((k) => Number(k.slice(3)));
      if (!ids.length) throw new Error("Choose at least one panel member.");
      const r = await api(`/admin/candidates/${candidateId}/interviews`, {
        round_name: f.round_name,
        interviewer_ids: ids,
        scheduled_at: new Date(f.scheduled_at).toISOString(),
        mode: f.mode,
        duration_minutes: Number(f.duration_minutes),
        location: f.location || undefined,
      });
      notice(
        `Scheduled with ${ids.length} panel member(s). ${r.questions} suggested question(s) attached.`,
      );
      await onDone?.();
    },
  );
}

async function scorecardDialog(candidateId) {
  const [tl, card] = await Promise.all([
    api(`/admin/candidates/${candidateId}/interview-timeline`),
    api(`/admin/candidates/${candidateId}/scorecard`),
  ]);
  const REC_TEXT = {
    strong_yes: "Strong yes",
    yes: "Yes",
    no: "No",
    strong_no: "Strong no",
  };
  viewDialog(
    `Scorecard · ${card.candidate.name}`,
    `<p><strong>${esc(card.summary)}</strong>${card.overall_rating != null ? ` · average ${card.overall_rating}/5` : ""} · feedback ${card.feedback_given} of ${card.feedback_expected}</p>
    <h3>Timeline</h3>${tl.length ? tl.map((r) => `<div class="activity"><strong>${esc(r.round_name)}</strong> · ${new Date(r.scheduled_at).toLocaleString("en-IN")} · <span class="pill ${r.state === "complete" ? "" : "neutral"}">${TL_STATE[r.state]}</span><br>${r.panel.map((p) => `<small>${esc(p.name)}: ${p.status === "completed" ? `${p.rating}/5 · ${REC_TEXT[p.recommendation]}` : esc(p.status)}</small>`).join("<br>")}</div>`).join("") : '<p class="muted">No interviews yet.</p>'}
    <h3>Panel comments</h3>${
      card.rounds
        .map(
          (r) =>
            `<div class="activity"><strong>${esc(r.round_name)}</strong>${r.avg_rating != null ? ` · average ${r.avg_rating}/5` : ""}${r.panel
              .filter((p) => p.feedback)
              .map(
                (p) =>
                  `<br><small><strong>${esc(p.name)}</strong> (${p.rating}/5): ${esc(p.feedback)}</small>`,
              )
              .join("")}</div>`,
        )
        .join("") || '<p class="muted">Nothing yet.</p>'
    }
    ${card.question_scores.length ? `<h3>Question scores</h3><div class="table-wrap"><table><thead><tr><th>Question</th><th>Average</th></tr></thead><tbody>${card.question_scores.map((q) => `<tr><td>${esc(q.question)}<small>${Q_CATEGORY[q.category] || ""}</small></td><td>${q.avg_rating}/5</td></tr>`).join("")}</tbody></table></div>` : ""}`,
  );
}

// What an interviewer sees: the candidate, suggested questions, and the form to score them.
async function interviewDialog(id, onDone) {
  const i = await api(`/interviews/${id}`);
  const c = i.candidate;
  const done = i.status === "completed";
  viewDialog(
    `${i.round_name} · ${c.name}`,
    `<p class="muted">${new Date(i.scheduled_at).toLocaleString("en-IN")} · ${i.duration_minutes} min · ${esc(i.mode.replace("_", " "))}${i.location ? ` · ${esc(i.location)}` : ""}</p>
    <p>${i.opening ? `For <strong>${esc(i.opening.title)}</strong>. ` : ""}${i.panel.length > 1 ? `Panel: ${i.panel.map((p) => esc(p.name)).join(", ")}.` : ""}</p>
    <div class="actions"><a class="button secondary" href="/api/interviews/${id}/calendar.ics">Download calendar file</a><a class="button secondary" target="_blank" rel="noopener" href="${esc(i.calendar_link)}">Add to Google Calendar</a>${i.files.map((f) => `<button class="secondary" data-ifile="${f.id}">View ${esc(f.name)}</button>`).join("")}${c.resume_url ? `<a class="button secondary" target="_blank" rel="noopener noreferrer" href="${esc(c.resume_url)}">Resume link</a>` : ""}</div>
    <p>${c.qualification ? `${esc(c.qualification)} · ` : ""}${c.experience_years != null ? `${c.experience_years} yrs · ` : ""}${c.match_score != null ? `${c.match_score}% match · ` : ""}${c.skills.length ? `Skills: ${c.skills.map(esc).join(", ")}` : ""}</p>${c.notes ? `<p>${esc(c.notes)}</p>` : ""}
    <form id="iv-form"><h3>Suggested questions</h3>${i.questions.length ? i.questions.map((q) => `<div class="activity"><strong>${q.position}. ${esc(q.question)}</strong> <small>${Q_CATEGORY[q.category] || ""}</small><br>${done ? (q.rating ? `<small>Your score: ${q.rating}/5</small>` : "") : `<label class="inline">How well answered<select name="qs_${q.id}"><option value="">Not asked</option>${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}</select></label>`}</div>`).join("") : '<p class="muted">No questions were suggested. Add some under Hiring → Question bank.</p>'}
    ${
      done
        ? "<p>Feedback submitted. Thank you.</p>"
        : `<div class="form-grid"><label>Overall rating (5 is best)<select name="rating">${[1, 2, 3, 4, 5].map((n) => `<option value="${n}" ${n === 3 ? "selected" : ""}>${n}</option>`).join("")}</select></label><label>Recommendation<select name="recommendation">${Object.entries(
            REC,
          )
            .map(
              ([k, v]) =>
                `<option value="${k}" ${k === "yes" ? "selected" : ""}>${v}</option>`,
            )
            .join(
              "",
            )}</select></label><label class="full">Feedback<textarea name="feedback" rows="4" maxlength="2000" required></textarea></label></div><p class="error-text" id="iv-error" role="alert"></p><div class="actions"><button type="submit">Submit feedback</button></div>`
    }</form>`,
  );
  document
    .querySelectorAll("dialog [data-ifile]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          openFile(`/api/interviews/${id}/files/${b.dataset.ifile}`)),
    );
  const form = document.querySelector("dialog #iv-form");
  if (done) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    e.submitter.disabled = true;
    try {
      const f = Object.fromEntries(new FormData(form));
      const scores = Object.keys(f)
        .filter((k) => k.startsWith("qs_") && f[k])
        .map((k) => ({ id: Number(k.slice(3)), rating: Number(f[k]) }));
      await api(`/interviews/${id}/feedback`, {
        rating: Number(f.rating),
        recommendation: f.recommendation,
        feedback: f.feedback,
        scores,
      });
      document.querySelector("dialog")?.remove();
      notice("Feedback saved.");
      await onDone?.();
      render();
    } catch (err) {
      document.querySelector("dialog #iv-error").textContent = err.message;
      e.submitter.disabled = false;
    }
  };
}

let bankFilter = { department_id: "", category: "", q: "" };
async function questionBankHtml() {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(bankFilter)) if (v) qs.set(k, v);
  const [rows, org] = await Promise.all([
    api(`/admin/question-bank?${qs}`),
    api("/admin/org"),
  ]);
  hiringCache.depts = org.departments;
  return `<div class="card"><div class="card-head"><div><h2>Interview question bank</h2><p class="muted">When an interview is scheduled, four or five of these are chosen for the candidate's department and attached for the panel. Questions with no department apply everywhere.</p></div><div class="actions"><button class="secondary" id="import-q">Paste several</button><button id="new-q">Add a question</button></div></div>
  <div class="actions spaced"><label class="inline">Department<select id="bank-dept"><option value="">All</option><option value="none" ${bankFilter.department_id === "none" ? "selected" : ""}>General only</option>${org.departments.map((d) => `<option value="${d.id}" ${String(d.id) === bankFilter.department_id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label><label class="inline">Type<select id="bank-cat"><option value="">All</option>${Object.entries(
    Q_CATEGORY,
  )
    .map(
      ([k, v]) =>
        `<option value="${k}" ${k === bankFilter.category ? "selected" : ""}>${v}</option>`,
    )
    .join(
      "",
    )}</select></label><label class="inline">Search<input id="bank-q" value="${esc(bankFilter.q)}"></label></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Question</th><th>Department</th><th>Type</th><th>Level</th><th>Used</th><th>Avg score</th><th></th></tr></thead><tbody>${rows.map((q) => `<tr><td>${esc(q.question)}</td><td>${esc(q.department_name || "All")}</td><td>${Q_CATEGORY[q.category]}</td><td>${Q_DIFFICULTY[q.difficulty]}</td><td>${q.used}</td><td>${q.avg_rating ?? "—"}</td><td><button class="ghost" data-edit-q="${q.id}">Edit</button> <button class="ghost" data-archive-q="${q.id}">Archive</button></td></tr>`).join("")}</tbody></table></div>`
      : empty(
          "No questions",
          "Add questions by department so interviews start with a consistent set.",
        )
  }</div>`;
}
function questionFields(q = {}) {
  const depts = hiringCache.depts || [];
  return `<label class="full">Question<input name="question" value="${esc(q.question || "")}" maxlength="500" required></label><label>Department<select name="department_id"><option value="">All departments</option>${depts.map((d) => `<option value="${d.id}" ${d.id === q.department_id ? "selected" : ""}>${esc(d.name)}</option>`).join("")}</select></label>${sel("category", "Type", Object.entries(Q_CATEGORY), q.category || "technical")}${sel("difficulty", "Level", Object.entries(Q_DIFFICULTY), q.difficulty || "medium")}`;
}
async function questionBankWire() {
  const on = (s, fn) =>
    document.querySelector(s)?.addEventListener("click", fn);
  const refresh = () => {
    bankFilter = {
      department_id: document.querySelector("#bank-dept").value,
      category: document.querySelector("#bank-cat").value,
      q: document.querySelector("#bank-q").value.trim(),
    };
    render();
  };
  document.querySelector("#bank-dept").onchange = refresh;
  document.querySelector("#bank-cat").onchange = refresh;
  document.querySelector("#bank-q").onchange = refresh;
  const body = (f) => ({
    question: f.question,
    department_id: f.department_id ? Number(f.department_id) : null,
    category: f.category,
    difficulty: f.difficulty,
  });
  on("#new-q", () =>
    dialog("Add a question", questionFields(), async (f) => {
      await api("/admin/question-bank", body(f));
      notice("Added.");
    }),
  );
  on("#import-q", () =>
    dialog(
      "Paste questions",
      `<label class="full">One question per line<textarea name="text" rows="10" required></textarea></label><label>Department<select name="department_id"><option value="">All departments</option>${(hiringCache.depts || []).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join("")}</select></label>${sel("category", "Type", Object.entries(Q_CATEGORY))}${sel("difficulty", "Level", Object.entries(Q_DIFFICULTY), "medium")}`,
      async (f) => {
        const r = await api("/admin/question-bank/import", {
          text: f.text,
          department_id: f.department_id ? Number(f.department_id) : null,
          category: f.category,
          difficulty: f.difficulty,
        });
        notice(`${r.added} added, ${r.skipped} skipped (already there).`);
      },
    ),
  );
  document.querySelectorAll("[data-edit-q]").forEach((b) => {
    b.onclick = async () => {
      const q = (await api("/admin/question-bank?active=all")).find(
        (x) => x.id === Number(b.dataset.editQ),
      );
      dialog("Edit question", questionFields(q), async (f) => {
        await api(`/admin/question-bank/${q.id}`, body(f), "PATCH");
        notice("Saved.");
      });
    };
  });
  document.querySelectorAll("[data-archive-q]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(
            `/admin/question-bank/${b.dataset.archiveQ}`,
            { active: false },
            "PATCH",
          );
          render();
        })),
  );
}
async function interviewAnalyticsHtml() {
  const a = await api("/admin/interviews/analytics");
  const t = (head, rows) =>
    rows.length
      ? `<div class="table-wrap"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c ?? "—"}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
      : empty("No interviews yet", "Scores appear after panels give feedback.");
  return `<div class="card"><h2>Interview quality</h2><p class="muted">${a.interviews} interviews · ${a.feedback_rate ?? "—"}% have feedback · average rating ${a.avg_rating ?? "—"}/5</p><h3>By department</h3>${t(
    ["Department", "Interviews", "Feedback in", "Avg rating"],
    a.departments.map((d) => [
      esc(d.department),
      d.interviews,
      d.completed,
      d.avg_rating,
    ]),
  )}<h3>Panel consistency</h3><p class="muted">Deviation is how far a person's rating sits from the rest of the same panel's average (lower means more consistent).</p>${t(
    [
      "Interviewer",
      "Interviews",
      "Feedback in",
      "Avg rating given",
      "Avg deviation",
    ],
    a.panelists.map((p) => [
      esc(p.name),
      p.scheduled,
      p.completed,
      p.avg_rating,
      p.avg_deviation,
    ]),
  )}<h3>Question effectiveness</h3>${t(
    ["Question", "Department", "Times used", "Scored", "Avg score"],
    a.questions.map((q) => [
      esc(q.question),
      esc(q.department),
      q.used,
      q.scored,
      q.avg_rating,
    ]),
  )}</div>`;
}

// ---- credit (CIBIL) checks ---------------------------------------------------------------------------
const RISK_PILL = { low: "", medium: "neutral", high: "danger" };
const riskPill = (r) =>
  r.risk
    ? `<span class="pill ${RISK_PILL[r.risk]}">${r.score} · ${{ low: "Low risk", medium: "Medium risk", high: "High risk" }[r.risk]}</span>`
    : r.status === "failed"
      ? '<span class="pill neutral">Failed</span>'
      : "—";

function creditPanelHtml(cr) {
  if (!cr.enabled) return "";
  return `<h3>Credit check (${esc(cr.bureau)})</h3><p class="muted">${
    cr.consent
      ? `Consent ${cr.consent.source === "portal" ? `given online by ${esc(cr.consent.given_name)}` : `recorded by HR (${esc(cr.consent.note)})`} on ${time(cr.consent.given_at)}.`
      : "No consent yet. The candidate can give it from their joining link, or you can record consent taken offline."
  }</p>${cr.checks
    .map(
      (k) =>
        `<div class="activity">${riskPill(k)} <small>${k.status === "manual" ? "Entered by hand" : k.status === "failed" ? esc(k.error || "") : "From the bureau"} · ${time(k.requested_at)}${k.requested_by_name ? ` · ${esc(k.requested_by_name)}` : ""}${k.pan_last4 ? ` · PAN ••••${esc(k.pan_last4)}` : ""}${k.note ? ` · ${esc(k.note)}` : ""}</small>${k.has_report ? ` <button class="ghost" data-credit-report="${k.id}">View report</button>` : ""}</div>`,
    )
    .join(
      "",
    )}<div class="actions spaced">${cr.consent ? `<button class="secondary" id="credit-run">${cr.automatic ? "Check with the bureau" : "Enter the score"}</button>${cr.automatic ? '<button class="ghost" id="credit-manual">Enter score by hand</button>' : ""}` : '<button class="secondary" id="credit-consent">Record consent taken offline</button>'}</div>`;
}
function wireCredit(id, cr, reopen) {
  if (!cr?.enabled) return;
  const on = (s, fn) =>
    document.querySelector(`dialog ${s}`)?.addEventListener("click", fn);
  const manual = () =>
    dialog(
      "Enter the credit score",
      `${input("manual_score", "Score from the bureau report (300–900)", "", 'type="number" min="300" max="900" required')}${input("note", "Note (e.g. report date)", "", "maxlength=500")}`,
      async (f) => {
        const r = await api(`/admin/candidates/${id}/credit-check`, {
          manual_score: Number(f.manual_score),
          note: f.note || undefined,
        });
        notice(`Recorded: ${r.risk_label}.`);
      },
    );
  on("#credit-manual", manual);
  on("#credit-run", () => {
    if (!cr.automatic) return manual();
    dialog(
      "Check with the bureau",
      `${input("pan", "Candidate's PAN (leave empty to use the one they entered)", "", 'maxlength=10 autocapitalize="characters"')}${input("dob", "Date of birth (if your bureau needs it)", "", 'type="date"')}<p class="full muted">The request is made from the server and recorded in the audit log.</p>`,
      async (f) => {
        try {
          const r = await api(`/admin/candidates/${id}/credit-check`, {
            pan: f.pan || undefined,
            dob: f.dob || undefined,
          });
          notice(`${r.risk_label}: ${r.score}.`);
        } catch (e) {
          throw e;
        }
      },
    );
  });
  on("#credit-consent", () =>
    dialog(
      "Record consent",
      '<label class="full">How was consent obtained? (form, email, date)<input name="note" maxlength="300" required></label>',
      async (f) => {
        await api(`/admin/candidates/${id}/credit-consent`, { note: f.note });
        notice("Consent recorded.");
      },
    ),
  );
  document.querySelectorAll("dialog [data-credit-report]").forEach((b) => {
    b.onclick = async () => {
      const r = await api(
        `/admin/credit-checks/${b.dataset.creditReport}/report`,
      );
      viewDialog(
        "Bureau report",
        `<p class="muted">Viewing is recorded in the audit log.</p><pre class="report">${esc(JSON.stringify(r, null, 2))}</pre>`,
      );
    };
  });
}

async function creditTabHtml() {
  const [d, s, log] = await Promise.all([
    api("/admin/credit-checks"),
    api("/admin/credit/settings"),
    api("/admin/credit/audit"),
  ]);
  const stat = (l, v) =>
    `<div class="stat"><div class="stat-label">${l}</div><div class="stat-value">${v}</div></div>`;
  return `<div class="stats">${stat("Low risk", d.summary.low)}${stat("Medium risk", d.summary.medium)}${stat("High risk", d.summary.high)}${stat("Awaiting consent", d.summary.awaiting_consent)}${stat("Consent given, not checked", d.summary.not_checked)}</div>
  <div class="card"><div class="card-head"><div><h2>Credit checks</h2><p class="muted">${s.enabled ? `On. ${s.url ? "Connected to your bureau API." : "No bureau connection: HR enters the score from the bureau's report."} ${s.required_before_hire ? "A check is required before hiring." : ""}` : "Off. Turn it on in Settings."}</p></div><button class="secondary" id="credit-settings">Settings</button></div>${
    d.rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Stage</th><th>Consent</th><th>Result</th><th>Checked</th><th></th></tr></thead><tbody>${d.rows.map((r) => `<tr><td>${esc(r.name)}<small>${esc(r.opening_title || "")}</small></td><td>${stagePill(r.stage)}</td><td>${r.consent_at ? `<span class="pill">${r.consent_source === "portal" ? "Given" : "Recorded"}</span>` : '<span class="pill neutral">Waiting</span>'}</td><td>${riskPill({ risk: r.risk, score: r.score, status: r.status })}</td><td>${r.requested_at ? time(r.requested_at) : "—"}</td><td><button class="secondary" data-cand="${r.candidate_id}">Open</button></td></tr>`).join("")}</tbody></table></div>`
      : empty(
          "No candidates yet",
          "Candidates at the interview or offer stage appear here.",
        )
  }</div>
  <div class="card"><h2>Audit log</h2>${log.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${log.map((a) => `<tr><td>${time(a.created_at)}</td><td>${esc(a.actor_name || "Candidate")}</td><td>${esc(a.action.replaceAll("_", " "))}<small>${esc(a.detail)}</small></td></tr>`).join("")}</tbody></table></div>` : empty("Nothing yet", "Every consent, check and report view is recorded here.")}</div>`;
}
async function creditTabWire() {
  document
    .querySelectorAll("[data-cand]")
    .forEach((b) => (b.onclick = () => candidateView(Number(b.dataset.cand))));
  document.querySelector("#credit-settings").onclick = async () => {
    const s = await api("/admin/credit/settings");
    dialog(
      "Credit check settings",
      `<label class="check full"><input type="checkbox" name="enabled" ${s.enabled ? "checked" : ""}> Ask candidates for consent and allow credit checks</label><label class="check full"><input type="checkbox" name="required_before_hire" ${s.required_before_hire ? "checked" : ""}> Require a check before a candidate can be hired</label>${input("provider_name", "Bureau name", s.provider_name, "maxlength=40")}${input("low_min", "Low risk from score", s.low_min, 'type="number" min="300" max="900"')}${input("medium_min", "Medium risk from score", s.medium_min, 'type="number" min="300" max="900"')}<label class="full">Consent wording shown to the candidate<textarea name="consent_text" rows="4" maxlength="2000">${esc(s.consent_text)}</textarea></label><h3 class="full">Bureau API (optional)</h3><p class="full muted">Your bureau or its integration partner gives you the address, key and request format. Leave empty to enter scores by hand. The address must be a public https website.</p>${input("url", "API address", s.url || "", 'type="url" maxlength=500')}${sel(
        "method",
        "Method",
        [
          ["POST", "POST"],
          ["GET", "GET"],
        ],
        s.method,
      )}${input("auth_header", "Header that carries the key", s.auth_header, "maxlength=60")}${input("api_key", s.api_key_set ? "API key (saved — type to replace)" : "API key", "", 'type="password" autocomplete="off"')}<label class="full">Request body (JSON; you can use {{pan}}, {{name}}, {{dob}}, {{phone}})<textarea name="body_template" rows="3" maxlength="2000">${esc(s.body_template || "")}</textarea></label>${input("score_path", "Where the score is in the answer (e.g. data.score)", s.score_path, "maxlength=100")}${s.encryption_configured ? "" : '<p class="error-text full">The server has no DATA_ENCRYPTION_KEY, so the API key cannot be saved.</p>'}`,
      async (f) => {
        const body = {
          enabled: "enabled" in f,
          required_before_hire: "required_before_hire" in f,
          provider_name: f.provider_name,
          low_min: Number(f.low_min),
          medium_min: Number(f.medium_min),
          consent_text: f.consent_text,
          url: f.url,
          method: f.method,
          auth_header: f.auth_header,
          body_template: f.body_template,
          score_path: f.score_path,
        };
        if (f.api_key) body.api_key = f.api_key;
        await api("/admin/credit/settings", body, "PUT");
        notice("Saved.");
      },
    );
  };
}

// ---- onboarding: readiness, team owners, joining documents ---------------------------------------
function readinessCard(rows) {
  return `<div class="card"><div class="card-head"><div><h2>New joiner readiness</h2><p class="muted">Everyone who joined in the last 60 days: documents, policies, tasks, assets and training at a glance.</p></div></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Joined</th><th>Documents verified</th><th>Policies signed</th><th>Tasks</th><th>Assets</th><th>Training</th><th>Buddy</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.name)}<small>${esc(r.employee_code || "")}</small></td><td>${fmtDate(r.date_of_joining)}</td><td>${r.docs ? `${r.docs_verified} of ${r.docs}` : "—"}</td><td>${r.policies_signed || "—"}</td><td>${r.tasks_done} of ${r.tasks}</td><td>${r.assets || "—"}</td><td>${r.trainings ? `${r.trainings_done} of ${r.trainings}` : "—"}</td><td>${esc(r.buddy_name || "—")}</td></tr>`).join("")}</tbody></table></div>`
      : empty("No recent joiners", "People you hire appear here.")
  }</div>`;
}
function ownersCard(owners) {
  const GROUPS = { it: "IT", finance: "Finance", admin: "Admin" };
  return `<div class="card"><div class="card-head"><div><h2>Who handles joining tasks</h2><p class="muted">When someone is hired, these teams are told what is waiting for them (laptop and accounts, payroll and bank advice, ID card and desk). They see and tick their tasks under Approvals.</p></div></div>${Object.entries(
    GROUPS,
  )
    .map(
      ([k, l]) =>
        `<div class="activity"><strong>${l}</strong>: ${owners[k].length ? owners[k].map((p) => esc(p.name)).join(", ") : '<span class="muted">nobody yet</span>'} <button class="ghost" data-owners="${k}">Change</button></div>`,
    )
    .join("")}</div>`;
}
function joiningDocsCard(rows) {
  return `<div class="card"><div class="card-head"><div><h2>Joining documents</h2><p class="muted">NDA and policies candidates read and sign on their joining link before day one. Each signature records their typed name, time and address, and keeps the text as it was when signed.</p></div><button id="new-joining-doc">Add a document</button></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Type</th><th>Required</th><th>Signed</th><th></th></tr></thead><tbody>${rows.map((d) => `<tr><td>${esc(d.title)}${d.active ? "" : ' <span class="pill neutral">Off</span>'}</td><td>${{ nda: "NDA", policy: "Policy", other: "Other" }[d.kind]}</td><td>${d.required ? "Yes" : "No"}</td><td>${d.signed}</td><td><button class="ghost" data-edit-jdoc="${d.id}">Edit</button> <button class="ghost" data-toggle-jdoc="${d.id}" data-active="${d.active ? 0 : 1}">${d.active ? "Turn off" : "Turn on"}</button></td></tr>`).join("")}</tbody></table></div>`
      : empty("No documents", "Add your NDA and policy acknowledgements.")
  }</div>`;
}
function jdocFields(d = {}) {
  return `${input("title", "Title", d.title || "", "required maxlength=150")}${sel(
    "kind",
    "Type",
    [
      ["nda", "NDA"],
      ["policy", "Policy"],
      ["other", "Other"],
    ],
    d.kind || "policy",
  )}<label class="full">Text the candidate reads<textarea name="body" rows="10" required maxlength="20000">${esc(d.body || "")}</textarea></label><label class="check"><input type="checkbox" name="required" ${d.required === 0 ? "" : "checked"}> Required before they can submit their joining details</label>`;
}
function onboardingPlusWire() {
  document.querySelectorAll("[data-owners]").forEach((b) => {
    b.onclick = async () => {
      const [people, owners] = await Promise.all([
        peopleList(),
        api("/admin/onboarding/owners"),
      ]);
      const group = b.dataset.owners;
      const chosen = new Set(owners[group].map((p) => p.id));
      dialog(
        `People who handle ${{ it: "IT", finance: "Finance", admin: "Admin" }[group]} tasks`,
        `<fieldset class="full"><legend>Choose one or more</legend><div class="panel-pick">${people.map((p) => `<label class="check"><input type="checkbox" name="u_${p.id}" ${chosen.has(p.id) ? "checked" : ""}> ${esc(p.name)}${p.employee_code ? ` (${esc(p.employee_code)})` : ""}</label>`).join("")}</div></fieldset>`,
        async (f) => {
          const ids = Object.keys(f)
            .filter((k) => k.startsWith("u_"))
            .map((k) => Number(k.slice(2)));
          await api(
            `/admin/onboarding/owners/${group}`,
            { user_ids: ids },
            "PUT",
          );
          notice("Saved.");
        },
      );
    };
  });
  document.querySelector("#new-joining-doc")?.addEventListener("click", () =>
    dialog("Add a joining document", jdocFields(), async (f) => {
      await api("/admin/joining-documents", {
        title: f.title,
        kind: f.kind,
        body: f.body,
        required: "required" in f,
      });
      notice("Added.");
    }),
  );
  document.querySelectorAll("[data-edit-jdoc]").forEach((b) => {
    b.onclick = async () => {
      const d = (await api("/admin/joining-documents")).find(
        (x) => x.id === Number(b.dataset.editJdoc),
      );
      dialog(`Edit · ${d.title}`, jdocFields(d), async (f) => {
        await api(
          `/admin/joining-documents/${d.id}`,
          {
            title: f.title,
            kind: f.kind,
            body: f.body,
            required: "required" in f,
          },
          "PATCH",
        );
        notice("Saved. People who already signed keep the text they signed.");
      });
    };
  });
  document.querySelectorAll("[data-toggle-jdoc]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(
            `/admin/joining-documents/${b.dataset.toggleJdoc}`,
            { active: b.dataset.active === "1" },
            "PATCH",
          );
          render();
        })),
  );
}
