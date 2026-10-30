import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

// Fingerprint / face unlock. When it is on and a session is saved, the app opens behind a lock
// that only the phone's biometrics (or its screen-lock PIN, as the system fallback) remove,
// and locks again after it has been in the background for a while. Turning it on needs a
// successful scan first. "Sign in with password instead" forgets the saved session.
export const SESSION_KEY = "laxmi.hrms.session";
const LOCK_KEY = "laxmi.hrms.biometric-lock";
const RELOCK_AFTER_MS = 30_000;

export async function biometricAvailable() {
  return (
    (await LocalAuthentication.hasHardwareAsync()) &&
    (await LocalAuthentication.isEnrolledAsync())
  );
}
export async function biometricLockOn() {
  return (await SecureStore.getItemAsync(LOCK_KEY)) === "1";
}
const scan = async (promptMessage: string) =>
  (
    await LocalAuthentication.authenticateAsync({
      promptMessage,
      cancelLabel: "Cancel",
    })
  ).success;

/** Turns the lock on (after a successful scan) or off. Returns the new state, or an error. */
export async function setBiometricLock(
  on: boolean,
): Promise<{ on: boolean; error?: string }> {
  if (!on) {
    await SecureStore.deleteItemAsync(LOCK_KEY);
    return { on: false };
  }
  if (!(await biometricAvailable()))
    return {
      on: false,
      error:
        "Set up a fingerprint or face unlock in your phone's settings first.",
    };
  if (!(await scan("Confirm to turn on fingerprint / face unlock")))
    return { on: false };
  await SecureStore.setItemAsync(LOCK_KEY, "1");
  return { on: true };
}

export function BiometricGate({ children }: { children: React.ReactNode }) {
  // checking → locked/unlocked. Children mount only after the first unlock, so nothing is
  // loaded or shown before the person proves who they are.
  const [state, setState] = useState<"checking" | "locked" | "unlocked">(
    "checking",
  );
  const [mounted, setMounted] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [error, setError] = useState("");
  const backgroundAt = useRef<number | null>(null);
  const prompting = useRef(false);

  const needsLock = async () =>
    (await biometricLockOn()) &&
    Boolean(await SecureStore.getItemAsync(SESSION_KEY));

  const unlock = useCallback(async () => {
    if (prompting.current) return;
    prompting.current = true;
    setError("");
    try {
      if (await scan("Unlock Laxmi India HRMS")) {
        setState("unlocked");
        setMounted(true);
      } else setError("Not unlocked. Try again.");
    } catch {
      setError("Fingerprint / face unlock is not available right now.");
    } finally {
      prompting.current = false;
    }
  }, []);

  useEffect(() => {
    void (async () => {
      if (await needsLock()) {
        setState("locked");
        void unlock();
      } else {
        setState("unlocked");
        setMounted(true);
      }
    })();
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background") backgroundAt.current = Date.now();
      if (next === "active" && backgroundAt.current !== null) {
        const away = Date.now() - backgroundAt.current;
        backgroundAt.current = null;
        if (away >= RELOCK_AFTER_MS)
          void needsLock().then((lock) => {
            if (lock) {
              setState("locked");
              void unlock();
            }
          });
      }
    });
    return () => sub.remove();
  }, [unlock]);

  const signInWithPassword = async () => {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    await SecureStore.deleteItemAsync(LOCK_KEY);
    setGeneration((g) => g + 1); // remount: the app starts at sign-in
    setState("unlocked");
    setMounted(true);
  };

  return (
    <View style={{ flex: 1 }}>
      {mounted && <React.Fragment key={generation}>{children}</React.Fragment>}
      {state !== "unlocked" && (
        <View style={s.cover} accessibilityViewIsModal>
          {state === "locked" && (
            <>
              <Image
                source={require("../assets/logo.png")}
                style={s.logo}
                resizeMode="contain"
                accessibilityIgnoresInvertColors
              />
              <Text style={s.title}>Locked</Text>
              <Text style={s.note}>
                Use your fingerprint or face to open the app.
              </Text>
              {error ? <Text style={s.error}>{error}</Text> : null}
              <Pressable
                accessibilityRole="button"
                style={s.button}
                onPress={() => void unlock()}
              >
                <Text style={s.buttonText}>Unlock</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={s.link}
                onPress={() => void signInWithPassword()}
              >
                <Text style={s.linkText}>Sign in with password instead</Text>
              </Pressable>
            </>
          )}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  cover: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    padding: 28,
    gap: 12,
  },
  logo: { width: 150, height: 58, marginBottom: 12 },
  title: { fontSize: 22, fontWeight: "700", color: "#2a2c3a" },
  note: { fontSize: 15, color: "#6d6f7d", textAlign: "center" },
  error: { fontSize: 14, color: "#ac051b", textAlign: "center" },
  button: {
    marginTop: 12,
    backgroundColor: "#ac051b",
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 48,
  },
  buttonText: { color: "#ffffff", fontSize: 16, fontWeight: "600" },
  link: { padding: 10 },
  linkText: { color: "#4e5aa8", fontSize: 14 },
});
