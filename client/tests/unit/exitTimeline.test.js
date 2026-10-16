import { describe, expect, mock, test } from "bun:test";

globalThis.__DEV__ = false;
mock.module("expo-application", () => ({ applicationId: "com.noahwallet.mainnet" }));

mock.module("noah-tools", () => ({
  getAppVariant: () => "mainnet",
  isGooglePlayServicesAvailable: () => true,
  nativeLog: () => {},
}));
mock.module("react-native", () => ({
  Platform: { OS: "ios" },
}));
mock.module("react-native-fs-turbo", () => ({
  default: {
    CachesDirectoryPath: "/tmp",
    DocumentDirectoryPath: "/tmp",
  },
}));
mock.module("expo-device", () => ({
  isDevice: true,
  manufacturer: "Apple",
  modelName: "iPhone 12 Pro",
  osName: "iOS",
  osVersion: "26.5",
}));

const {
  buildExitTimelineItems,
  getExitStateLabels,
  EXIT_STATE_ORDER,
  getExitStatusText,
  isCancelableExit,
  isClaimableExit,
  getExitBlockRows,
} = await import("../../src/lib/exitTimeline");

describe("exit cancellation eligibility", () => {
  test("allows a newly started exit", () => {
    expect(isCancelableExit("Start", { kind: "start", tip_height: 100 })).toBe(true);
  });

  test("allows processing until the final exit transaction is broadcast", () => {
    for (const kind of [
      "verify-inputs",
      "awaiting-input-confirmation",
      "awaiting-cpfp-broadcast",
    ]) {
      expect(
        isCancelableExit("Processing", {
          kind: "processing",
          tip_height: 100,
          transactions: [{ txid: "final", status: { kind } }],
        }),
      ).toBe(true);
    }

    expect(
      isCancelableExit("Processing", {
        kind: "processing",
        tip_height: 100,
        transactions: [
          { txid: "ancestor", status: { kind: "confirmed" } },
          { txid: "final", status: { kind: "awaiting-cpfp-broadcast" } },
        ],
      }),
    ).toBe(true);
  });

  test("rejects processing after the final exit transaction is broadcast", () => {
    for (const kind of ["awaiting-confirmation", "confirmed"]) {
      expect(
        isCancelableExit("Processing", {
          kind: "processing",
          tip_height: 100,
          transactions: [{ txid: "final", status: { kind } }],
        }),
      ).toBe(false);
    }
  });

  test("rejects states beyond the abortable window", () => {
    for (const state of [
      "AwaitingDelta",
      "Claimable",
      "ClaimInProgress",
      "Claimed",
      "VtxoAlreadySpent",
      "Canceled",
    ]) {
      expect(isCancelableExit(state, { kind: "awaiting-delta", tip_height: 100 })).toBe(false);
    }
  });
});

describe("canceled exit timelines", () => {
  test("exposes canceled as a terminal exit state", () => {
    expect(EXIT_STATE_ORDER.at(-1)).toBe("Canceled");
    expect(getExitStateLabels().Canceled).toBe("Canceled");
    expect(getExitStatusText({ state: "Canceled" })).toBe("Exit processing was canceled");
  });

  test("describes a canceled state in timeline history", () => {
    const items = buildExitTimelineItems({
      history: ["Start", "Canceled"],
      historyDetails: [
        { kind: "start", tip_height: 100 },
        { kind: "canceled", tip_height: 101 },
      ],
      currentState: "Canceled",
      currentDetails: { kind: "canceled", tip_height: 101 },
      currentBlockHeight: 101,
    });

    expect(items.at(-1)).toMatchObject({
      state: "Canceled",
      label: "Canceled",
      description: "Exit processing was canceled before completion.",
      isCurrent: true,
    });
  });
});


describe("swept exit API compatibility", () => {
  test("preserves the terminal swept input facts without claiming a payout", () => {
    const details = { kind: "vtxo-swept", tip_height: 220, spent_inputs: ["backing:0"] };
    expect(getExitStateLabels().VtxoSwept).toBe("Swept");
    expect(getExitStatusText({ state: "VtxoSwept", details })).toBe("Exit backing was swept");
    const items = buildExitTimelineItems({ currentState: "VtxoSwept", currentDetails: details });
    expect(items[0].description).toBe("A backing input was spent by another transaction. This exit cannot continue.");
    expect(getExitBlockRows({ state: "VtxoSwept", details })).toContainEqual({ label: "Spent backing inputs", value: "backing:0", explorerUrl: null });
    expect(isCancelableExit("VtxoSwept", details)).toBe(false);
  });
  test("a fresh swept status overrides an older claimable flag", () => {
    const exit = { state: "Claimable", state_details: { kind: "claimable" }, is_claimable: true };
    expect(isClaimableExit(exit, { state: "VtxoSwept", state_details: { kind: "vtxo-swept" } })).toBe(false);
  });
});
