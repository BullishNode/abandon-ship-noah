import { applicationId } from "expo-application";
import declaredRouting from "../owned-signet-routing.json";
import type { BarkConfigOpts } from "react-native-nitro-ark";

export type OwnedSignetRouting = {
  schema: 1;
  profile: "track-a-two-step-per-key";
  network: "signet";
  api_url: string;
  lnurl_domain: string;
  blockheight_url: string;
  wallet: BarkConfigOpts;
};

const selectedProfile = process.env.EXPO_PUBLIC_NOAH_PROFILE;
const ownedNativeIds = new Set([
  "com.noahwallet.tracka.signet", "com.noahwallet.trackb.signet", "com.noahwallet.trackc.signet",
]);
export const OWNED_SIGNET_PROFILE = selectedProfile === "track-a-two-step-per-key";
if (selectedProfile !== undefined && selectedProfile !== "stock" && !OWNED_SIGNET_PROFILE) {
  throw new Error("Unknown or foreign owned Noah JavaScript profile");
}
if (OWNED_SIGNET_PROFILE ? applicationId !== "com.noahwallet.tracka.signet" : ownedNativeIds.has(applicationId ?? "")) {
  throw new Error("Installed native identity and Noah JavaScript profile do not match");
}
if (OWNED_SIGNET_PROFILE && process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT !== "unifiedpush") {
  throw new Error("A Signet requires its declared UnifiedPush transport");
}

// Configuration selects an isolated test destination; it never certifies readiness.
export const getOwnedSignetRouting = (variant: string): OwnedSignetRouting | null => {
  const selected = process.env.EXPO_PUBLIC_NOAH_PROFILE;
  if ((selected === undefined || selected === "stock") && declaredRouting === null) return null;
  if (selected !== "track-a-two-step-per-key" || variant !== "signet" ||
      declaredRouting === null) {
    throw new Error("An explicit, prepared signet routing profile is required.");
  }
  const routing = declaredRouting as OwnedSignetRouting;
  if (routing.schema !== 1 || routing.profile !== selected || routing.network !== "signet" ||
      !routing.api_url || !routing.lnurl_domain || !routing.blockheight_url || !routing.wallet?.ark ||
      (routing.wallet.bitcoind && (!routing.wallet.bitcoind_user || !routing.wallet.bitcoind_pass)) ||
      Number(Boolean(routing.wallet.esplora)) + Number(Boolean(routing.wallet.bitcoind)) !== 1) {
    throw new Error("Incomplete owned signet routing; public fallbacks are refused.");
  }
  return routing;
};

// Apply before discovery as well as before native submission in the owned profile.
export const assertOwnedLightningDomain = (domain: string): void => {
  if (!OWNED_SIGNET_PROFILE) return;
  const routing = getOwnedSignetRouting("signet");
  if (!routing || domain.toLowerCase() !== routing.lnurl_domain) {
    throw new Error("The owned signet profile refuses a foreign Lightning address domain.");
  }
};
