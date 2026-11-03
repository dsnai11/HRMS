// Appearance & branding (administrators): the brand colour, an accent and the logo. The web
// portal and the phone app both take their colours from here. Also: profile photographs.

// What the portal shows before and after sign-in (logo, name), refreshed when it changes.
let branding = null;
async function loadBranding() {
  branding = await api("/branding").catch(() => null);
}
const brandLogoSrc = () => branding?.logo_url || "/brand/logo.png";
// Re-reads the brand stylesheet so a new colour shows at once.
function refreshBrandCss() {
  const link = document.querySelector('link[href^="/api/branding.css"]');
  if (link) link.href = `/api/branding.css?v=${Date.now()}`;
}

// A photo shrunk to at most 512 px on its longer side, as a JPEG (base64 without the prefix).
async function shrinkProfilePhoto(file) {
  if (!["image/jpeg", "image/png"].includes(file.type)) throw new Error("Choose a JPG or PNG photo.");
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("That file could not be read as a photo."));
      i.src = url;
    });
    const scale = Math.min(1, 512 / Math.max(img.width, img.height));
    const canvas = Object.assign(document.createElement("canvas"), {
      width: Math.round(img.width * scale),
      height: Math.round(img.height * scale),
    });
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
  } finally {
    URL.revokeObjectURL(url);
  }
}
// A round photo, or initials when there is none.
const avatarHtml = (person, cls = "avatar") =>
  person?.photo_at
    ? `<span class="${cls} has-photo"><img src="/api/people/${person.id}/photo?v=${encodeURIComponent(person.photo_at)}" alt=""></span>`
    : `<span class="${cls}">${initials(person?.name || "")}</span>`;

// Profile page: the photo card, with upload and remove.
async function photoCard(id) {
  if (id !== renderId) return;
  const card = document.createElement("div");
  card.className = "card photo-card";
  card.innerHTML = `<div class="photo-row">${avatarHtml(me, "avatar avatar-xl")}<div><h2>Profile photo</h2><p class="muted">Shown to colleagues in the app and the portal. A clear, recent photo of your face, like a passport photo, works best.</p><div class="actions"><label class="button secondary file-button">${me.photo_at ? "Change photo" : "Upload photo"}<input type="file" id="photo-file" accept="image/jpeg,image/png" hidden></label>${me.photo_at ? '<button type="button" class="ghost" id="photo-remove">Remove</button>' : ""}</div></div></div>`;
  const content = document.querySelector("#content");
  content.insertBefore(card, content.children[1] ?? null);
  card.querySelector("#photo-file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = await shrinkProfilePhoto(file);
      await api("/profile/photo", { mime: "image/jpeg", data }, "PUT");
      await loadMe();
      notice("Photo updated.");
      render();
    } catch (err) {
      notice(err.message, true);
    }
  };
  card.querySelector("#photo-remove")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      await api("/profile/photo", undefined, "DELETE");
      await loadMe();
      notice("Photo removed.");
      render();
    }),
  );
}

async function brandingPage(id) {
  const b = await api("/admin/branding");
  if (id !== renderId) return;
  const p = b.palette;
  document.querySelector("#content").innerHTML =
    heading("Appearance & branding", "The colours and logo of the web portal and the phone app.") +
    `<div class="brand-admin"><div class="card"><h2>Colours</h2><p class="muted">Pick the brand colour; every shade (buttons, menus, highlights, night mode) is worked out from it. White text has to be readable on it, so very light colours are refused.</p><form id="brand-form" class="form-grid"><label>Brand colour<span class="color-field"><input type="color" name="primary" value="${esc(p.primary)}" aria-describedby="brand-contrast"><input name="primary_text" value="${esc(p.primary)}" maxlength="7" pattern="#[0-9a-fA-F]{6}" aria-label="Brand colour code"></span></label><label>Accent (optional)<span class="color-field"><input type="color" name="accent" value="${esc(b.accent || p.accent)}"><input name="accent_text" value="${esc(b.accent || "")}" maxlength="7" placeholder="Worked out" aria-label="Accent colour code"></span></label><p class="full" id="brand-contrast" aria-live="polite"></p><div class="actions full"><button>Save colours</button><button type="button" class="ghost" id="brand-reset">Back to Laxmi red</button></div></form></div><div class="card"><h2>Preview</h2><div class="brand-preview" id="brand-preview"><div class="bp-bar"><span class="bp-dot"></span><strong>Laxmi HRMS</strong></div><div class="bp-body"><div class="bp-card"><small>Today's attendance</small><strong>09:14</strong><span class="bp-btn">Punch Out</span></div><div class="bp-chips"><span class="bp-chip on">Approved</span><span class="bp-chip">Pending</span></div></div></div><p class="muted">The phone app picks up the new colours the next time it opens.</p></div><div class="card"><h2>Logo</h2><p class="muted">PNG or JPG, up to 512 KB, on a white or clear background. Shown on the sign-in page, in the menu and in the phone app.</p><div class="logo-box"><img src="${esc(b.logo_url || "/brand/logo.png")}" alt="Current logo"></div><div class="actions"><label class="button secondary file-button">Upload logo<input type="file" id="logo-file" accept="image/png,image/jpeg" hidden></label>${b.logo_url ? '<button type="button" class="ghost" id="logo-remove">Use the standard logo</button>' : ""}</div></div></div>`;
  const form = document.querySelector("#brand-form");
  const preview = document.querySelector("#brand-preview");
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (hex) => 1.05 / (lum(hex) + 0.05);
  const show = () => {
    const hex = form.primary.value;
    const r = Math.round(ratio(hex) * 10) / 10;
    preview.querySelectorAll(".bp-bar, .bp-btn, .bp-chip.on, .bp-dot").forEach((el) => (el.style.background = hex));
    const out = document.querySelector("#brand-contrast");
    out.textContent = r >= 4.5 ? `White text on this colour: ${r}:1, readable.` : `White text on this colour: ${r}:1. It needs at least 4.5:1: choose a darker colour.`;
    out.className = `full ${r >= 4.5 ? "muted" : "error-text"}`;
  };
  const sync = (picker, text) => {
    form[picker].oninput = () => ((form[text].value = form[picker].value), show());
    form[text].oninput = () => {
      if (/^#[0-9a-f]{6}$/i.test(form[text].value)) {
        form[picker].value = form[text].value;
        show();
      }
    };
  };
  sync("primary", "primary_text");
  sync("accent", "accent_text");
  show();
  const after = async (msg) => {
    refreshBrandCss();
    await Promise.all([loadMe(), loadBranding()]);
    notice(msg);
    render();
  };
  form.onsubmit = (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      await api("/admin/branding", { primary: form.primary_text.value || null, accent: form.accent_text.value || null }, "PUT");
      await after("Colours saved for the portal and the phone app.");
    });
  };
  document.querySelector("#brand-reset").onclick = (e) =>
    busy(e.currentTarget, async () => {
      await api("/admin/branding", { primary: null, accent: null }, "PUT");
      await after("Back to the standard colours.");
    });
  document.querySelector("#logo-file").onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      if (!["image/png", "image/jpeg"].includes(file.type)) throw new Error("Choose a PNG or JPG.");
      if (file.size > 512 * 1024) throw new Error("The logo can be up to 512 KB.");
      await api("/admin/branding/logo", { mime: file.type, data: await toB64(file) }, "PUT");
      await after("Logo updated.");
    } catch (err) {
      notice(err.message, true);
    }
  };
  document.querySelector("#logo-remove")?.addEventListener("click", (e) =>
    busy(e.currentTarget, async () => {
      await api("/admin/branding/logo", undefined, "DELETE");
      await after("Using the standard logo.");
    }),
  );
}
