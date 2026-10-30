const box = document.querySelector("#careers");
const q = new URLSearchParams(location.search);
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const fmt = (iso) =>
  iso
    ? new Intl.DateTimeFormat("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: iso.length > 10 ? "numeric" : undefined,
        minute: iso.length > 10 ? "2-digit" : undefined,
      }).format(new Date(iso))
    : "";
const TYPE = {
  full_time: "Full time",
  part_time: "Part time",
  contract: "Contract",
  intern: "Intern",
  consultant: "Consultant",
};
async function call(path, body) {
  const res = await fetch(`/api/careers${path}`, {
    ...(body !== undefined
      ? { method: "POST", body: JSON.stringify(body) }
      : {}),
    headers: { "Content-Type": "application/json" },
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || "Something went wrong.");
  return out;
}
const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("The file could not be read."));
    r.readAsDataURL(file);
  });

async function tracker(token) {
  try {
    const t = await call(`/track/${encodeURIComponent(token)}`);
    document.title = `${t.company} · Application status`;
    box.innerHTML = `<header><img class="page-logo" src="/brand/logo.png" alt=""><p class="eyebrow">${esc(t.company)}</p><h1>Hello, ${esc(t.name)}</h1><p class="muted">Your application${t.position ? ` for ${esc(t.position)}` : ""}, received ${fmt(t.applied_on)}.</p></header>
    <div class="card"><h2>Application progress</h2><ul class="join-steps">${t.steps.map((s) => `<li class="${s.state === "done" ? "done" : ""}">${s.state === "current" ? "● " : ""}${esc(s.label)}</li>`).join("")}</ul>${
      t.closed
        ? '<div class="join-note">Your application was not taken forward this time. Thank you for your interest.</div>'
        : t.offer
          ? '<div class="join-ok">An offer has been made. Please check your email for your private joining link.</div>'
          : '<p class="muted">We will email you at each step.</p>'
    }</div>${
      t.interviews.length
        ? `<div class="card"><h2>Upcoming interviews</h2>${t.interviews.map((i) => `<div class="join-doc"><span>${esc(i.round_name)} · ${fmt(i.scheduled_at)}</span><span>${esc(i.mode.replace("_", " "))}${i.location ? ` · ${esc(i.location)}` : ""}</span></div>`).join("")}</div>`
        : ""
    }`;
  } catch (e) {
    box.innerHTML = `<div class="card"><h2>Link not valid</h2><p>${esc(e.message)}</p></div>`;
  }
}

async function jobs(companyId) {
  let data;
  try {
    data = await call(`/${encodeURIComponent(companyId)}`);
  } catch (e) {
    box.innerHTML = `<div class="card"><h2>Careers</h2><p>${esc(e.message)}</p></div>`;
    return;
  }
  document.title = `${data.company} · Careers`;
  const want = Number(q.get("job")) || null;
  const list = data.jobs;
  box.innerHTML = `<header><img class="page-logo" src="/brand/logo.png" alt=""><p class="eyebrow">${esc(data.company)}</p><h1>Join our team</h1><p class="muted">${list.length ? "Choose a role and apply in two minutes." : "There are no open positions right now. Please check back soon."}</p></header>
  <p id="msg" class="muted" role="status"></p>${list
    .map(
      (
        j,
      ) => `<div class="card" id="job-${j.id}"><h2>${esc(j.title)}</h2><p class="muted">${[j.department_name, j.location || j.branch_name, TYPE[j.employment_type], j.positions > 1 ? `${j.positions} positions` : null, j.closing_date ? `apply by ${fmt(j.closing_date)}` : null].filter(Boolean).map(esc).join(" · ")}</p>${j.description ? `<p class="prewrap">${esc(j.description)}</p>` : ""}${j.qualifications ? `<p><strong>Qualifications:</strong> ${esc(j.qualifications)}</p>` : ""}${j.min_experience_years ? `<p><strong>Experience:</strong> ${j.min_experience_years}+ years</p>` : ""}${j.skills.length ? `<p><strong>Skills:</strong> ${j.skills.map(esc).join(", ")}</p>` : ""}<div class="actions"><button data-apply="${j.id}">Apply</button></div><form class="apply-form" id="form-${j.id}" hidden><div class="form-grid">
    <label>Full name<input name="name" required maxlength="100" autocomplete="name"></label>
    <label>Email<input name="email" type="email" required maxlength="254" autocomplete="email"></label>
    <label>Mobile<input name="phone" required maxlength="20" inputmode="tel" autocomplete="tel"></label>
    <label>Highest qualification<input name="qualification" maxlength="200"></label>
    <label>Total experience (years)<input name="experience_years" type="number" min="0" max="60" step="0.5"></label>
    <label>Expected pay (₹ a year)<input name="expected_ctc" type="number" min="0"></label>
    <label>Notice period (days)<input name="notice_days" type="number" min="0" max="365"></label>
    <label class="full">Key skills, separated by commas<input name="skills" maxlength="600"></label>
    <label class="full">Resume (PDF, JPG or PNG, up to 2 MB)<input name="resume" type="file" accept="application/pdf,image/jpeg,image/png"></label>${(j.screening ?? [])
      .map((s) =>
        s.type === "yes_no"
          ? `<label>${esc(s.text)}<select name="sq_${s.id}" required><option value="">Choose…</option><option value="yes">Yes</option><option value="no">No</option></select></label>`
          : s.type === "number"
            ? `<label>${esc(s.text)}<input name="sq_${s.id}" type="number" step="any" required></label>`
            : `<label>${esc(s.text)}<select name="sq_${s.id}" required><option value="">Choose…</option>${s.options.map((o) => `<option>${esc(o)}</option>`).join("")}</select></label>`,
      )
      .join("")}</div>
    <p class="error-text" role="alert"></p><div class="actions spaced"><button type="submit">Submit application</button></div></form></div>`,
    )
    .join("")}`;
  const open = (id) => {
    box
      .querySelectorAll(".apply-form")
      .forEach((f) => (f.hidden = f.id !== `form-${id}`));
    document.querySelector(`#form-${id}`)?.scrollIntoView({ block: "nearest" });
  };
  box
    .querySelectorAll("[data-apply]")
    .forEach((b) => (b.onclick = () => open(b.dataset.apply)));
  if (want && list.some((j) => j.id === want)) open(want);
  box.querySelectorAll(".apply-form").forEach((form) => {
    const id = Number(form.id.replace("form-", ""));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const err = form.querySelector(".error-text");
      err.textContent = "";
      e.submitter.disabled = true;
      try {
        const f = Object.fromEntries(new FormData(form));
        const body = { opening_id: id };
        for (const k of [
          "name",
          "email",
          "phone",
          "qualification",
          "skills",
          "experience_years",
          "expected_ctc",
          "notice_days",
        ])
          if (f[k] !== "")
            body[k] = [
              "experience_years",
              "expected_ctc",
              "notice_days",
            ].includes(k)
              ? Number(f[k])
              : f[k];
        const job = list.find((j) => j.id === id);
        if (job?.screening?.length)
          body.screening = Object.fromEntries(
            job.screening.map((s) => [s.id, s.type === "number" ? Number(f[`sq_${s.id}`]) : f[`sq_${s.id}`]]),
          );
        const file = form.elements.resume.files[0];
        if (file) {
          if (file.size > 2 * 1024 * 1024)
            throw new Error("The resume can be up to 2 MB.");
          if (
            !["application/pdf", "image/jpeg", "image/png"].includes(file.type)
          )
            throw new Error("Use a PDF, JPG or PNG resume.");
          body.resume = {
            name: file.name.replace(/\.[^.]+$/, ""),
            mime: file.type,
            data: await toBase64(file),
          };
        }
        const r = await call(`/${encodeURIComponent(companyId)}/apply`, body);
        box.innerHTML = `<div class="card"><h2>Application received</h2><p>Thank you. We have your application and will be in touch.</p><p>Save this private link to follow your application:</p><label>Your tracking link<input readonly value="${esc(r.track_url)}" id="track"></label><div class="actions spaced"><a class="button" href="${esc(r.track_url)}">See my application status</a></div></div>`;
      } catch (ex) {
        err.textContent = ex.message;
        e.submitter.disabled = false;
      }
    };
  });
}

// Choosing an interview time from the slots HR offered (a one-time link by email).
async function slotPicker(token) {
  const show = (t) => {
    const when = (iso) =>
      new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit", timeZone: t.timezone }).format(new Date(iso));
    document.title = `${t.company} · Interview time`;
    box.innerHTML = `<header><img class="page-logo" src="/brand/logo.png" alt=""><p class="eyebrow">${esc(t.company)}</p><h1>Hello, ${esc(t.name)}</h1><p class="muted">${esc(t.round)}${t.job ? ` for ${esc(t.job)}` : ""} · ${t.minutes} minutes · ${esc(t.mode.replace("_", " "))}</p></header>${
      t.status === "booked"
        ? `<div class="card"><h2>Your interview is booked</h2><p>${when(t.booked_slot)}. The details and a calendar invitation are in your email.</p></div>`
        : t.status !== "open"
          ? '<div class="card"><h2>This link is no longer valid</h2><p>Please reply to the email you received.</p></div>'
          : t.slots.length
            ? `<div class="card"><h2>Choose a time</h2><p class="muted" id="msg" role="status"></p>${t.slots.map((s) => `<p><button data-slot="${esc(s)}">${when(s)}</button></p>`).join("")}</div>`
            : '<div class="card"><h2>No times left</h2><p>All the offered times have been taken. Please reply to the email you received and we will offer new ones.</p></div>'
    }`;
    box.querySelectorAll("[data-slot]").forEach(
      (b) =>
        (b.onclick = async () => {
          box.querySelectorAll("[data-slot]").forEach((x) => (x.disabled = true));
          try {
            await call(`/slots/${encodeURIComponent(token)}`, { slot: b.dataset.slot });
            show(await call(`/slots/${encodeURIComponent(token)}`));
          } catch (e) {
            box.querySelector("#msg").textContent = e.message;
            show(await call(`/slots/${encodeURIComponent(token)}`).catch(() => t));
          }
        }),
    );
  };
  try {
    show(await call(`/slots/${encodeURIComponent(token)}`));
  } catch (e) {
    box.innerHTML = `<div class="card"><h2>Link not valid</h2><p>${esc(e.message)}</p></div>`;
  }
}

if (q.get("slot")) slotPicker(q.get("slot"));
else if (q.get("t")) tracker(q.get("t"));
else if (q.get("c")) jobs(q.get("c"));
else
  box.innerHTML =
    '<div class="card"><h2>Careers</h2><p>This link is incomplete.</p></div>';
