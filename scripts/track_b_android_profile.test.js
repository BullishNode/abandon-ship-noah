// Execute the actual Expo plugin on synthetic Gradle/source inputs. No APK claim.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const pluginPath = path.join(
  __dirname,
  "../client/plugins/withNoahAndroidPrebuildFix.js",
);
function plugin(profile) {
  const hooks = {};
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(pluginPath, "utf8"),
    {
      module,
      process: { env: { EXPO_PUBLIC_NOAH_PROFILE: profile } },
      require(name) {
        if (name === "@expo/config-plugins")
          return {
            withAppBuildGradle(config, hook) {
              hooks.gradle = hook;
              return config;
            },
            withDangerousMod(config, [platform, hook]) {
              assert.equal(platform, "android");
              hooks.sources = hook;
              return config;
            },
          };
        if (name === "fs") return fs;
        if (name === "path") return path;
        throw new Error("Unexpected dependency");
      },
    },
    { filename: pluginPath },
  );
  module.exports({});
  return hooks;
}
const input = `android {
 namespace 'generated.package'
 defaultConfig { applicationId 'generated.package' }
 productFlavors {
  signet { applicationId 'com.noahwallet.signet' }
  regtest { applicationId 'com.noahwallet.regtest' }
  mainnet { applicationId 'com.noahwallet.mainnet' }
 }
}`;
test("stock prebuild retains all three existing application IDs", () => {
  const result = plugin("stock").gradle({ modResults: { contents: input } })
    .modResults.contents;
  assert.match(result, /signet \{ applicationId 'com\.noahwallet\.signet'/);
  assert.match(result, /regtest \{ applicationId 'com\.noahwallet\.regtest'/);
  assert.match(result, /mainnet \{ applicationId 'com\.noahwallet\.mainnet'/);
  assert.doesNotMatch(result, /trackb/);
});
test("B prebuild selects the separate Signet ID and preserves other IDs/namespace", () => {
  const hooks = plugin("track-b");
  const result = hooks.gradle({ modResults: { contents: input } }).modResults
    .contents;
  assert.match(
    result,
    /signet \{ applicationId 'com\.noahwallet\.trackb\.signet'/,
  );
  assert.match(result, /namespace 'com\.noahwallet'/);
  assert.match(result, /regtest \{ applicationId 'com\.noahwallet\.regtest'/);
  assert.match(result, /mainnet \{ applicationId 'com\.noahwallet\.mainnet'/);
  assert.equal(
    hooks.gradle({ modResults: { contents: result } }).modResults.contents,
    result,
  );
});
test("B generated source package normalizes to the retained shared namespace", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "noah-profile-prebuild-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const java = path.join(root, "app/src/main/java");
  const generated = path.join(java, "com/noahwallet/trackb/signet");
  fs.mkdirSync(generated, { recursive: true });
  fs.writeFileSync(
    path.join(generated, "MainActivity.kt"),
    "package com.noahwallet.trackb.signet\nimport com.noahwallet.trackb.signet.R\n",
  );
  await plugin("track-b").sources({
    modRequest: { platformProjectRoot: root },
  });
  assert.equal(
    fs.readFileSync(path.join(java, "com/noahwallet/MainActivity.kt"), "utf8"),
    "package com.noahwallet\nimport com.noahwallet.R\n",
  );
  assert.equal(fs.existsSync(path.join(generated, "MainActivity.kt")), false);
});
