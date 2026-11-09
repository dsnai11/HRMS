// The certificate itself: used by the printable page (letter.js) and the design screen.
// Every border, rosette and medal is drawn here as vector art, so it prints sharp at any size.
// esc comes from whichever page loads this file. Colours follow --cert (see styles.css).
const CV_W = 1188;
const CV_H = 840;
const CV_TAU = Math.PI * 2;
const cvN = (v) => v.toFixed(1);

// A point travelling round a rounded rectangle, with the direction pointing outwards.
function cvRing(x, y, w, h, r) {
  const sx = w - 2 * r;
  const sy = h - 2 * r;
  const a = (Math.PI * r) / 2;
  const length = 2 * sx + 2 * sy + 4 * a;
  const at = (dist) => {
    let s = dist % length;
    if (s < sx) return [x + r + s, y, 0, -1];
    s -= sx;
    if (s < a) { const t = s / r; return [x + w - r + r * Math.sin(t), y + r - r * Math.cos(t), Math.sin(t), -Math.cos(t)]; }
    s -= a;
    if (s < sy) return [x + w, y + r + s, 1, 0];
    s -= sy;
    if (s < a) { const t = s / r; return [x + w - r + r * Math.cos(t), y + h - r + r * Math.sin(t), Math.cos(t), Math.sin(t)]; }
    s -= a;
    if (s < sx) return [x + w - r - s, y + h, 0, 1];
    s -= sx;
    if (s < a) { const t = s / r; return [x + r - r * Math.sin(t), y + h - r + r * Math.cos(t), -Math.sin(t), Math.cos(t)]; }
    s -= a;
    if (s < sy) return [x, y + h - r - s, -1, 0];
    s -= sy;
    const t = s / r;
    return [x + r - r * Math.cos(t), y + r - r * Math.sin(t), -Math.cos(t), -Math.sin(t)];
  };
  return { length, at };
}

// Interlaced waves round a frame, the engraved band of a banknote.
function cvGuilloche(ring, amp, waves, strands, attrs) {
  const count = Math.round(ring.length / 2.4);
  let d = "";
  for (let j = 0; j < strands; j++) {
    const phase = (CV_TAU * j) / strands;
    const pts = [];
    for (let i = 0; i < count; i++) {
      const u = (CV_TAU * i) / count;
      const [x, y, nx, ny] = ring.at((ring.length * i) / count);
      const off = amp * Math.sin(waves * u + phase) * (0.74 + 0.26 * Math.cos(waves * 2 * u));
      pts.push(`${cvN(x + nx * off)} ${cvN(y + ny * off)}`);
    }
    d += `M${pts.join(" ")}Z`;
  }
  return `<path fill="none" d="${d}" ${attrs}/>`;
}

// A spirograph rosette centred on 0,0.
function cvRosette(radius, depth, petals, strands, attrs) {
  const count = 360;
  let d = "";
  for (let j = 0; j < strands; j++) {
    const phase = (CV_TAU * j) / strands / petals;
    const pts = [];
    for (let i = 0; i < count; i++) {
      const t = (CV_TAU * i) / count;
      const r = radius - depth + depth * Math.sin(petals * (t + phase));
      pts.push(`${cvN(r * Math.cos(t))} ${cvN(r * Math.sin(t))}`);
    }
    d += `M${pts.join(" ")}Z`;
  }
  return `<path fill="none" d="${d}" ${attrs}/>`;
}

const CV_GOLD = 'stroke="url(#cvGold)"';
const cvRect = (x, y, w, h, r) => `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
const cvNotched = (x, y, w, h, r) => `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 0 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 0 ${x + w - r} ${y + h}H${x + r}A${r} ${r} 0 0 0 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 0 ${x + r} ${y}Z`;
const cvCorners = (pts, inner) => pts.map(([x, y]) => `<g transform="translate(${x} ${y})">${inner}</g>`).join("");

const CV_DEFS = `<defs>
  <linearGradient id="cvGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8f6a18"/><stop offset=".28" stop-color="#ecd48c"/><stop offset=".5" stop-color="#b98c2e"/><stop offset=".74" stop-color="#f7e9b6"/><stop offset="1" stop-color="#9a7320"/></linearGradient>
  <radialGradient id="cvPaper" cx=".5" cy=".46" r=".78"><stop offset="0" stop-color="#fffefa"/><stop offset=".72" stop-color="#fdf8ea"/><stop offset="1" stop-color="#f4ead0"/></radialGradient>
  <radialGradient id="cvDeep" cx=".5" cy=".42" r=".86"><stop offset="0" class="cs-main"/><stop offset=".55" class="cs-dark"/><stop offset="1" class="cs-deep"/></radialGradient>
  <linearGradient id="cvSweep" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="cs-main"/><stop offset="1" class="cs-deep"/></linearGradient>
</defs>`;

const CV_ART = {
  heritage: () => {
    const corner = `<circle r="46" class="ca-dark" stroke="url(#cvGold)" stroke-width="2.5"/>${cvRosette(38, 11, 8, 7, `${CV_GOLD} stroke-width=".8"`)}<circle r="6" fill="url(#cvGold)"/>`;
    return `<rect width="${CV_W}" height="${CV_H}" fill="url(#cvPaper)"/>
      <g transform="translate(594 395)" opacity=".1">${cvRosette(285, 62, 18, 16, 'class="ca-line" stroke-width=".8"')}${cvRosette(170, 40, 12, 12, 'class="ca-line" stroke-width=".7"')}</g>
      <path class="ca-dark" fill-rule="evenodd" d="${cvRect(16, 16, 1156, 808, 8)}${cvRect(66, 66, 1056, 708, 3)}"/>
      ${cvGuilloche(cvRing(41, 41, 1106, 758, 6), 17, 118, 5, `${CV_GOLD} stroke-width=".85"`)}
      <path fill="none" ${CV_GOLD} stroke-width="2.5" d="${cvRect(24, 24, 1140, 792, 6)}"/>
      <path fill="none" ${CV_GOLD} stroke-width="3" d="${cvRect(66, 66, 1056, 708, 3)}"/>
      <path fill="none" class="ca-line" stroke-width="1" d="${cvRect(76, 76, 1036, 688, 2)}"/>
      ${cvCorners([[62, 62], [1126, 62], [62, 778], [1126, 778]], corner)}`;
  },
  prestige: () => {
    let waves = "";
    for (let row = -2; row < 30; row++) {
      const pts = [];
      for (let x = 0; x <= CV_W; x += 6) pts.push(`${x} ${cvN(row * 30 + 26 * Math.sin(x / 74 + row * 0.42) + 9 * Math.sin(x / 23))}`);
      waves += `M${pts.join(" ")}`;
    }
    return `<rect width="${CV_W}" height="${CV_H}" fill="url(#cvDeep)"/>
      <path fill="none" ${CV_GOLD} stroke-width=".8" opacity=".55" d="${waves}"/>
      <path fill="url(#cvPaper)" d="${cvNotched(52, 52, 1084, 736, 48)}"/>
      <path fill="none" ${CV_GOLD} stroke-width="4" d="${cvNotched(52, 52, 1084, 736, 48)}"/>
      <path fill="none" ${CV_GOLD} stroke-width="1.4" d="${cvNotched(66, 66, 1056, 708, 48)}"/>
      <path fill="none" class="ca-line" stroke-width=".8" d="${cvNotched(74, 74, 1040, 692, 48)}"/>
      <g transform="translate(594 420)" opacity=".08">${cvRosette(270, 58, 16, 14, 'class="ca-line" stroke-width=".8"')}</g>
      ${cvCorners([[52, 52], [1136, 52], [52, 788], [1136, 788]], `<circle r="30" fill="none" ${CV_GOLD} stroke-width="1.5"/>${cvRosette(25, 7, 8, 6, `${CV_GOLD} stroke-width=".7"`)}`)}`;
  },
  executive: () => {
    const edge = (o) => `M${330 + o} 0C${410 + o} 250 ${262 + o} 560 ${372 + o} 840`;
    let lines = "";
    for (let i = 1; i < 18; i++) lines += edge(-i * 19);
    return `<rect width="${CV_W}" height="${CV_H}" fill="url(#cvPaper)"/>
      <g transform="translate(790 420)" opacity=".09">${cvRosette(300, 64, 18, 16, 'class="ca-line" stroke-width=".8"')}</g>
      <path fill="url(#cvDeep)" d="${edge(0)}H0V0Z"/>
      <path fill="none" ${CV_GOLD} stroke-width=".9" opacity=".6" d="${lines}"/>
      <path fill="none" ${CV_GOLD} stroke-width="6" d="${edge(0)}"/>
      <path fill="none" ${CV_GOLD} stroke-width="1.5" d="${edge(14)}"/>
      <g transform="translate(160 650)">${cvRosette(112, 26, 14, 14, `${CV_GOLD} stroke-width=".8"`)}${cvRosette(58, 14, 10, 10, `${CV_GOLD} stroke-width=".7"`)}</g>
      <path fill="none" ${CV_GOLD} stroke-width="1.6" d="M1164 24H420M1164 816H470M1164 24V816"/>`;
  },
  sovereign: () => {
    const corner = `${cvRosette(50, 14, 10, 9, `${CV_GOLD} stroke-width=".85"`)}<circle r="7" fill="url(#cvGold)"/>`;
    return `<rect width="${CV_W}" height="${CV_H}" fill="url(#cvDeep)"/>
      <g transform="translate(594 400)" opacity=".16">${cvRosette(300, 66, 20, 18, `${CV_GOLD} stroke-width=".8"`)}${cvRosette(180, 42, 14, 12, `${CV_GOLD} stroke-width=".7"`)}</g>
      ${cvGuilloche(cvRing(34, 34, 1120, 772, 4), 12, 148, 4, `${CV_GOLD} stroke-width=".9"`)}
      <path fill="none" ${CV_GOLD} stroke-width="2.5" d="${cvRect(16, 16, 1156, 808, 4)}"/>
      <path fill="none" ${CV_GOLD} stroke-width="2.5" d="${cvRect(54, 54, 1080, 732, 2)}"/>
      <path fill="none" ${CV_GOLD} stroke-width=".9" d="${cvRect(64, 64, 1060, 712, 2)}"/>
      ${cvCorners([[122, 122], [1066, 122], [122, 718], [1066, 718]], corner)}`;
  },
  horizon: () => {
    let rings = "";
    for (let r = 60; r < 400; r += 15) rings += `M${CV_W - r} 0A${r} ${r} 0 0 0 ${CV_W} ${r}`;
    let low = "";
    for (let r = 40; r < 260; r += 13) low += `M${r} ${CV_H}A${r} ${r} 0 0 0 0 ${CV_H - r}`;
    return `<rect width="${CV_W}" height="${CV_H}" fill="#fffefb"/>
      <g transform="translate(600 450)" opacity=".07">${cvRosette(290, 62, 18, 16, 'class="ca-line" stroke-width=".8"')}</g>
      <path fill="url(#cvGold)" d="M640 0H700L1188 372V428Z"/>
      <path fill="url(#cvSweep)" d="M690 0H1188V384Z"/>
      <path class="ca-deep" d="M880 0H1188V235Z"/>
      <path fill="none" ${CV_GOLD} stroke-width="1" opacity=".75" d="${rings}"/>
      <path fill="url(#cvGold)" d="M0 610V650L268 840H214Z"/>
      <path fill="url(#cvSweep)" d="M0 636V840H256Z"/>
      <path fill="none" ${CV_GOLD} stroke-width="1" opacity=".7" d="${low}"/>
      <path fill="none" ${CV_GOLD} stroke-width="1.5" d="M26 26H600M1162 460V814H300"/>`;
  },
};

const cvArtCache = {};
function cvArt(style) {
  cvArtCache[style] ??= `<svg class="cert-art" viewBox="0 0 ${CV_W} ${CV_H}" preserveAspectRatio="none" aria-hidden="true">${CV_DEFS}${CV_ART[style]()}</svg>`;
  return cvArtCache[style];
}

// The gold medal on two ribbons. An uploaded company seal sits in its centre.
function cvMedal(c, style) {
  const cx = 120;
  const cy = 112;
  const edge = [];
  for (let i = 0; i < 360; i++) {
    const t = (CV_TAU * i) / 360;
    const r = 100 + 5.5 * Math.cos(36 * t);
    edge.push(`${cvN(cx + r * Math.cos(t))} ${cvN(cy + r * Math.sin(t))}`);
  }
  let leaves = "";
  for (const side of [-1, 1])
    for (let i = 0; i < 9; i++) {
      const a = ((90 + side * (30 + i * 15.5)) * Math.PI) / 180;
      const x = cx + 45 * Math.cos(a);
      const y = cy + 45 * Math.sin(a);
      leaves += `<ellipse cx="${cvN(x)}" cy="${cvN(y)}" rx="9.5" ry="3.6" fill="url(#cvGold)" transform="rotate(${cvN((a * 180) / Math.PI + side * 62)} ${cvN(x)} ${cvN(y)})"/>`;
    }
  const star = [];
  for (let i = 0; i < 10; i++) {
    const a = (CV_TAU * i) / 10 - Math.PI / 2;
    const r = i % 2 ? 11 : 26;
    star.push(`${cvN(cx + r * Math.cos(a))} ${cvN(cy + r * Math.sin(a))}`);
  }
  const ringId = `cvMedalRing-${style}`;
  const centre = c.seal_url
    ? `<circle cx="${cx}" cy="${cy}" r="84" fill="#fffdf6"/><image href="${esc(c.seal_url)}" x="${cx - 70}" y="${cy - 70}" width="140" height="140" preserveAspectRatio="xMidYMid meet"/>`
    : `<circle cx="${cx}" cy="${cy}" r="84" class="ca-dark"/><circle cx="${cx}" cy="${cy}" r="82" fill="none" stroke="url(#cvGold)" stroke-width="1.5"/><circle cx="${cx}" cy="${cy}" r="59" fill="none" stroke="url(#cvGold)" stroke-width="1"/>
       <path id="${ringId}" fill="none" d="M${cx} ${cy - 65}a65 65 0 1 1 -.01 0"/>
       <text class="ca-medal-text" fill="#f3dfa1"><textPath href="#${ringId}" textLength="396" lengthAdjust="spacingAndGlyphs">${esc(String(c.company).toUpperCase())} ★ CERTIFIED ★ </textPath></text>
       ${leaves}<polygon points="${star.join(" ")}" fill="url(#cvGold)"/>`;
  return `<svg class="cert-medal" viewBox="0 0 240 310" aria-hidden="true">${CV_DEFS}
    <path class="ca-main" d="M78 170L38 300L74 284L98 310L132 186Z"/><path class="ca-deep" d="M162 170L202 300L166 284L142 310L108 186Z"/>
    <path fill="none" stroke="url(#cvGold)" stroke-width="2" d="M76 180L44 288M164 180L196 288"/>
    <polygon points="${edge.join(" ")}" fill="url(#cvGold)" stroke="#7d5a12" stroke-width=".8"/>
    <circle cx="${cx}" cy="${cy}" r="91" fill="none" stroke="#7d5a12" stroke-width="1"/>
    ${centre}</svg>`;
}

const CV_RULE = '<svg class="cert-rule" viewBox="0 0 400 14" aria-hidden="true"><path fill="url(#cvGold)" d="M0 6.4H176V7.6H0ZM224 6.4H400V7.6H224ZM200 0L207 7L200 14L193 7ZM184 4L187 7L184 10L181 7ZM216 4L219 7L216 10L213 7Z"/></svg>';

function certificateHtml(c) {
  const style = CV_ART[c.style] ? c.style : "heritage";
  const facts = [`Completed on ${c.completed}`, c.hours > 0 ? `${c.hours} ${c.hours === 1 ? "hour" : "hours"}` : "", c.score != null ? `Score ${c.score}%` : ""].filter(Boolean).join("  ·  ");
  const parts = /^(certificate)\s+(of\s+.+)$/i.exec(String(c.title).trim());
  const title = parts ? `<span class="cert-title-main">${esc(parts[1])}</span><span class="cert-title-sub">${esc(parts[2])}</span>` : `<span class="cert-title-main">${esc(c.title)}</span>`;
  const person = String(c.person);
  const nameSize = person.length > 34 ? " cert-name-s" : person.length > 24 ? " cert-name-m" : "";
  return `<div class="cert-frame"><article class="cert cert-${style}">${cvArt(style)}
    <div class="cert-medal-wrap">${cvMedal(c, style)}</div>
    <div class="cert-body">
      <header class="cert-top"><span class="cert-plaque"><img class="cert-logo" src="${esc(c.logo_url)}" alt=""></span><div class="cert-company">${esc(c.company)}</div></header>
      <h1 class="cert-title">${title}</h1>
      <p class="cert-lead">This is to certify that</p>
      <p class="cert-name${nameSize}">${esc(person)}</p>
      ${CV_RULE}
      <p class="cert-lead">${esc(c.message)}</p>
      <p class="cert-course${String(c.course).length > 46 ? " cert-course-s" : ""}">${esc(c.course)}</p>
      <p class="cert-facts">${esc(facts)}${c.validity ? `<br>${esc(c.validity)}` : ""}</p>
      <footer class="cert-foot">
        <div class="cert-ref"><strong>Certificate no.</strong>${esc(c.number)}${c.link ? `<small>Verify at ${esc(c.link)}</small>` : ""}</div>
        <div class="cert-foot-gap"></div>
        <div class="cert-sign"><div class="cert-sign-img">${c.signature_url ? `<img src="${esc(c.signature_url)}" alt="Signature">` : ""}</div><strong>${esc(c.signatory_name || "Authorised signatory")}</strong><small>${esc(c.signatory_title || `For ${c.company}`)}</small></div>
      </footer>
    </div>
  </article></div>`;
}
function certificateColour(root, color) {
  root.querySelectorAll(".cert").forEach((c) => c.style.setProperty("--cert", color));
}
