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
    <div class="card"><h2>Open positions</h2>${a.open_positions.length ? `<div class="table-wrap"><table><thead><tr><th>Role</th><th>Days open</th><th>Positions</th><th>In process</th><th>Filled</th></tr></thead><tbody>${a.open_positions.map((o) => `<tr><td>${esc(o.title)}</td><td>${o.days_open}</td><td>${o.positions}</td><td>${o.candidates}</td><td>${o.filled}</td></tr>`).join("")}</tbody></table></div>` : empty("Nothing open", "Open positions appear here.")}</div>`;
  }
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
