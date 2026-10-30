// ---- RMS, further: bulk moves in the inbox, talent pool, hiring report, source settings,
// interview slots for the candidate to pick, screening questions on a job ----
const BULK_STAGES = { screening: "Shortlist", interview: "Move to interview", rejected: "Reject" };
const rmsState = { talent: { q: "", skills: "", location: "", min_exp: "", max_exp: "", stage: "", page: 0 }, report: { from: "", to: "" } };

async function rmsExtras(id, src, openings, job) {
  if (id !== renderId) return;
  // Bulk: a checkbox on each inbox row and a bar of actions.
  const inboxTable = job ? [...document.querySelectorAll("#content .card")].find((c) => c.textContent.includes("resume inbox"))?.querySelector("table") : null;
  if (inboxTable) {
    inboxTable.querySelector("thead tr").insertAdjacentHTML("afterbegin", '<th><input type="checkbox" id="bulk-all" aria-label="Select all"></th>');
    inboxTable.querySelectorAll("tbody tr").forEach((tr) => {
      const cid = tr.querySelector("[data-cand-open]")?.dataset.candOpen;
      tr.insertAdjacentHTML("afterbegin", `<td>${cid ? `<input type="checkbox" data-bulk="${cid}" aria-label="Select">` : ""}</td>`);
    });
    inboxTable.closest(".table-wrap").insertAdjacentHTML(
      "beforebegin",
      `<div class="pl-bar" id="bulk-bar"><span class="muted" id="bulk-n">0 selected</span>${Object.entries(BULK_STAGES).map(([k, l]) => `<button type="button" class="${k === "rejected" ? "ghost" : "secondary"}" data-bulk-go="${k}" disabled>${l}</button>`).join("")}</div>`,
    );
    const boxes = () => [...inboxTable.querySelectorAll("[data-bulk]")];
    const update = () => {
      const n = boxes().filter((b) => b.checked).length;
      document.querySelector("#bulk-n").textContent = `${n} selected`;
      document.querySelectorAll("[data-bulk-go]").forEach((b) => (b.disabled = !n));
    };
    inboxTable.addEventListener("change", (e) => {
      if (e.target.id === "bulk-all") boxes().forEach((b) => (b.checked = e.target.checked));
      update();
    });
    document.querySelectorAll("[data-bulk-go]").forEach((b) =>
      b.addEventListener("click", () => {
        const ids = boxes().filter((x) => x.checked).map((x) => Number(x.dataset.bulk));
        const stage = b.dataset.bulkGo;
        const go = async (reason) => {
          const r = await api("/admin/candidates/bulk", { ids, stage, ...(reason ? { reason } : {}) });
          const failed = r.results.filter((x) => !x.ok);
          notice(`${r.moved} moved.${failed.length ? ` ${failed.length} not moved: ${failed[0].error}` : ""}`, failed.length > 0);
        };
        if (stage === "rejected")
          dialog(`Reject ${ids.length} candidate(s)`, '<label class="full">Reason (they are told by email)<input name="reason" maxlength="300" required></label>', (f) => go(f.reason));
        else busy(b, async () => (await go(), render()));
      }),
    );
  }

  // Source settings: costs for cost per hire, default job, mailbox, agency portal link.
  document.querySelectorAll("[data-src-toggle]").forEach((b) => {
    const s = src.items.find((x) => x.id === Number(b.dataset.srcToggle));
    b.insertAdjacentHTML("beforebegin", `<button class="ghost" data-src-set="${s.id}">Settings</button> `);
    if (s.last_error) b.closest("tr").querySelector("td").insertAdjacentHTML("beforeend", `<small class="error-text">${esc(s.last_error)}</small>`);
    if (s.mailbox) b.closest("tr").querySelector("td").insertAdjacentHTML("beforeend", `<small>Mailbox: ${esc(s.mailbox.user)}</small>`);
  });
  document.querySelectorAll("[data-src-set]").forEach((b) =>
    b.addEventListener("click", () => {
      const s = src.items.find((x) => x.id === Number(b.dataset.srcSet));
      const jobs = [["", "None: the message must name the job (J12)"], ...openings.filter((o) => o.status !== "closed").map((o) => [o.id, `J${o.id} · ${o.title}`])];
      dialog(
        `${s.name} · settings`,
        `${input("fee_per_hire", "Fee per hire (₹)", s.fee_per_hire ?? 0, 'type="number" min="0"')}${input("monthly_cost", "Monthly cost (₹, e.g. a job-board plan)", s.monthly_cost ?? 0, 'type="number" min="0"')}${sel("default_opening_id", "Default job for resumes that do not name one", jobs, s.default_opening_id ?? "")}${
          s.kind === "email"
            ? `<h3 class="full">Mailbox to read (IMAP)</h3><p class="full muted">Resumes emailed here are read every 5 minutes. Gmail and Google Workspace: use imap.gmail.com, port 993 and an app password. Microsoft 365 no longer allows passwords for IMAP: forward that mailbox to one that does.</p>${input("host", "Server", s.mailbox?.host ?? "", 'placeholder="imap.gmail.com"')}${input("port", "Port", 993, 'type="number" min="1" max="65535"')}${input("user", "Mailbox", s.mailbox?.user ?? "", 'placeholder="careers@lifc.in"')}${input("password", "Password or app password", "", 'type="password" autocomplete="new-password" placeholder="Leave empty to keep"')}<label class="check full"><input type="checkbox" name="check" value="1"> Read the mailbox now</label>`
            : ""
        }${
          s.kind === "whatsapp"
            ? `<p class="full muted">WhatsApp: in your Meta app, set the webhook to <code>${esc(location.origin)}/api/whatsapp/webhook</code> with the verify token you put in WHATSAPP_VERIFY_TOKEN, and subscribe to messages. Candidates send their CV with the job code (J12) in the message.</p>`
            : ""
        }${s.kind === "agency" ? '<p class="full muted">The agency uses its portal link, shown once when the source was added. To give a new link, add a new agency source and switch this one off.</p>' : ""}`,
        async (f) => {
          await api(`/admin/rms/sources/${s.id}/costs`, { fee_per_hire: Number(f.fee_per_hire || 0), monthly_cost: Number(f.monthly_cost || 0), default_opening_id: f.default_opening_id ? Number(f.default_opening_id) : null }, "PATCH");
          if (s.kind === "email" && f.host && f.user && f.password)
            await api(`/admin/rms/sources/${s.id}/mailbox`, { host: f.host, port: Number(f.port || 993), user: f.user, password: f.password }, "PUT");
          if (f.check === "1") {
            const r = await api(`/admin/rms/sources/${s.id}/mailbox/check`, {});
            notice(`Read ${r.messages} new message(s): ${r.taken} resume(s) taken, ${r.skipped} without a job or a resume.`);
          } else notice("Saved.");
        },
      );
    }),
  );

  await talentCard(id, openings);
  await reportCard(id);
}

async function talentCard(id, openings) {
  const st = rmsState.talent;
  const params = new URLSearchParams(Object.entries(st).filter(([, v]) => v !== "" && v !== 0));
  if (st.page) params.set("page", st.page);
  const d = await api(`/admin/rms/talent?${params}`);
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card";
  card.id = "talent";
  const pages = Math.max(1, Math.ceil(d.total / d.page_size));
  const jobOpts = openings.filter((o) => o.status !== "closed").map((o) => `<option value="${o.id}">J${o.id} · ${esc(o.title)}</option>`).join("");
  card.innerHTML = `<h2>Talent pool</h2><p class="muted">Every candidate on every job, past and present. Find people for a new job and add them in one click.</p>
    <form id="tp-form" class="filters">${input("q", "Words (name, skill, anything in the resume)", st.q)}${input("skills", "Skills (comma separated)", st.skills)}${input("location", "City", st.location)}${input("min_exp", "Experience from", st.min_exp, 'type="number" min="0" max="60" step="0.5"')}${input("max_exp", "to", st.max_exp, 'type="number" min="0" max="60" step="0.5"')}${sel("stage", "Stage", [["", "Any"], ["open", "In a pipeline now"], ["rejected", "Not selected"], ["withdrawn", "Withdrawn"], ["hired", "Hired"]], st.stage)}<button>Search</button></form>
    <p class="muted">${d.total.toLocaleString("en-IN")} candidate(s)${pages > 1 ? ` · page ${d.page + 1} of ${pages}` : ""}</p>${
      d.rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Candidate</th><th>Skills</th><th>Experience</th><th>Last job</th><th>Stage</th><th></th></tr></thead><tbody>${d.rows
            .map(
              (r) =>
                `<tr><td><strong>${esc(r.name)}</strong><small>${esc(r.phone || "")} ${esc(r.email || "")}${r.location ? ` · ${esc(r.location)}` : ""}</small></td><td>${r.skills.slice(0, 5).map((s) => `<span class="pill neutral">${esc(s)}</span>`).join(" ")}</td><td>${r.experience_years ?? "—"}</td><td>${esc(r.opening_title || "—")}<small>${esc(r.source || "")}</small></td><td>${stagePill(r.stage)}</td><td>${r.resume_id ? `<a class="button secondary" href="/api/admin/candidate-files/${r.resume_id}" target="_blank" rel="noopener">Resume</a> ` : ""}<button class="ghost" data-cand-open="${r.id}">Open</button> ${jobOpts ? `<select data-tp-job="${r.id}" aria-label="Add to job"><option value="">Add to job…</option>${jobOpts}</select>` : ""}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty("Nobody found", "Try fewer words or a wider experience range.")
    }${pages > 1 ? `<div class="actions"><button class="ghost" id="tp-prev" ${d.page ? "" : "disabled"}>← Previous</button><button class="ghost" id="tp-next" ${d.page + 1 < pages ? "" : "disabled"}>Next →</button></div>` : ""}`;
  document.querySelector("#content").append(card);
  card.querySelector("#tp-form").onsubmit = (e) => {
    e.preventDefault();
    Object.assign(st, Object.fromEntries(new FormData(e.target)), { page: 0 });
    render();
  };
  card.querySelector("#tp-prev")?.addEventListener("click", () => (st.page--, render()));
  card.querySelector("#tp-next")?.addEventListener("click", () => (st.page++, render()));
  card.querySelectorAll("[data-cand-open]").forEach((b) => (b.onclick = () => candidateView(Number(b.dataset.candOpen))));
  card.querySelectorAll("[data-tp-job]").forEach((s) =>
    s.addEventListener("change", async () => {
      if (!s.value) return;
      try {
        await api(`/admin/candidates/${s.dataset.tpJob}/copy`, { opening_id: Number(s.value) });
        notice("Added to the job, with their resume.");
      } catch (e) {
        notice(e.message, true);
      }
      s.value = "";
    }),
  );
}

async function reportCard(id) {
  const st = rmsState.report;
  const d = await api(`/admin/rms/report?${new URLSearchParams(Object.entries(st).filter(([, v]) => v))}`);
  if (id !== renderId) return;
  const inr = (n) => (n == null ? "—" : `₹${new Intl.NumberFormat("en-IN").format(n)}`);
  const table = (title, rows, cost) =>
    `<h3>${title}</h3>${
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>${title.replace("By ", "")}</th><th>Received</th><th>Shortlisted</th><th>Interviewed</th><th>Offered</th><th>Hired</th><th>Hire rate</th><th>Days to hire</th>${cost ? "<th>Cost</th><th>Cost per hire</th>" : ""}</tr></thead><tbody>${rows
            .map(
              (r) =>
                `<tr><td>${esc(r.name)}</td><td>${r.received}</td><td>${r.shortlisted}</td><td>${r.interviewed}</td><td>${r.offered}</td><td><strong>${r.hired}</strong></td><td>${r.conversion}%</td><td>${r.avg_days_to_hire ?? "—"}</td>${cost ? `<td>${inr(r.cost)}</td><td>${inr(r.cost_per_hire)}</td>` : ""}</tr>`,
            )
            .join("")}</tbody></table></div>`
        : '<p class="muted">No candidates in this period.</p>'
    }`;
  const card = document.createElement("div");
  card.className = "card";
  card.innerHTML = `<div class="card-head"><div><h2>Hiring report</h2><p class="muted">${d.total} candidate(s) received from ${fmtDate(d.from)} to ${fmtDate(d.to)}. Costs come from each source's settings (monthly cost and fee per hire).</p></div></div>
    <form id="rp-form" class="filters">${input("from", "From", d.from, 'type="date"')}${input("to", "To", d.to, 'type="date"')}<button>Show</button></form>
    ${table("By source", d.by_source, true)}${table("By branch", d.by_branch)}${table("By recruiter", d.by_recruiter)}`;
  document.querySelector("#content").append(card);
  card.querySelector("#rp-form").onsubmit = (e) => {
    e.preventDefault();
    Object.assign(st, Object.fromEntries(new FormData(e.target)));
    render();
  };
}

// The candidate window gets "Send time slots": the candidate picks the interview time.
const plainCandidateView = candidateView;
candidateView = async function (cid) {
  await plainCandidateView(cid);
  const sched = document.querySelector("dialog #sched");
  if (!sched) return;
  sched.insertAdjacentHTML("afterend", '<button class="secondary" id="send-slots">Let them pick a time</button>');
  document.querySelector("dialog #send-slots").onclick = async () => {
    const people = (await api("/admin/employees?limit=200")).items;
    const slotRow = (i) => input(`slot${i}`, `Time ${i + 1}`, "", `type="datetime-local" ${i === 0 ? "required" : ""}`);
    dialog(
      "Send interview times to choose from",
      `${input("round_name", "Round", "Interview", 'maxlength="60" required')}${sel("mode", "Mode", [["in_person", "In person"], ["video", "Video"], ["phone", "Phone"]])}${input("location", "Place or meeting link", "", 'maxlength="300"')}${input("duration_minutes", "Minutes", 45, 'type="number" min="10" max="480"')}<label class="full">Interviewers<select name="ivs" multiple size="5" required>${people.map((p) => `<option value="${p.id}">${esc(p.name)}${p.designation_name ? ` · ${esc(p.designation_name)}` : ""}</option>`).join("")}</select></label>${[0, 1, 2, 3, 4, 5].map(slotRow).join("")}<p class="full muted">The candidate gets a one-time link by email and picks one; times when an interviewer is already booked are hidden.</p>`,
      async (f) => {
        const slots = [0, 1, 2, 3, 4, 5].map((i) => f[`slot${i}`]).filter(Boolean).map((v) => new Date(v).toISOString());
        const ivs = [...document.querySelectorAll('dialog select[name="ivs"] option:checked')].map((o) => Number(o.value));
        await api(`/admin/candidates/${cid}/interview-invites`, { round_name: f.round_name, mode: f.mode, location: f.location || null, duration_minutes: Number(f.duration_minutes), interviewer_ids: ivs, slots });
        notice("Sent. You will be told when they choose a time.");
      },
    );
  };
};

// Job details get "Screening questions": asked on the careers page; a knock-out answer rejects.
const plainOpeningDetails = openingDetailsDialog;
openingDetailsDialog = async function (oid) {
  await plainOpeningDetails(oid);
  const actions = document.querySelector("dialog .form-actions");
  if (!actions) return;
  actions.insertAdjacentHTML("afterbegin", '<button type="button" class="ghost" id="screening-edit">Screening questions</button>');
  document.querySelector("dialog #screening-edit").onclick = async () => {
    const o = (await api("/admin/openings")).find((x) => x.id === oid);
    const qs = JSON.parse(o.screening || "[]");
    const row = (q, i) =>
      `<div class="sv-row" data-sq="${i}"><select data-k="type" aria-label="Type">${[["yes_no", "Yes / No"], ["number", "Number"], ["choice", "Choice"]].map(([k, l]) => `<option value="${k}" ${q.type === k ? "selected" : ""}>${l}</option>`).join("")}</select><input data-k="text" value="${esc(q.text ?? "")}" maxlength="200" placeholder="Question, e.g. Do you have a two-wheeler licence?"><input data-k="options" value="${esc((q.options ?? []).join(", "))}" placeholder="Choices (for Choice), comma separated"><input data-k="ko" value="${esc(q.knockout ? (q.knockout.equals ?? (q.knockout.min !== undefined ? `>=${q.knockout.min}` : `<=${q.knockout.max}`)) : "")}" placeholder="Knock-out: no / >=2 / <=40 / a choice"><button type="button" class="ghost" data-sq-drop="${i}">✕</button></div>`;
    dialog(
      `Screening questions · ${o.title}`,
      `<p class="full muted">Asked on the careers page. A knock-out rejects the application at once with a polite email: for Yes/No write the answer that knocks out (e.g. "no"); for numbers ">=2" (must be at least 2) or "<=40"; for a choice, the choice that knocks out.</p><div class="full" id="sq-rows">${(qs.length ? qs : [{ type: "yes_no", text: "" }]).map(row).join("")}</div><div class="full"><button type="button" class="secondary" id="sq-add">+ Add question</button></div>`,
      async () => {
        const list = [...document.querySelectorAll("dialog [data-sq]")]
          .map((r) => {
            const v = (k) => r.querySelector(`[data-k="${k}"]`).value.trim();
            const type = v("type"),
              ko = v("ko");
            if (!v("text")) return null;
            const knockout = !ko ? undefined : type === "number" ? (ko.startsWith("<=") ? { max: Number(ko.slice(2)) } : { min: Number(ko.replace(/^>=/, "")) }) : { equals: ko.toLowerCase() === "yes" || ko.toLowerCase() === "no" ? ko.toLowerCase() : ko };
            return { type, text: v("text"), ...(type === "choice" ? { options: v("options").split(",").map((x) => x.trim()).filter(Boolean) } : {}), ...(knockout ? { knockout } : {}) };
          })
          .filter(Boolean);
        await api(`/admin/openings/${oid}/details`, { screening: list }, "PATCH");
        notice("Screening questions saved.");
      },
    );
    document.querySelector("dialog #sq-add").onclick = () =>
      document.querySelector("dialog #sq-rows").insertAdjacentHTML("beforeend", row({ type: "yes_no" }, document.querySelectorAll("dialog [data-sq]").length));
    document.querySelector("dialog #sq-rows").addEventListener("click", (e) => e.target.closest("[data-sq-drop]")?.closest("[data-sq]").remove());
  };
};
