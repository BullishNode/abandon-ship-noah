const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SUPPORTED_ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64"];
const requiredFiles = (abis) => [
  ...abis.flatMap((abi) =>
    ["libbark_cpp.a", "libcxxbridge1.a"].map(
      (name) => `android/src/main/jniLibs/${abi}/${name}`,
    ),
  ),
  "cpp/generated/ark_cxx.h",
  "cpp/generated/cxx.h",
];

function requireHex(value, length, label) {
  if (typeof value !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(value)) {
    throw new Error(`Invalid ${label}`);
  }
}

// This checks an independently admitted build manifest. It does not qualify a
// compiler, certify the native implementation, or establish phone readiness.
function verifyArkNativeArtifacts(packageDir, env = process.env) {
  requireHex(env.NOAH_ARK_MANIFEST_SHA256, 64, "native manifest pin");
  requireHex(env.NOAH_ARK_SDK_COMMIT, 40, "SDK commit pin");
  requireHex(env.NOAH_ARK_NITRO_COMMIT, 40, "Nitro commit pin");
  const abis = (env.NOAH_ARK_REQUIRED_ABIS || "").split(",");
  if (abis.some((abi) => !SUPPORTED_ABIS.includes(abi)) || new Set(abis).size !== abis.length) {
    throw new Error("Exact admitted Android ABI scope is required");
  }
  const required = requiredFiles(abis);
  if (!env.NOAH_ARK_NATIVE_MANIFEST) throw new Error("Native manifest is required");
  const manifestFd = fs.openSync(env.NOAH_ARK_NATIVE_MANIFEST, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let bytes;
  try {
    const stat = fs.fstatSync(manifestFd);
    if (!stat.isFile() || stat.size > 65536) throw new Error("Invalid native manifest size/type");
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(manifestFd, bytes, offset, bytes.length - offset, null);
      if (count === 0) throw new Error("Native manifest changed during read");
      offset += count;
    }
    const after = fs.fstatSync(manifestFd);
    if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
      throw new Error("Native manifest changed during read");
    }
  } finally {
    fs.closeSync(manifestFd);
  }
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== env.NOAH_ARK_MANIFEST_SHA256) {
    throw new Error("Native manifest hash differs from admitted pin");
  }
  const manifest = JSON.parse(bytes);
  if (manifest.schema !== 1 || manifest.sdk_commit !== env.NOAH_ARK_SDK_COMMIT ||
      manifest.nitro_commit !== env.NOAH_ARK_NITRO_COMMIT || JSON.stringify(manifest.abis) !== JSON.stringify(abis) ||
      !Array.isArray(manifest.files) || manifest.files.length !== required.length) {
    throw new Error("Native manifest identity or file set differs");
  }
  const root = fs.realpathSync(packageDir);
  const jniRoot = path.join(root, "android/src/main/jniLibs");
  for (const abi of fs.readdirSync(jniRoot)) {
    const dir = path.join(jniRoot, abi);
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Native artifact symlink refused");
    for (const name of fs.readdirSync(dir)) {
      if (!required.includes(`android/src/main/jniLibs/${abi}/${name}`)) {
        throw new Error("Unadmitted native artifact would contaminate the ABI scope");
      }
    }
  }
  const seen = new Set();
  let total = 0;
  for (const file of manifest.files) {
    if (!file || !required.includes(file.path) || seen.has(file.path)) {
      throw new Error("Unexpected or duplicate native artifact path");
    }
    seen.add(file.path);
    requireHex(file.sha256, 64, "artifact SHA256");
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > 1024 ** 3) {
      throw new Error("Invalid native artifact size");
    }
    total += file.size;
    if (total > 4 * 1024 ** 3) throw new Error("Native artifact set exceeds byte bound");
    let current = root;
    for (const component of file.path.split("/")) {
      current = path.join(current, component);
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Native artifact symlink refused");
    }
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size !== file.size) throw new Error("Native artifact size/type mismatch");
      const hash = crypto.createHash("sha256");
      const buffer = Buffer.alloc(128 * 1024);
      let count;
      let readBytes = 0;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        readBytes += count;
        if (readBytes > file.size) throw new Error("Native artifact grew during read");
        hash.update(buffer.subarray(0, count));
      }
      const after = fs.fstatSync(fd);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
          hash.digest("hex") !== file.sha256) throw new Error("Native artifact bytes changed or hash differs");
    } finally {
      fs.closeSync(fd);
    }
  }
  return {
    manifest_sha256: env.NOAH_ARK_MANIFEST_SHA256,
    sdk_commit: manifest.sdk_commit,
    nitro_commit: manifest.nitro_commit,
    verified_files: seen.size,
    verified_bytes: total,
    verified_abis: abis,
    platform: "android",
    apk_contents_verified: false,
    native_execution_qualified: false,
  };
}

module.exports = { verifyArkNativeArtifacts, requiredFiles, SUPPORTED_ABIS };
