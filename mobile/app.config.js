module.exports = {
  expo: {
    name: "Laxmi India HRMS",
    slug: "laxmi-india-hrms",
    scheme: "laxmihrms",
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    ios: {
      supportsTablet: true,
      bundleIdentifier: process.env.IOS_BUNDLE_ID || "com.laxmiindia.hrms",
      infoPlist: { ITSAppUsesNonExemptEncryption: false },
    },
    android: {
      package: process.env.ANDROID_PACKAGE || "com.laxmiindia.hrms",
      blockedPermissions: [
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.RECORD_AUDIO",
      ],
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      [
        "expo-location",
        {
          locationWhenInUsePermission:
            "Your location is used only when you punch in or out to verify your assigned workplace.",
          isIosBackgroundLocationEnabled: false,
          isAndroidBackgroundLocationEnabled: false,
          isAndroidForegroundServiceEnabled: false,
        },
      ],
    ],
  },
};
