// Mocked transport admission only; no native distributor, device or delivery credit.
import { beforeEach, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
const source = (name: string) => fileURLToPath(new URL(`../client/src/${name}`, import.meta.url));
let endpoint = "";
let lookupFails = false;
let permission = "granted";
const expo = mock(async () => { throw new Error("Expo fallback must not run for C"); });
const lookup = mock(() => { if (lookupFails) throw new Error("synthetic distributor failure"); return endpoint; });
const unused = async () => { throw new Error("Unrelated operation must not run"); };
mock.module("gt-react-native", () => ({ getLocale: () => "en", msg: (value: string) => value }));
mock.module("react-native", () => ({ Platform: { OS: "android" } }));
mock.module("expo-device", () => ({ isDevice: false }));
mock.module("expo-constants", () => ({ default: { expoConfig: { extra: { eas: { projectId: "synthetic-stock-must-not-be-used" } } } } }));
mock.module("expo-notifications", () => ({
  AndroidImportance: { MAX: 5 }, PermissionStatus: { DENIED: "denied" },
  setNotificationChannelAsync: async () => undefined,
  getPermissionsAsync: async () => ({ status: permission }),
  requestPermissionsAsync: async () => ({ status: permission }),
  getDevicePushTokenAsync: expo, getExpoPushTokenAsync: expo,
  registerTaskAsync: async () => undefined,
  addNotificationReceivedListener: () => ({ remove() {} }), setNotificationHandler() {},
}));
mock.module("expo-task-manager", () => ({ defineTask() {} }));
mock.module("@sentry/react-native", () => ({ captureException() {} }));
mock.module("noah-tools", () => ({ getUnifiedPushEndpoint: lookup }));
mock.module(source("lib/trackCProfile.ts"), () => ({ TRACK_C_PROFILE: true }));
mock.module(source("constants.ts"), () => ({ shouldUseUnifiedPush: () => true }));
mock.module(source("lib/backgroundTranslations.ts"), () => ({ getBackgroundMessages: async () => (value: string) => value }));
mock.module(source("lib/log.ts"), () => ({ default: () => ({ d() {}, w() {}, e() {}, i() {} }) }));
mock.module(source("lib/tasks.ts"), () => ({ claimLightningReceivesTask: unused, maintenanceTask: unused, submitInvoiceTask: unused, triggerBackupTask: unused }));
mock.module(source("lib/api.ts"), () => ({ registerPushToken: unused, reportJobStatus: unused, heartbeatResponse: unused }));
mock.module(source("store/walletStore.ts"), () => ({ useWalletStore: { getState: unused } }));
mock.module(source("store/profileStore.ts"), () => ({ useProfileStore: { getState: unused } }));
mock.module(source("lib/bitcoinAmount.ts"), () => ({ formatBitcoinAmount: unused }));
mock.module(source("hooks/useWidget.ts"), () => ({ updateWidget: unused }));
mock.module(source("lib/recurringPayments.ts"), () => ({ executeDueRecurringPayments: unused }));
const { registerForPushNotificationsAsync, getPushPermissionStatus } = await import("../client/src/lib/pushNotifications");
beforeEach(() => { endpoint = ""; lookupFails = false; permission = "granted"; expo.mockClear(); lookup.mockClear(); });
test("C emulator accepts an actual returned UnifiedPush endpoint without Expo", async () => {
  endpoint = "https://owned-distributor-fixture.invalid/public-fixture";
  const result = await registerForPushNotificationsAsync();
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value).toEqual({ kind: "success", pushToken: endpoint, pushType: "unified" });
  expect(lookup).toHaveBeenCalledTimes(1); expect(expo).not.toHaveBeenCalled();
});
for (const fails of [false, true]) test(`missing or failed distributor lookup (${fails}) cannot fall back to stock Expo`, async () => {
  lookupFails = fails;
  expect((await registerForPushNotificationsAsync()).isErr()).toBe(true);
  expect(lookup).toHaveBeenCalledTimes(1); expect(expo).not.toHaveBeenCalled();
});
test("notification permission denial stays a denial without token lookup", async () => {
  permission = "denied";
  const result = await registerForPushNotificationsAsync();
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value).toEqual({ kind: "permission_denied", permissionStatus: "denied" });
  expect(lookup).not.toHaveBeenCalled(); expect(expo).not.toHaveBeenCalled();
});
test("emulator permission status never pretends to be a physical phone", async () => {
  const result = await getPushPermissionStatus();
  expect(result.isOk()).toBe(true);
  if (result.isOk()) expect(result.value.isPhysicalDevice).toBe(false);
  expect(expo).not.toHaveBeenCalled();
});
