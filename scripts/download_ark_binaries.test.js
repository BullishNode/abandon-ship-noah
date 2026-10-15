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
  const manifest = {
    schema_version: 1, platform: "android",
    sdk_git: "https://github.com/BullishNode/abandon-ship-bark.git",
    sdk_commit: "ca568d5a28aa16a2a4fbb853531d869ad22a9724",
    nitro_git: "https://github.com/BullishNode/abandon-ship-nitro-ark.git",
    nitro_commit: "1234567890123456789012345678901234567890",
    package_version: "0.0.146", package_sha256: sha(packageBytes), files: [],
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
