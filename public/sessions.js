// Classroom and online training sessions on the Learning page: the employee's upcoming and
// past sessions, and HR's schedule with invitations and attendance.
const SESSION_STATUS = { scheduled: "Scheduled", cancelled: "Cancelled", completed: "Held" };
const ATTEND = { invited: "Invited", attended: "Attended", absent: "Absent" };
const sessionWhen = (s) =>
  `${fmtDate(s.starts_at.slice(0, 10))} · ${time(s.starts_at).split(", ").pop()} – ${time(s.ends_at).split(", ").pop()}`;
let sessionWhenTab = "upcoming";

// ---- employee ------------------------------------------------------------------------------------
async function mySessionsHtml() {
  const d = await api("/training-sessions/mine");
  if (!d.upcoming.length && !d.past.length) return "";
  const rows = (list, past) =>
    list
      .map(
        (s) =>
          `<tr><td>${esc(s.title)}${s.trainer ? `<small>${esc(s.trainer)}</small>` : ""}</td><td>${sessionWhen(s)}</td><td>${s.venue ? (/^https?:\/\//.test(s.venue) ? `<a href="${esc(s.venue)}" target="_blank" rel="noopener noreferrer">Join link ↗</a>` : esc(s.venue)) : "—"}</td><td>${past ? `<span class="pill ${s.attendance === "attended" ? "" : "neutral"}">${s.status === "cancelled" ? "Cancelled" : ATTEND[s.attendance]}</span>` : '<span class="pill">Invited</span>'}</td></tr>`,
      )
      .join("");
  const table = (list, past) =>
    `<div class="table-wrap"><table><thead><tr><th>Session</th><th>When</th><th>Where</th><th>Status</th></tr></thead><tbody>${rows(list, past)}</tbody></table></div>`;
  return `<div class="card"><h2>My training sessions</h2>${d.upcoming.length ? `<h3>Upcoming</h3>${table(d.upcoming, false)}` : '<p class="muted">No upcoming sessions.</p>'}${d.past.length ? `<h3>Past</h3>${table(d.past.slice(0, 20), true)}` : ""}</div>`;
}

// ---- HR ------------------------------------------------------------------------------------------
async function sessionsAdminHtml() {
  const rows = await api(`/admin/training-sessions?when=${sessionWhenTab}`);
  return `<div class="card"><div class="card-head"><div><h2>Training sessions</h2><p class="muted">Classroom or online sessions with a time, place and trainer. Attendance at a session linked to tracked training completes that training.</p></div><div class="actions"><select id="session-when" aria-label="Show"><option value="upcoming" ${sessionWhenTab === "upcoming" ? "selected" : ""}>Upcoming</option><option value="past" ${sessionWhenTab === "past" ? "selected" : ""}>Past</option></select><button id="new-session">Schedule a session</button></div></div>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Session</th><th>When</th><th>Where</th><th>People</th><th>Status</th><th></th></tr></thead><tbody>${rows
          .map(
            (s) =>
              `<tr><td>${esc(s.title)}${s.trainer ? `<small>${esc(s.trainer)}</small>` : ""}</td><td>${sessionWhen(s)}</td><td>${esc(s.venue || "—")}</td><td>${s.status === "completed" ? `${s.attended} of ${s.invited} attended` : `${s.invited}${s.capacity ? ` of ${s.capacity}` : ""} invited`}</td><td><span class="pill ${s.status === "scheduled" ? "" : "neutral"}">${SESSION_STATUS[s.status]}</span></td><td><button class="secondary" data-session="${s.id}">Open</button></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : empty(sessionWhenTab === "past" ? "No past sessions" : "Nothing scheduled", "Schedule a classroom or online session and invite people.")
  }</div>`;
}
const peoplePicker = (people, taken = new Set()) =>
  `<div class="full"><input type="search" id="pick-q" placeholder="Filter people" aria-label="Filter people"><div class="pick-list" id="pick-list">${people
    .filter((p) => !taken.has(p.id))
    .map(
      (p) =>
        `<label class="check" data-text="${esc(`${p.name} ${p.employee_code || ""} ${p.department_name || ""}`.toLowerCase())}"><input type="checkbox" name="uid" value="${p.id}"> ${esc(p.name)} <small>${esc(p.employee_code || "")}${p.department_name ? ` · ${esc(p.department_name)}` : ""}</small></label>`,
    )
    .join("")}</div></div>`;
function wirePicker() {
  const q = document.querySelector("dialog #pick-q");
  if (q)
    q.oninput = () =>
      document.querySelectorAll("dialog #pick-list label").forEach(
        (l) => (l.hidden = !l.dataset.text.includes(q.value.trim().toLowerCase())),
      );
}
const picked = () =>
  [...document.querySelectorAll("dialog [name=uid]:checked")].map((c) => Number(c.value));

function sessionsAdminWire() {
  document.querySelector("#session-when").onchange = (e) => {
    sessionWhenTab = e.target.value;
    render();
  };
  document.querySelector("#new-session").onclick = async () => {
    const [trainings, people] = await Promise.all([
      api("/admin/trainings"),
      api("/admin/employees?limit=200&active=1"),
    ]);
    const tracked = trainings.filter((t) => t.kind !== "course" && t.active);
    const tomorrow = addDaysStr(today(), 1);
    dialog(
      "Schedule a session",
      `<label class="full">Linked training (optional)<select name="training_id"><option value="">— None —</option>${tracked.map((t) => `<option value="${t.id}">${esc(t.title)} (${t.completed} of ${t.assigned} done)</option>`).join("")}</select></label>${input("title", "Title (defaults to the training's)", "", 'maxlength="150"')}${input("trainer", "Trainer", "", 'maxlength="120"')}${input("starts_at", "Starts", `${tomorrow}T10:00`, 'type="datetime-local" required')}${input("ends_at", "Ends", `${tomorrow}T12:00`, 'type="datetime-local" required')}${input("capacity", "Seats (optional)", "", 'type="number" min="1" max="1000"')}<label class="full">Venue or meeting link<input name="venue" maxlength="300" placeholder="Jaipur HO, training room, or https://…"></label><label class="full">Notes for attendees<input name="notes" maxlength="1000"></label><p class="muted full">Invite people below. With a linked training and nobody ticked, everyone who still has that training to do is invited.</p>${peoplePicker(people.items)}`,
      async (f) => {
        const r = await api("/admin/training-sessions", {
          training_id: f.training_id ? Number(f.training_id) : undefined,
          title: f.title || undefined,
          trainer: f.trainer || undefined,
          venue: f.venue || undefined,
          notes: f.notes || undefined,
          starts_at: f.starts_at,
          ends_at: f.ends_at,
          capacity: f.capacity ? Number(f.capacity) : undefined,
          user_ids: picked(),
        });
        notice(`Scheduled. ${r.invited} ${r.invited === 1 ? "person was" : "people were"} invited.`);
      },
    );
    document.querySelector("dialog").classList.add("wide");
    wirePicker();
  };
  document.querySelectorAll("[data-session]").forEach(
    (b) => (b.onclick = () => sessionDialog(Number(b.dataset.session))),
  );
}
async function sessionDialog(id) {
  const s = await api(`/admin/training-sessions/${id}`);
  const started = s.starts_at <= new Date().toISOString();
  const markable = started && s.status !== "cancelled";
  viewDialog(
    s.title,
    `<p class="muted">${sessionWhen(s)}${s.venue ? ` · ${esc(s.venue)}` : ""}${s.trainer ? ` · ${esc(s.trainer)}` : ""}${s.training_title ? ` · completes “${esc(s.training_title)}”` : ""} · <span class="pill">${SESSION_STATUS[s.status]}</span></p>${s.notes ? `<p>${esc(s.notes)}</p>` : ""}<form id="attend-form">${
      s.attendees.length
        ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Department</th><th>${markable ? "Attended" : "Status"}</th></tr></thead><tbody>${s.attendees
            .map(
              (a) =>
                `<tr><td>${esc(a.name)}<small>${esc(a.employee_code || "")}</small></td><td>${esc(a.department_name || "—")}</td><td>${markable ? `<input type="checkbox" name="att" value="${a.user_id}" ${a.status === "attended" ? "checked" : ""} ${a.user_id === me.id ? "disabled" : ""} aria-label="${esc(a.name)} attended">${a.user_id === me.id ? " <small>Someone else marks you</small>" : ""}` : ATTEND[a.status]}</td></tr>`,
            )
            .join("")}</tbody></table></div>`
        : '<p class="muted">Nobody invited yet.</p>'
    }<p class="error-text" id="att-error" role="alert"></p><div class="actions spaced">${markable && s.attendees.length ? '<button type="submit">Save attendance</button>' : ""}${s.status === "scheduled" && !started ? '<button type="button" class="secondary" id="invite-more">Invite more…</button> <button type="button" class="ghost" id="cancel-session">Cancel session</button>' : ""}</div></form>${started ? "" : '<p class="muted">Attendance can be marked once the session starts.</p>'}`,
  );
  const form = document.querySelector("dialog #attend-form");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const marks = [...form.querySelectorAll("[name=att]:not(:disabled)")].map((c) => ({
      user_id: Number(c.value),
      attended: c.checked,
    }));
    try {
      const r = await api(`/admin/training-sessions/${id}/attendance`, { marks });
      document.querySelector("dialog")?.remove();
      notice(r.completed ? `Attendance saved. Training completed for ${r.completed}.` : "Attendance saved.");
      render();
    } catch (err) {
      document.querySelector("dialog #att-error").textContent = err.message;
    }
  };
  document.querySelector("dialog #cancel-session")?.addEventListener("click", () =>
    dialog(
      "Cancel session",
      '<label class="full">Reason, sent to the people invited<input name="reason" maxlength="300"></label>',
      async (f) => {
        await api(`/admin/training-sessions/${id}/cancel`, { reason: f.reason || undefined });
        notice("Cancelled. The people invited were told.");
      },
    ),
  );
  document.querySelector("dialog #invite-more")?.addEventListener("click", async () => {
    const people = await api("/admin/employees?limit=200&active=1");
    dialog(
      `Invite to ${s.title}`,
      peoplePicker(people.items, new Set(s.attendees.map((a) => a.user_id))),
      async () => {
        const ids = picked();
        if (!ids.length) throw new Error("Tick the people to invite.");
        const r = await api(`/admin/training-sessions/${id}/invite`, { user_ids: ids });
        notice(`${r.invited} invited.`);
      },
    );
    wirePicker();
  });
}
