import { distanceMeters } from "./geo.js";

// Impossible-travel limit between two accepted punches. Commercial flights are
// excluded on purpose: a 250 km/h ground speed is already suspicious.
export const MAX_SPEED_KMH = 250;
const MIN_TRAVEL_METERS = 1000;
const REPEAT_WINDOW = 3;

const sameSpot = (a, b) =>
  Math.abs(a.latitude - b.latitude) < 1e-6 &&
  Math.abs(a.longitude - b.longitude) < 1e-6;

export function parseSignals(raw) {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const text = (v) => (typeof v === "string" ? v.slice(0, 40) : null);
  return {
    emulator: s.emulator === true,
    rooted: s.rooted === true ? true : s.rooted === false ? false : null,
    platform: text(s.platform),
    osVersion: text(s.osVersion),
    appVersion: text(s.appVersion),
  };
}

/**
 * Server-side plausibility checks on a punch that already passed the geofence.
 * `previous` is the user's accepted punch events, newest first, each with
 * latitude, longitude and created_at (ISO).
 * Returns { reject, flags }: `reject` is a message when the punch must be
 * refused; `flags` are soft findings kept for administrator review.
 */
export function assessPunch({ signals, location, previous, now = Date.now() }) {
  const flags = [];
  if (signals.emulator)
    return {
      reject: "Attendance can only be recorded on a real phone.",
      flags: ["emulator"],
    };
  if (signals.rooted === true) flags.push("rooted_device");
  const last = previous[0];
  if (last) {
    const meters = distanceMeters(
      last.latitude,
      last.longitude,
      location.latitude,
      location.longitude,
    );
    const hours = Math.max(now - Date.parse(last.created_at), 1000) / 3600000;
    if (meters > MIN_TRAVEL_METERS && meters / 1000 / hours > MAX_SPEED_KMH)
      return {
        reject:
          "Your location changed too fast since your last punch. Contact your administrator.",
        flags: ["impossible_travel"],
      };
  }
  const recent = previous.slice(0, REPEAT_WINDOW);
  if (
    recent.length === REPEAT_WINDOW &&
    recent.every((p) => sameSpot(p, location))
  )
    flags.push("repeated_exact_coordinates");
  return { reject: null, flags };
}
