// Mocked orchestration only: no native, device, Redis or payment qualification.
import { beforeEach, expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ok } from "neverthrow";
const source = (name: string) => fileURLToPath(new URL(`../client/src/${name}`, import.meta.url));
const hash = "9d041fb4729e3c19c8716cc6f6143a02ba93dcedfba07e9bf197c2b3dea0b595";
const load = mock(async () => ok(true));
const boundInvoice = mock(async (_sats: number, _hash: string) => ok({ payment_request: "public-bound-invoice-fixture" }));
const submit = mock(async (_payload: unknown) => ok(undefined));
mock.module(source("lib/walletApi.ts"), () => ({ loadWalletIfNeeded: load, maintenanceDelegated: async () => ok(undefined) }));
mock.module(source("lib/paymentsApi.ts"), () => ({
  bolt11InvoiceWithDescriptionHash: boundInvoice,
  tryClaimAllLightningReceives: async () => ok(undefined),
}));
mock.module(source("lib/api.ts"), () => ({ submitInvoice: submit }));
mock.module(source("lib/backupCoordinator.ts"), () => ({ flushBackup: async () => ok(undefined) }));
mock.module(source("lib/log.ts"), () => ({ default: () => ({ e() {}, d() {}, i() {} }) }));
mock.module("react-native-nitro-ark", () => ({}));
const { submitInvoiceTask } = await import("../client/src/lib/tasks");
beforeEach(() => { load.mockClear(); boundInvoice.mockClear(); submit.mockClear(); });
test("LNURL task preserves exact hash and requested amount on dedicated native route", async () => {
  expect((await submitInvoiceTask("public-transaction-fixture", 100_000, hash)).isOk()).toBe(true);
  expect(boundInvoice).toHaveBeenCalledWith(100, hash);
  expect(submit).toHaveBeenCalledWith({ invoice: "public-bound-invoice-fixture", transaction_id: "public-transaction-fixture" });
});
for (const amount of [0, -1000, 1001, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid LNURL amount ${amount} refuses before loading or native invoice`, async () => {
    expect((await submitInvoiceTask("public-transaction-fixture", amount, hash)).isErr()).toBe(true);
    expect(load).not.toHaveBeenCalled(); expect(boundInvoice).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });
}
for (const invalid of ["", "00".repeat(31), "gg".repeat(32), undefined]) {
  test(`missing or malformed hash ${String(invalid)} refuses without native call`, async () => {
    expect((await submitInvoiceTask("public-transaction-fixture", 100_000, invalid as string)).isErr()).toBe(true);
    expect(load).not.toHaveBeenCalled(); expect(boundInvoice).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });
}
