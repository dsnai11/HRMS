// The recruitment agency portal: open jobs to submit candidates to, and the agency's own
// candidates with their status. The private link (?k=…) is the agency's source key.
const box = document.querySelector("#agency");
const key = new URLSearchParams(location.search).get("k") || "";
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const MIME = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};
const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("The file could not be read."));
    r.readAsDataURL(file);
  });
const day = (iso) => (iso ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(iso)) : "");

async function load() {
  const res = await fetch(`/api/agency/${encodeURIComponent(key)}`);
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    box.innerHTML = `<div class="card"><h2>Link not valid</h2><p>${esc(d.error || "Ask the company for a new link.")}</p></div>`;
    return;
  }
  document.title = `${d.company} · ${d.agency}`;
  box.innerHTML = `<header><img class="page-logo" src="/brand/logo.png" alt=""><p class="eyebrow">${esc(d.company)}</p><h1>${esc(d.agency)}</h1><p class="muted">Submit candidates for open jobs and follow their status. You see only the candidates you sent.</p></header>
  <div class="card"><h2>Submit a candidate</h2><form id="sub" class="form-grid">
    <label>Job<select name="job" required>${d.jobs.map((j) => `<option value="${j.id}">${esc(j.code)} · ${esc(j.title)}${j.location || j.branch_name ? ` · ${esc(j.location || j.branch_name)}` : ""}</option>`).join("")}</select></label>
    <label>Name<input name="name" maxlength="100" required></label>
    <label>Mobile<input name="phone" maxlength="20" required inputmode="tel"></label>
    <label>Email<input name="email" type="email" maxlength="254"></label>
    <label>City<input name="location" maxlength="80"></label>
    <label>Expected pay (₹ a year)<input name="expected_ctc" type="number" min="0"></label>
    <label>Notice period (days)<input name="notice_days" type="number" min="0" max="365"></label>
    <label class="full">Resume (PDF, Word or photo, up to 2 MB)<input name="resume" type="file" accept=".pdf,.doc,.docx,.jpg,.jpeg,.png" required></label>
    <p class="error-text full" role="alert"></p><div class="actions full"><button>Submit</button></div></form></div>
  <div class="card"><h2>Your candidates (${d.submitted.length})</h2>${
    d.submitted.length
      ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Job</th><th>Sent</th><th>Status</th></tr></thead><tbody>${d.submitted
          .map((c) => `<tr><td>${esc(c.name)}</td><td>${esc(c.job || "")}</td><td>${day(c.received_at)}</td><td><span class="pill neutral">${esc(c.status)}</span></td></tr>`)
          .join("")}</tbody></table></div>`
      : '<p class="muted">Nothing sent yet.</p>'
  }</div>`;
  const form = box.querySelector("#sub");
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector(".error-text");
    err.textContent = "";
    e.submitter.disabled = true;
    try {
      const f = Object.fromEntries(new FormData(form));
      const file = form.elements.resume.files[0];
      const ext = file.name.split(".").pop().toLowerCase();
      if (!MIME[ext]) throw new Error("Use a PDF, Word or photo resume.");
      if (file.size > 2 * 1024 * 1024) throw new Error("The resume can be up to 2 MB.");
      const body = {
        opening_id: Number(f.job),
        name: f.name,
        phone: f.phone,
        ...(f.email ? { email: f.email } : {}),
        ...(f.location ? { location: f.location } : {}),
        ...(f.expected_ctc ? { expected_ctc: Number(f.expected_ctc) } : {}),
        ...(f.notice_days ? { notice_days: Number(f.notice_days) } : {}),
        resume: { name: file.name, mime: MIME[ext], data: await toBase64(file) },
      };
      const res = await fetch(`/api/intake/${encodeURIComponent(key)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || "Could not submit.");
      await load();
      box.querySelector("header .muted").textContent = out.duplicate
        ? "This candidate was already on that job: we added your submission to their record."
        : "Submitted. Thank you.";
    } catch (ex) {
      err.textContent = ex.message;
      e.submitter.disabled = false;
    }
  };
}
load();
