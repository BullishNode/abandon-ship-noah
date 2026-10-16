// Fresh-process software admission only; no installed APK, JNI, HTTP or wallet is opened.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
const path = fileURLToPath(new URL("../client/src/lib/ownedSignetRouting.ts", import.meta.url));
const A = "track-a-two-step-per-key";
const cases: [string, string | undefined, boolean][] = [
  ["com.noahwallet.tracka.signet", A, true],
  ["com.noahwallet.signet", undefined, true],
  ["com.noahwallet.mainnet", "stock", true],
  ["com.noahwallet.signet", A, false],
  ["com.noahwallet.trackb.signet", A, false],
  ["com.noahwallet.trackc.signet", A, false],
  ["com.noahwallet.tracka.signet", undefined, false],
  ["com.noahwallet.tracka.signet", "stock", false],
  ["com.noahwallet.trackb.signet", undefined, false],
  ["com.noahwallet.trackb.signet", "stock", false],
  ["com.noahwallet.trackc.signet", undefined, false],
  ["com.noahwallet.trackc.signet", "stock", false],
  ["com.noahwallet.tracka.signet", "track-c-sweep-per-key", false],
  ["com.noahwallet.signet", "track-b-sweep-fixed", false],
];
for (const [nativeId, profile, accepted] of cases) test(`native ${nativeId}; JS ${String(profile)}`, () => {
  const env = { ...process.env, EXPO_PUBLIC_NOAH_PUSH_TRANSPORT: "unifiedpush" };
  if (profile === undefined) delete env.EXPO_PUBLIC_NOAH_PROFILE;
  else env.EXPO_PUBLIC_NOAH_PROFILE = profile;
  const code = `const {mock}=await import("bun:test");mock.module("expo-application",()=>({applicationId:${JSON.stringify(nativeId)}}));await import(${JSON.stringify(path)})`;
  const result = Bun.spawnSync([process.execPath, "-e", code], { env });
  expect(result.exitCode === 0).toBe(accepted);
});
