import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  KeyboardAvoidingView,
  Modal,
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
import { CameraView, useCameraPermissions } from "expo-camera";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as Notifications from "expo-notifications";
import More, { MENU, type Section } from "./More";
type User = {
  id: number;
  name: string;
  role: string;
  must_change_password: boolean;
  email?: string | null;
  employee_code?: string | null;
  designation?: string | null;
};
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
  company?: { id: number; name: string; require_selfie?: boolean } | null;
  workplace: { name: string; radius: number } | null;
  openShift: Shift | null;
  todayShift: Shift | null;
  device: { status: "pending" | "approved" | "revoked" } | null;
};
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});
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
      <Text style={[s.buttonText, secondary && { color: "#4e5aa8" }]}>
        {title}
      </Text>
    </Pressable>
  );
}
export default function Attendance() {
  const [token, setToken] = useState<string | null>(null),
    sessionRef = useRef<string | null>(null),
    locked = useRef(false),
    pushToken = useRef<string | null>(null),
    pushRegistered = useRef(false),
    identity = useRef<Identity | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [nextPassword, setNextPassword] = useState("");
  const [changing, setChanging] = useState(false),
    [message, setMessage] = useState(""),
    [timezone, setTimezone] = useState("Asia/Kolkata");
  // Which screen the menu has open: the punch screen, or one of More's sections.
  const [view, setView] = useState<Section | "Punch">("Home"),
    [menuOpen, setMenuOpen] = useState(false),
    [counts, setCounts] = useState({ alerts: 0, messages: 0 });
  const [cameraPermission, requestCamera] = useCameraPermissions();
  const selfieResolver = useRef<((photo: string | null) => void) | null>(null);
  const cameraRef = useRef<CameraView | null>(null);
  const [selfieOpen, setSelfieOpen] = useState(false);
  // "Mark IN / OUT": the person sees where the phone says they are and confirms.
  const [fix, setFix] = useState<{
    action: "in" | "out";
    address: string;
    accuracy: number;
  } | null>(null);
  const fixResolver = useRef<((ok: boolean) => void) | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  async function confirmPlace(
    position: Location.LocationObject,
    action: "in" | "out",
  ): Promise<boolean> {
    let address = "";
    try {
      const [a] = await Promise.race([
        Location.reverseGeocodeAsync(position.coords),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slow")), 5000)),
      ]);
      address = [a?.name, a?.street, a?.district, a?.city, a?.postalCode]
        .filter(Boolean)
        .join(", ");
    } catch {
      /* the coordinates are shown instead */
    }
    setFix({
      action,
      address:
        address ||
        position.coords.latitude.toFixed(5) + ", " + position.coords.longitude.toFixed(5),
      accuracy: Math.round(position.coords.accuracy ?? 0),
    });
    return new Promise((resolve) => {
      fixResolver.current = resolve;
    });
  }
  const answerFix = (ok: boolean) => {
    setFix(null);
    fixResolver.current?.(ok);
  };
  // Resolves with a small JPEG (base64) or null if the person cancels.
  async function takeSelfie(): Promise<string | null> {
    if (!cameraPermission?.granted && !(await requestCamera()).granted)
      throw new Error(
        "Allow camera access in phone settings to take the selfie.",
      );
    setSelfieOpen(true);
    return new Promise((resolve) => {
      selfieResolver.current = resolve;
    });
  }
  async function captureSelfie() {
    let base64: string | null = null;
    try {
      const photo = await cameraRef.current?.takePictureAsync({
        quality: 0.7,
        skipProcessing: true,
        shutterSound: false,
      });
      // A full-resolution camera photo is several MB; 480 px wide is plenty to see a face
      // and keeps the punch small (about 30-60 KB).
      if (photo?.uri) {
        const image = await ImageManipulator.manipulate(photo.uri)
          .resize({ width: 480 })
          .renderAsync();
        base64 =
          (
            await image.saveAsync({
              compress: 0.6,
              format: SaveFormat.JPEG,
              base64: true,
            })
          ).base64 ?? null;
      }
    } finally {
      setSelfieOpen(false);
      selfieResolver.current?.(base64);
    }
  }
  function cancelSelfie() {
    setSelfieOpen(false);
    selfieResolver.current?.(null);
  }
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
    setPassword("");
    setNextPassword("");
    await SecureStore.deleteItemAsync(KEY);
  }
  async function api<T>(
    path: string,
    body?: object,
    session = sessionRef.current,
    method?: string,
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
        ...(body || method
          ? {
              method: method ?? "POST",
              ...(body ? { body: JSON.stringify(body) } : {}),
            }
          : {}),
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
  // Android only: registers this phone for push. Quietly does nothing when the app was
  // built without Firebase, or the person declines notifications.
  async function registerPush(session: string) {
    if (Platform.OS !== "android") return;
    try {
      await Notifications.setNotificationChannelAsync("default", {
        name: "HR updates",
        importance: Notifications.AndroidImportance.DEFAULT,
      });
      let granted = (await Notifications.getPermissionsAsync()).granted;
      if (!granted)
        granted = (await Notifications.requestPermissionsAsync()).granted;
      if (!granted) return;
      const { data } = await Notifications.getDevicePushTokenAsync();
      if (typeof data !== "string" || !data) return;
      pushToken.current = data;
      await api(
        "/push/register",
        { token: data, platform: "android" },
        session,
      );
    } catch {
      /* push is a convenience; the in-app alerts still work */
    }
  }
  async function refresh(session = sessionRef.current) {
    if (!session) return;
    const p = await api<Profile>("/me", undefined, session);
    setProfile(p);
    if (!p.user.must_change_password && p.user.role !== "super_admin") {
      if (!pushRegistered.current) {
        pushRegistered.current = true;
        void registerPush(session);
      }
    }
  }
  // popup: also show a failure as a pop-up, for actions started away from the
  // message area (the Home punch button sits far above it).
  async function run(fn: () => Promise<void>, popup = false) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      const text =
        e instanceof Error ? e.message : "Unable to connect. Please retry.";
      setMessage(text);
      if (popup) Alert.alert("Attendance not recorded", text);
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
      if (pushToken.current)
        await api("/push/unregister", { token: pushToken.current }).catch(
          () => {},
        );
      pushRegistered.current = false;
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
  const punch = (popup = false) =>
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
      let selfie: string | undefined;
      if (current.company?.require_selfie) {
        const photo = await takeSelfie();
        if (!photo) throw new Error("A selfie is needed to punch.");
        selfie = photo;
      }
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
      if (!(await confirmPlace(position, action))) return;
      // The server takes readings up to a minute old; take a new one after a long pause.
      if (Date.now() - position.timestamp > 40000)
        position = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.Highest,
        });
      try {
        await api("/punch", {
          action,
          ...(selfie ? { selfie } : {}),
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
    }, popup);
  const onCounts = useCallback(
    (alerts: number, messages: number) => setCounts({ alerts, messages }),
    [],
  );
  // For images and file links: the server address and the same headers api() sends.
  const files = useMemo(
    () => ({
      base: API,
      headers: (): Record<string, string> => ({
        ...(sessionRef.current
          ? { Authorization: "Bearer " + sessionRef.current }
          : {}),
        ...(identity.current?.secret
          ? {
              "X-Device-Id": identity.current.id,
              "X-Device-Secret": identity.current.secret,
            }
          : {}),
      }),
    }),
    [],
  );
  const moreApi = useMemo(
    () =>
      <T,>(path: string, body?: object, method?: string) =>
        api<T>(path, body, sessionRef.current, method),
    // api reads only refs and state setters, so the first one stays valid.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const open = profile?.openShift,
    done = profile?.todayShift;
  const passwordScreen = profile?.user.must_change_password || changing;
  const employeeView =
    !!profile && !passwordScreen && profile.user.role !== "super_admin";
  return (
    <SafeAreaView style={s.safe}>
      <StatusBar style="dark" />
      <Modal
        visible={selfieOpen}
        animationType="slide"
        onRequestClose={cancelSelfie}
      >
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <CameraView ref={cameraRef} style={{ flex: 1 }} facing="front" />
          <View style={{ padding: 20, gap: 12, backgroundColor: "#000" }}>
            <Text style={{ color: "#fff", textAlign: "center" }}>
              Face the camera and tap Take selfie.
            </Text>
            <Button title="Take selfie" onPress={() => void captureSelfie()} />
            <Button title="Cancel" secondary onPress={cancelSelfie} />
          </View>
        </View>
      </Modal>
      {employeeView && profile && (
        <View style={s.topbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Open menu"
            onPress={() => setMenuOpen(true)}
            hitSlop={10}
          >
            <Text style={s.burger}>☰</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Alerts"
            onPress={() => setView("Alerts")}
            hitSlop={10}
          >
            <Text style={s.bell}>
              🔔{counts.alerts ? " " + counts.alerts : ""}
            </Text>
          </Pressable>
          <View style={s.avatar}>
            <Text style={s.avatarText}>
              {profile.user.name
                .split(" ")
                .filter(Boolean)
                .slice(0, 2)
                .map((w) => w[0].toUpperCase())
                .join("")}
            </Text>
          </View>
          <View style={{ maxWidth: 170 }}>
            <Text style={s.barCode}>
              {profile.user.employee_code || profile.user.name}
            </Text>
            <Text style={s.barSub} numberOfLines={2}>
              {profile.user.designation ||
                (profile.user.employee_code ? profile.user.name : "")}
            </Text>
          </View>
        </View>
      )}
      <Modal
        visible={menuOpen && employeeView}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuOpen(false)}
      >
        <View style={s.menuWrap}>
          <View style={s.menu}>
            <ScrollView>
              {profile && (
                <View style={s.menuUser}>
                  <Text style={s.menuCompany}>LAXMI INDIA FINANCE</Text>
                  <View style={s.menuAvatar}>
                    <Text style={s.menuAvatarText}>
                      {profile.user.name
                        .split(" ")
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((w) => w[0].toUpperCase())
                        .join("")}
                    </Text>
                  </View>
                  <Text style={s.menuName}>{profile.user.name}</Text>
                  {!!profile.user.email && (
                    <Text style={s.menuSub}>{profile.user.email}</Text>
                  )}
                  {!!profile.user.designation && (
                    <Text style={s.menuSub}>{profile.user.designation}</Text>
                  )}
                </View>
              )}
              {MENU.map(([group, items]) => (
                <View key={group} style={{ marginBottom: 6 }}>
                  <Text style={s.menuGroup}>{group}</Text>
                  {items.map(([id, label]) => (
                    <Pressable
                      key={id}
                      onPress={() => {
                        setView(id);
                        setMenuOpen(false);
                      }}
                      style={[s.menuItem, view === id && s.menuItemOn]}
                    >
                      <Text style={s.menuText}>
                        {label}
                        {id === "Messages" && counts.messages
                          ? " (" + counts.messages + ")"
                          : ""}
                        {id === "Alerts" && counts.alerts
                          ? " (" + counts.alerts + ")"
                          : ""}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ))}
              <Text style={s.menuGroup}>Account</Text>
              <Pressable
                style={s.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  setChanging(true);
                }}
              >
                <Text style={s.menuText}>Change Password</Text>
              </Pressable>
              <Pressable
                style={s.menuItem}
                onPress={() => {
                  setMenuOpen(false);
                  void logout();
                }}
              >
                <Text style={s.menuText}>Log Out</Text>
              </Pressable>
              <Text style={s.menuVersion}>
                Version {Constants.expoConfig?.version ?? ""}
              </Text>
            </ScrollView>
          </View>
          <Pressable
            style={{ flex: 1 }}
            accessibilityLabel="Close menu"
            onPress={() => setMenuOpen(false)}
          />
        </View>
      </Modal>
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
          {!employeeView && (
            <View style={s.brand}>
              <View style={s.logo}>
                <Text style={s.logoText}>L</Text>
              </View>
              <View>
                <Text style={s.brandName}>Laxmi India</Text>
                <Text style={s.eyebrow}>FINANCE LTD. · HRMS</Text>
              </View>
            </View>
          )}
          {loading ? (
            <ActivityIndicator size="large" color="#4e5aa8" />
          ) : !token ? (
            <>
              <Text style={s.title}>Employee Engagement Portal</Text>
              <Text style={s.subtitle}>Creating a great place to work.</Text>
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
                <View>
                  <TextInput
                    accessibilityLabel="Password"
                    style={[s.input, { paddingRight: 56 }]}
                    secureTextEntry={!showPassword}
                    autoComplete="current-password"
                    value={password}
                    onChangeText={setPassword}
                  />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={showPassword ? "Hide password" : "Show password"}
                    onPress={() => setShowPassword(!showPassword)}
                    style={s.eye}
                    hitSlop={10}
                  >
                    <Text style={{ fontSize: 18 }}>{showPassword ? "🙈" : "👁"}</Text>
                  </Pressable>
                </View>
                <Button
                  title={busy ? "Signing in…" : "Sign in →"}
                  onPress={login}
                  disabled={busy || !email || !password}
                />
                <Button
                  title="Forgot password?"
                  secondary
                  disabled={busy || !email}
                  onPress={() =>
                    run(async () => {
                      const r = await api<{ message: string }>(
                        "/forgot-password",
                        { email: email.trim() },
                        null,
                      );
                      setMessage(r.message);
                    })
                  }
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
              {view !== "Punch" ? (
                <More
                  api={moreApi}
                  userId={profile.user.id}
                  section={view}
                  onSection={setView}
                  onPunch={() => setView("Punch")}
                  onSlidePunch={() => punch(true)}
                  onCounts={onCounts}
                  files={files}
                  onSignOut={() => void logout()}
                  onPassword={() => setChanging(true)}
                />
              ) : (
                <>
                  <Text style={s.crumb}>Attendance / Punch In / Out</Text>
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
                    onPress={() => void punch()}
                    disabled={
                      busy ||
                      profile.device?.status !== "approved" ||
                      (!open && !done && !profile.workplace)
                    }
                  />
                  <Button
                    title="My Attendance"
                    secondary
                    onPress={() => setView("My Attendance")}
                  />
                  </View>
                  <Text style={s.note}>
                    Location is captured only at punch-in and punch-out. No
                    background tracking. Pull down to refresh.
                  </Text>
                </>
              )}
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
      {employeeView && (
        <View style={s.tabBar}>
          {(
            [
              ["Home", "⌂", "Home"],
              ["Leave", "☼", "Leave"],
              ["My Attendance", "▤", "Attendance"],
              ["Profile", "☺", "Profile"],
            ] as const
          ).map(([id, icon, label]) => (
            <Pressable
              key={id}
              accessibilityRole="tab"
              accessibilityState={{ selected: view === id }}
              onPress={() => setView(id)}
              style={[s.tabItem, view === id && s.tabItemOn]}
            >
              <Text style={[s.tabIcon, view === id && { color: "#ac051b" }]}>{icon}</Text>
              <Text style={[s.tabLabel, view === id && { color: "#ac051b" }]}>{label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Modal
        visible={!!fix}
        transparent
        animationType="slide"
        onRequestClose={() => answerFix(false)}
      >
        <View style={s.sheetWrap}>
          <View style={s.sheet}>
            <Text style={s.sheetTitle}>
              {fix?.action === "out" ? "Mark OUT" : "Mark IN"}
            </Text>
            <View style={s.pinRow}>
              <Text style={s.pin}>📍</Text>
              <View style={{ flex: 1 }}>
                <Text style={s.sheetAddress}>{fix?.address}</Text>
                <Text style={s.note}>
                  Accurate to about {fix?.accuracy} m ·{" "}
                  {profile?.workplace?.name ?? "your workplace"}
                </Text>
              </View>
            </View>
            <Button
              title="Confirm"
              onPress={() => answerFix(true)}
            />
            <Button title="Cancel" secondary onPress={() => answerFix(false)} />
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f8f7fa" },
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
    backgroundColor: "#ac051b",
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  logoText: { fontSize: 28, color: "#ffffff", fontWeight: "600" },
  brandName: { fontSize: 21, fontWeight: "700", color: "#2a2c3a" },
  eyebrow: { fontSize: 10, letterSpacing: 1.5, color: "#8a8c99", marginTop: 4 },
  title: {
    fontSize: 35,
    fontWeight: "600",
    letterSpacing: -1.2,
    color: "#2a2c3a",
  },
  subtitle: { fontSize: 14, color: "#6f7282", lineHeight: 23 },
  card: {
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#eceaf1",
    borderRadius: 20,
    padding: 23,
    gap: 15,
  },
  label: { fontSize: 12, fontWeight: "600", color: "#555867" },
  input: {
    backgroundColor: "#fafafc",
    borderColor: "#e1e0e8",
    borderWidth: 1,
    borderRadius: 10,
    padding: 15,
    color: "#2a2c3a",
    fontSize: 16,
  },
  button: {
    paddingVertical: 17,
    paddingHorizontal: 22,
    backgroundColor: "#4e5aa8",
    borderRadius: 12,
    alignItems: "center",
    marginTop: 6,
  },
  secondary: { backgroundColor: "#eceefa" },
  buttonText: { fontSize: 15, color: "#fff", fontWeight: "600" },
  note: { color: "#7a7d8c", fontSize: 12, lineHeight: 20 },
  heading: {
    color: "#2a2c3a",
    fontSize: 25,
    fontWeight: "600",
    letterSpacing: -0.5,
  },
  badge: {
    color: "#ac051b",
    fontSize: 10,
    letterSpacing: 1.3,
    fontWeight: "600",
    marginBottom: 10,
  },
  siteName: { fontWeight: "600", fontSize: 15, color: "#3a3c4a" },
  callout: { backgroundColor: "#f3f2f7", borderRadius: 10, padding: 15 },
  tabs: { flexDirection: "row", gap: 12 },
  crumb: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    fontWeight: "600",
    color: "#2a2c3a",
  },
  topbar: {
    backgroundColor: "#24262f",
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  burger: { color: "#fff", fontSize: 26 },
  bell: { color: "#fff", fontSize: 18 },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: "#e7e3f3",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#4e5aa8", fontWeight: "700" },
  barCode: { color: "#fff", fontWeight: "700", fontSize: 16 },
  barSub: { color: "#d7d8df", fontSize: 11 },
  eye: { position: "absolute", right: 14, top: 0, bottom: 0, justifyContent: "center" },
  menuUser: {
    backgroundColor: "#8c0416",
    paddingTop: 48,
    paddingHorizontal: 18,
    paddingBottom: 16,
    gap: 2,
  },
  menuAvatar: {
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 8,
  },
  menuAvatarText: { color: "#ac051b", fontWeight: "800", fontSize: 18 },
  menuName: { color: "#fff", fontWeight: "800", fontSize: 17 },
  menuCompany: {
    color: "#fff",
    fontWeight: "800",
    letterSpacing: 1.5,
    fontSize: 12,
    marginBottom: 12,
  },
  menuSub: { color: "#fbd5da", fontSize: 12 },
  menuVersion: { color: "#fbd5da", fontSize: 11, textAlign: "center", marginTop: 18 },
  tabBar: {
    flexDirection: "row",
    backgroundColor: "#fff",
    borderTopWidth: 1,
    borderColor: "#eceaf1",
    paddingVertical: 6,
    paddingHorizontal: 8,
  },
  tabItem: { flex: 1, alignItems: "center", paddingVertical: 6, borderRadius: 14 },
  tabItemOn: { backgroundColor: "#fde7ea" },
  tabIcon: { fontSize: 18, color: "#7a7d8c" },
  tabLabel: { fontSize: 11, color: "#7a7d8c", fontWeight: "600" },
  sheetWrap: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
  sheet: {
    backgroundColor: "#fff",
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 22,
    gap: 12,
  },
  sheetTitle: { fontSize: 22, fontWeight: "800", color: "#2a2c3a" },
  pinRow: { flexDirection: "row", gap: 12, alignItems: "center" },
  pin: { fontSize: 34 },
  sheetAddress: { fontSize: 15, fontWeight: "700", color: "#2a2c3a" },
  menuWrap: {
    flex: 1,
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  menu: { width: 280, backgroundColor: "#ac051b", paddingBottom: 30 },
  menuGroup: {
    color: "#fbd5da",
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1,
    textTransform: "uppercase",
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 4,
  },
  menuItem: { paddingVertical: 11, paddingHorizontal: 26 },
  menuItemOn: { backgroundColor: "#8c0416" },
  menuText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  historyRow: {
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderColor: "#f0eff4",
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
    color: "#a2a4b0",
    textAlign: "center",
    fontSize: 9,
    letterSpacing: 2,
    marginVertical: 22,
  },
});
