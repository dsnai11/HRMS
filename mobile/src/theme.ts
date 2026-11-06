import { useSyncExternalStore } from "react";
import { Appearance } from "react-native";
import * as SecureStore from "expo-secure-store";

// The app's colours. An administrator picks the brand colour on the web portal (Appearance &
// branding); the app works out the same shades as the portal (server/brand.js) and recolours
// every screen. Screens read colours from T, and style sheets made with themed() are rebuilt
// when the brand or the Day / Night look changes. The look follows the phone's own light or
// dark setting unless the person picks Day or Night on the Profile screen (kept on the phone).
export type Brand = {
  primary: string | null;
  accent: string | null;
  logo_url: string | null;
  updated_at: string | null;
};
const DEFAULT = "#c8102e";
const HEX = /^#[0-9a-f]{6}$/i;
const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const hex = (c: number[]) =>
  "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
export const mix = (a: string, b: string, t: number) => {
  const x = rgb(a),
    y = rgb(b);
  return hex(x.map((v, i) => v + (y[i] - v) * t));
};

// Soft brand tints are mixed towards the card colour: white by day, dark grey by night.
const shades = (primary: string, accent: string | null, dark = false) => {
  const card = dark ? NIGHT.surface : "#ffffff";
  return {
    primary,
    primaryDark: mix(primary, "#000000", 0.14),
    primaryDeeper: mix(primary, "#000000", 0.3),
    primaryHot: mix(primary, "#ffffff", 0.18),
    light: mix(primary, card, 0.4),
    soft: mix(primary, card, dark ? 0.78 : 0.9),
    softer: mix(primary, card, dark ? 0.86 : 0.95),
    border: mix(primary, card, dark ? 0.6 : 0.82),
    onPrimarySoft: mix(primary, "#ffffff", 0.85),
    accent: accent && HEX.test(accent) ? accent : mix(primary, "#ffffff", 0.18),
  };
};

// Neutrals and status colours for each look.
const DAY = {
  ink: "#1f2130",
  body: "#3a3c4a",
  muted: "#626576",
  faint: "#9a9cab",
  line: "#e8e6ee",
  lineStrong: "#c9c8d3",
  page: "#f5f4f8",
  fill: "#f4f3f7",
  surface: "#ffffff",
  success: "#1f7a4d",
  successSoft: "#e3f4ea",
  warning: "#8a5300",
  warningSoft: "#fff1d6",
  info: "#1d5fbf",
  infoSoft: "#e7effc",
  danger: "#b3261e",
  dangerSoft: "#fbe9e6",
};
const NIGHT: typeof DAY = {
  ink: "#f1f1f5",
  body: "#d6d6de",
  muted: "#a3a5b3",
  faint: "#7c7e8c",
  line: "#2e2f3a",
  lineStrong: "#454657",
  page: "#111117",
  fill: "#23242d",
  surface: "#1b1c23",
  success: "#5fc493",
  successSoft: "#173326",
  warning: "#f0b65a",
  warningSoft: "#3a2c12",
  info: "#7fb0ff",
  infoSoft: "#16253f",
  danger: "#ff8a80",
  dangerSoft: "#3d1c1a",
};

/** Brand colours plus the neutrals and status colours of the current look. */
export const T = {
  ...shades(DEFAULT, null),
  ...DAY,
  // Text and icons on the brand colour: white in both looks.
  onPrimary: "#ffffff",
};
export let brand: Brand = { primary: null, accent: null, logo_url: null, updated_at: null };

// ---- Day / Night ------------------------------------------------------------------------
export type ThemeMode = "system" | "light" | "dark";
const MODE_KEY = "laxmi.hrms.theme";
let mode: ThemeMode = "system";
let dark = false;
export const themeMode = () => mode;
export const isDark = () => dark;
function recolour() {
  const next = mode === "system" ? Appearance.getColorScheme() === "dark" : mode === "dark";
  const primary = brand.primary && HEX.test(brand.primary) ? brand.primary.toLowerCase() : DEFAULT;
  dark = next;
  Object.assign(T, shades(primary, brand.accent, dark), dark ? NIGHT : DAY);
  version++;
  listeners.forEach((l) => l());
}
/** Day, Night, or follow the phone; remembered on this phone. */
export function setThemeMode(next: ThemeMode) {
  mode = next;
  recolour();
  void SecureStore.setItemAsync(MODE_KEY, next).catch(() => {});
}
export async function restoreTheme() {
  try {
    const saved = await SecureStore.getItemAsync(MODE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") mode = saved;
  } catch {
    /* follows the phone */
  }
  recolour();
}
Appearance.addChangeListener(() => {
  if (mode === "system") recolour();
});

let version = 0;
const listeners = new Set<() => void>();
const STORE_KEY = "laxmi.hrms.brand";

export function applyBrand(next: Partial<Brand> | null | undefined, save = true) {
  const primary = next?.primary && HEX.test(next.primary) ? next.primary.toLowerCase() : DEFAULT;
  const merged: Brand = {
    primary: next?.primary ?? null,
    accent: next?.accent ?? null,
    logo_url: next?.logo_url ?? null,
    updated_at: next?.updated_at ?? null,
  };
  if (JSON.stringify(merged) === JSON.stringify(brand)) return;
  brand = merged;
  Object.assign(T, shades(primary, merged.accent, dark));
  version++;
  listeners.forEach((l) => l());
  if (save) void SecureStore.setItemAsync(STORE_KEY, JSON.stringify(merged)).catch(() => {});
}
/** The brand saved on this phone, so the app opens in the right colours before the network answers. */
export async function restoreBrand() {
  try {
    const saved = await SecureStore.getItemAsync(STORE_KEY);
    if (saved) applyBrand(JSON.parse(saved), false);
  } catch {
    /* the standard colours stay */
  }
}
/** Re-renders when the brand changes; the number changes with it. */
export function useBrandVersion() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}
/** A style sheet rebuilt from T when the brand changes. Use like StyleSheet.create's result. */
export function themed<S extends object>(make: () => S): S {
  let cache: S | null = null;
  let built = -1;
  const current = () => {
    if (built !== version || !cache) {
      cache = make();
      built = version;
    }
    return cache;
  };
  return new Proxy({} as S, {
    get: (_, key) => (current() as Record<string | symbol, unknown>)[key],
    has: (_, key) => key in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_, key) => Object.getOwnPropertyDescriptor(current(), key),
  });
}
