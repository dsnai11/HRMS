import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as Location from "expo-location";
import * as SecureStore from "expo-secure-store";
import * as Device from "expo-device";
import * as Crypto from "expo-crypto";
import Constants from "expo-constants";
type User = { name: string; role: string; must_change_password: boolean };
type Shift = {
  id: number;
  workplace_name: string;
  in_at: string;
  out_at: string | null;
  required_out_at?: string | null;
  day_type?: "full_day" | "half_day" | null;
  half_day_reasons?: string;
};
type Profile = {
  user: User;
  workplace: { name: string; radius: number } | null;
  openShift: Shift | null;
  todayShift: Shift | null;
  device: { status: "pending" | "approved" | "revoked" } | null;
};
const API = (process.env.EXPO_PUBLIC_API_URL || "").replace(/\/$/, "");
const KEY = "laxmi.hrms.session";
const DEVICE_ID_KEY = "laxmi.hrms.device-id";
const DEVICE_SECRET_KEY = "laxmi.hrms.device-secret";
type Identity = { id: string; secret: string | null };
function Button({
  title,
  onPress,
  disabled = false,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={[s.button, secondary && s.secondary, disabled && { opacity: 0.5 }]}
    >
      <Text style={[s.buttonText, secondary && { color: "#22684f" }]}>
        {title}
      </Text>
    </Pressable>
  );
}
export default function Attendance() {
  const [token, setToken] = useState<string | null>(null),
    sessionRef = useRef<string | null>(null),
    locked = useRef(false),
    identity = useRef<Identity | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null),
    [shifts, setShifts] = useState<Shift[]>([]);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [refreshedAt, setRefreshedAt] = useState(0);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [nextPassword, setNextPassword] = useState("");
  const [changing, setChanging] = useState(false),
    [message, setMessage] = useState(""),
    [timezone, setTimezone] = useState("Asia/Kolkata"),
    [history, setHistory] = useState(false);
  // The phone's identity survives sign-out: the administrator approves this
  // specific phone once, and the secret proves later requests come from it.
  async function loadIdentity(): Promise<Identity> {
    if (identity.current) return identity.current;
    let id = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (!id) {
      id = Crypto.randomUUID();
      await SecureStore.setItemAsync(DEVICE_ID_KEY, id);
    }
    identity.current = {
      id,
      secret: await SecureStore.getItemAsync(DEVICE_SECRET_KEY),
    };
    return identity.current;
  }
  async function clearSession() {
    sessionRef.current = null;
    setToken(null);
    setProfile(null);
    setShifts([]);
    setPassword("");
    setNextPassword("");
    await SecureStore.deleteItemAsync(KEY);
  }
  async function api<T>(
    path: string,
    body?: object,
    session = sessionRef.current,
  ): Promise<T> {
    if (
      !API ||
      (!API.startsWith("https://") && !(__DEV__ && API.startsWith("http://")))
    )
      throw new Error(
        "Company server is not configured. Contact your administrator.",
      );
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), 90000);
    try {
      const response = await fetch(API + "/api" + path, {
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...(session ? { Authorization: "Bearer " + session } : {}),
          ...(identity.current?.secret
            ? {
                "X-Device-Id": identity.current.id,
                "X-Device-Secret": identity.current.secret,
              }
            : {}),
        },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 401 && path !== "/login") await clearSession();
        throw new Error(data.error || "Request failed.");
      }
      return data as T;
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError")
        throw new Error(
          "The showcase server may be waking up. Refresh attendance before retrying a punch.",
        );
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  async function refresh(session = sessionRef.current) {
    if (!session) return;
    const p = await api<Profile>("/me", undefined, session);
    setProfile(p);
    setRefreshedAt(Date.now());
    if (!p.user.must_change_password && p.user.role !== "super_admin")
      setShifts(await api<Shift[]>("/shifts", undefined, session));
  }
  async function run(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Unable to connect. Please retry.",
      );
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await loadIdentity();
        const saved = await SecureStore.getItemAsync(KEY);
        if (!mounted) return;
        sessionRef.current = saved;
        setToken(saved);
        const config = await api<{ timezone: string }>(
          "/config",
          undefined,
          null,
        );
        setTimezone(config.timezone);
        if (saved) await refresh(saved);
      } catch (e) {
        if (mounted)
          setMessage(
            e instanceof Error ? e.message : "Could not restore session.",
          );
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active" && sessionRef.current) void run(() => refresh());
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
    // Initialization and foreground refresh read the current session ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const time = (value: string) =>
    new Intl.DateTimeFormat("en-IN", {
      timeZone: timezone,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  const login = () =>
    run(async () => {
      const device = await loadIdentity();
      const result = await api<{ token: string; deviceSecret?: string }>(
        "/login",
        {
          email: email.trim(),
          password,
          native: true,
          device: {
            id: device.id,
            platform: Platform.OS,
            model: Device.modelName ?? undefined,
            secret: device.secret ?? undefined,
          },
        },
        null,
      );
      if (result.deviceSecret) {
        await SecureStore.setItemAsync(DEVICE_SECRET_KEY, result.deviceSecret);
        device.secret = result.deviceSecret;
      }
      await SecureStore.setItemAsync(KEY, result.token);
      sessionRef.current = result.token;
      setToken(result.token);
      setPassword("");
      await refresh(result.token);
    });
  const logout = () =>
    run(async () => {
      await api("/logout", {});
      await clearSession();
    });
  const changePassword = () =>
    run(async () => {
      await api("/password", {
        currentPassword: password,
        newPassword: nextPassword,
      });
      setPassword("");
      setNextPassword("");
      setChanging(false);
      await refresh();
      setMessage("Password updated.");
    });
  const punch = () =>
    run(async () => {
      const current = await api<Profile>("/me");
      setProfile(current);
      if (
        current.openShift?.id !== profile?.openShift?.id ||
        current.todayShift?.id !== profile?.todayShift?.id
      )
        throw new Error(
          "Attendance changed on another device. Review your status and tap again.",
        );
      if (current.device?.status !== "approved")
        throw new Error(
          current.device?.status === "pending"
            ? "Your phone is waiting for administrator approval."
            : "This phone is not authorised. Ask your administrator.",
        );
      const ending = current.openShift ?? current.todayShift;
      const required = ending?.required_out_at;
      if (
        ending &&
        required &&
        Date.now() < Date.parse(required) &&
        !(await new Promise<boolean>((resolve) =>
          Alert.alert(
            "Punch out early?",
            "Your full day completes at " +
              time(required) +
              ". Punching out now marks this day as a half day.",
            [
              { text: "Stay", style: "cancel", onPress: () => resolve(false) },
              {
                text: "Punch out",
                style: "destructive",
                onPress: () => resolve(true),
              },
            ],
            { cancelable: true, onDismiss: () => resolve(false) },
          ),
        ))
      )
        return;
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== "granted")
        throw new Error(
          "Allow precise location in phone settings to record attendance.",
        );
      if (!(await Location.hasServicesEnabledAsync()))
        throw new Error("Turn on location services and retry.");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let position: Location.LocationObject;
      try {
        position = await Promise.race([
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Highest,
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error("GPS took too long. Move outdoors and retry."),
                ),
              25000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (AppState.currentState !== "active")
        throw new Error("Keep the app open while recording attendance.");
      const action = ending ? "out" : "in";
      try {
        await api("/punch", {
          action,
          location: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: position.timestamp,
            mocked: position.mocked === true,
          },
          signals: {
            emulator: !Device.isDevice,
            rooted: await Device.isRootedExperimentalAsync().catch(() => null),
            platform: Platform.OS,
            osVersion: Device.osVersion ?? undefined,
            appVersion: Constants.expoConfig?.version,
          },
        });
      } catch (e) {
        await refresh().catch(() => {});
        throw e;
      }
      await refresh();
      Alert.alert(
        "Attendance recorded",
        action === "in"
          ? "You are punched in. Have a good workday."
          : "You are punched out. Your working hours are saved.",
      );
    });
  const open = profile?.openShift,
    done = profile?.todayShift;
  const passwordScreen = profile?.user.must_change_password || changing;
  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={s.scroll}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            token ? (
              <RefreshControl
                refreshing={busy}
                onRefresh={() => void run(() => refresh())}
              />
            ) : undefined
          }
        >
          <View style={s.brand}>
            <View style={s.logo}>
              <Text style={s.logoText}>L</Text>
            </View>
            <View>
              <Text style={s.brandName}>Laxmi India</Text>
              <Text style={s.eyebrow}>FINANCE LTD. · HRMS</Text>
            </View>
          </View>
          {loading ? (
            <ActivityIndicator size="large" color="#17694f" />
          ) : !token ? (
            <>
              <Text style={s.title}>Your workday,{"\n"}in one place.</Text>
              <Text style={s.subtitle}>
                Sign in to record attendance at your assigned workplace.
              </Text>
              <View style={s.card}>
                <Text style={s.label}>Email address</Text>
                <TextInput
                  accessibilityLabel="Email address"
                  style={s.input}
                  autoCapitalize="none"
                  autoComplete="username"
                  keyboardType="email-address"
                  value={email}
                  onChangeText={setEmail}
                />
                <Text style={s.label}>Password</Text>
                <TextInput
                  accessibilityLabel="Password"
                  style={s.input}
                  secureTextEntry
                  autoComplete="current-password"
                  value={password}
                  onChangeText={setPassword}
                />
                <Button
                  title={busy ? "Signing in…" : "Sign in →"}
                  onPress={login}
                  disabled={busy || !email || !password}
                />
              </View>
              <Text style={s.note}>
                Your administrator provides your first sign-in credentials.
                Location is requested only when you punch in or out.
              </Text>
            </>
          ) : !profile ? (
            <View style={s.card}>
              <Text style={s.subtitle}>
                Connect to the company server to load your attendance.
              </Text>
              <Button
                title="Retry connection"
                onPress={() => void run(() => refresh())}
                disabled={busy}
              />
              <Button
                title="Sign out"
                onPress={logout}
                disabled={busy}
                secondary
              />
            </View>
          ) : passwordScreen ? (
            <>
              <Text style={s.title}>Make it yours.</Text>
              <Text style={s.subtitle}>
                Choose a password of at least 12 characters.
              </Text>
              <View style={s.card}>
                <Text style={s.label}>Current password</Text>
                <TextInput
                  accessibilityLabel="Current password"
                  style={s.input}
                  secureTextEntry
                  autoComplete="current-password"
                  value={password}
                  onChangeText={setPassword}
                />
                <Text style={s.label}>New password</Text>
                <TextInput
                  accessibilityLabel="New password"
                  style={s.input}
                  secureTextEntry
                  autoComplete="new-password"
                  value={nextPassword}
                  onChangeText={setNextPassword}
                />
                <Button
                  title="Save password"
                  onPress={changePassword}
                  disabled={busy || nextPassword.length < 12}
                />
                {!profile.user.must_change_password && (
                  <Button
                    title="Cancel"
                    secondary
                    disabled={busy}
                    onPress={() => {
                      setChanging(false);
                      setPassword("");
                      setNextPassword("");
                    }}
                  />
                )}
              </View>
              <Button
                title="Sign out"
                secondary
                onPress={logout}
                disabled={busy}
              />
            </>
          ) : profile.user.role === "super_admin" ? (
            <View style={s.card}>
              <Text style={s.heading}>Administrator account</Text>
              <Text style={s.subtitle}>
                Use the company web portal to manage employees, workplaces and
                attendance.
              </Text>
              <Button title="Sign out" onPress={logout} disabled={busy} />
            </View>
          ) : (
            <>
              <Text style={s.eyebrow}>YOUR WORKSPACE</Text>
              <Text style={s.title}>
                Hello, {profile.user.name.split(" ")[0]}.
              </Text>
              <Text style={s.subtitle}>
                A little clarity for every workday.
              </Text>
              <View style={s.tabs}>
                <Button
                  title="Today"
                  secondary={history}
                  onPress={() => setHistory(false)}
                />
                <Button
                  title="My history"
                  secondary={!history}
                  onPress={() => setHistory(true)}
                />
              </View>
              {!history ? (
                <View style={s.card}>
                  <Text style={s.badge}>
                    {open
                      ? "● WORKING NOW"
                      : done
                        ? "✓ PUNCHED OUT"
                        : "○ NOT PUNCHED IN"}
                  </Text>
                  <Text style={s.heading}>
                    {open
                      ? "Your shift is in progress"
                      : done
                        ? "Today's shift is recorded"
                        : "Ready to begin?"}
                  </Text>
                  <Text style={s.siteName}>
                    {open?.workplace_name ||
                      done?.workplace_name ||
                      profile.workplace?.name ||
                      "No workplace assigned"}
                  </Text>
                  <Text style={s.subtitle}>
                    {open
                      ? "Started " +
                        time(open.in_at) +
                        ". End your shift at this same workplace" +
                        (open.required_out_at
                          ? " after " +
                            time(open.required_out_at) +
                            " for a full day."
                          : ".")
                      : done
                        ? "Punched out at " +
                          time(done.out_at ?? done.in_at) +
                          (done.day_type === "half_day" ? " · half day" : "") +
                          ". Punched out by mistake? Tap below at the workplace to replace it with the latest time."
                        : "You must be inside your assigned " +
                          (profile.workplace?.radius || "—") +
                          " m boundary."}
                  </Text>
                  {profile.device?.status !== "approved" && (
                    <View style={s.callout}>
                      <Text style={s.note}>
                        {profile.device?.status === "pending"
                          ? "This phone is waiting for your administrator to approve it. Pull down to refresh once approved."
                          : "This phone is not registered for attendance. Sign out and sign in again, or contact your administrator."}
                      </Text>
                    </View>
                  )}
                  <View style={s.callout}>
                    <Text style={s.note}>
                      We check a fresh GPS reading when you tap below. Enable
                      precise location and stay inside the workplace boundary.
                    </Text>
                  </View>
                  <Button
                    title={
                      busy
                        ? "Checking attendance…"
                        : open
                          ? "Punch out →"
                          : done
                            ? "Update punch-out →"
                            : "Punch in →"
                    }
                    onPress={punch}
                    disabled={
                      busy ||
                      profile.device?.status !== "approved" ||
                      (!open && !done && !profile.workplace)
                    }
                  />
                </View>
              ) : (
                <View style={s.card}>
                  <Text style={s.heading}>Recent attendance</Text>
                  <Text style={s.note}>Latest 100 shifts · {timezone}</Text>
                  {shifts.length === 0 ? (
                    <Text style={s.subtitle}>
                      Your recorded shifts will appear here.
                    </Text>
                  ) : (
                    shifts.map((shift) => (
                      <View key={shift.id} style={s.historyRow}>
                        <Text style={s.siteName}>{shift.workplace_name}</Text>
                        <Text style={s.note}>In: {time(shift.in_at)}</Text>
                        <Text style={s.note}>
                          Out:{" "}
                          {shift.out_at ? time(shift.out_at) : "Still working"}
                        </Text>
                        {shift.day_type && (
                          <Text style={s.note}>
                            {shift.day_type === "half_day"
                              ? "Half day (" +
                                JSON.parse(shift.half_day_reasons || "[]")
                                  .map((r: string) =>
                                    r === "late_in" ? "late in" : "left early",
                                  )
                                  .join(", ") +
                                ")"
                              : "Full day"}
                          </Text>
                        )}
                        <Text style={s.siteName}>
                          {(
                            ((shift.out_at
                              ? Date.parse(shift.out_at)
                              : refreshedAt) -
                              Date.parse(shift.in_at)) /
                            3600000
                          ).toFixed(2)}{" "}
                          hours{!shift.out_at ? " · as of last refresh" : ""}
                        </Text>
                      </View>
                    ))
                  )}
                </View>
              )}
              <Text style={s.note}>
                Location is captured only at punch-in and punch-out. No
                background tracking. Pull down to refresh.
              </Text>
              <View style={s.tabs}>
                <Button
                  title="Password"
                  secondary
                  onPress={() => setChanging(true)}
                  disabled={busy}
                />
                <Button
                  title="Sign out"
                  secondary
                  onPress={logout}
                  disabled={busy}
                />
              </View>
            </>
          )}
          {!!message && (
            <Text accessibilityRole="alert" style={s.message}>
              {message}
            </Text>
          )}
          <Text style={s.footer}>LAXMI INDIA FINANCE LTD.</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f5f8f5" },
  scroll: {
    flexGrow: 1,
    padding: 26,
    maxWidth: 600,
    width: "100%",
    alignSelf: "center",
    gap: 14,
  },
  brand: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 14,
    marginBottom: 28,
  },
  logo: {
    width: 44,
    height: 44,
    backgroundColor: "#193c30",
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { fontSize: 28, color: "#e3f3e8", fontWeight: "600" },
  brandName: { fontSize: 21, fontWeight: "700", color: "#213c30" },
  eyebrow: { fontSize: 10, letterSpacing: 1.5, color: "#779282", marginTop: 4 },
  title: {
    fontSize: 35,
    fontWeight: "600",
    letterSpacing: -1.2,
    color: "#213c30",
  },
  subtitle: { fontSize: 14, color: "#73847a", lineHeight: 23 },
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e1eae3",
    borderRadius: 20,
    padding: 23,
    gap: 15,
  },
  label: { fontSize: 12, fontWeight: "600", color: "#496252" },
  input: {
    backgroundColor: "#f9fbf9",
    borderColor: "#dce6df",
    borderWidth: 1,
    borderRadius: 10,
    padding: 15,
    color: "#213c30",
    fontSize: 16,
  },
  button: {
    paddingVertical: 17,
    paddingHorizontal: 22,
    backgroundColor: "#17694f",
    borderRadius: 12,
    alignItems: "center",
    marginTop: 6,
  },
  secondary: { backgroundColor: "#e8f0e9" },
  buttonText: { fontSize: 15, color: "#fff", fontWeight: "600" },
  note: { color: "#7a8c7e", fontSize: 12, lineHeight: 20 },
  heading: {
    color: "#213c30",
    fontSize: 25,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  badge: {
    color: "#277751",
    fontSize: 10,
    letterSpacing: 1.3,
    fontWeight: "600",
    marginBottom: 10,
  },
  siteName: { fontWeight: "600", fontSize: 15, color: "#3b5946" },
  callout: { backgroundColor: "#f1f6f1", borderRadius: 10, padding: 15 },
  tabs: { flexDirection: "row", gap: 12 },
  historyRow: {
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: "#e7eee8",
    gap: 7,
  },
  message: {
    backgroundColor: "#f9eae3",
    color: "#894a35",
    padding: 17,
    borderRadius: 12,
    lineHeight: 22,
  },
  footer: {
    color: "#a0afa3",
    textAlign: "center",
    fontSize: 9,
    letterSpacing: 2,
    marginVertical: 22,
  },
});
