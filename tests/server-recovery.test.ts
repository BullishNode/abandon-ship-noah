// Focused orchestration controls use public synthetic data and mocked native calls.
// They do not qualify native recovery, JNI artifacts, cryptography, or a device.
import { beforeEach, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { err, ok } from "neverthrow";

const source = (name: string) => fileURLToPath(new URL(`../client/src/${name}`, import.meta.url));
const DATA = "/public-fixture/ark";
const MARKER = `${DATA}.server-recovery-pending`;
const PHRASE = "public synthetic fixture, not a wallet seed";
const files = new Map<string, string>();
const events: string[] = [];
let stored: string | null = null;
let loaded = false;
let markerWriteFails = false;
let markerRemoveFails = false;
let saveFails = false;
let invalidPhrase = false;
let response: Record<string, unknown>;
let nativeFailure = false;
let waitForNative: Promise<void> | null = null;
const state = {
  isInitialized: false, isWalletLoaded: false, restoreProgress: null as unknown,
  setRestoreProgress(value: unknown) { state.restoreProgress = value; },
};
const forbidden = () => { throw new Error("Unexpected wallet mutation in fixture"); };
const nativeRecovery = mock(async () => {
  events.push("native-recovery");
  files.set(`${DATA}/db.sqlite`, "imported fixture state");
  loaded = true;
  if (waitForNative) await waitForNative;
  if (nativeFailure) throw new Error("provider error must not be presented as success");
  return response;
});
const backupFailure = new Error("fixture backup service unavailable");
const listBackups = mock(async (_options: { mnemonic: string }) => err(backupFailure));

mock.module("react-native-nitro-ark", () => ({
  restoreWalletFromArkServer: nativeRecovery,
  isWalletLoaded: async () => loaded,
  deriveKeypairFromMnemonic: async () => {
    if (invalidPhrase) throw new Error("invalid phrase");
    return { public_key: "public-fixture", secret_key: "synthetic-not-a-key" };
  },
  createMnemonic: forbidden, loadWallet: forbidden, createWallet: forbidden,
  mailboxAuthorization: forbidden, onchainBalance: forbidden, offchainBalance: forbidden,
  sync: forbidden, onchainSync: forbidden, closeWallet: forbidden, verifyMessage: forbidden,
  maintenance: forbidden, maintenanceRefresh: forbidden, maintenanceDelegated: forbidden,
  refreshVtxosDelegated: forbidden, estimateRefreshFee: forbidden, refreshServer: forbidden,
  getArkInfo: forbidden, syncPendingRounds: forbidden, signMesssageWithMnemonic: forbidden,
  vtxos: forbidden, decodeVtxoHex: forbidden, importVtxo: forbidden,
  dangerousDropVtxo: forbidden, unlockVtxos: forbidden, getExpiringVtxos: forbidden,
  createWalletSnapshot: forbidden, validateWalletSnapshot: forbidden,
}));
mock.module("react-native-fs-turbo", () => ({ default: {
  exists: (name: string) => files.has(name) || [...files.keys()].some((key) => key.startsWith(`${name}/`)),
  readdir: (name: string) => [...files.keys()].filter((key) => key.startsWith(`${name}/`)),
  writeFile: (name: string, value: string) => {
    if (markerWriteFails) throw new Error("fixture marker write failure");
    events.push("marker"); files.set(name, value);
  },
  unlink: (name: string) => {
    if (name !== MARKER) forbidden();
    if (markerRemoveFails) throw new Error("fixture marker unlink failure");
    events.push("clear-marker"); files.delete(name);
  },
} }));
mock.module(source("constants.ts"), () => ({
  ARK_DATA_PATH: DATA, CACHES_DIRECTORY_PATH: "/public-fixture/cache",
  DOCUMENT_DIRECTORY_PATH: "/public-fixture", shouldUseUnifiedPush: () => false,
}));
mock.module(source("config.ts"), () => ({ APP_VARIANT: "regtest" }));
mock.module(source("lib/crypto.ts"), () => ({
  getStoredMnemonic: async () => ok(stored), getMnemonic: async () => ok(stored),
  setMnemonic: async (phrase: string) => {
    events.push("save-identity");
    if (saveFails) return err(new Error("fixture keystore unavailable"));
    stored = phrase; return ok(undefined);
  },
  peakKeyPair: async (index: number) => {
    expect(index).toBe(0); events.push("peek-auth0");
    return ok({ public_key: "public-fixture", secret_key: "synthetic-not-a-key" });
  },
  clearMnemonic: forbidden, resetServerAuthToken: async () => ok(undefined),
}));
mock.module(source("store/walletStore.ts"), () => ({ useWalletStore: {
  getState: () => state,
  setState: (value: object) => { events.push("finish"); Object.assign(state, value); },
} }));
mock.module(source("lib/log.ts"), () => ({ default: () => ({
  error() {}, e() {}, w() {}, d() {}, i() {},
}) }));
mock.module("noah-tools", () => ({
  storeNativeMnemonic: forbidden, clearNativeMnemonic: forbidden,
  clearNativeEsploraEndpoint: forbidden, storeNativeEsploraEndpoint: forbidden,
  decryptWalletBackup: forbidden, downloadFile: forbidden, encryptWalletSnapshot: forbidden,
  finalizeWalletSnapshotInstall: forbidden, installWalletSnapshot: forbidden,
  restoreBackup: forbidden, rollbackWalletSnapshotInstall: forbidden, uploadFile: forbidden,
}));
mock.module(source("lib/esplora.ts"), () => ({
  getEffectiveEsploraEndpoint: () => "https://public-fixture.invalid", validateEsploraEndpoint: forbidden,
}));
mock.module(source("lib/walletConfig.ts"), () => ({
  getDefaultEsploraEndpoint: () => null, getEffectiveWalletConfig: () => ({ regtest: true }),
  getWalletRefreshExpiryThreshold: () => 10,
}));
mock.module(source("store/esploraStore.ts"), () => ({ useEsploraStore: { getState: () => ({}) } }));
mock.module(source("store/backupStore.ts"), () => ({ useBackupStore: { getState: () => ({}) } }));
mock.module(source("lib/api.ts"), () => ({
  listBackupObjectsForRestore: listBackups, completeBackupUpload: forbidden,
  getBackupObjectDownloadForRestore: forbidden, getDownloadUrlForRestore: forbidden,
  initiateBackupUpload: forbidden, updateBackupSettings: forbidden,
}));
mock.module(source("lib/errorUtils.ts"), () => ({ redactSensitiveErrorMessage: () => "fixture error" }));
mock.module("react-native-uuid", () => ({ default: { v4: () => "public-fixture-operation" } }));
mock.module("ky", () => ({ default: { get: forbidden } }));

const wallet = await import("../client/src/lib/walletApi");
const backup = await import("../client/src/lib/backupService");
const completeReport = () => ({
  is_complete: true,
  recovered: { vtxo_ids: ["distinct-public-fixture-id"], known_amount_sat: 12000 },
  skipped: { vtxo_ids: [], known_amount_sat: 0 }, exited: { vtxo_ids: [], known_amount_sat: 0 },
  failed: { vtxo_ids: [], known_amount_sat: 0 }, foreign: { vtxo_ids: [], known_amount_sat: 0 },
});
beforeEach(() => {
  files.clear(); events.length = 0; stored = null; loaded = false;
  markerWriteFails = false; markerRemoveFails = false; saveFails = false; invalidPhrase = false;
  nativeFailure = false; waitForNative = null;
  response = { status: "completed", report: completeReport() };
  state.isInitialized = false; state.isWalletLoaded = false; state.restoreProgress = null;
  nativeRecovery.mockClear(); listBackups.mockClear();
});

test("actual complete native report finishes without ordinary create or load", async () => {
  const result = await wallet.restoreWalletFromServer(PHRASE);
  expect(result.isOk()).toBe(true);
  expect(nativeRecovery).toHaveBeenCalledTimes(1);
  expect(nativeRecovery.mock.calls[0]).toEqual([DATA, { regtest: true, mnemonic: PHRASE }]);
  expect(events).toEqual(["marker", "save-identity", "native-recovery", "peek-auth0", "clear-marker", "finish"]);
  expect(state.isInitialized && state.isWalletLoaded).toBe(true);
  expect(files.has(MARKER)).toBe(false);
  expect(files.get(`${DATA}/db.sqlite`)).toBe("imported fixture state");
});

test("completed but incomplete report preserves loaded assets and blocks replacement", async () => {
  response = { status: "completed", report: { ...completeReport(), is_complete: false } };
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(files.has(MARKER) && loaded).toBe(true); expect(stored).toBe(PHRASE);
  expect(files.get(`${DATA}/db.sqlite`)).toBe("imported fixture state");
  expect(state.isInitialized || state.isWalletLoaded).toBe(false);
  expect((await wallet.createWallet()).isErr()).toBe(true);
  expect((await wallet.loadWalletIfNeeded()).isErr()).toBe(true);
  expect((await backup.restoreWallet(PHRASE)).isErr()).toBe(true);
  expect(listBackups).not.toHaveBeenCalled(); expect(nativeRecovery).toHaveBeenCalledTimes(1);
  expect(events).not.toContain("clear-marker");
});

test("native failure status never becomes full restoration", async () => {
  response = { status: "failed", error: "fixture partial failure" };
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(files.has(MARKER) && loaded).toBe(true); expect(state.isInitialized).toBe(false);
});

test("native rejection after import preserves the same DB and identity", async () => {
  nativeFailure = true;
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(stored).toBe(PHRASE); expect(loaded).toBe(true);
  expect(files.get(`${DATA}/db.sqlite`)).toBe("imported fixture state");
  expect(files.has(MARKER)).toBe(true); expect(state.isInitialized).toBe(false);
});

test("a second server or backup action cannot race the pending native import", async () => {
  let release!: () => void;
  waitForNative = new Promise<void>((resolve) => { release = resolve; });
  const first = wallet.restoreWalletFromServer(PHRASE);
  while (!nativeRecovery.mock.calls.length) await Promise.resolve();
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect((await backup.restoreWallet(PHRASE)).isErr()).toBe(true);
  expect(listBackups).not.toHaveBeenCalled(); expect(nativeRecovery).toHaveBeenCalledTimes(1);
  release(); expect((await first).isOk()).toBe(true);
});

test("existing owned files are refused before any seed or native mutation", async () => {
  files.set(`${DATA}/db.sqlite`, "existing wallet");
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(events).toEqual([]); expect(nativeRecovery).not.toHaveBeenCalled();
  expect(files.get(`${DATA}/db.sqlite`)).toBe("existing wallet");
});

test("the backup route still uses its mnemonic-authenticated service, without server recovery", async () => {
  const result = await backup.restoreWallet(PHRASE);
  expect(result.isErr()).toBe(true);
  if (result.isErr()) expect(result.error).toBe(backupFailure);
  expect(listBackups).toHaveBeenCalledWith({ mnemonic: PHRASE });
  expect(nativeRecovery).not.toHaveBeenCalled(); expect(events).toEqual([]);
});

test("missing report is not a completed recovery", async () => {
  response = { status: "completed" };
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(files.has(MARKER)).toBe(true); expect(state.isInitialized).toBe(false);
});

test("marker write failure never starts native import", async () => {
  markerWriteFails = true;
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(nativeRecovery).not.toHaveBeenCalled(); expect(stored).toBe(null);
});

test("keystore failure keeps the pending hold and does not import", async () => {
  saveFails = true;
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(files.has(MARKER)).toBe(true); expect(nativeRecovery).not.toHaveBeenCalled();
});

test("a failed hold removal after full native recovery cannot mark onboarding complete", async () => {
  markerRemoveFails = true;
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(files.has(MARKER) && loaded).toBe(true); expect(state.isInitialized).toBe(false);
  expect(files.get(`${DATA}/db.sqlite`)).toBe("imported fixture state");
});

test("an invalid phrase is refused before writing pending state", async () => {
  invalidPhrase = true;
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(events).toEqual([]); expect(files.has(MARKER)).toBe(false);
  expect(nativeRecovery).not.toHaveBeenCalled();
});


test("server recovery cannot enter while ordinary wallet creation owns the action", async () => {
  // The native creation mock deliberately refuses, but the pending action must
  // exclude recovery before ordinary creation reaches any native mutation.
  const creation = wallet.createWallet().catch((error: unknown) => error);
  expect((await wallet.restoreWalletFromServer(PHRASE)).isErr()).toBe(true);
  expect(nativeRecovery).not.toHaveBeenCalled();
  expect(files.has(MARKER)).toBe(false);
  await creation;
});
