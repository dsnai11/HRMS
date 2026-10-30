// ---- Surveys: answering (everyone) and running them with anonymous results (HR) ----
const SURVEY_TYPES = { enps: "eNPS (0–10)", rating: "Rating (1–5)", choice: "Choice", text: "Comment" };
const surveyForm = (s) =>
  `<form id="survey-form" class="form-grid">${s.intro ? `<p class="full">${esc(s.intro)}</p>` : ""}${s.questions
    .map((q) => {
      const scale = (from, to, low, high) =>
        `<div class="scale" role="radiogroup" aria-label="${esc(q.text)}">${Array.from({ length: to - from + 1 }, (_, i) => from + i)
          .map((n) => `<label class="scale-pick"><input type="radio" name="${q.id}" value="${n}" required><span>${n}</span></label>`)
          .join("")}</div><small class="muted">${low} … ${high}</small>`;
      const body =
        q.type === "enps"
          ? scale(0, 10, "Not at all", "Definitely")
          : q.type === "rating"
            ? scale(1, 5, "Strongly disagree", "Strongly agree")
            : q.type === "choice"
              ? q.options.map((o) => `<label class="check"><input type="radio" name="${q.id}" value="${esc(o)}" required> ${esc(o)}</label>`).join("")
              : `<textarea name="${q.id}" rows="3" maxlength="1000" placeholder="Optional"></textarea>`;
      return `<fieldset class="full survey-q"><legend>${esc(q.text)}</legend>${body}</fieldset>`;
    })
    .join("")}<p class="full muted">Your answers are anonymous: they are stored without your name, and results are shown only when at least 5 people have answered.</p><div class="actions full"><button>Send answers</button></div></form>`;

async function surveysPage(id) {
  const list = await api("/surveys");
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading("Surveys", "Tell us how work is going. Answers are anonymous.") +
    (list.length
      ? list
          .map(
            (s) =>
              `<div class="card"><div class="card-head"><div><h2>${esc(s.title)}</h2><p class="muted">Open until ${fmtDate(s.closes_on)} · ${s.questions.length} question(s)</p></div>${s.answered ? '<span class="pill neutral">Answered, thank you</span>' : `<button data-survey="${s.id}">Answer</button>`}</div></div>`,
          )
          .join("")
      : `<div class="card">${empty("No surveys open", "When HR opens a survey for you it appears here.")}</div>`);
  document.querySelectorAll("[data-survey]").forEach((b) =>
    b.addEventListener("click", () => {
      const s = list.find((x) => x.id === Number(b.dataset.survey));
      viewDialog(s.title, surveyForm(s));
      document.querySelector("dialog #survey-form").onsubmit = (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const answers = Object.fromEntries(s.questions.map((q) => [q.id, f.get(q.id) ?? ""]));
        busy(e.submitter, async () => {
          await api(`/surveys/${s.id}/respond`, { answers });
          document.querySelector("dialog")?.remove();
          notice("Thank you. Your answers were sent anonymously.");
          render();
        });
      };
    }),
  );
}

// ---- HR ------------------------------------------------------------------------------------------
const SURVEY_TEMPLATE = [
  { type: "enps", text: "" },
  { type: "rating", text: "I know what is expected of me at work" },
  { type: "rating", text: "My manager supports me and gives useful feedback" },
  { type: "rating", text: "I have the tools and information to do my job well" },
  { type: "rating", text: "I see a future for myself at this company" },
  { type: "rating", text: "My workload is manageable" },
  { type: "text", text: "What is one thing we should change?" },
];
async function surveyAdminPage(id) {
  const [data, org] = await Promise.all([api("/admin/surveys"), has("org.read") ? api("/admin/org") : Promise.resolve({ branches: [], departments: [] })]);
  if (id !== renderId) return;
  const status = { draft: "Draft", open: "Open", closed: "Closed" };
  document.querySelector("#content").innerHTML =
    heading(
      "Engagement surveys",
      `Anonymous pulse surveys and eNPS. Results, and each department or branch within them, appear once ${data.min_group} people have answered.`,
      '<button id="sv-new">New survey</button>',
    ) +
    `<div class="card">${
      data.surveys.length
        ? `<div class="table-wrap"><table><thead><tr><th>Survey</th><th>Status</th><th>Closes</th><th>Answered</th><th></th></tr></thead><tbody>${data.surveys
            .map(
              (s) =>
                `<tr><td>${esc(s.title)}<small>${s.questions.length} question(s)${s.audience.branch_ids?.length || s.audience.department_ids?.length ? " · chosen branches/departments" : " · everyone"}</small></td><td><span class="pill ${s.status === "open" ? "" : "neutral"}">${status[s.status]}</span></td><td>${fmtDate(s.closes_on)}</td><td>${s.answered} of ${s.eligible} (${s.eligible ? Math.round((s.answered / s.eligible) * 100) : 0}%)</td><td>${
                  s.status === "draft"
                    ? `<button class="secondary" data-sv-open="${s.id}">Open and notify</button> <button class="ghost" data-sv-del="${s.id}">Delete</button>`
                    : `<button class="secondary" data-sv-results="${s.id}">Results</button>${s.status === "open" ? ` <button class="ghost" data-sv-close="${s.id}">Close</button>` : ""}`
                }</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty("No surveys yet", "Start with the quarterly pulse template: eNPS, five statements and one comment.")
    }</div><div id="sv-results"></div>`;
  const act = (sel, fn) =>
    document.querySelectorAll(sel).forEach((b) => b.addEventListener("click", () => busy(b, () => fn(b))));
  act("[data-sv-open]", async (b) => {
    const r = await api(`/admin/surveys/${b.dataset.svOpen}/open`, {});
    notice(`Opened. ${r.people} people were told.`);
    render();
  });
  act("[data-sv-close]", async (b) => {
    if (!confirm("Close this survey? Nobody can answer after this.")) return;
    await api(`/admin/surveys/${b.dataset.svClose}/close`, {});
    render();
  });
  act("[data-sv-del]", async (b) => {
    await api(`/admin/surveys/${b.dataset.svDel}`, undefined, "DELETE");
    render();
  });
  act("[data-sv-results]", (b) => surveyResults(Number(b.dataset.svResults), "department"));

  document.querySelector("#sv-new").onclick = () => {
    const rows = SURVEY_TEMPLATE.map((q) => ({ ...q }));
    const rowHtml = (q, i) =>
      `<div class="sv-row" data-i="${i}"><select data-k="type" aria-label="Type">${Object.entries(SURVEY_TYPES).map(([k, l]) => `<option value="${k}" ${k === q.type ? "selected" : ""}>${l}</option>`).join("")}</select><input data-k="text" value="${esc(q.text)}" maxlength="300" placeholder="${q.type === "enps" ? "Standard eNPS question" : "Question"}" aria-label="Question">${q.type === "choice" ? `<input data-k="options" value="${esc((q.options ?? []).join(", "))}" placeholder="Choices, separated by commas" aria-label="Choices">` : ""}<button type="button" class="ghost" data-drop="${i}" aria-label="Remove question">✕</button></div>`;
    const opts = (list) => list.map((x) => `<label class="check"><input type="checkbox" value="${x.id}"> ${esc(x.name)}</label>`).join("");
    dialog(
      "New survey",
      `${input("title", "Title", `Pulse ${new Intl.DateTimeFormat("en-IN", { month: "short", year: "numeric" }).format(new Date())}`, 'required maxlength="120"')}${input("closes_on", "Closes on", "", `type="date" required min="${today()}"`)}
       <label class="full">Introduction (optional)<textarea name="intro" rows="2" maxlength="1000"></textarea></label>
       <div class="full"><strong>Questions</strong><div id="sv-rows"></div><button type="button" class="secondary" id="sv-add">+ Add question</button></div>
       <details class="full"><summary>Only some branches or departments (default: everyone)</summary><div class="cr-cols" id="sv-br">${opts(org.branches)}</div><div class="cr-cols" id="sv-dp">${opts(org.departments)}</div></details>`,
      async (f) => {
        readRows();
        const picked = (sel) => [...document.querySelectorAll(`dialog ${sel} input:checked`)].map((c) => Number(c.value));
        await api("/admin/surveys", {
          title: f.title,
          intro: f.intro || null,
          closes_on: f.closes_on,
          questions: rows.map((q) => ({ type: q.type, text: q.text, ...(q.type === "choice" ? { options: String(q.options ?? "").split(",").map((o) => o.trim()).filter(Boolean) } : {}) })),
          audience: { branch_ids: picked("#sv-br"), department_ids: picked("#sv-dp") },
        });
        notice("Saved as a draft. Open it to send it to people.");
      },
    );
    const box = document.querySelector("dialog #sv-rows");
    const readRows = () =>
      box.querySelectorAll(".sv-row").forEach((r) => {
        const q = rows[Number(r.dataset.i)];
        q.type = r.querySelector('[data-k="type"]').value;
        q.text = r.querySelector('[data-k="text"]').value;
        const o = r.querySelector('[data-k="options"]');
        if (o) q.options = o.value.split(",").map((x) => x.trim()).filter(Boolean);
      });
    const draw = () => {
      box.innerHTML = rows.map(rowHtml).join("");
      box.querySelectorAll('[data-k="type"]').forEach((s) => (s.onchange = () => (readRows(), draw())));
      box.querySelectorAll("[data-drop]").forEach((b) => (b.onclick = () => (readRows(), rows.splice(Number(b.dataset.drop), 1), draw())));
    };
    document.querySelector("dialog #sv-add").onclick = () => (readRows(), rows.push({ type: "rating", text: "" }), draw());
    draw();
  };
}

async function surveyResults(surveyId, by) {
  const r = await api(`/admin/surveys/${surveyId}/results?by=${by}`);
  const el = document.querySelector("#sv-results");
  const q = (x) => {
    if (x.type === "enps")
      return `<div class="stat"><div class="stat-label">eNPS · ${x.answers} answers</div><div class="stat-value">${x.score > 0 ? "+" : ""}${x.score}</div><small>${x.promoters} promoters · ${x.passives} passives · ${x.detractors} detractors</small></div>`;
    if (x.type === "rating")
      return `<div class="kv"><span>${esc(x.text)}</span><strong>${x.average ?? "—"} / 5</strong></div><small class="muted">${x.counts.map((n, i) => `${i + 1}: ${n}`).join(" · ")}</small>`;
    if (x.type === "choice") return `<div class="kv"><span>${esc(x.text)}</span><strong>${x.options.map((o, i) => `${esc(o)} ${x.counts[i]}`).join(" · ")}</strong></div>`;
    return `<h3>${esc(x.text)} (${x.comments.length})</h3>${x.comments.map((c) => `<div class="activity">${esc(c)}</div>`).join("") || '<p class="muted">No comments.</p>'}`;
  };
  el.innerHTML = `<div class="card"><div class="card-head"><div><h2>${esc(r.survey.title)}</h2><p class="muted">${r.answered} of ${r.eligible} answered</p></div><div class="actions"><button class="${by === "department" ? "" : "secondary"}" data-by="department">By department</button><button class="${by === "branch" ? "" : "secondary"}" data-by="branch">By branch</button></div></div>${
    r.hidden
      ? `<div class="callout">Results appear once ${r.min_group} people have answered, so nobody's answers can be picked out.</div>`
      : r.results.map(q).join("") +
        (r.groups.length
          ? `<h3>By ${by}</h3><div class="table-wrap"><table><thead><tr><th>${by === "department" ? "Department" : "Branch"}</th><th>Answers</th><th>eNPS</th>${r.survey.questions.filter((x) => x.type === "rating").map((x) => `<th>${esc(x.text.slice(0, 28))}</th>`).join("")}</tr></thead><tbody>${r.groups
              .map((g) => {
                if (g.hidden) return `<tr><td>${esc(g.name)}</td><td>${g.answers}</td><td colspan="${1 + r.survey.questions.filter((x) => x.type === "rating").length}" class="muted">Fewer than ${r.min_group} answers: hidden</td></tr>`;
                const e = g.results.find((x) => x.type === "enps");
                return `<tr><td>${esc(g.name)}</td><td>${g.answers}</td><td>${e ? e.score : "—"}</td>${g.results.filter((x) => x.type === "rating").map((x) => `<td>${x.average}</td>`).join("")}</tr>`;
              })
              .join("")}</tbody></table></div>`
          : "")
  }</div>`;
  el.querySelectorAll("[data-by]").forEach((b) => b.addEventListener("click", () => busy(b, () => surveyResults(surveyId, b.dataset.by))));
  el.scrollIntoView({ behavior: "smooth" });
}
