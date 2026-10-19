// Learning: self-paced courses (lessons, quiz, certificate) and tracked training.
let learnTab = "mine";
const LESSON_KIND = { text: "Text", link: "Link", video: "Video link" };

async function learningPage(id) {
  const manage = has("performance.manage");
  const tabs = {
    mine: "My learning",
    ...(manage ? { manage: "Manage courses" } : {}),
  };
  if (!tabs[learnTab]) learnTab = "mine";
  const html = await learningHtml(learnTab);
  if (id !== renderId) return;
  document.querySelector("#content").innerHTML =
    heading("Learning", "Courses, quizzes and certificates.") +
    `<div class="tabbar">${Object.entries(tabs)
      .map(
        ([k, l]) =>
          `<button class="${k === learnTab ? "" : "secondary"}" data-tab="${k}">${l}</button>`,
      )
      .join("")}</div><div id="tab">${html}</div>`;
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => (b.onclick = () => ((learnTab = b.dataset.tab), render())));
  learningWire(learnTab);
}

async function learningHtml(tab) {
  if (tab === "mine") {
    const rows = await api("/trainings/mine");
    return `<div class="card"><h2>My learning</h2>${
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Course</th><th>Hours</th><th>Due</th><th>Status</th><th></th></tr></thead><tbody>${rows
            .map(
              (t) =>
                `<tr><td>${esc(t.title)}${t.mandatory ? ' <span class="pill">Mandatory</span>' : ""}</td><td>${t.hours}</td><td>${t.due_date ? fmtDate(t.due_date) : "—"}${t.status === "assigned" && t.due_date && t.due_date < today() ? ' <span class="pill">Overdue</span>' : ""}</td><td><span class="pill ${t.status === "completed" ? "" : "neutral"}">${t.status === "completed" ? `Done ${fmtDate(t.completed_on)}${t.score != null ? ` · ${t.score}%` : ""}` : "To do"}</span></td><td>${
                  t.kind === "course"
                    ? t.status === "completed"
                      ? `<a class="button secondary" target="_blank" rel="noopener" href="/letter.html?type=certificate&id=${t.id}">Certificate</a>`
                      : `<button class="secondary" data-open-course="${t.id}">Open course</button>`
                    : t.status === "assigned" && !t.mandatory
                      ? `<button class="secondary" data-done-train="${t.id}">Mark done</button>`
                      : t.status === "assigned"
                        ? "<small>Confirmed by your manager or HR</small>"
                        : ""
                }</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : empty("Nothing assigned", "Courses assigned to you appear here.")
    }</div>`;
  }
  const rows = await api("/admin/trainings");
  return `<div class="card"><div class="card-head"><div><h2>Courses and training</h2><p class="muted">A course has lessons and an optional quiz; people finish it themselves and get a certificate. Tracked training is confirmed by a manager or HR.</p></div><div class="actions"><button class="secondary" id="new-training">Assign tracked training</button><button id="new-course">New course</button></div></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Title</th><th>Type</th><th>Due</th><th>Completed</th><th></th></tr></thead><tbody>${rows.map((t) => `<tr><td>${esc(t.title)}${t.mandatory ? ' <span class="pill">Mandatory</span>' : ""}${t.active ? "" : ' <span class="pill neutral">Off</span>'}</td><td>${t.kind === "course" ? "Course" : "Tracked"}</td><td>${t.due_date ? fmtDate(t.due_date) : "—"}</td><td>${t.completed} of ${t.assigned}</td><td><button class="secondary" data-train="${t.id}" data-name="${esc(t.title)}" data-kind="${t.kind}">Records</button>${t.kind === "course" ? ` <button class="ghost" data-edit-course="${t.id}">Edit</button> <button class="ghost" data-assign-course="${t.id}">Assign</button> <button class="ghost" data-course-settings="${t.id}">Settings</button>` : ""}</td></tr>`).join("")}</tbody></table></div>`
      : empty(
          "No courses",
          "Create a course, add lessons and a quiz, then assign it.",
        )
  }</div>`;
}

// ---- learner: course player ------------------------------------------------------------------
async function courseDialog(recordId) {
  const c = await api(`/learning/${recordId}`);
  const allDone = c.lessons.every((l) => l.done);
  const lessonHtml = c.lessons
    .map(
      (l, i) =>
        `<div class="card lesson"><h3>${i + 1}. ${esc(l.title)} ${l.done ? '<span class="pill">Read</span>' : ""}</h3>${
          l.kind === "text"
            ? `<p class="prewrap">${esc(l.body)}</p>`
            : `<p><a class="button secondary" href="${esc(l.body)}" target="_blank" rel="noopener noreferrer">Open ${l.kind === "video" ? "video" : "link"}</a></p>`
        }${l.done || c.status === "completed" ? "" : `<button class="secondary" data-lesson="${l.id}">Mark as read</button>`}</div>`,
    )
    .join("");
  const quiz =
    c.questions.length && c.status !== "completed"
      ? allDone
        ? c.attempts_left === 0
          ? '<p class="error-text">You have used all your attempts. Ask HR to reset them.</p>'
          : `<form id="quiz" class="card"><h3>Quiz</h3><p class="muted">Pass mark ${c.pass_mark}%.${c.attempts_left != null ? ` ${c.attempts_left} attempt(s) left.` : ""}${c.best_score != null ? ` Best so far: ${c.best_score}%.` : ""}</p>${c.questions.map((q, i) => `<fieldset><legend>${i + 1}. ${esc(q.question)}</legend>${q.options.map((o, j) => `<label class="check"><input type="radio" name="q${i}" value="${j}" required> ${esc(o)}</label>`).join("")}</fieldset>`).join("")}<p id="quiz-result" class="error-text" role="status"></p><button type="submit">Submit answers</button></form>`
        : '<p class="muted">The quiz opens after you mark every lesson as read.</p>'
      : "";
  viewDialog(
    c.title,
    `<p class="muted">${esc(c.description || "")} ${c.hours} hour(s)${c.due_date ? ` · due ${fmtDate(c.due_date)}` : ""}</p>${
      c.status === "completed"
        ? `<p class="notice-ok">Completed ${fmtDate(c.completed_on)}${c.score != null ? ` · ${c.score}%` : ""}. <a href="/letter.html?type=certificate&id=${c.id}" target="_blank" rel="noopener">Certificate</a></p>`
        : ""
    }${lessonHtml}${quiz}`,
  );
  document.querySelectorAll("dialog [data-lesson]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          const r = await api(
            `/learning/${recordId}/lessons/${b.dataset.lesson}/done`,
            {},
          );
          if (r.completed) notice("Course completed. Well done.");
          await courseDialog(recordId);
          render();
        })),
  );
  const form = document.querySelector("dialog #quiz");
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      e.submitter.disabled = true;
      try {
        const answers = c.questions.map((_, i) =>
          Number(form.elements[`q${i}`].value),
        );
        const r = await api(`/learning/${recordId}/quiz`, { answers });
        if (r.passed) {
          notice(`Passed with ${r.score}%. Your certificate is ready.`);
          await courseDialog(recordId);
          render();
        } else {
          const wrong = r.correct
            .map((ok, i) => (ok ? null : i + 1))
            .filter(Boolean);
          document.querySelector("dialog #quiz-result").textContent =
            `Score ${r.score}% (pass mark ${r.pass_mark}%). Check question ${wrong.join(", ")}.${r.attempts_left != null ? ` ${r.attempts_left} attempt(s) left.` : ""}`;
          e.submitter.disabled = false;
          if (r.attempts_left === 0) await courseDialog(recordId);
        }
      } catch (err) {
        document.querySelector("dialog #quiz-result").textContent = err.message;
        e.submitter.disabled = false;
      }
    };
}

// ---- HR: course builder ----------------------------------------------------------------------
let builderSeq = 0;
const lessonRow = (l = {}) => {
  const n = ++builderSeq;
  return `<div class="card builder-row" data-row><label>Lesson title<input name="l_title_${n}" value="${esc(l.title || "")}" maxlength="120"></label><label>Type<select name="l_kind_${n}">${Object.entries(
    LESSON_KIND,
  )
    .map(
      ([k, v]) =>
        `<option value="${k}" ${l.kind === k ? "selected" : ""}>${v}</option>`,
    )
    .join(
      "",
    )}</select></label><label class="full">Text, or the web address for a link or video<textarea name="l_body_${n}" rows="4" maxlength="20000">${esc(l.body || "")}</textarea></label><button type="button" class="ghost" data-remove-row>Remove lesson</button></div>`;
};
const questionRow = (q = {}) => {
  const n = ++builderSeq;
  const o = q.options || [];
  return `<div class="card builder-row" data-row><label class="full">Question<input name="q_text_${n}" value="${esc(q.question || "")}" maxlength="300"></label>${[0, 1, 2, 3].map((i) => `<label>Choice ${i + 1}<input name="q_o${i}_${n}" value="${esc(o[i] || "")}" maxlength="150"></label>`).join("")}<label>Correct answer<select name="q_c_${n}">${[0, 1, 2, 3].map((i) => `<option value="${i}" ${q.correct === i ? "selected" : ""}>Choice ${i + 1}</option>`).join("")}</select></label><label>Why (shown after passing)<input name="q_e_${n}" value="${esc(q.explanation || "")}" maxlength="300"></label><button type="button" class="ghost" data-remove-row>Remove question</button></div>`;
};
function collectContent(f) {
  const lessons = [];
  const questions = [];
  for (const k of Object.keys(f)) {
    let m = /^l_title_(\d+)$/.exec(k);
    if (m && (f[k] || f[`l_body_${m[1]}`]))
      lessons.push({
        title: f[k],
        kind: f[`l_kind_${m[1]}`],
        body: f[`l_body_${m[1]}`],
      });
    m = /^q_text_(\d+)$/.exec(k);
    if (m && f[k]) {
      const options = [0, 1, 2, 3]
        .map((i) => f[`q_o${i}_${m[1]}`])
        .filter(Boolean);
      const wanted = Number(f[`q_c_${m[1]}`]);
      // Blank choices are dropped, so find the correct one by position among those kept.
      const kept = [0, 1, 2, 3].filter((i) => f[`q_o${i}_${m[1]}`]);
      questions.push({
        question: f[k],
        options,
        correct: kept.indexOf(wanted),
        explanation: f[`q_e_${m[1]}`] || undefined,
      });
    }
  }
  return { lessons, questions };
}
async function courseBuilder(id) {
  const c = await api(`/admin/learning/${id}`);
  if (c.locked)
    return viewDialog(
      c.title,
      "<p>People have already started this course, so its content is locked. Create a new course if you need changes.</p>",
    );
  dialog(
    `Edit course · ${c.title}`,
    `<div class="full" id="lessons"><h3>Lessons</h3>${c.lessons.map(lessonRow).join("")}</div><div class="full actions"><button type="button" class="secondary" id="add-lesson">Add a lesson</button></div><div class="full" id="questions"><h3>Quiz (optional)</h3>${c.questions.map(questionRow).join("")}</div><div class="full actions"><button type="button" class="secondary" id="add-question">Add a question</button></div>`,
    async (f) => {
      const r = await api(
        `/admin/learning/${id}/content`,
        collectContent(f),
        "PUT",
      );
      notice(`Saved ${r.lessons} lesson(s) and ${r.questions} question(s).`);
    },
  );
  const d = document.querySelector("dialog");
  d.classList.add("wide");
  const wireRows = () =>
    d
      .querySelectorAll("[data-remove-row]")
      .forEach((b) => (b.onclick = () => b.closest("[data-row]").remove()));
  const add = (box, html) => {
    d.querySelector(box).insertAdjacentHTML("beforeend", html);
    wireRows();
  };
  d.querySelector("#add-lesson").onclick = () => add("#lessons", lessonRow());
  d.querySelector("#add-question").onclick = () =>
    add("#questions", questionRow());
  wireRows();
}

function learningWire(tab) {
  const on = (s, fn) =>
    document.querySelector(s)?.addEventListener("click", fn);
  const each = (s, fn) =>
    document.querySelectorAll(s).forEach((b) => (b.onclick = () => fn(b)));
  each("[data-open-course]", (b) => courseDialog(Number(b.dataset.openCourse)));
  each("[data-done-train]", (b) =>
    busy(b, async () => {
      await api(`/trainings/records/${b.dataset.doneTrain}/complete`, {});
      render();
    }),
  );
  if (tab !== "manage") return;
  on("#new-course", () =>
    dialog(
      "New course",
      `${input("title", "Course title", "", "required maxlength=150")}${input("hours", "Hours", 1, 'type="number" min="0.25" step="0.25"')}${input("due_date", "Company-wide due date (optional)", "", 'type="date"')}<label class="full">Description<textarea name="description" rows="3" maxlength="1000"></textarea></label><label class="check"><input type="checkbox" name="mandatory"> Mandatory</label>`,
      async (b) => {
        const r = await api("/admin/trainings", {
          kind: "course",
          title: b.title,
          hours: Number(b.hours),
          due_date: b.due_date || undefined,
          description: b.description || undefined,
          mandatory: "mandatory" in b,
        });
        notice("Course created. Choose Edit to add lessons and a quiz.");
        learnTab = "manage";
        return r;
      },
    ),
  );
  on("#new-training", () =>
    dialog(
      "Assign tracked training",
      `${input("title", "Training", "", "required maxlength=150")}${input("hours", "Hours", 1, 'type="number" min="0.25" step="0.25"')}${input("due_date", "Due date", "", 'type="date"')}<label class="check"><input type="checkbox" name="mandatory"> Mandatory (completion confirmed by manager or HR)</label><p class="full muted">Assigned to everyone in the company.</p>`,
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
  each("[data-edit-course]", (b) =>
    courseBuilder(Number(b.dataset.editCourse)),
  );
  each("[data-assign-course]", async (b) => {
    const people = await peopleList();
    dialog(
      "Assign course",
      `<label class="full">Who<select name="who"><option value="all">Everyone</option>${people.map((p) => `<option value="${p.id}">${esc(p.name)}${p.employee_code ? ` (${esc(p.employee_code)})` : ""}</option>`).join("")}</select></label>`,
      async (f) => {
        const r = await api(
          `/admin/learning/${b.dataset.assignCourse}/assign`,
          f.who === "all" ? {} : { user_ids: [Number(f.who)] },
        );
        notice(`Assigned to ${r.assigned} new learner(s).`);
      },
    );
  });
  each("[data-course-settings]", async (b) => {
    const c = await api(`/admin/learning/${b.dataset.courseSettings}`);
    dialog(
      `Settings · ${c.title}`,
      `${input("pass_mark", "Pass mark (%)", c.pass_mark, 'type="number" min="1" max="100"')}${input("max_attempts", "Quiz attempts (0 = unlimited)", c.max_attempts, 'type="number" min="0" max="20"')}${input("due_days", "Days to finish for new joiners", c.due_days, 'type="number" min="1" max="365"')}<label class="check"><input type="checkbox" name="auto_assign" ${c.auto_assign ? "checked" : ""}> Assign to every new joiner automatically</label><label class="check"><input type="checkbox" name="mandatory" ${c.mandatory ? "checked" : ""}> Mandatory</label><label class="check"><input type="checkbox" name="active" ${c.active ? "checked" : ""}> Course is on</label>`,
      async (f) => {
        await api(
          `/admin/learning/${c.id}`,
          {
            pass_mark: Number(f.pass_mark),
            max_attempts: Number(f.max_attempts),
            due_days: Number(f.due_days),
            auto_assign: "auto_assign" in f,
            mandatory: "mandatory" in f,
            active: "active" in f,
          },
          "PATCH",
        );
        notice("Saved.");
      },
    );
  });
  each("[data-train]", async (b) => {
    const rows = await api(`/admin/trainings/${b.dataset.train}/records`);
    const course = b.dataset.kind === "course";
    viewDialog(
      b.dataset.name,
      `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Status</th>${course ? "<th>Attempts</th>" : ""}<th></th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.employee_name)}</td><td>${r.status === "completed" ? `Done ${fmtDate(r.completed_on)}${r.score != null ? ` · ${r.score}%` : ""}` : r.started_at ? "In progress" : "To do"}</td>${course ? `<td>${r.attempts}</td>` : ""}<td>${r.status === "assigned" ? `<button class="ghost" data-confirm="${r.id}">Mark done</button>${course && r.attempts ? ` <button class="ghost" data-reset="${r.id}">Reset attempts</button>` : ""}` : ""}</td></tr>`).join("")}</tbody></table></div>`,
    );
    document.querySelectorAll("dialog [data-confirm]").forEach(
      (x) =>
        (x.onclick = () =>
          busy(x, async () => {
            await api(`/trainings/records/${x.dataset.confirm}/complete`, {});
            x.remove();
          })),
    );
    document.querySelectorAll("dialog [data-reset]").forEach(
      (x) =>
        (x.onclick = () =>
          busy(x, async () => {
            await api(`/admin/trainings/records/${x.dataset.reset}/reset`, {});
            notice("Attempts reset.");
            x.remove();
          })),
    );
  });
}
