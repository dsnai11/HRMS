// LMS: who is late or stuck (HR's list and a manager's team), and the certificate design.

// Beside a person on appraisal and probation reviews.
function lateTrainingNote(titles) {
  if (!titles?.length) return "";
  return `<small class="late-training">Mandatory training 15+ days overdue: ${esc(titles.join(", "))}</small>`;
}
const followState = (r) =>
  [r.days_late ? `${r.days_late} ${r.days_late === 1 ? "day" : "days"} late` : "", r.out_of_attempts ? "All quiz attempts used" : ""].filter(Boolean).join(" · ");
const followCourse = (r) => `${esc(r.title)}${r.mandatory ? ' <span class="pill">Mandatory</span>' : ""}`;

async function learnFollowupHtml() {
  const rows = await api("/admin/learning-followup");
  return `<div class="card"><h2>Overdue and failed</h2><p class="muted">Everyone with a late course or no quiz attempts left. The manager is told as soon as a course is late, HR at 7 days, and the department head at 15 days for mandatory courses.</p>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Course</th><th>Due</th><th>Position</th><th>Follow-up so far</th><th></th></tr></thead><tbody>${rows
          .map(
            (r) =>
              `<tr><td>${esc(r.name)}<small>${esc([r.employee_code, r.department, r.branch].filter(Boolean).join(" · "))}</small></td><td>${followCourse(r)}</td><td>${r.due ? fmtDate(r.due) : "—"}</td><td>${followState(r)}</td><td>${esc(r.stage)}<small>${esc(r.manager_name ? `Manager: ${r.manager_name}` : "No manager set")}</small></td><td>${r.out_of_attempts ? `<button class="secondary" data-allow="${r.id}">Allow more attempts</button>` : ""}</td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : empty("Nothing to follow up", "Nobody has late training or has run out of quiz attempts.")
  }</div>`;
}
function learnFollowupWire() {
  document.querySelectorAll("[data-allow]").forEach(
    (b) =>
      (b.onclick = () =>
        busy(b, async () => {
          await api(`/admin/trainings/records/${b.dataset.allow}/reset`, {});
          notice("They can take the quiz again.");
          render();
        })),
  );
}

function learnTeamHtml() {
  const rows = learnTeam.rows;
  return `<div class="card"><h2>My team's late training</h2><p class="muted">Courses your team has not finished on time, and anyone with no quiz attempts left.</p>${
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Course</th><th>Due</th><th>Position</th></tr></thead><tbody>${rows
          .map((r) => `<tr><td>${esc(r.name)}<small>${esc(r.employee_code || "")}</small></td><td>${followCourse(r)}</td><td>${r.due ? fmtDate(r.due) : "—"}</td><td>${followState(r)}</td></tr>`)
          .join("")}</tbody></table></div>`
      : empty("All on track", "Nobody in your team is late.")
  }</div>`;
}

let certDesign = null; // what is on the form, including chosen pictures
const CERT_STYLES = { classic: "Classic (double border)", modern: "Modern (colour band)", simple: "Simple (thin border)" };

async function certDesignHtml() {
  certDesign = { ...(await api("/admin/certificate-design")), signature: undefined, seal: undefined };
  const d = certDesign;
  const pic = (key, label, url) =>
    `<label class="full">${label}<input type="file" accept="image/png,image/jpeg" data-cert-file="${key}"></label><p class="full muted" data-cert-state="${key}">${url ? `A ${key} is on file. <button type="button" class="ghost" data-cert-clear="${key}">Remove</button>` : "None added."}</p>`;
  return `<div class="cert-design"><div class="card"><h2>Certificate design</h2><p class="muted">The picture updates as you change this. New certificates use the saved design; ones already issued keep theirs.</p>
    <form class="form-grid" id="cert-form">
      <label class="full">Style<select name="style">${Object.entries(CERT_STYLES).map(([k, l]) => `<option value="${k}" ${k === d.style ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="full">Colour<input type="color" name="color" value="${esc(d.color)}"></label>
      <label class="full">Heading<input name="title" value="${esc(d.title)}" maxlength="80" required></label>
      <label class="full">Wording before the course name<input name="message" value="${esc(d.message)}" maxlength="200" required></label>
      <label>Signatory name<input name="signatory_name" value="${esc(d.signatory_name || "")}" maxlength="100"></label>
      <label>Signatory designation<input name="signatory_title" value="${esc(d.signatory_title || "")}" maxlength="100"></label>
      ${pic("signature", "Signature (PNG or JPG, up to 512 KB)", d.signature_url)}
      ${pic("seal", "Company seal (PNG or JPG, up to 512 KB)", d.seal_url)}
      <div class="full actions"><button id="cert-save">Save design</button></div>
    </form></div>
    <div class="card"><h2>Preview</h2><div id="cert-preview"></div><p class="muted">The name, course and dates here are only an example.</p></div></div>`;
}

function certPreview() {
  const box = document.querySelector("#cert-preview");
  if (!box) return;
  const f = Object.fromEntries(new FormData(document.querySelector("#cert-form")));
  box.innerHTML = certificateHtml({
    ...certDesign,
    ...f,
    person: "Employee Name",
    course: "Name of the Course",
    hours: 2,
    completed: "1 January 2027",
    score: 85,
    validity: null,
    number: "LIFC-2027-1A2B3C4D",
    link: null,
  });
  certificateColour(box, f.color);
}

function certDesignWire() {
  const form = document.querySelector("#cert-form");
  form.oninput = certPreview;
  const state = (key, text) => (document.querySelector(`[data-cert-state="${key}"]`).textContent = text);
  document.querySelectorAll("[data-cert-file]").forEach(
    (input) =>
      (input.onchange = async () => {
        const key = input.dataset.certFile;
        const file = input.files[0];
        if (!file) return;
        try {
          if (!["image/png", "image/jpeg"].includes(file.type)) throw new Error("Choose a PNG or JPG picture.");
          if (file.size > 512 * 1024) throw new Error("The picture can be up to 512 KB.");
          certDesign[key] = { mime: file.type, data: await toB64(file) };
          certDesign[`${key}_url`] = URL.createObjectURL(file);
          state(key, `${file.name} will be used when you save.`);
          certPreview();
        } catch (e) {
          input.value = "";
          notice(e.message, "error");
        }
      }),
  );
  document.querySelectorAll("[data-cert-clear]").forEach(
    (b) =>
      (b.onclick = () => {
        const key = b.dataset.certClear;
        certDesign[key] = null;
        certDesign[`${key}_url`] = null;
        state(key, "It will be removed when you save.");
        certPreview();
      }),
  );
  form.onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(form));
    busy(document.querySelector("#cert-save"), async () => {
      await api("/admin/certificate-design", { ...f, signature: certDesign.signature, seal: certDesign.seal }, "PUT");
      notice("Certificate design saved.");
      render();
    });
  };
  certPreview();
}
