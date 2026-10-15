const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { installOwnedAndroid } = require("./download_ark_binaries.js");
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noah-native-installer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, "node_modules/react-native-nitro-ark");
  const destination = path.join(pkg, "android/src/main/jniLibs");
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, "old-payload"), "preserved");
  const packageBytes = Buffer.from(JSON.stringify({ version: "0.0.146" }));
  fs.writeFileSync(path.join(pkg, "package.json"), packageBytes);
  fs.mkdirSync(path.join(pkg, "cpp/generated"), { recursive: true });
  const headerBytes = Buffer.from("fixture public generated CXX source");
  fs.writeFileSync(path.join(pkg, "cpp/generated/ark_cxx.h"), headerBytes);
  const manifest = {
    schema_version: 1, platform: "android",
    sdk_git: "https://github.com/BullishNode/abandon-ship-bark.git",
    sdk_commit: "ca568d5a28aa16a2a4fbb853531d869ad22a9724",
    nitro_git: "https://github.com/BullishNode/abandon-ship-nitro-ark.git",
    nitro_commit: "1234567890123456789012345678901234567890",
    package_version: "0.0.146", package_sha256: sha(packageBytes),
    package_files: [
      { path: "package.json", bytes: packageBytes.length, sha256: sha(packageBytes) },
      { path: "cpp/generated/ark_cxx.h", bytes: headerBytes.length, sha256: sha(headerBytes) },
    ], files: [],
  };
  for (const abi of ["arm64-v8a", "armeabi-v7a", "x86_64"]) {
    fs.mkdirSync(path.join(root, "jniLibs", abi), { recursive: true });
    for (const lib of ["libbark_cpp.a", "libcxxbridge1.a"]) {
      // Synthetic public bytes exercise installer integrity, never an ABI/build claim.
      const bytes = Buffer.from(`fixture:${abi}:${lib}`);
      fs.writeFileSync(path.join(root, "jniLibs", abi, lib), bytes);
      manifest.files.push({ path: `${abi}/${lib}`, bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  fs.mkdirSync(path.join(root, "client"));
  fs.writeFileSync(path.join(root, "client/package.json"), JSON.stringify({ dependencies: {
    "react-native-nitro-ark": `https://github.com/BullishNode/abandon-ship-nitro-ark/releases/download/${manifest.nitro_commit}/react-native-nitro-ark-${manifest.package_version}.tgz`,
  } }));
  const manifestPath = path.join(root, "native-ark-artifacts.json");
  const write = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  write();
  const preserved = () => assert.equal(fs.readFileSync(path.join(destination, "old-payload"), "utf8"), "preserved");
  return { root, manifest, manifestPath, write, destination, preserved };
}

test("missing manifest preserves current payload without a download", (t) => {
  const f = fixture(t); fs.unlinkSync(f.manifestPath);
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath)); f.preserved();
});
test("same version with wrong SDK or package bytes is refused", (t) => {
  const f = fixture(t); f.manifest.sdk_commit = "0".repeat(40); f.write();
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /SDK source/); f.preserved();
  f.manifest.sdk_commit = "ca568d5a28aa16a2a4fbb853531d869ad22a9724";
  f.manifest.package_sha256 = "0".repeat(64); f.write();
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /package digest/); f.preserved();
});
test("one corrupted library refuses the whole set before replacement", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, "jniLibs", f.manifest.files[5].path), "corrupted");
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /byte count|digest/); f.preserved();
});
test("duplicate or escaping artifact paths are refused", (t) => {
  const f = fixture(t); f.manifest.files[5].path = f.manifest.files[0].path; f.write();
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /duplicate artifact paths/); f.preserved();
  f.manifest.files[5].path = "../outside.a"; f.write();
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /artifact paths/); f.preserved();
});
test("symlink library refuses the whole set", (t) => {
  const f = fixture(t); const filename = path.join(f.root, "jniLibs", f.manifest.files[0].path);
  const bytes = fs.readFileSync(filename); fs.unlinkSync(filename);
  fs.writeFileSync(path.join(f.root, "other.a"), bytes); fs.symlinkSync(path.join(f.root, "other.a"), filename);
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /regular file/); f.preserved();
});
test("exact complete set installs six validated payloads and retained public provenance", (t) => {
  const f = fixture(t); installOwnedAndroid(f.root, f.manifestPath);
  assert.equal(fs.existsSync(path.join(f.destination, "old-payload")), false);
  for (const entry of f.manifest.files) {
    const bytes = fs.readFileSync(path.join(f.destination, entry.path));
    assert.equal(bytes.length, entry.bytes); assert.equal(sha(bytes), entry.sha256);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.destination, "c-native-build-manifest.json"))), f.manifest);
});

test("wrong Nitro revision and stock app dependency are refused before replacement", (t) => {
  const f = fixture(t); f.manifest.nitro_commit = "a".repeat(40); f.write();
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /exact owned app dependency/); f.preserved();
  fs.writeFileSync(path.join(f.root, "client/package.json"), JSON.stringify({ dependencies: { "react-native-nitro-ark": "0.0.144" } }));
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /exact owned app dependency/); f.preserved();
});

test("same package metadata with changed generated CXX bytes is refused", (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, "node_modules/react-native-nitro-ark/cpp/generated/ark_cxx.h"), "stock generated CXX differs");
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /packed source bytes/); f.preserved();
});
test("extra unreviewed package source is refused", (t) => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, "node_modules/react-native-nitro-ark/extra.js"), "unexpected");
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /source file set/); f.preserved();
});

// A genuine boundary check: production installer may not read a whole JNI archive.
test("JNI validation and staged verification use incremental reads", (t) => {
  const f = fixture(t);
  const original = fs.readFileSync;
  fs.readFileSync = function(filename, ...options) {
    assert.equal(typeof filename === "string" && filename.endsWith(".a"), false,
      "whole archive read attempted");
    return original.call(this, filename, ...options);
  };
  try { installOwnedAndroid(f.root, f.manifestPath); }
  finally { fs.readFileSync = original; }
  assert.equal(fs.existsSync(path.join(f.destination, "old-payload")), false);
});

test("incremental digest covers bytes beyond the first chunk", (t) => {
  const f = fixture(t);
  const entry = f.manifest.files[0];
  const filename = path.join(f.root, "jniLibs", entry.path);
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 7, 42);
  fs.writeFileSync(filename, bytes);
  entry.bytes = bytes.length; entry.sha256 = sha(bytes); f.write();
  const fd = fs.openSync(filename, "r+");
  try { fs.writeSync(fd, Buffer.from([43]), 0, 1, bytes.length - 1); }
  finally { fs.closeSync(fd); }
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /Artifact digest differs/);
  f.preserved();
});

// Explicit opt-in ONLY on the owned qualification VM; not an ABI/product claim.
const resourceBytes = Number(process.env.NOAH_INSTALLER_RESOURCE_BYTES || 0);
test("large sparse JNI staging keeps resource use bounded", {
  skip: resourceBytes === 0,
  timeout: 300_000,
}, async (t) => {
  assert.ok(Number.isSafeInteger(resourceBytes) && resourceBytes >= 1024 * 1024 && resourceBytes <= 2 * 1024 ** 3);
  const f = fixture(t);
  const entry = f.manifest.files[0];
  const filename = path.join(f.root, "jniLibs", entry.path);
  fs.truncateSync(filename, resourceBytes);
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  entry.bytes = resourceBytes; entry.sha256 = hash.digest("hex"); f.write();
  installOwnedAndroid(f.root, f.manifestPath);
  assert.equal(fs.statSync(path.join(f.destination, entry.path)).size, resourceBytes);
  assert.equal(fs.existsSync(path.join(f.destination, "old-payload")), false);
  // Absolute per-process highwater; run this selector alone for an honest peak.
  const peakKiB = process.resourceUsage().maxRSS;
  assert.ok(peakKiB < 256 * 1024, `installer peak exceeded256MiB: ${peakKiB}KiB`);
  process.stdout.write(JSON.stringify({ synthetic_resource_bytes: resourceBytes, maxRSS_KiB: peakKiB, scope: "streaming installer staging only; no ABI/APK/device credit" }) + "\n");
});

function localDelivery(f) {
  f.manifest.nitro_commit = "a815576182ebebc9db1120a6a629e9c4c1674a5e";
  f.manifest.package_tarball = {
    path: "native-ark-package.tgz", bytes: 492171204,
    sha256: "b39e17850ae6af7c44cde4d952b280fa23f378529071aff68fe61a2da700c8d5",
  };
  fs.writeFileSync(path.join(f.root, "client/package.json"), JSON.stringify({ dependencies: {
    "react-native-nitro-ark": "file:../native-ark-package.tgz",
  } }));
  f.write();
}
test("local qualification cannot substitute a wrong tarball pin or source", (t) => {
  const f = fixture(t); localDelivery(f);
  f.manifest.package_tarball.sha256 = "0".repeat(64); f.write();
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /tarball pin/); f.preserved();
  f.manifest.package_tarball.sha256 = "b39e17850ae6af7c44cde4d952b280fa23f378529071aff68fe61a2da700c8d5";
  f.manifest.nitro_commit = "0".repeat(40); f.write();
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /source pin/); f.preserved();
});
test("local qualification refuses alternate dependency paths and traversal", (t) => {
  const f = fixture(t); localDelivery(f);
  fs.writeFileSync(path.join(f.root, "client/package.json"), JSON.stringify({ dependencies: {
    "react-native-nitro-ark": "file:../../native-ark-package.tgz",
  } }));
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /app dependency/); f.preserved();
  localDelivery(f); f.manifest.package_tarball.path = "../native-ark-package.tgz"; f.write();
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /artifact path/); f.preserved();
});
test("local qualification refuses a missing or symlink tarball before JNI changes", (t) => {
  const f = fixture(t); localDelivery(f);
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /ENOENT/); f.preserved();
  fs.writeFileSync(path.join(f.root, "other.tgz"), "synthetic wrong package");
  fs.symlinkSync(path.join(f.root, "other.tgz"), path.join(f.root, "native-ark-package.tgz"));
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /regular file/); f.preserved();
});
test("local qualification refuses wrong tar bytes before touching existing JNI", (t) => {
  const f = fixture(t); localDelivery(f);
  fs.writeFileSync(path.join(f.root, "native-ark-package.tgz"), "synthetic wrong package");
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /tarball byte count/); f.preserved();
});

// Owned VM only: exercise the actual digest check after the exact size check.
test("same-size wrong local TGZ is rejected before existing JNI replacement", {
  skip: process.env.NOAH_INSTALLER_LOCAL_SIZE_NEGATIVE !== "1", timeout: 300_000,
}, (t) => {
  const f = fixture(t); localDelivery(f);
  const filename = path.join(f.root, "native-ark-package.tgz");
  fs.writeFileSync(filename, "synthetic wrong package"); fs.truncateSync(filename, 492171204);
  assert.throws(() => installOwnedAndroid(f.root, f.manifestPath), /tarball digest/);
  f.preserved();
});
