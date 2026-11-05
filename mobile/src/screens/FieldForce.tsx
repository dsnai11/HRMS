import React, { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { T, themed } from "../theme";
import { Icon, success, tick } from "../ui";
import { Btn, attempt, useLoad, type Api } from "./kit";

// Field Force (a separate module of the HRMS, from the Field Force Activation plan).
// Field staff who have not punched in by the morning message see this card on Home: punch
// in, or tell their manager why. Nothing shows for anyone else, or when the server has the
// module switched off (the request then fails quietly and the card stays hidden).
type Today = {
  field_team: string | null;
  show: boolean;
  reason?: string | null;
  reason_label?: string | null;
  reasons?: { value: string; label: string }[];
};

export function FieldForceCard({
  api,
  refreshKey,
  onLeave,
}: {
  api: Api;
  // Changes after a punch, so the card disappears once the person has punched in.
  refreshKey: number;
  onLeave: () => void;
}) {
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
