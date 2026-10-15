const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { prepare } = require("./prepare_owned_signet_routing.cjs");

// These are synthetic software configuration controls, never a network/readiness verdict.
const sdk = "a".repeat(40), nitro = "b".repeat(40);
const base = () => ({
  schema: 1, profile: "track-a-two-step-per-key", network: "signet",
  genesis: "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6",
  server_pubkey: "02" + "c".repeat(64), sdk_commit: sdk, nitro_commit: nitro,
  api_url: "https://noah-a.example.test", lnurl_domain: "noah-a.example.test",
  blockheight_url: "https://chain-a.example.test/height",
  wallet: { ark: "http://ark-a.example.test:3535", bitcoind: "http://127.0.0.1:18443/rpc",
    bitcoind_user: "synthetic-readonly-role", bitcoind_pass: "synthetic-software-control-token",
    vtxo_refresh_expiry_threshold: 12, fallback_fee_rate: 10000, htlc_recv_claim_delta: 18,
    vtxo_exit_margin: 12, round_tx_required_confirmations: 2 },
});
const native = () => ({ mainnet: { preserved: "mainnet" }, regtest: { preserved: "regtest" }, signet: { old: true } });
function invoke(data, modify = {}) {
  const bytes = Buffer.from(JSON.stringify(data));
  return prepare(bytes, modify.hash ?? crypto.createHash("sha256").update(bytes).digest("hex"),
    modify.sdk ?? sdk, modify.nitro ?? nitro, modify.native ?? native());
}
test("same declared signet config reaches JS and native without changing other networks", () => {
  const data = base(), result = invoke(data), js = JSON.parse(result.js), asset = JSON.parse(result.android);
  assert.deepEqual(js, data); assert.deepEqual(asset.mainnet, native().mainnet); assert.deepEqual(asset.regtest, native().regtest);
  assert.equal(asset.signet.ark, js.wallet.ark); assert.equal(asset.signet.server, js.api_url);
  assert.equal(asset.signet.bitcoind, js.wallet.bitcoind); assert.equal(asset.signet.esplora, null);
  assert.equal(asset.signet.vtxoRefreshExpiryThreshold, 12); assert.equal(asset.signet.htlcRecvClaimDelta, 18);
  assert.equal(asset.signet.vtxoExitMargin, 12); assert.equal(asset.signet.routingProfile, js.profile);
});
test("declared Esplora is supported without an additional Core backend", () => {
  const d = base(); delete d.wallet.bitcoind; delete d.wallet.bitcoind_user; delete d.wallet.bitcoind_pass;
  d.wallet.esplora = "https://chain-a.example.test/api";
  const out = JSON.parse(invoke(d).android); assert.equal(out.signet.esplora, d.wallet.esplora); assert.equal(out.signet.bitcoind, null);
});
for (const [name, mutate] of [
  ["wrong genesis", d => { d.genesis = "d".repeat(64); }],
  ["wrong profile", d => { d.profile = "track-b"; }],
  ["wrong network", d => { d.network = "mainnet"; }],
  ["missing chain", d => { delete d.wallet.bitcoind; }],
  ["two chain backends", d => { d.wallet.esplora = "https://chain-a.example.test/api"; }],
  ["weaker exit margin", d => { d.wallet.vtxo_exit_margin = 11; }],
  ["nonintegral confirmations", d => { d.wallet.round_tx_required_confirmations = 1.5; }],
  ["embedded credentials", d => { d.wallet.bitcoind = "https://user:pass@chain-a.example.test"; }],
  ["false native RPC TLS label", d => { d.wallet.bitcoind = "https://127.0.0.1:18443"; }],
  ["public plaintext RPC", d => { d.wallet.bitcoind = "http://chain-a.example.test:18443"; }],
  ["credentialless native RPC", d => { delete d.wallet.bitcoind_user; delete d.wallet.bitcoind_pass; }],
  ["empty scoped RPC authentication", d => { d.wallet.bitcoind_pass = ""; }],
  ["Core cookie on a phone", d => { d.wallet.bitcoind_cookie = "/operator/.cookie"; }],
  ["stock API origin", d => { d.api_url = "https://signet.noahwallet.io"; d.lnurl_domain = "signet.noahwallet.io"; }],
  ["stock Ark origin", d => { d.wallet.ark = "https://ark.signet.2nd.dev"; }],
  ["stock Esplora origin", d => { delete d.wallet.bitcoind; d.wallet.esplora = "https://esplora.signet.2nd.dev"; }],
  ["LNURL origin drift", d => { d.lnurl_domain = "other.example.test"; }],
  ["unknown field", d => { d.payment_ready = true; }],
]) test(`rejects ${name}`, () => { const d = base(); mutate(d); assert.throws(() => invoke(d)); });
test("requires external admitted hash and exact SDK/Nitro pins", () => {
  assert.throws(() => invoke(base(), { hash: "0".repeat(64) }));
  assert.throws(() => invoke(base(), { sdk: "0".repeat(40) }));
  assert.throws(() => invoke(base(), { nitro: "0".repeat(40) }));
});
test("refuses unknown native asset shape", () => { assert.throws(() => invoke(base(), { native: {} })); });
