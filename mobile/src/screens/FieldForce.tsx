import React, { useCallback, useEffect, useState } from "react";
import { Alert, AppState, StyleSheet, Text, View } from "react-native";
import * as Location from "expo-location";

import { T, themed } from "../theme";
import { Icon, success, tick } from "../ui";
import { syncFieldTracking } from "../fieldForceTask";
import { Btn, Field, attempt, useLoad, type Api } from "./kit";

// Field Force (a separate module of the HRMS, from the Field Force Activation plan), on the
// Home screen. Nothing shows for anyone who is not field staff, or when the server has the
// module switched off (the requests then fail quietly and the card stays hidden).
//  - Morning: not punched in yet? Punch in, or tell the manager why.
//  - Tracking: agree (or not) to location sharing while punched in; log customer visits.
type Today = {
  field_team: string | null;
  show: boolean;
  reason?: string | null;
  reason_label?: string | null;
  reasons?: { value: string; label: string }[];
};
type Tracking = {
  field_team: string | null;
  tracking_on: boolean;
  consent?: boolean;
  consent_text?: string;
  track: boolean;
  punched_in?: boolean;
  ping_minutes: number;
};

export function FieldForceCard({
  api,
  refreshKey,
  onLeave,
}: {
  api: Api;
  // Changes after a punch, so the card follows punch-in and punch-out.
  refreshKey: number;
  onLeave: () => void;
}) {
  return (
    <>
      <MorningReasons api={api} refreshKey={refreshKey} onLeave={onLeave} />
      <LocationSharing api={api} refreshKey={refreshKey} />
    </>
  );
}

function MorningReasons({ api, refreshKey, onLeave }: { api: Api; refreshKey: number; onLeave: () => void }) {
  const today = useLoad(() => api<Today>("/field-force/today"));
  const [saving, setSaving] = useState(false);
  const { reload } = today;
  useEffect(() => {
    if (refreshKey) void reload();
  }, [refreshKey, reload]);
  const a = today.data;
  if (!a?.show) return null;
  const choose = async (value: string) => {
    tick();
    setSaving(true);
    const ok = await attempt(() => api("/field-force/reason", { reason: value }));
    setSaving(false);
    if (!ok) return;
    success();
    await reload();
    if (value === "on_leave") onLeave();
  };
  return (
    <View style={f.card} accessibilityLabel="You have not punched in yet">
      <View style={f.head}>
        <Icon name="alarm-outline" size={22} color={T.primary} />
        <Text style={f.heading}>You have not punched in yet</Text>
      </View>
      <Text style={f.body}>
        {a.reason
          ? `You told your manager: ${a.reason_label}. Punch in as soon as you start.`
          : "Please punch in. If you cannot start yet, tell your manager why:"}
      </Text>
      <View style={{ gap: 8 }}>
        {(a.reasons ?? []).map((r) => (
          <Btn
            key={r.value}
            title={(a.reason === r.value ? "✓ " : "") + r.label}
            secondary={a.reason !== r.value}
            disabled={saving}
            onPress={() => void choose(r.value)}
          />
        ))}
      </View>
    </View>
  );
}

function LocationSharing({ api, refreshKey }: { api: Api; refreshKey: number }) {
  const state = useLoad(() => api<Tracking>("/field-force/tracking"));
  const [phone, setPhone] = useState<"on" | "off" | "no_permission" | null>(null);
  const [later, setLater] = useState(false);
  const [visit, setVisit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { reload } = state;
  const s = state.data;
  // Follow the server: start at punch-in, stop at punch-out or withdrawal.
  const sync = useCallback(async (next: Tracking | null) => {
    if (!next?.field_team) return;
    setPhone(await syncFieldTracking(next).catch(() => "off" as const));
  }, []);
  useEffect(() => {
    // Starts or stops the phone's location updates (an outside system); the state is set
    // only after the phone answers, as in useLoad.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void sync(s);
  }, [s, sync]);
  useEffect(() => {
    if (refreshKey) void reload();
  }, [refreshKey, reload]);
  // Coming back to the app re-checks (for example after punching out on another screen).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active") void reload();
    });
    return () => sub.remove();
  }, [reload]);
  if (!s?.field_team || !s.tracking_on) return null;

  if (!s.consent) {
    if (later) return null;
    return (
      <View style={f.card}>
        <View style={f.head}>
          <Icon name="navigate-outline" size={22} color={T.primary} />
          <Text style={f.heading}>Share your location while working?</Text>
        </View>
        <Text style={f.body}>{s.consent_text}</Text>
        <Btn
          title="I agree"
          disabled={busy}
          onPress={async () => {
            setBusy(true);
            const ok = await attempt(() => api("/field-force/tracking/consent", { agree: true }));
            setBusy(false);
            if (ok) {
              success();
              await reload();
            }
          }}
        />
        <Btn title="Not now" secondary onPress={() => setLater(true)} />
      </View>
    );
  }
  if (!s.punched_in) return null;

  const logVisit = async () => {
    setBusy(true);
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
    const ok = await attempt(
      () =>
        api("/field-force/visits", {
          customer: visit?.trim() || undefined,
          latitude: position?.coords.latitude,
          longitude: position?.coords.longitude,
          accuracy: position?.coords.accuracy ?? undefined,
        }),
      "Visit logged.",
    );
    setBusy(false);
    if (ok) setVisit(null);
  };
  return (
    <View style={f.card}>
      <View style={f.head}>
        <Icon name={phone === "on" ? "navigate" : "navigate-outline"} size={22} color={T.primary} />
        <Text style={f.heading}>{phone === "no_permission" ? "Allow location to share it" : "Location sharing is on"}</Text>
      </View>
      <Text style={f.body}>
        {phone === "no_permission"
          ? "Location is switched off for this app. Turn it on in your phone's settings so your visits are recorded."
          : "Your location is shared while you are punched in, and stops when you punch out. At a customer or market? Log the visit."}
      </Text>
      {visit === null ? (
        <Btn title="Log a customer visit" onPress={() => setVisit("")} />
      ) : (
        <>
          <Field label="Customer or place (optional)" value={visit} onChange={setVisit} placeholder="Name, loan number or market" />
          <Btn title="Save visit" disabled={busy} onPress={() => void logVisit()} />
          <Btn title="Cancel" secondary onPress={() => setVisit(null)} />
        </>
      )}
      <Btn
        title="Stop sharing my location"
        secondary
        onPress={() =>
          Alert.alert("Stop sharing your location?", "Your manager and HR will see that you stopped.", [
            { text: "Keep sharing", style: "cancel" },
            {
              text: "Stop",
              style: "destructive",
              onPress: async () => {
                if (await attempt(() => api("/field-force/tracking/consent", { agree: false }))) await reload();
              },
            },
          ])
        }
      />
    </View>
  );
}

const f = themed(() =>
  StyleSheet.create({
    card: {
      backgroundColor: T.surface,
      borderWidth: 1,
      borderColor: T.primary,
      borderRadius: 20,
      padding: 20,
      gap: 12,
    },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    heading: { color: T.ink, fontSize: 21, fontWeight: "600", letterSpacing: -0.4, flexShrink: 1 },
    body: { color: T.body, fontSize: 15, lineHeight: 21 },
  }),
);
