import React, { useEffect } from "react";
import { Image, Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  FadeIn,
  FadeInDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { T, themed } from "./theme";

// Shared motion and visual pieces for the phone app. Motion follows the phone's "reduce
// motion" setting (Reanimated does this by default): enter animations become instant.
// Timing: things arrive in 260-320 ms with a light stagger, presses answer in ~100 ms.

export type IconName = keyof typeof Ionicons.glyphMap;
/** One outline icon set across the app. Decorative unless given a label. */
export function Icon({
  name,
  size = 22,
  color = T.ink,
  label,
}: {
  name: IconName;
  size?: number;
  color?: string;
  label?: string;
}) {
  return (
    <Ionicons
      name={name}
      size={size}
      color={color}
      accessibilityElementsHidden={!label}
      importantForAccessibility={label ? "yes" : "no-hide-descendants"}
      accessibilityLabel={label}
    />
  );
}

/** Content that rises gently into place; in lists, each item a little after the one before. */
export function Appear({
  index = 0,
  children,
  style,
}: {
  index?: number;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <Animated.View entering={FadeInDown.duration(300).delay(Math.min(index, 8) * 45)} style={style}>
      {children}
    </Animated.View>
  );
}
/** A whole screen fading in when it opens. */
export function ScreenIn({ children }: { children: React.ReactNode }) {
  return (
    <Animated.View entering={FadeIn.duration(220)} style={{ gap: 14 }}>
      {children}
    </Animated.View>
  );
}

/** A Pressable that dips slightly while held, then springs back. */
export function PressScale({
  style,
  children,
  haptic = false,
  onPress,
  ...rest
}: PressableProps & { style?: StyleProp<ViewStyle>; haptic?: boolean; children: React.ReactNode }) {
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));
  return (
    <Pressable
      {...rest}
      onPressIn={(e) => {
        scale.set(withTiming(0.97, { duration: 90 }));
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withSpring(1, { damping: 14, stiffness: 260 }));
        rest.onPressOut?.(e);
      }}
      onPress={(e) => {
        if (haptic) tick();
        onPress?.(e);
      }}
    >
      <Animated.View style={[style, anim]}>{children}</Animated.View>
    </Pressable>
  );
}

/** A grey block that pulses while content loads, in the shape of what is coming. */
export function Skeleton({ height = 16, width = "100%", radius = 8 }: { height?: number; width?: number | `${number}%`; radius?: number }) {
  const o = useSharedValue(0.55);
  useEffect(() => {
    o.set(withRepeat(withSequence(withTiming(1, { duration: 650 }), withTiming(0.55, { duration: 650 })), -1));
  }, [o]);
  const anim = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ height, width, borderRadius: radius, backgroundColor: T.fill }, anim]} />;
}
/** A loading card: a title line and three rows. */
export function SkeletonCard() {
  return (
    <View style={u.card} accessibilityLabel="Loading" accessibilityRole="progressbar">
      <Skeleton height={20} width="45%" />
      <Skeleton />
      <Skeleton width="80%" />
      <Skeleton width="60%" />
    </View>
  );
}

// Haptics: a light tick on selection, a success buzz when something is recorded.
export const tick = () => void Haptics.selectionAsync().catch(() => {});
export const success = () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
export const failure = () => void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});

/** A round photo, or initials on the brand colour when there is none. */
export function Avatar({
  name,
  uri,
  headers,
  size = 44,
}: {
  name: string;
  uri?: string | null;
  headers?: Record<string, string>;
  size?: number;
}) {
  const initials = name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
  const box = { width: size, height: size, borderRadius: size / 2 };
  return uri ? (
    <Image source={{ uri, headers }} style={[box, { backgroundColor: T.soft }]} accessibilityLabel={`Photo of ${name}`} />
  ) : (
    <View style={[box, u.initials]} accessibilityLabel={name}>
      <Text style={[u.initialsText, { fontSize: size * 0.36 }]}>{initials}</Text>
    </View>
  );
}

const u = themed(() =>
  StyleSheet.create({
    card: {
      backgroundColor: T.surface,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: T.line,
      padding: 16,
      gap: 10,
    },
    initials: { backgroundColor: T.primary, alignItems: "center", justifyContent: "center" },
    initialsText: { color: "#fff", fontWeight: "800" },
  }),
);
