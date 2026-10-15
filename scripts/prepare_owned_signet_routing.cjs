const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROFILE = "track-a-two-step-per-key";
const GENESIS = "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6";
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const exactKeys = (value, keys) => value && typeof value === "object" &&
  !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort());

function prepare(bytes, expectedHash, sdk, nitro, nativeAsset) {
  if (bytes.length > 65536 || !/^[a-f0-9]{64}$/.test(expectedHash) || hash(bytes) !== expectedHash) {
    throw new Error("Routing manifest differs from the independently admitted pin");
  }
  const data = JSON.parse(bytes);
  if (!exactKeys(data, ["schema", "profile", "network", "genesis", "server_pubkey", "sdk_commit",
    "nitro_commit", "api_url", "lnurl_domain", "blockheight_url", "wallet"]) ||
    data.schema !== 1 || data.profile !== PROFILE || data.network !== "signet" ||
    data.genesis !== GENESIS || !/^0[23][a-f0-9]{64}$/.test(data.server_pubkey) ||
    !/^[a-f0-9]{40}$/.test(sdk) || !/^[a-f0-9]{40}$/.test(nitro) ||
    data.sdk_commit !== sdk || data.nitro_commit !== nitro) {
    throw new Error("Wrong routing identity or field set");
  }
  const url = (value, httpsOnly = true) => {
    const parsed = new URL(value);
    if (!(httpsOnly ? parsed.protocol === "https:" : ["https:", "http:"].includes(parsed.protocol)) ||
        parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid owned URL");
    return parsed;
  };
  if (url(data.api_url).hostname !== data.lnurl_domain) throw new Error("LNURL origin differs");
  url(data.blockheight_url);
  const wallet = data.wallet;
  const chainKey = wallet?.esplora ? "esplora" : "bitcoind";
  const numeric = ["vtxo_refresh_expiry_threshold", "fallback_fee_rate", "htlc_recv_claim_delta",
    "vtxo_exit_margin", "round_tx_required_confirmations"];
  const auth = chainKey === "bitcoind" ? ["bitcoind_user", "bitcoind_pass"] : [];
  if (!exactKeys(wallet, ["ark", chainKey, ...numeric, ...auth]) ||
      auth.some((key) => typeof wallet[key] !== "string" || wallet[key].length === 0 ||
        wallet[key].length > 256 || /[\r\n\0]/.test(wallet[key])) ||
      numeric.some((key) => !Number.isSafeInteger(wallet[key]) || wallet[key] <= 0) ||
      wallet.vtxo_refresh_expiry_threshold !== 12 || wallet.htlc_recv_claim_delta !== 18 ||
      wallet.vtxo_exit_margin !== 12) throw new Error("Wallet routing or security margins differ");
  url(wallet.ark, false);
  if (chainKey === "esplora") {
    url(wallet.esplora);
  } else {
    // The pinned bitcoincore-rpc simple_http transport is plain TCP even for an
    // https-labelled URL. Only an independently qualified private HTTP route is supported.
    const rpc = url(wallet.bitcoind, false);
    const octets = rpc.hostname.split(".").map(Number);
    const ipv4 = octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255);
    const privateAddress = ipv4 && (octets[0] === 127 || octets[0] === 10 ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
    if (rpc.protocol !== "http:" || !privateAddress) {
      throw new Error("Native Core requires a qualified private HTTP route; HTTPS is not native TLS");
    }
  }
  const forbidden = ["noahwallet.io", "ark.signet.2nd.dev", "esplora.signet.2nd.dev", "mempool.space", "mempool.second.tech"];
  for (const value of [data.api_url, data.blockheight_url, wallet.ark, wallet[chainKey]]) {
    if (forbidden.some((host) => url(value, false).hostname === host || url(value, false).hostname.endsWith(`.${host}`))) {
      throw new Error("Stock external service is not an owned routing destination");
    }
  }
  const asset = JSON.parse(JSON.stringify(nativeAsset));
  if (!asset.signet || !asset.regtest || !asset.mainnet) throw new Error("Unknown native asset shape");
  asset.signet = {
    routingProfile: PROFILE,
    ark: wallet.ark, server: data.api_url, esplora: wallet.esplora ?? null,
    bitcoind: wallet.bitcoind ?? null, bitcoindCookie: null,
    bitcoindUser: wallet.bitcoind_user ?? null, bitcoindPass: wallet.bitcoind_pass ?? null,
    vtxoRefreshExpiryThreshold: wallet.vtxo_refresh_expiry_threshold,
    fallbackFeeRate: wallet.fallback_fee_rate, htlcRecvClaimDelta: wallet.htlc_recv_claim_delta,
    vtxoExitMargin: wallet.vtxo_exit_margin, roundTxRequiredConfirmations: wallet.round_tx_required_confirmations,
  };
  return { js: JSON.stringify(data, null, 2) + "\n", android: JSON.stringify(asset, null, 2) + "\n" };
}

if (require.main === module) {
  if (process.argv.length !== 6) throw new Error("Expected manifest path, SHA256, SDK commit and Nitro commit");
  const root = path.resolve(__dirname, "..");
  const js = path.join(root, "client/src/owned-signet-routing.json");
  const android = path.join(root, "client/nitromodules/noah-tools/android/src/main/assets/noah_bark_config.json");
  const bytes = fs.readFileSync(process.argv[2]);
  const prepared = prepare(bytes, process.argv[3], process.argv[4], process.argv[5], JSON.parse(fs.readFileSync(android)));
  for (const [destination, value] of [[js, prepared.js], [android, prepared.android]]) {
    const temporary = `${destination}.owned-routing.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    if (fs.readFileSync(destination, "utf8") !== value) throw new Error("Routing write differs");
  }
  console.log(JSON.stringify({ profile: PROFILE, js_sha256: hash(prepared.js), android_sha256: hash(prepared.android),
    manifest_sha256: process.argv[3], payment_ready: false }));
}
module.exports = { prepare };
