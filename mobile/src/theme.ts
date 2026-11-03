import { useSyncExternalStore } from "react";
import * as SecureStore from "expo-secure-store";

// The app's colours. An administrator picks the brand colour on the web portal (Appearance &
// branding); the app works out the same shades as the portal (server/brand.js) and recolours
// every screen. Screens read colours from T, and style sheets made with themed() are rebuilt
// when the brand changes.
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

const shades = (primary: string, accent: string | null) => ({
  primary,
  primaryDark: mix(primary, "#000000", 0.14),
  primaryDeeper: mix(primary, "#000000", 0.3),
  primaryHot: mix(primary, "#ffffff", 0.18),
  light: mix(primary, "#ffffff", 0.4),
  soft: mix(primary, "#ffffff", 0.9),
  softer: mix(primary, "#ffffff", 0.95),
  border: mix(primary, "#ffffff", 0.82),
  onPrimarySoft: mix(primary, "#ffffff", 0.85),
  accent: accent && HEX.test(accent) ? accent : mix(primary, "#ffffff", 0.18),
});

/** Brand colours plus the fixed neutrals and status colours. */
export const T = {
  ...shades(DEFAULT, null),
  ink: "#1f2130",
  body: "#3a3c4a",
  muted: "#626576",
  line: "#e8e6ee",
  page: "#f5f4f8",
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
export let brand: Brand = { primary: null, accent: null, logo_url: null, updated_at: null };

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
  Object.assign(T, shades(primary, merged.accent));
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
