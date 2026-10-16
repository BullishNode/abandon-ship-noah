// Each native/JS pair gets a fresh module process; these are mocked identity controls.
// No wallet, endpoint, distributor or filesystem is accessed by these fixtures.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
const profileModule = fileURLToPath(
  new URL("../client/src/lib/trackBProfile.ts", import.meta.url),
);
const owned = "com.noahwallet.trackb.signet";
const mismatch = "Noah native application and JavaScript profile do not match";
const pairs: [string | undefined, string | null, boolean][] = [
  [undefined, owned, false],
  ["stock", owned, false],
  [undefined, "com.noahwallet.tracka.signet", false],
  ["stock", "com.noahwallet.tracka.signet", false],
  [undefined, "com.noahwallet.trackc.signet", false],
  ["stock", "com.noahwallet.trackc.signet", false],
  ["track-b", "com.noahwallet.signet", false],
  ["track-b", "com.noahwallet.mainnet", false],
  ["track-b", "com.noahwallet.regtest", false],
  ["track-b", "com.noahwallet.tracka.signet", false],
  ["track-b", "com.noahwallet.trackc.signet", false],
  ["track-b", null, false],
  ["track-b", owned, true],
  [undefined, "com.noahwallet.signet", true],
  ["stock", "com.noahwallet.mainnet", true],
  ["stock", "com.noahwallet.regtest", true],
];
for (const [selector, nativeId, allowed] of pairs) {
  test(`native ${String(nativeId)} and JS ${String(selector)} ${allowed ? "agree" : "refuse before admission"}`, () => {
    const env = { ...process.env };
    env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT = "unifiedpush";
    if (selector === undefined) delete env.EXPO_PUBLIC_NOAH_PROFILE;
    else env.EXPO_PUBLIC_NOAH_PROFILE = selector;
    const code = `const { mock } = await import("bun:test");
      mock.module("expo-application", () => ({ applicationId: ${JSON.stringify(nativeId)} }));
      const profile = await import(${JSON.stringify(profileModule)});
      if (profile.TRACK_B_PROFILE !== ${selector === "track-b"}) throw new Error("Unexpected selected profile");
      process.stdout.write("IDENTITY_ADMITTED");`;
    const result = Bun.spawnSync([process.execPath, "-e", code], { env });
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr);
    if (allowed) {
      expect(result.exitCode).toBe(0);
      expect(stdout).toBe("IDENTITY_ADMITTED");
    } else {
      expect(result.exitCode).not.toBe(0);
      expect(stdout).not.toContain("IDENTITY_ADMITTED");
      expect(stderr).toContain(mismatch);
    }
  });
}
