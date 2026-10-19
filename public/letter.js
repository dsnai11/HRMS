const box = document.querySelector("#letter");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
(async () => {
  const q = new URLSearchParams(location.search);
  const id = Number(q.get("id"));
  const path =
    q.get("type") === "offer"
      ? `/api/admin/offers/${id}/letter`
      : q.get("type") === "change"
        ? `/api/admin/changes/${id}/letter`
        : `/api/admin/exits/${id}/letter?kind=${encodeURIComponent(q.get("kind") || "experience")}`;
  const res = await fetch(path);
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    box.innerHTML = `<p class="error-text">${res.status === 401 ? "Please sign in to the portal first, then reopen this page." : esc(e.error || "This letter is not available.")}</p>`;
    return;
  }
  const d = await res.json();
  document.title = `${d.title} · ${d.to}`;
  box.innerHTML = `<article class="slip letter"><header><div><h1>${esc(d.company)}</h1></div><button class="no-print" id="print">Print / save as PDF</button></header><p class="letter-date">${esc(d.date)}</p><h2>${esc(d.title)}</h2><p><strong>${esc(d.to)}</strong></p>${d.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}<p class="letter-sign">${esc(d.signoff)}<br><br><br>Authorised signatory</p></article>`;
  box.querySelector("#print")?.addEventListener("click", () => print());
})();
