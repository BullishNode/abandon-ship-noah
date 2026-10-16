import { applicationId } from "expo-application";

// Public profile selection; credentials come only from the privately provisioned
// app file. This selector is not financial readiness or proof of endpoint ownership.
const selectedProfile = process.env.EXPO_PUBLIC_NOAH_PROFILE;
if (selectedProfile && selectedProfile !== "stock" && selectedProfile !== "track-c") {
  throw new Error("Unknown Noah build profile");
}
export const TRACK_C_PROFILE = selectedProfile === "track-c";
// This value comes from the installed native package, not Expo/Metro environment.
const ownedNativeApplication = [
  "com.noahwallet.tracka.signet", "com.noahwallet.trackb.signet", "com.noahwallet.trackc.signet",
].includes(applicationId ?? "");
if (TRACK_C_PROFILE ? applicationId !== "com.noahwallet.trackc.signet" : ownedNativeApplication) {
  throw new Error("Noah native application and JavaScript profile do not match");
}
if (TRACK_C_PROFILE && process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT !== "unifiedpush") {
  throw new Error("C Signet requires its declared UnifiedPush transport");
}

export interface TrackCSignetProfile {
  version: 1;
  profile: "track-c";
  network: "signet";
  ark: string;
  server: string;
  lnurlDomain: string;
  bitcoind: string;
  bitcoindUser: string;
  bitcoindPass: string;
  vtxoRefreshExpiryThreshold: number;
  fallbackFeeRate: number;
  htlcRecvClaimDelta: number;
  vtxoExitMargin: number;
  roundTxRequiredConfirmations: number;
}
const FAIL = "C Signet configuration is unavailable or invalid";
const FIELDS = ["version", "profile", "network", "ark", "server", "lnurlDomain", "bitcoind",
  "bitcoindUser", "bitcoindPass", "vtxoRefreshExpiryThreshold", "fallbackFeeRate",
  "htlcRecvClaimDelta", "vtxoExitMargin", "roundTxRequiredConfirmations"];
const LOCAL = /^http:\/\/(?:127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})\/?$/;
const endpoint = (value: unknown, core = false): string => {
  if (typeof value !== "string" || value.length > 2048 || !/^[!-~]+$/.test(value)) throw new Error(FAIL);
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(FAIL);
  const match = LOCAL.exec(value);
  const local = match !== null && Number(match[1]) <= 65535;
  if (core ? !local : !(value.startsWith("https://") || local)) throw new Error(FAIL);
  if (["second.tech", "2nd.dev", "noahwallet.io"].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new Error(FAIL);
  }
  return value;
};
export function parseTrackCProfile(raw: string): TrackCSignetProfile {
  try {
    if (raw.length > 8192) throw new Error(FAIL);
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(FAIL);
    const data = value as Record<string, unknown>;
    if (Object.keys(data).length !== FIELDS.length || !FIELDS.every((key) => Object.hasOwn(data, key)) ||
        data.version !== 1 || data.profile !== "track-c" || data.network !== "signet") throw new Error(FAIL);
    endpoint(data.ark); endpoint(data.server); endpoint(data.bitcoind, true);
    if (typeof data.lnurlDomain !== "string" || data.lnurlDomain.length > 253 ||
        !/^[a-z0-9][a-z0-9.-]*\.[a-z0-9]+$/.test(data.lnurlDomain) || data.lnurlDomain.includes("..") ||
        ["second.tech", "2nd.dev", "noahwallet.io"].some((host) => data.lnurlDomain === host || (data.lnurlDomain as string).endsWith(`.${host}`))) throw new Error(FAIL);
    if (typeof data.bitcoindUser !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(data.bitcoindUser) ||
        typeof data.bitcoindPass !== "string" || !/^[!-~]{1,256}$/.test(data.bitcoindPass)) throw new Error(FAIL);
    for (const key of ["vtxoRefreshExpiryThreshold", "htlcRecvClaimDelta", "vtxoExitMargin", "roundTxRequiredConfirmations"]) {
      const number = data[key];
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 || number > 65535) throw new Error(FAIL);
    }
    if (typeof data.fallbackFeeRate !== "number" || !Number.isSafeInteger(data.fallbackFeeRate) || data.fallbackFeeRate <= 0) throw new Error(FAIL);
    return Object.freeze(data) as unknown as TrackCSignetProfile;
  } catch { throw new Error(FAIL); }
}
