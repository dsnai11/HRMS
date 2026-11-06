// Field Force (a separate module of the HRMS): location while a field person is punched in.
// The background task is defined here, at app start (imported from index.js), as Expo
// requires. It runs only after the person agreed in the app, only while the server says
// "track" (punched in, company switched on), with the phone's "tracking on" notification
// (Android) or location indicator (iPhone). The server answers every upload with whether to
// keep going; at punch-out, a withdrawal or sign-out the updates stop.
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";

import { SESSION_KEY } from "./biometric";

export const FIELD_TASK = "laxmi-field-force-location";
const API = (process.env.EXPO_PUBLIC_API_URL || "").replace(/\/$/, "");
// The same keys the app shell uses for the phone's identity (Attendance.tsx).
const DEVICE_ID_KEY = "laxmi.hrms.device-id";
const DEVICE_SECRET_KEY = "laxmi.hrms.device-secret";

type Point = { at: string; latitude: number; longitude: number; accuracy: number | null; mocked: boolean };
// Points not yet delivered (no network); sent with the next batch. At most a working day's worth.
let waiting: Point[] = [];

async function upload(points: Point[]) {
  const [token, id, secret] = await Promise.all([
    SecureStore.getItemAsync(SESSION_KEY),
    SecureStore.getItemAsync(DEVICE_ID_KEY),
    SecureStore.getItemAsync(DEVICE_SECRET_KEY),
  ]);
  // Signed out: nothing may be sent.
  if (!token || !id || !secret || !API) return { track: false };
  const res = await fetch(`${API}/api/field-force/pings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Device-Id": id,
      "X-Device-Secret": secret,
    },
    body: JSON.stringify({ points }),
  });
  if (res.status === 401 || res.status === 403 || res.status === 404) return { track: false };
  if (!res.ok) throw new Error(`Upload failed (${res.status})`);
  return (await res.json()) as { track: boolean };
}

export async function stopFieldTracking() {
  waiting = [];
  if (await Location.hasStartedLocationUpdatesAsync(FIELD_TASK).catch(() => false))
    await Location.stopLocationUpdatesAsync(FIELD_TASK).catch(() => {});
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(FIELD_TASK, async ({ data, error }) => {
  if (error || !data?.locations?.length) return;
  const fresh = data.locations.map((l) => ({
    at: new Date(l.timestamp).toISOString(),
    latitude: l.coords.latitude,
    longitude: l.coords.longitude,
    accuracy: l.coords.accuracy ?? null,
    mocked: Boolean(l.mocked),
  }));
  const batch = [...waiting, ...fresh].slice(-480);
  try {
    const answer = await upload(batch);
    waiting = [];
    if (!answer.track) await stopFieldTracking();
  } catch {
    // No network: keep them for the next try.
    waiting = batch;
  }
});

// Starts or stops the updates to match what the server says. Must be called while the app
// is open (Android allows starting the "tracking on" service only then).
export async function syncFieldTracking(state: { track: boolean; ping_minutes: number }) {
  const running = await Location.hasStartedLocationUpdatesAsync(FIELD_TASK).catch(() => false);
  if (!state.track) {
    if (running) await stopFieldTracking();
    return "off";
  }
  const permission = await Location.requestForegroundPermissionsAsync();
  if (permission.status !== "granted") return "no_permission";
  if (running) return "on";
  await Location.startLocationUpdatesAsync(FIELD_TASK, {
    accuracy: Location.Accuracy.Balanced,
    timeInterval: state.ping_minutes * 60000,
    distanceInterval: 50,
    deferredUpdatesInterval: state.ping_minutes * 60000,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    activityType: Location.ActivityType.AutomotiveNavigation,
    foregroundService: {
      notificationTitle: "Field tracking is on",
      notificationBody: "Your location is shared with your company while you are punched in. It stops when you punch out.",
      killServiceOnDestroy: false,
    },
  });
  return "on";
}
