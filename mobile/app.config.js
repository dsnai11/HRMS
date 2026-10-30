const fs = require("node:fs");
// Android push needs the Firebase file; without it the app still builds, just without push.
const googleServices = fs.existsSync(`${__dirname}/google-services.json`)
  ? "./google-services.json"
  : undefined;

module.exports = {
  expo: {
    name: "Laxmi India HRMS",
    slug: "laxmi-india-hrms",
    scheme: "laxmihrms",
    version: "1.0.0",
    orientation: "portrait",
    userInterfaceStyle: "light",
    icon: "./assets/icon.png",
    web: { favicon: "./assets/favicon.png" },
    ios: {
      supportsTablet: true,
      bundleIdentifier: process.env.IOS_BUNDLE_ID || "com.laxmiindia.hrms",
      infoPlist: { ITSAppUsesNonExemptEncryption: false },
    },
    android: {
      ...(googleServices ? { googleServicesFile: googleServices } : {}),
      package: process.env.ANDROID_PACKAGE || "com.laxmiindia.hrms",
      adaptiveIcon: {
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundColor: "#ffffff",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      blockedPermissions: [
        "android.permission.ACCESS_BACKGROUND_LOCATION",
        "android.permission.RECORD_AUDIO",
      ],
    },
    plugins: [
      "expo-router",
      "expo-secure-store",
      "expo-notifications",
      [
        "expo-local-authentication",
        {
          faceIDPermission:
            "Face ID is used only to unlock the app on this phone, if you turn it on.",
        },
      ],
      [
        "expo-camera",
        {
          cameraPermission:
            "The camera is used only to take a selfie when you punch in or out, if your company requires it.",
          recordAudioAndroid: false,
        },
      ],
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
