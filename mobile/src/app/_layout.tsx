import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { BiometricGate } from "../biometric";
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <BiometricGate>
        <Stack screenOptions={{ headerShown: false }} />
      </BiometricGate>
    </SafeAreaProvider>
  );
}
