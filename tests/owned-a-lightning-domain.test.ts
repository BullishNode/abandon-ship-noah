// Software routing boundary only; no HTTP, wallet or native payment is executed.
import { expect, mock, test } from "bun:test";
import { fileURLToPath } from "node:url";
process.env.EXPO_PUBLIC_NOAH_PROFILE = "track-a-two-step-per-key";
process.env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT = "unifiedpush";
mock.module("expo-application", () => ({ applicationId: "com.noahwallet.tracka.signet" }));
const path = fileURLToPath(new URL("../client/src/owned-signet-routing.json", import.meta.url));
mock.module(path, () => ({ default: { schema:1, profile:"track-a-two-step-per-key", network:"signet", api_url:"https://owned-noah.example.test",lnurl_domain:"owned-noah.example.test",blockheight_url:"https://owned-noah.example.test/height",wallet:{ark:"http://127.0.0.1:3535",bitcoind:"http://127.0.0.1:19333",bitcoind_user:"synthetic",bitcoind_pass:"synthetic"} } }));
const { assertOwnedLightningDomain } = await import("../client/src/lib/ownedSignetRouting");
test("the declared owned domain is admitted", () => { expect(() => assertOwnedLightningDomain("owned-noah.example.test")).not.toThrow(); });
for (const domain of ["signet.noahwallet.io", "foreign.example.test", "", "owned-noah.example.test.evil.invalid"]) test(`foreign or malformed domain ${domain} is refused`, () => { expect(() => assertOwnedLightningDomain(domain)).toThrow("refuses a foreign"); });
