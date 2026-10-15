import RNFSTurbo from "react-native-fs-turbo";
import { Platform } from "react-native";
import { APP_VARIANT } from "~/config";
import { parseTrackBProfile, type TrackBSignetProfile } from "./trackBProfile";
let pinned: string | null = null;
export function getTrackBSignetProfile(): TrackBSignetProfile {
  try {
    if (Platform.OS !== "android" || APP_VARIANT !== "signet") throw new Error();
    // Root provisions this once, as this app UID/0600, before the first launch.
    // It is never part of the APK, public build environment or source archive.
    const raw = RNFSTurbo.readFile(
      `${RNFSTurbo.DocumentDirectoryPath}/track-b-signet-profile.json`,
      "utf8",
    );
    if (pinned !== null && raw !== pinned) throw new Error();
    const profile = parseTrackBProfile(raw);
    pinned = raw;
    return profile;
  } catch {
    throw new Error("B Signet configuration is unavailable or invalid");
  }
}
