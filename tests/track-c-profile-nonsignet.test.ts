// Run as a separate Bun process: APP_VARIANT is intentionally a module constant.
// This fixture does not mutate a getter after module import or open any wallet.
import { afterAll, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
const source = (name: string) => fileURLToPath(new URL(`../client/src/${name}`, import.meta.url));
const previous = process.env.EXPO_PUBLIC_NOAH_PROFILE;
const previousPush = process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT;
process.env.EXPO_PUBLIC_NOAH_PROFILE = "track-c";
process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT = "unifiedpush";
afterAll(() => {
  if (previous === undefined) delete process.env.EXPO_PUBLIC_NOAH_PROFILE; else process.env.EXPO_PUBLIC_NOAH_PROFILE = previous;
  if (previousPush === undefined) delete process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT; else process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT = previousPush;
});
const read = mock(() => { throw new Error("Filesystem must not be read for non-Signet"); });
mock.module("expo-application", () => ({ applicationId: "com.noahwallet.trackc.signet" }));
mock.module("react-native", () => ({ Platform: { OS: "android" } }));
mock.module(source("config.ts"), () => ({ APP_VARIANT: "mainnet" }));
mock.module("react-native-fs-turbo", () => ({ default: {
  DocumentDirectoryPath: "/synthetic-private-app-files", readFile: read,
} }));
const { getTrackCSignetProfile } = await import("../client/src/lib/trackCRuntime");
test("fresh non-Signet module refuses before reading any private runtime file", () => {
  expect(() => getTrackCSignetProfile()).toThrow("C Signet configuration is unavailable or invalid");
  expect(read).not.toHaveBeenCalled();
});
