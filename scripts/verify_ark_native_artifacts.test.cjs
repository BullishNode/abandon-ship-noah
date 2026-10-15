const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { verifyArkNativeArtifacts, requiredFiles, SUPPORTED_ABIS } = require("./verify_ark_native_artifacts");

const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noah-native-artifact-control-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pkg = path.join(dir, "node_modules", "react-native-nitro-ark");
  const manifest = { schema: 1, sdk_commit: "a".repeat(40), nitro_commit: "b".repeat(40), abis: SUPPORTED_ABIS, files: [] };
  for (const relative of requiredFiles(SUPPORTED_ABIS)) {
    // Synthetic SOFTWARE bytes: these controls do not build or qualify an ABI.
    const bytes = Buffer.from(`synthetic artifact control: ${relative}\n`);
    const filename = path.join(pkg, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, bytes);
    manifest.files.push({ path: relative, sha256: sha(bytes), size: bytes.length });
  }
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version: "0.0.144" }));
  const env = {
    NOAH_ARK_PROFILE: "track-a-two-step-per-key",
    NOAH_ARK_NATIVE_MANIFEST: path.join(dir, "native-manifest.json"),
    NOAH_ARK_SDK_COMMIT: manifest.sdk_commit,
    NOAH_ARK_NITRO_COMMIT: manifest.nitro_commit,
    NOAH_ARK_REQUIRED_ABIS: SUPPORTED_ABIS.join(","),
  };
  function save() {
    const bytes = Buffer.from(JSON.stringify(manifest));
    fs.writeFileSync(env.NOAH_ARK_NATIVE_MANIFEST, bytes);
    env.NOAH_ARK_MANIFEST_SHA256 = sha(bytes);
  }
  save();
  return { dir, pkg, manifest, env, save };
}

test("checks the exact admitted three-ABI files and headers without modifying them", (t) => {
  const f = fixture(t);
  const result = verifyArkNativeArtifacts(f.pkg, f.env);
  assert.equal(result.verified_files, 8);
  assert.equal(result.native_execution_qualified, false);
  assert.deepEqual(result.verified_abis, SUPPORTED_ABIS);
  for (const file of f.manifest.files) assert.equal(sha(fs.readFileSync(path.join(f.pkg, file.path))), file.sha256);
});

test("refuses a different manifest hash", (t) => {
  const f = fixture(t);
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, { ...f.env, NOAH_ARK_MANIFEST_SHA256: "0".repeat(64) }), /hash differs/);
});

test("refuses an oversized manifest before loading it", (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.env.NOAH_ARK_NATIVE_MANIFEST, Buffer.alloc(65537));
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /manifest size/);
});

test("refuses a declared artifact beyond the build resource bound", (t) => {
  const f = fixture(t);
  f.manifest.files[0].size = 1024 ** 3 + 1;
  f.save();
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /artifact size/);
});

for (const key of ["NOAH_ARK_SDK_COMMIT", "NOAH_ARK_NITRO_COMMIT"]) {
  test(`refuses wrong independently declared ${key}`, (t) => {
    const f = fixture(t);
    assert.throws(() => verifyArkNativeArtifacts(f.pkg, { ...f.env, [key]: "c".repeat(40) }), /identity/);
  });
}

test("refuses an omitted ABI instead of treating ARM64 as all platforms", (t) => {
  const f = fixture(t);
  f.manifest.files = f.manifest.files.filter((entry) => !entry.path.includes("x86_64"));
  f.save();
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /file set/);
});

test("refuses duplicate artifact paths", (t) => {
  const f = fixture(t);
  f.manifest.files[1] = f.manifest.files[0];
  f.save();
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /duplicate/);
});

test("refuses traversal even if the supplied manifest hash is admitted", (t) => {
  const f = fixture(t);
  f.manifest.files[0].path = "../outside";
  f.save();
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /artifact path/);
});

test("refuses changed library bytes of the same length", (t) => {
  const f = fixture(t);
  const entry = f.manifest.files[0];
  fs.writeFileSync(path.join(f.pkg, entry.path), Buffer.alloc(entry.size, 0x78));
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /hash differs/);
});

test("refuses a library symlink", (t) => {
  const f = fixture(t);
  const name = path.join(f.pkg, f.manifest.files[0].path);
  fs.renameSync(name, path.join(f.dir, "original.a"));
  fs.symlinkSync(path.join(f.dir, "original.a"), name);
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /symlink/);
});

test("a declared x86-only build verifies only x86 and refuses leftover stock ARM libraries", (t) => {
  const f = fixture(t);
  f.env.NOAH_ARK_REQUIRED_ABIS = "x86_64";
  f.manifest.abis = ["x86_64"];
  f.manifest.files = f.manifest.files.filter((entry) =>
    !entry.path.includes("arm64-v8a") && !entry.path.includes("armeabi-v7a"));
  f.save();
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /contaminate/);
  for (const abi of ["arm64-v8a", "armeabi-v7a"]) {
    fs.rmSync(path.join(f.pkg, "android/src/main/jniLibs", abi), { recursive: true });
  }
  const result = verifyArkNativeArtifacts(f.pkg, f.env);
  assert.deepEqual(result.verified_abis, ["x86_64"]);
  assert.equal(result.verified_files, 4);
  assert.equal(result.apk_contents_verified, false);
});

test("refuses an artifact directory symlink", (t) => {
  const f = fixture(t);
  const name = path.join(f.pkg, "cpp/generated");
  fs.renameSync(name, name + ".original");
  fs.symlinkSync(name + ".original", name);
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /symlink/);
});

test("refuses a missing staged header", (t) => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.pkg, "cpp/generated/ark_cxx.h"));
  assert.throws(() => verifyArkNativeArtifacts(f.pkg, f.env), /ENOENT/);
});

test("actual A postinstall path checks staged files and never replaces them with stock downloads", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, "download_ark_binaries.js")], {
    cwd: f.dir, env: { ...process.env, ...f.env }, encoding: "utf8", timeout: 5000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verified_files, 8);
  assert.equal(fs.existsSync(path.join(f.dir, "temp_ark_downloads")), false);
  for (const file of f.manifest.files) assert.equal(sha(fs.readFileSync(path.join(f.pkg, file.path))), file.sha256);
});

test("actual A postinstall fails closed on a missing pin without deleting staged files", (t) => {
  const f = fixture(t);
  const env = { ...process.env, ...f.env };
  delete env.NOAH_ARK_MANIFEST_SHA256;
  const result = spawnSync(process.execPath, [path.join(__dirname, "download_ark_binaries.js")], {
    cwd: f.dir, env, encoding: "utf8", timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /native manifest pin/);
  assert.equal(fs.existsSync(path.join(f.dir, "temp_ark_downloads")), false);
  for (const file of f.manifest.files) assert.equal(sha(fs.readFileSync(path.join(f.pkg, file.path))), file.sha256);
});

test("unknown explicit profiles refuse instead of falling back to stock downloads", (t) => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, [path.join(__dirname, "download_ark_binaries.js")], {
    cwd: f.dir, env: { ...process.env, ...f.env, NOAH_ARK_PROFILE: "unknown" },
    encoding: "utf8", timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown native Ark profile/);
  assert.equal(fs.existsSync(path.join(f.dir, "temp_ark_downloads")), false);
});
