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

// Configuration selects an isolated test destination; it never certifies readiness.
export const getOwnedSignetRouting = (variant: string): OwnedSignetRouting | null => {
  const selected = process.env.EXPO_PUBLIC_NOAH_PROFILE;
  if (selected === undefined && declaredRouting === null) return null;
  if (selected !== "track-a-two-step-per-key" || variant !== "signet" ||
      declaredRouting === null) {
    throw new Error("An explicit, prepared signet routing profile is required.");
  }
  const routing = declaredRouting as OwnedSignetRouting;
  if (routing.schema !== 1 || routing.profile !== selected || routing.network !== "signet" ||
      !routing.api_url || !routing.lnurl_domain || !routing.blockheight_url || !routing.wallet?.ark ||
      Number(Boolean(routing.wallet.esplora)) + Number(Boolean(routing.wallet.bitcoind)) !== 1) {
    throw new Error("Incomplete owned signet routing; public fallbacks are refused.");
  }
  return routing;
};
