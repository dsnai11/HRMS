// The certificate itself: used by the printable page (letter.js) and the design preview.
// esc comes from whichever page loads this file.
function certificateHtml(c) {
  const facts = [`Completed on ${c.completed}`, c.hours > 0 ? `${c.hours} ${c.hours === 1 ? "hour" : "hours"}` : "", c.score != null ? `Score ${c.score}%` : ""].filter(Boolean).join(" · ");
  return `<div class="cert-frame"><article class="cert cert-${esc(c.style)}">
    <header class="cert-top"><img class="cert-logo" src="${esc(c.logo_url)}" alt=""><div class="cert-company">${esc(c.company)}</div></header>
    <h1 class="cert-title">${esc(c.title)}</h1>
    <p class="cert-lead">This is to certify that</p>
    <p class="cert-name">${esc(c.person)}</p>
    <p class="cert-lead">${esc(c.message)}</p>
    <p class="cert-course">${esc(c.course)}</p>
    <p class="cert-facts">${esc(facts)}${c.validity ? `<br>${esc(c.validity)}` : ""}</p>
    <footer class="cert-foot">
      <div class="cert-ref">Certificate no. ${esc(c.number)}${c.link ? `<small>Check it at ${esc(c.link)}</small>` : ""}</div>
      <div class="cert-seal">${c.seal_url ? `<img src="${esc(c.seal_url)}" alt="Company seal">` : ""}</div>
      <div class="cert-sign"><div class="cert-sign-img">${c.signature_url ? `<img src="${esc(c.signature_url)}" alt="Signature">` : ""}</div><strong>${esc(c.signatory_name || "Authorised signatory")}</strong><small>${esc(c.signatory_title || `For ${c.company}`)}</small></div>
    </footer>
  </article></div>`;
}
function certificateColour(root, color) {
  root.querySelector(".cert").style.setProperty("--cert", color);
}
