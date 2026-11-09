import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";

import { T, themed } from "../theme";
import { PressScale, SkeletonCard } from "../ui";
// Shared building blocks for the phone's work screens (Supervisor, claims, resignation,
// performance, learning, tax): the same look and behaviour as the screens in More.tsx.
export type Api = <T>(
  path: string,
  body?: object,
  method?: string,
) => Promise<T>;
export type Files = { base: string; headers: () => Record<string, string> };

export const inr = (n: number) =>
  "₹" +
  new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(n ?? 0);
export const dateText = (d: string) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(d.slice(0, 10) + "T00:00:00Z"));
export const timeText = (iso: string) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
export const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v.trim());
export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : "Please retry.";

export function Btn({
  title,
  onPress,
  secondary,
  disabled,
}: {
  title: string;
  onPress: () => void;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[k.btn, secondary && k.btnSecondary, disabled && { opacity: 0.5 }]}
    >
      <Text style={[k.btnText, secondary && { color: T.primary }]}>
        {title}
      </Text>
    </PressScale>
  );
}
export function Field({
  label,
  value,
  onChange,
  placeholder,
  multiline,
  keyboardType,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: "default" | "numeric" | "email-address";
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={k.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        style={[
          k.input,
          multiline && { minHeight: 80, textAlignVertical: "top" },
        ]}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize="sentences"
      />
    </View>
  );
}
/** One choice from a few options, as chips. */
export function Choice<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label?: string;
  options: [T, string][];
  value: T | null;
  onChange: (v: T) => void;
}) {
  return (
    <View style={{ gap: 6 }}>
      {label ? <Text style={k.label}>{label}</Text> : null}
      <View style={k.wrap}>
        {options.map(([v, l]) => (
          <Pressable
            key={String(v)}
            accessibilityRole="radio"
            accessibilityState={{ selected: value === v }}
            onPress={() => onChange(v)}
            style={[k.chip, value === v && k.chipOn]}
          >
            <Text style={[k.chipText, value === v && { color: "#fff" }]}>
              {l}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
/** A value shown as a pill; tapping it opens a list to choose from. */
export function PickSheet<V extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: V;
  options: [V, string][];
  onChange: (v: V) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find(([v]) => v === value)?.[1] ?? "";
  return (
    <>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}: ${current}`} style={k.pickPill} onPress={() => setOpen(true)}>
        <Text style={k.note}>{label}</Text>
        <Text style={k.strong} numberOfLines={1}>{current} ▾</Text>
      </Pressable>
      <Modal visible={open} transparent animationType="slide" onRequestClose={() => setOpen(false)}>
        <Pressable style={k.sheetWrap} accessibilityLabel="Close" onPress={() => setOpen(false)}>
          <Pressable style={k.sheet} accessibilityRole="none">
            <Text style={k.heading}>{label}</Text>
            <ScrollView style={{ maxHeight: 380 }}>
              {options.map(([v, l]) => (
                <Pressable
                  key={String(v)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: v === value }}
                  style={k.sheetRow}
                  onPress={() => {
                    onChange(v);
                    setOpen(false);
                  }}
                >
                  <Text style={[k.strong, v === value && { color: T.primaryText }]}>{l}</Text>
                  {v === value ? <Text style={{ color: T.primaryText, fontWeight: "800" }}>✓</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
export const Pill = ({ text }: { text: string }) => (
  <Text style={k.pill}>{text}</Text>
);
export const Status = ({
  loading,
  error,
}: {
  loading: boolean;
  error: string;
}) =>
  loading ? (
    <SkeletonCard />
  ) : error ? (
    <Text style={k.error}>{error}</Text>
  ) : null;
export const Empty = ({ text }: { text: string }) => (
  <Text style={k.note}>{text}</Text>
);
/** Tabs at the top of a screen. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: [T, string][];
  value: T;
  onChange: (v: T) => void;
}) {
  return <Choice options={tabs} value={value} onChange={onChange} />;
}

// Runs `load` now and on demand, showing errors in place.
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setData(await load());
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    // Loads once on mount; state is set after the request returns.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void run();
  }, [run]);
  return { data, error, loading, reload: run };
}
export async function attempt(fn: () => Promise<unknown>, done?: string) {
  try {
    await fn();
    if (done) Alert.alert(done);
    return true;
  } catch (e) {
    Alert.alert("Could not complete", errorText(e));
    return false;
  }
}

// Files: open through a short-lived link; pick a PDF or photo (up to 2 MB) from the phone.
export async function openDocument(api: Api, files: Files, id: number) {
  try {
    const link = await api<{ url: string }>("/download-links", {
      kind: "document",
      id,
    });
    await Linking.openURL(files.base + link.url);
  } catch (e) {
    Alert.alert("Could not open", errorText(e));
  }
}
const PICK_TYPES = ["application/pdf", "image/jpeg", "image/png"];
export async function pickAndUpload(
  api: Api,
  name: string,
): Promise<number | null> {
  const r = await DocumentPicker.getDocumentAsync({
    type: PICK_TYPES,
    copyToCacheDirectory: true,
  });
  if (r.canceled || !r.assets?.length) return null;
  const a = r.assets[0];
  const mime = a.mimeType ?? "";
  if (!PICK_TYPES.includes(mime)) throw new Error("Choose a PDF, JPG or PNG.");
  if ((a.size ?? 0) > 2 * 1024 * 1024)
    throw new Error("Files can be up to 2 MB.");
  const doc = await api<{ id: number }>("/documents", {
    kind: "other",
    name,
    mime,
    data: await new File(a.uri).base64(),
  });
  return doc.id;
}

export const k = themed(() => StyleSheet.create({
  pickPill: { flex: 1, minHeight: 44, justifyContent: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12, borderWidth: 1, borderColor: T.line, backgroundColor: T.fill },
  sheetWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: { backgroundColor: T.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22, padding: 20, paddingBottom: 36, gap: 10 },
  sheetRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", minHeight: 48, borderBottomWidth: 1, borderBottomColor: T.line },
  card: {
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.line,
    borderRadius: 20,
    padding: 20,
    gap: 12,
  },
  heading: {
    color: T.ink,
    fontSize: 21,
    fontWeight: "600",
    letterSpacing: -0.4,
  },
  sub: { color: T.ink, fontSize: 16, fontWeight: "600" },
  label: { fontSize: 12, fontWeight: "600", color: T.body },
  input: {
    backgroundColor: T.fill,
    borderColor: T.line,
    borderWidth: 1,
    borderRadius: 10,
    padding: 13,
    color: T.ink,
    fontSize: 15,
  },
  btn: {
    paddingVertical: 15,
    paddingHorizontal: 20,
    backgroundColor: T.primary,
    borderRadius: 12,
    alignItems: "center",
  },
  btnSecondary: { backgroundColor: T.softer },
  btnText: { fontSize: 15, color: "#fff", fontWeight: "600" },
  chip: {
    paddingVertical: 9,
    paddingHorizontal: 14,
    borderRadius: 18,
    backgroundColor: T.softer,
  },
  chipOn: { backgroundColor: T.primary },
  chipText: { color: T.primary, fontWeight: "600", fontSize: 13 },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  // Wraps instead of overflowing on narrow phones and with large text sizes.
  row: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderColor: T.line,
  },
  item: {
    gap: 6,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderColor: T.line,
  },
  actions: { flexDirection: "row", gap: 8, flexWrap: "wrap" },
  strong: { fontWeight: "600", color: T.body, fontSize: 14 },
  note: { color: T.muted, fontSize: 12, lineHeight: 18 },
  body: { color: T.body, fontSize: 14, lineHeight: 21 },
  link: { color: T.primary, fontWeight: "600", fontSize: 13 },
  error: {
    color: T.danger,
    backgroundColor: T.warningSoft,
    padding: 12,
    borderRadius: 10,
  },
  pill: {
    backgroundColor: T.softer,
    color: T.primary,
    fontSize: 11,
    fontWeight: "600",
    paddingVertical: 3,
    paddingHorizontal: 9,
    borderRadius: 10,
    overflow: "hidden",
    alignSelf: "flex-start",
  },
}));
