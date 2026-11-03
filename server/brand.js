// Brand colours: an administrator picks one colour (and optionally an accent); the shades the
// portal and the phone app need are worked out from it, so every screen stays consistent and
// readable. The phone app has the same calculation (mobile/src/theme.ts).
export const DEFAULT_PRIMARY = "#c8102e";
export const HEX = /^#[0-9a-f]{6}$/i;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c) => "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
/** Mix `hex` towards `toward` (another hex) by `amount` (0 = unchanged, 1 = the other colour). */
export const mix = (hex, toward, amount) => {
  const a = rgb(hex),
    b = rgb(toward);
  return toHex(a.map((v, i) => v + (b[i] - v) * amount));
};
const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

/** The named shades used by the portal (CSS variables) and the app (theme tokens). */
export function palette(primary = DEFAULT_PRIMARY, accent = null) {
  const p = HEX.test(primary ?? "") ? primary.toLowerCase() : DEFAULT_PRIMARY;
  // Night mode needs a lighter tone of the brand colour for text on dark panels.
  let nightText = mix(p, "#ffffff", 0.45);
  for (let i = 0; i < 6 && contrast(nightText, "#12141c") < 4.5; i++) nightText = mix(nightText, "#ffffff", 0.2);
  return {
    primary: p,
    dark: mix(p, "#000000", 0.14),
    deeper: mix(p, "#000000", 0.3),
    ink: mix(p, "#000000", 0.62),
    hot: mix(p, "#ffffff", 0.18),
    soft: mix(p, "#ffffff", 0.9),
    softer: mix(p, "#ffffff", 0.95),
    border: mix(p, "#ffffff", 0.82),
    night: mix(p, "#ffffff", 0.08),
    nightText,
    accent: HEX.test(accent ?? "") ? accent.toLowerCase() : mix(p, "#ffffff", 0.18),
    // White text on the brand colour must stay readable.
    on_primary_contrast: Math.round(contrast(p, "#ffffff") * 10) / 10,
  };
}

/** CSS that recolours the portal: loaded after styles.css, so it wins. */
export function brandCss(c) {
  const v = palette(c?.brand_primary, c?.brand_accent);
  return `/* Brand colours set under Administration → Appearance & branding. */
:root {
  --red: ${v.primary};
  --red-hot: ${v.hot};
  --red-dark: ${v.deeper};
  --red-ink: ${v.ink};
  --red-50: ${v.softer};
  --red-100: ${v.soft};
  --brand-a: ${v.dark};
  --brand-b: ${mix(v.primary, "#000000", 0.45)};
  --brand-accent: ${v.accent};
}
:root[data-theme="dark"] {
  --red: ${v.night};
  --red-hot: ${mix(v.primary, "#ffffff", 0.25)};
  --red-text: ${v.nightText};
}
`;
}
