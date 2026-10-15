// C requires actual owned native artifacts. This installer never downloads stock binaries.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SDK_COMMIT = "ca568d5a28aa16a2a4fbb853531d869ad22a9724";
const ABIS = ["arm64-v8a", "armeabi-v7a", "x86_64"];
const LIBRARIES = ["libbark_cpp.a", "libcxxbridge1.a"];
const EXPECTED_FILES = ABIS.flatMap((abi) => LIBRARIES.map((lib) => `${abi}/${lib}`)).sort();
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function regularFile(filename) {
  const stat = fs.lstatSync(filename);
  check(stat.isFile() && !stat.isSymbolicLink(), `Expected regular file: ${filename}`);
  return stat;
}

function exactKeys(value, keys, label) {
  check(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  check(JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort()), `${label} fields differ`);
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function installOwnedAndroid(projectRoot, manifestPath) {
  // The manifest is public, reviewed build evidence, not a runtime qualification flag.
  regularFile(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  exactKeys(manifest, ["schema_version", "platform", "sdk_git", "sdk_commit", "nitro_git", "nitro_commit", "package_version", "package_sha256", "files"], "Artifact manifest");
  check(manifest.schema_version === 1 && manifest.platform === "android", "Only owned Android artifact schema 1 is supported");
  check(manifest.sdk_git === "https://github.com/BullishNode/abandon-ship-bark.git" && manifest.sdk_commit === SDK_COMMIT, "Artifact SDK source differs");
  check(manifest.nitro_git === "https://github.com/BullishNode/abandon-ship-nitro-ark.git" && /^[0-9a-f]{40}$/.test(manifest.nitro_commit), "Artifact Nitro source differs");
  check(/^[0-9a-f]{64}$/.test(manifest.package_sha256), "Invalid package digest");
  check(Array.isArray(manifest.files) && manifest.files.length === EXPECTED_FILES.length, "Incomplete Android artifact set");
  const packageDirectory = [
    path.join(projectRoot, "node_modules/react-native-nitro-ark"),
    path.join(projectRoot, "client/node_modules/react-native-nitro-ark"),
  ].find((candidate) => fs.existsSync(candidate));
  check(packageDirectory, "Owned Nitro package is not installed");
  const packageFile = path.join(packageDirectory, "package.json");
  regularFile(packageFile);
  const packageBytes = fs.readFileSync(packageFile);
  check(digest(packageBytes) === manifest.package_sha256, "Installed Nitro package digest differs");
  check(JSON.parse(packageBytes).version === manifest.package_version, "Installed Nitro version differs");
  const actualPaths = manifest.files.map((entry) => entry.path).sort();
  check(JSON.stringify(actualPaths) === JSON.stringify(EXPECTED_FILES), "Unexpected or duplicate artifact paths");
  const sourceRoot = path.join(path.dirname(path.resolve(manifestPath)), "jniLibs");
  for (const entry of manifest.files) {
    exactKeys(entry, ["path", "bytes", "sha256"], "Artifact file");
    check(Number.isSafeInteger(entry.bytes) && entry.bytes > 0, "Invalid artifact byte count");
    check(/^[0-9a-f]{64}$/.test(entry.sha256), "Invalid artifact digest");
    // Paths are the exact fixed ABI/library set; no archive extraction or arbitrary paths.
    const filename = path.join(sourceRoot, entry.path);
    const parent = fs.lstatSync(path.dirname(filename));
    check(parent.isDirectory() && !parent.isSymbolicLink(), "Artifact ABI directory must be real");
    check(regularFile(filename).size === entry.bytes, "Artifact byte count differs");
    check(digest(fs.readFileSync(filename)) === entry.sha256, "Artifact digest differs");
  }
  // All identities and source bytes are validated before touching the current payload.
  const parent = path.join(packageDirectory, "android/src/main");
  check(fs.statSync(parent).isDirectory(), "Nitro Android destination is missing");
  const destination = path.join(parent, "jniLibs");
  if (fs.existsSync(destination)) {
    const current = fs.lstatSync(destination);
    check(current.isDirectory() && !current.isSymbolicLink(), "Current JNI destination must be a real directory");
  }
  const staging = fs.mkdtempSync(path.join(parent, ".c-jni-staging-"));
  const backup = `${staging}-previous`;
  let previousMoved = false;
  let installed = false;
  try {
    for (const abi of ABIS) fs.mkdirSync(path.join(staging, abi));
    for (const entry of manifest.files) {
      const target = path.join(staging, entry.path);
      fs.copyFileSync(path.join(sourceRoot, entry.path), target, fs.constants.COPYFILE_EXCL);
      const copied = fs.readFileSync(target);
      check(copied.length === entry.bytes && digest(copied) === entry.sha256, "Staged artifact changed during copy");
      const fd = fs.openSync(target, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    fs.writeFileSync(path.join(staging, "c-native-build-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
    const receipt = fs.openSync(path.join(staging, "c-native-build-manifest.json"), "r");
    try { fs.fsyncSync(receipt); } finally { fs.closeSync(receipt); }
    for (const abi of ABIS) syncDirectory(path.join(staging, abi));
    syncDirectory(staging);
    if (fs.existsSync(destination)) { fs.renameSync(destination, backup); previousMoved = true; }
    try { fs.renameSync(staging, destination); installed = true; syncDirectory(parent); }
    catch (error) {
      if (!installed && previousMoved) { fs.renameSync(backup, destination); previousMoved = false; syncDirectory(parent); }
      throw error;
    }
    if (previousMoved) fs.rmSync(backup, { recursive: true });
    return manifest;
  } finally {
    if (!installed) fs.rmSync(staging, { recursive: true, force: true });
    // A backup surviving an install/cleanup failure is preserved for inspection.
  }
}

if (require.main === module) {
  installOwnedAndroid(process.cwd(), path.join(process.cwd(), "native-ark-artifacts.json"));
}
module.exports = { installOwnedAndroid };
