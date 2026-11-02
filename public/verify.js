// Public check of a training certificate number printed on a certificate.
const form = document.querySelector("#verify-form");
const out = document.querySelector("#verify-result");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const day = (d) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${d}T00:00:00Z`));

async function check(no) {
  out.innerHTML = '<p class="muted">Checking…</p>';
  let res;
  try {
    res = await fetch(`/api/certificates/verify/${encodeURIComponent(no)}`);
  } catch {
    out.innerHTML =
      '<p class="error-text">Could not reach the server. Check your connection and press Check again.</p>';
    return;
  }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    out.innerHTML = `<p class="error-text">${esc(d.error || "Could not check right now. Try again later.")}</p>`;
    return;
  }
  out.innerHTML = d.found
    ? `<div class="callout"><p><strong>${d.valid ? "Valid certificate" : "This certificate has expired"}</strong></p><p>${esc(d.name)} completed “${esc(d.course)}” (${esc(d.hours)} hours) at ${esc(d.company)} on ${day(d.completed_on)}.${d.expires_on ? ` ${d.valid ? "Valid until" : "Expired on"} ${day(d.expires_on)}.` : ""}</p><p><small>${esc(d.certificate_no)}</small></p></div>`
    : '<p class="error-text">No certificate has this number. Check it was typed exactly as printed.</p>';
}
form.onsubmit = (e) => {
  e.preventDefault();
  const no = form.no.value.trim();
  if (no) check(no);
};
const start = new URLSearchParams(location.search).get("no");
if (start) {
  form.no.value = start;
  check(start);
}
