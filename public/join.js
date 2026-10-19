const box = document.querySelector("#join");
const token = new URLSearchParams(location.search).get("t") || "";
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const KIND = {
  id_proof: "ID proof (Aadhaar, passport…)",
  address_proof: "Address proof",
  pan: "PAN card",
  education: "Education certificate",
  experience: "Experience / relieving letter",
  bank: "Cancelled cheque / passbook",
  other: "Other",
};
const fmt = (d) =>
  d
    ? new Intl.DateTimeFormat("en-IN", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${d}T00:00:00Z`))
    : "";
let data = null;

async function call(path, body, method) {
  const res = await fetch(`/api/join/${encodeURIComponent(token)}${path}`, {
    ...(body !== undefined || method ? { method: method || "POST" } : {}),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    headers: { "Content-Type": "application/json" },
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(new Error(out.error || "Something went wrong."), {
      status: res.status,
    });
  return out;
}
function say(text, bad = false) {
  const el = box.querySelector("#msg");
  if (!el) return;
  el.textContent = text;
  el.className = bad ? "error-text" : "muted";
  el.scrollIntoView({ block: "nearest" });
}
function rows(kind, list, n, fields) {
  return Array.from({ length: n }, (_, i) => {
    const r = list[i] || {};
    return `<div class="join-rows ${kind}">${fields
      .map(
        ([k, l, attrs = ""]) =>
          `<label>${l}<input name="${kind}_${k}_${i}" value="${esc(r[k])}" ${attrs}></label>`,
      )
      .join("")}</div>`;
  }).join("");
}
function steps(d) {
  const accepted = d.offer?.status === "accepted";
  const sent = ["submitted", "verified"].includes(d.status);
  return `<ul class="join-steps"><li class="done">1 · Offer</li><li class="${accepted ? "done" : ""}">2 · Accept</li><li class="${sent ? "done" : ""}">3 · Your details</li><li class="${d.status === "verified" ? "done" : ""}">4 · Verified</li></ul>`;
}

function draw() {
  const d = data;
  document.title = `${d.company} · Joining portal`;
  const o = d.offer;
  const f = d.form;
  const s = d.sensitive;
  let html = `<header><p class="eyebrow">${esc(d.company)}</p><h1>Welcome, ${esc(d.name)}</h1></header>${steps(d)}<p id="msg" class="muted" role="status"></p>`;
  if (!o) {
    box.innerHTML =
      html +
      `<div class="card"><p>Your offer is not available right now. Please contact HR.</p></div>`;
    return;
  }
  html += `<div class="card"><h2>Your offer</h2><p class="muted">${esc(o.designation)} · joining ${fmt(o.joining_date)}</p><div class="join-letter">${o.letter.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}<p><strong>${esc(o.letter.signoff)}</strong></p></div>`;
  if (o.status === "sent")
    html += `<form id="accept"><label>To accept, type your full name: <em>${esc(d.name)}</em><input name="full_name" autocomplete="name" required maxlength="100"></label><div class="actions spaced"><button type="submit">I accept this offer</button><button type="button" class="ghost" id="decline">I want to decline</button></div></form><form id="decline-form" hidden><label>Reason (optional)<input name="reason" maxlength="300"></label><div class="actions spaced"><button type="submit" class="secondary">Confirm decline</button></div></form>`;
  else html += `<div class="join-ok">You accepted this offer. Thank you.</div>`;
  html += `</div>`;
  if (o.status !== "accepted") {
    box.innerHTML = html;
    wire();
    return;
  }
  if (d.status === "verified")
    html += `<div class="join-ok">HR has verified your details. We look forward to seeing you on ${fmt(o.joining_date)}. Your login will be shared by HR.</div>`;
  else if (d.status === "submitted")
    html += `<div class="join-ok">Your details are with HR for review. We will email you if anything needs correcting.</div>`;
  if (d.status === "changes_requested" && d.hr_note)
    html += `<div class="join-note"><strong>HR asked for a correction:</strong> ${esc(d.hr_note)}</div>`;
  const ro = d.editable ? "" : "disabled";
  html += `<form id="details" class="card"><h2>Your details</h2><div class="form-grid">
    <label>Date of birth<input type="date" name="date_of_birth" value="${esc(f.date_of_birth)}" ${ro}></label>
    <label>Gender<select name="gender" ${ro}>${[
      ["", "—"],
      ["male", "Male"],
      ["female", "Female"],
      ["other", "Other"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${f.gender === v ? "selected" : ""}>${l}</option>`,
      )
      .join("")}</select></label>
    <label>Mobile<input name="phone" value="${esc(f.phone)}" maxlength="20" inputmode="tel" ${ro}></label>
    <label class="full">Current address<input name="address" value="${esc(f.address)}" maxlength="300" ${ro}></label>
    <label>Emergency contact name<input name="emergency_name" value="${esc(f.emergency_name)}" maxlength="100" ${ro}></label>
    <label>Emergency contact phone<input name="emergency_phone" value="${esc(f.emergency_phone)}" maxlength="20" inputmode="tel" ${ro}></label>
    <label>Relation<input name="emergency_relation" value="${esc(f.emergency_relation)}" maxlength="50" ${ro}></label>
  </div>
  <h2>Education</h2>${rows("edu", f.education || [], 3, [
    ["degree", "Degree"],
    ["institute", "Institute"],
    ["year", "Year", 'maxlength="4" inputmode="numeric"'],
    ["score", "Score"],
  ]).replaceAll("<input ", `<input ${ro} `)}
  <h2>Previous employment</h2>${rows("job", f.employment || [], 3, [
    ["employer", "Employer"],
    ["role", "Role"],
    ["from", "From", 'type="month"'],
    ["to", "To", 'type="month"'],
  ]).replaceAll("<input ", `<input ${ro} `)}`;
  if (d.encryption_configured)
    html += `<h2>Bank and ID numbers</h2><p class="muted">These are stored encrypted and shown only to authorised payroll staff.</p><div class="form-grid">
    <label>PAN<input name="pan" value="${esc(s.pan)}" maxlength="10" autocapitalize="characters" ${ro}></label>
    <label>UAN (if you have one)<input name="uan" value="${esc(s.uan)}" maxlength="12" inputmode="numeric" ${ro}></label>
    <label>Account holder name<input name="account_holder" value="${esc(s.account_holder)}" maxlength="100" ${ro}></label>
    <label>Bank name<input name="bank_name" value="${esc(s.bank_name)}" maxlength="60" ${ro}></label>
    <label>Account number<input name="bank_account" value="${esc(s.bank_account)}" maxlength="20" inputmode="numeric" ${ro}></label>
    <label>IFSC<input name="ifsc" value="${esc(s.ifsc)}" maxlength="11" autocapitalize="characters" ${ro}></label></div>`;
  html += `<h2>Documents</h2><p class="muted">PDF, JPG or PNG up to 2 MB each. An ID proof and an address proof are required.</p>${
    d.documents.length
      ? d.documents
          .map(
            (x) =>
              `<div class="join-doc"><span>${esc(x.name)} · ${esc(KIND[x.kind] || x.kind)}${x.verified ? " · verified" : ""}</span>${d.editable ? `<button type="button" class="ghost" data-del="${x.id}">Remove</button>` : ""}</div>`,
          )
          .join("")
      : ""
  }`;
  if (d.editable)
    html += `<div class="form-grid"><label>Document type<select id="doc-kind">${d.doc_kinds.map((k) => `<option value="${k}">${esc(KIND[k] || k)}</option>`).join("")}</select></label><label>File<input type="file" id="doc-file" accept="application/pdf,image/jpeg,image/png"></label></div><div class="actions"><button type="button" class="secondary" id="doc-add">Upload document</button></div>`;
  if (d.editable)
    html += `<div class="actions spaced"><button type="button" class="secondary" id="save">Save and continue later</button><button type="submit">Submit to HR</button></div>`;
  html += `</form>`;
  box.innerHTML = html;
  wire();
}

function collect() {
  const form = box.querySelector("#details");
  const g = (n) => form.elements[n]?.value.trim() ?? "";
  const out = {};
  for (const k of [
    "date_of_birth",
    "gender",
    "phone",
    "address",
    "emergency_name",
    "emergency_phone",
    "emergency_relation",
  ])
    out[k] = g(k);
  out.education = [0, 1, 2]
    .map((i) => ({
      degree: g(`edu_degree_${i}`),
      institute: g(`edu_institute_${i}`),
      year: g(`edu_year_${i}`),
      score: g(`edu_score_${i}`),
    }))
    .filter((r) => Object.values(r).some(Boolean));
  out.employment = [0, 1, 2]
    .map((i) => ({
      employer: g(`job_employer_${i}`),
      role: g(`job_role_${i}`),
      from: g(`job_from_${i}`),
      to: g(`job_to_${i}`),
    }))
    .filter((r) => Object.values(r).some(Boolean));
  if (data.encryption_configured)
    for (const k of [
      "pan",
      "uan",
      "account_holder",
      "bank_name",
      "bank_account",
      "ifsc",
    ])
      out[k] = g(k);
  return out;
}
async function saveForm() {
  await call("/form", collect(), "PUT");
}
const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("The file could not be read."));
    r.readAsDataURL(file);
  });
async function reload(message) {
  data = await call("", undefined, "GET");
  draw();
  if (message) say(message);
}
function guard(button, fn) {
  return async (e) => {
    e?.preventDefault();
    if (button) button.disabled = true;
    try {
      await fn();
    } catch (err) {
      say(err.message, true);
    } finally {
      if (button) button.disabled = false;
    }
  };
}
function wire() {
  const accept = box.querySelector("#accept");
  if (accept)
    accept.onsubmit = guard(
      accept.querySelector("button[type=submit]"),
      async () => {
        await call("/accept", { full_name: accept.elements.full_name.value });
        await reload("Offer accepted. Please fill in your details below.");
      },
    );
  box.querySelector("#decline")?.addEventListener("click", () => {
    box.querySelector("#decline-form").hidden = false;
  });
  const dec = box.querySelector("#decline-form");
  if (dec)
    dec.onsubmit = guard(dec.querySelector("button"), async () => {
      await call("/decline", { reason: dec.elements.reason.value });
      box.innerHTML = `<div class="card"><h2>Offer declined</h2><p>Thank you for letting us know. We wish you the best.</p></div>`;
    });
  const details = box.querySelector("#details");
  if (!details) return;
  box.querySelector("#save")?.addEventListener(
    "click",
    guard(box.querySelector("#save"), async () => {
      await saveForm();
      await reload("Saved. You can come back to this link any time.");
    }),
  );
  details.onsubmit = guard(
    details.querySelector("button[type=submit]"),
    async () => {
      await saveForm();
      await call("/submit", {});
      await reload("Submitted to HR. Thank you.");
    },
  );
  box.querySelector("#doc-add")?.addEventListener(
    "click",
    guard(box.querySelector("#doc-add"), async () => {
      const file = box.querySelector("#doc-file").files[0];
      if (!file) throw new Error("Choose a file first.");
      if (file.size > 2 * 1024 * 1024)
        throw new Error("Files can be up to 2 MB.");
      if (!["application/pdf", "image/jpeg", "image/png"].includes(file.type))
        throw new Error("Use a PDF, JPG or PNG file.");
      // Keep what has been typed so far; the page redraws after an upload.
      await saveForm();
      await call("/documents", {
        kind: box.querySelector("#doc-kind").value,
        name: file.name.replace(/\.[^.]+$/, "").slice(0, 100) || "document",
        mime: file.type,
        data: await toBase64(file),
      });
      await reload("Uploaded.");
    }),
  );
  box.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = guard(b, async () => {
      await saveForm();
      await call(`/documents/${b.dataset.del}`, undefined, "DELETE");
      await reload("Removed.");
    });
  });
}

(async () => {
  try {
    data = await call("", undefined, "GET");
    draw();
  } catch (e) {
    box.innerHTML = `<div class="card"><h2>${e.status === 410 ? "This link is closed" : "Link not valid"}</h2><p>${esc(e.message)}</p></div>`;
  }
})();
