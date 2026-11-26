// An ex-employee's private page: only the documents HR has allowed, nothing else.
const box = document.querySelector("#alumni");
// Keep the private link out of the address bar once read; a refresh in this tab still works.
let token = new URLSearchParams(location.search).get("t") || "";
try {
  if (token) sessionStorage.setItem("alumni-t", token);
  else token = sessionStorage.getItem("alumni-t") || "";
} catch {}
if (location.search) history.replaceState(null, "", location.pathname);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const day = (d) =>
  d
    ? new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${d.slice(0, 10)}T00:00:00Z`))
    : "";

async function load() {
  if (!token) {
    box.innerHTML = '<p class="error-text">This link is incomplete. Open it again from the email HR sent you.</p>';
    return;
  }
  let res;
  try {
    res = await fetch(`/api/alumni/${encodeURIComponent(token)}`);
  } catch {
    box.innerHTML = '<p class="error-text">Could not reach the server. Check your connection and refresh.</p>';
    return;
  }
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    box.innerHTML = `<p class="error-text">${esc(d.error || "This link does not work.")}</p>`;
    return;
  }
  document.title = `${d.company}: your documents`;
  box.innerHTML = `<p><strong>${esc(d.name)}</strong>${d.employee_code ? ` <span class="muted">(${esc(d.employee_code)})</span>` : ""}</p><p class="muted">Documents ${esc(d.company)} has shared with you. This link works until ${day(d.expires_at)}.</p>${
    d.items.length
      ? `<div class="alumni-list">${d.items
          .map(
            (i) =>
              `<div class="activity"><strong>${esc(i.title)}</strong> <small>${day(i.date)}</small> <a class="button secondary" href="/api/alumni/${encodeURIComponent(token)}/file/${i.kind}/${i.id}">Download</a></div>`,
          )
          .join("")}</div>`
      : '<p class="muted">Nothing has been shared yet. Contact HR if you need a document.</p>'
  }`;
}
load();
