// Software-only profile admission; no native distributor or delivery evidence.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
const modulePath = fileURLToPath(new URL("../client/src/lib/ownedSignetRouting.ts", import.meta.url));
for (const transport of [undefined, "expo", "unifiedpush"]) test(`owned A push selection ${String(transport)}`, () => {
  const env = { ...process.env, EXPO_PUBLIC_NOAH_PROFILE: "track-a-two-step-per-key" };
  if (transport === undefined) delete env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT;
  else env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT = transport;
  const result = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(modulePath)})`], { env });
  expect(result.exitCode === 0).toBe(transport === "unifiedpush");
  if (transport !== "unifiedpush") expect(new TextDecoder().decode(result.stderr)).toContain("A Signet requires its declared UnifiedPush transport");
});
test("stock selection does not require an owned distributor", () => {
  const env = { ...process.env }; delete env.EXPO_PUBLIC_NOAH_PROFILE; delete env.EXPO_PUBLIC_NOAH_PUSH_TRANSPORT;
  const result = Bun.spawnSync([process.execPath, "-e", `await import(${JSON.stringify(modulePath)})`], { env });
  expect(result.exitCode).toBe(0);
});
