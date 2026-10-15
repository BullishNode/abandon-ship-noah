// Synthetic parser/config controls only; no endpoint, SDK, Android or payment calls.
import { afterAll, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
const previous = process.env.EXPO_PUBLIC_NOAH_PROFILE;
const previousPush = process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT;
process.env.EXPO_PUBLIC_NOAH_PROFILE = "track-c";
process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT = "unifiedpush";
const source = (name: string) => fileURLToPath(new URL(`../client/src/${name}`, import.meta.url));
const fixture = {
  version: 1, profile: "track-c", network: "signet",
  ark: "https://ark.c-fixture.invalid", server: "https://noah.c-fixture.invalid",
  lnurlDomain: "lnurl.c-fixture.invalid", bitcoind: "http://127.0.0.1:19443",
  bitcoindUser: "synthetic-test-user", bitcoindPass: "synthetic-test-only-not-a-runtime-secret",
  vtxoRefreshExpiryThreshold: 48, fallbackFeeRate: 10000, htlcRecvClaimDelta: 18,
  vtxoExitMargin: 12, roundTxRequiredConfirmations: 1,
};
mock.module("expo-application", () => ({ applicationId: "com.noahwallet.trackc.signet" }));
const { parseTrackCProfile } = await import("../client/src/lib/trackCProfile");
let platform = "android";
const appVariant = "signet";
let raw: string | null = null;
const reads: string[] = [];
mock.module("react-native", () => ({ Platform: { get OS() { return platform; } } }));
mock.module("expo-constants", () => ({ default: { expoConfig: { version: "synthetic" } } }));
mock.module(source("config.ts"), () => ({ get APP_VARIANT() { return appVariant; } }));
mock.module("react-native-fs-turbo", () => ({ default: {
  DocumentDirectoryPath: "/synthetic-private-app-files",
  readFile(path: string) { reads.push(path); if (raw === null) throw new Error("synthetic missing file"); return raw; },
} }));
const { getTrackCSignetProfile } = await import("../client/src/lib/trackCRuntime");
const wallet = await import("../client/src/lib/walletConfig");
afterAll(() => { if (previous === undefined) delete process.env.EXPO_PUBLIC_NOAH_PROFILE; else process.env.EXPO_PUBLIC_NOAH_PROFILE = previous;
  if (previousPush === undefined) delete process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT; else process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT = previousPush; });

test("complete private profile is immutable and retains exact Core bindings", () => {
  const parsed = parseTrackCProfile(JSON.stringify(fixture));
  expect(parsed).toEqual(fixture); expect(Object.isFrozen(parsed)).toBe(true);
});
for (const [name, delta] of [
  ["wrong network", { network: "regtest" }], ["coerced version", { version: "1" }],
  ["stock Ark", { ark: "https://ark.signet.2nd.dev" }],
  ["stock backend", { server: "https://signet.noahwallet.io" }],
  ["stock LNURL", { lnurlDomain: "signet.noahwallet.io" }],
  ["remote HTTP Core", { bitcoind: "http://core.c-fixture.invalid:19443" }],
  ["unsupported TLS Core", { bitcoind: "https://127.0.0.1:19443" }],
  ["localhost Core", { bitcoind: "http://localhost:19443" }],
  ["abbreviated loopback", { bitcoind: "http://127.1:19443" }],
  ["missing Core port", { bitcoind: "http://127.0.0.1" }],
  ["oversized port", { bitcoind: "http://127.0.0.1:65536" }],
  ["URL credentials", { ark: "https://user:password@ark.c-fixture.invalid" }],
  ["URL query", { server: "https://noah.c-fixture.invalid?secret=synthetic" }],
  ["missing real auth", { bitcoindPass: "" }],
  ["unsafe auth character", { bitcoindUser: "user:other" }],
  ["fractional policy", { htlcRecvClaimDelta: 1.5 }],
  ["overflow policy", { vtxoExitMargin: 65536 }],
  ["extra Esplora", { esplora: "https://foreign-fixture.invalid" }],
] as const) {
  test(`${name} refuses with a static error`, () => {
    expect(() => parseTrackCProfile(JSON.stringify({ ...fixture, ...delta }))).toThrow("C Signet configuration is unavailable or invalid");
  });
}
test("missing fields, malformed or excessive JSON refuse", () => {
  const { bitcoindPass: omitted, ...partial } = fixture;
  expect(omitted).toBeTruthy();
  for (const value of [JSON.stringify(partial), "{", "[]", " ".repeat(8193)]) {
    expect(() => parseTrackCProfile(value)).toThrow("C Signet configuration is unavailable or invalid");
  }
});
test("literal IPv6 and explicit port80 use the same local HTTP contract", () => {
  for (const bitcoind of ["http://[::1]:19443", "http://127.0.0.1:80"]) {
    expect(parseTrackCProfile(JSON.stringify({ ...fixture, bitcoind })).bitcoind).toBe(bitcoind);
  }
});
test("missing private file refuses; unsupported iOS refuses before reading", () => {
  expect(() => getTrackCSignetProfile()).toThrow("C Signet configuration is unavailable or invalid");
  const count = reads.length;
  platform = "ios";
  expect(() => getTrackCSignetProfile()).toThrow();
  expect(reads.length).toBe(count);
  platform = "android";
});
test("JS config uses private Core and ignores a persisted/custom Esplora override", () => {
  raw = JSON.stringify(fixture);
  const config = wallet.getEffectiveWalletConfig("https://foreign-fixture.invalid");
  expect(config.signet).toBe(true); expect(config.regtest).toBe(false); expect(config.bitcoin).toBe(false);
  expect(config.config?.ark).toBe(fixture.ark);
  expect(config.config?.esplora).toBe("");
  expect(config.config?.bitcoind).toBe(fixture.bitcoind);
  expect(wallet.getDefaultBlockheightEndpoint()).toBe(fixture.bitcoind);
  expect(wallet.getWalletRpcAuth()).toEqual({ username: fixture.bitcoindUser, password: fixture.bitcoindPass });
  expect(reads.every((path) => path === "/synthetic-private-app-files/track-c-signet-profile.json")).toBe(true);
});
test("changed private bindings refuse within a process and original bindings remain readable", () => {
  raw = JSON.stringify({ ...fixture, server: "https://changed.c-fixture.invalid" });
  expect(() => getTrackCSignetProfile()).toThrow("C Signet configuration is unavailable or invalid");
  raw = JSON.stringify(fixture); expect(getTrackCSignetProfile().server).toBe(fixture.server);
});

for (const transport of [undefined, "expo"]) test(`C build selection refuses undeclared transport ${String(transport)}`, () => {
  const env = { ...process.env };
  if (transport === undefined) delete env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT;
  else env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT = transport;
  const result = Bun.spawnSync([process.execPath, "-e", `const { mock } = await import("bun:test"); mock.module("expo-application", () => ({ applicationId: "com.noahwallet.trackc.signet" })); await import(${JSON.stringify(source("lib/trackCProfile.ts"))})`], { env });
  expect(result.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(result.stderr)).toContain("C Signet requires its declared UnifiedPush transport");
});
