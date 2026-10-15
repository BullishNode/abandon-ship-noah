const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { prepare } = require("./prepare_owned_signet_routing.cjs");
const PROFILE = "track-a-two-step-per-key";
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");

function readBounded(file, limit) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw Error("Bounded regular input required");
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (count === 0) break;
      used += count;
      if (used > limit) throw Error("Input exceeded read limit");
    }
    const data = buffer.subarray(0, used), after = fs.fstatSync(fd);
    if (data.length !== before.size || before.dev !== after.dev || before.ino !== after.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw Error("Input changed during read");
    return data;
  } finally { fs.closeSync(fd); }
}

function trustFiles(root, env = process.env, now = Date.now()) {
  if (env.NOAH_ARK_PROFILE !== PROFILE || env.EXPO_PUBLIC_NOAH_PROFILE !== PROFILE) {
    throw Error("Both explicit A build profiles are required");
  }
  const bytes = readBounded(env.NOAH_A_ROUTING_MANIFEST, 65536);
  const ca = readBounded(env.NOAH_A_CA_FILE, 16384);
  if (!/^[a-f0-9]{64}$/.test(env.NOAH_A_CA_SHA256 || "") || sha(ca) !== env.NOAH_A_CA_SHA256 ||
      !/^\s*-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(ca.toString())) {
    throw Error("Exactly one independently pinned public CA certificate is required");
  }
  const cert = new crypto.X509Certificate(ca);
  if (!cert.ca || now < Date.parse(cert.validFrom) || now >= Date.parse(cert.validTo)) {
    throw Error("Qualification certificate must be a currently valid CA");
  }
  const jsFile = path.join(root, "client/src/owned-signet-routing.json");
  const nativeFile = path.join(root, "client/nitromodules/noah-tools/android/src/main/assets/noah_bark_config.json");
  const native = readBounded(nativeFile, 65536);
  const prepared = prepare(bytes, env.NOAH_A_ROUTING_SHA256, env.NOAH_ARK_SDK_COMMIT,
    env.NOAH_ARK_NITRO_COMMIT, JSON.parse(native));
  if (!readBounded(jsFile, 65536).equals(Buffer.from(prepared.js)) ||
      !native.equals(Buffer.from(prepared.android))) throw Error("JS/native routing is missing or differs");
  const signet = readBounded(path.join(root, "client/android/app/src/signet/AndroidManifest.xml"), 65536).toString();
  if ((signet.match(/<application>/g) || []).length !== 1 || signet.includes("networkSecurityConfig")) {
    throw Error("Original signet manifest seam differs");
  }
  const manifest = signet.replace("<application>", '<application android:networkSecurityConfig="@xml/noah_a_network_security_config" android:usesCleartextTraffic="false" tools:replace="android:usesCleartextTraffic">');
  // Android/OkHttp trust only this qualification CA. This does not add TLS to native Rust RPC.
  const xml = '<?xml version="1.0" encoding="utf-8"?>\n<network-security-config><base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="@raw/noah_a_qualification_ca" /></trust-anchors></base-config></network-security-config>\n';
  const receipt = {
    schema: 1, profile: PROFILE, sdk_commit: env.NOAH_ARK_SDK_COMMIT, nitro_commit: env.NOAH_ARK_NITRO_COMMIT,
    routing_manifest_sha256: sha(bytes), js_sha256: sha(Buffer.from(prepared.js)), native_asset_sha256: sha(native),
    qualification_ca_sha256: sha(ca), original_signet_manifest_sha256: sha(Buffer.from(signet)),
    manifest_sha256: sha(Buffer.from(manifest)), network_security_sha256: sha(Buffer.from(xml)),
    transport_or_payment_ready: false,
  };
  return {
    "AndroidManifest.xml": Buffer.from(manifest),
    "res/xml/noah_a_network_security_config.xml": Buffer.from(xml),
    "res/raw/noah_a_qualification_ca.pem": ca,
    "preparation-receipt.json": Buffer.from(JSON.stringify(receipt, null, 2) + "\n"),
  };
}

function apply(root, mode, env = process.env) {
  if (!["prepare", "check"].includes(mode)) throw Error("Expected prepare or check");
  const files = trustFiles(root, env), output = path.join(root, "client/android/app/owned-a-trust");
  if (mode === "prepare") {
    fs.mkdirSync(output, { mode: 0o700 }); // A stale preparation is never reused implicitly.
    for (const [name, data] of Object.entries(files)) {
      const target = path.join(output, name);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const fd = fs.openSync(target, "wx", 0o600);
      try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }
  for (const [name, expected] of Object.entries(files)) {
    if (!readBounded(path.join(output, name), 65536).equals(expected)) throw Error("Trust preparation differs");
  }
  return { profile: PROFILE, receipt_sha256: sha(files["preparation-receipt.json"]), transport_or_payment_ready: false };
}
if (require.main === module) console.log(JSON.stringify(apply(path.resolve(__dirname, ".."), process.argv[2])));
module.exports = { trustFiles, apply };
