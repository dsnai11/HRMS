import React, { useCallback, useEffect, useState } from "react";
import { AppState, Modal, StyleSheet, Text, View } from "react-native";
import { T, themed, useBrandVersion } from "../theme";
import { Icon } from "../ui";
import { Btn, type Api } from "./kit";

// A transfer the employee has not acknowledged pops up whenever the app opens or comes back to
// the front. "Remind me later" works twice; the third time they must acknowledge. HR sees how
// many times it was skipped.
type Ack = {
  id: number;
  effective_date: string;
  details: string[];
  note: string | null;
  skips: number;
  skips_left: number;
  can_skip: boolean;
};
export default function TransferAck({ api }: { api: Api }) {
  useBrandVersion();
  const [list, setList] = useState<Ack[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => {
    api<Ack[]>("/me/acknowledgements")
      .then(setList)
      .catch(() => {});
  }, [api]);
  useEffect(() => {
    load();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") load();
    });
    return () => sub.remove();
  }, [load]);
  const a = list[0];
  if (!a) return null;
  const act = async (action: "skip" | "acknowledge") => {
    setBusy(true);
    setError("");
    try {
      await api(`/me/acknowledgements/${a.id}`, { action });
      setList((l) => l.slice(1));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => (a.can_skip ? void act("skip") : undefined)}>
      <View style={s.shade}>
        <View style={s.box} accessibilityRole="alert">
          <View style={s.head}>
            <Icon name="swap-horizontal-outline" size={26} color={T.primary} />
            <Text style={s.title}>You are being transferred</Text>
          </View>
          <Text style={s.text}>From {a.effective_date}</Text>
          {a.details.map((d) => (
            <Text key={d} style={s.detail}>
              {d}
            </Text>
          ))}
          {a.note ? <Text style={s.text}>{a.note}</Text> : null}
          <Text style={s.small}>
            {a.can_skip
              ? `You can choose "Remind me later" ${a.skips_left} more ${a.skips_left === 1 ? "time" : "times"}.`
              : "You have skipped this twice. Please acknowledge to continue."}
          </Text>
          {error ? <Text style={s.error}>{error}</Text> : null}
          <Btn title="I acknowledge" onPress={() => void act("acknowledge")} disabled={busy} />
          {a.can_skip ? <Btn title="Remind me later" secondary onPress={() => void act("skip")} disabled={busy} /> : null}
        </View>
      </View>
    </Modal>
  );
}
const s = themed(() =>
  StyleSheet.create({
    shade: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 20 },
    box: { backgroundColor: T.surface, borderRadius: 20, padding: 20, gap: 10 },
    head: { flexDirection: "row", alignItems: "center", gap: 10 },
    title: { color: T.ink, fontSize: 19, fontWeight: "700", flexShrink: 1 },
    text: { color: T.ink, fontSize: 15 },
    detail: { color: T.ink, fontSize: 15, fontWeight: "600" },
    small: { color: T.ink, opacity: 0.7, fontSize: 13 },
    error: { color: "#c8102e", fontSize: 14 },
  }),
);
