# Private owned Nitro package qualification

The C Android qualification package is a private local TGZ. No GitHub release or
NPM publication exists. Do not invent a release URL or allow a stock downloader.
This source supports the exact qualified a815 Nitro/ca568 SDK package in addition
to the existing independently pinned owned release URL route.

The root-owned build places the actual reviewed bytes at the ignored project-root
`native-ark-package.tgz`. The client dependency must be exactly
`file:../native-ark-package.tgz`. Generate the actual Bun lock with supported
Bun1.3.13 and lifecycle scripts disabled, preserve failures, and review its diff;
never hand-edit lock or package provenance. This branch only adds delivery
support: it does not change client/package.json or the lock itself.

The ignored `native-ark-artifacts.json` retains schema1 and all existing identity,
package metadata, full non-JNI packed source inventory and exact six-file JNI
hashes. Local delivery additionally declares `package_tarball` with exactly
`path`, `bytes`, `sha256`. Its path must be `native-ark-package.tgz`; size must be
492171204 and SHA256 must be
`b39e17850ae6af7c44cde4d952b280fa23f378529071aff68fe61a2da700c8d5`.
The manifest must declare Nitro
`a815576182ebebc9db1120a6a629e9c4c1674a5e`, SDK
`ca568d5a28aa16a2a4fbb853531d869ad22a9724`, packageversion0.0.146.
This is an explicit current source/artifact pin, not a readiness flag.

A local package is checked with incremental hashing before installed package
metadata/source or JNI replacement. The existing full94-file non-JNI inventory
and six native archives are checked again, and staged JNI bytes are checked
before rename. The package contains the actual compiled DEBUG static archives;
this does not qualify a Gradle/JNI link, loaded APK, device or payment.

Root/Q must run the actual package positive using the independently retained
package-final-manifest/combined-manifest-v2 receipts and compare every installed
file/hash. The tiny synthetic controls cover refusals only; they cannot pretend
to be the pinned492MB archive. The opt-in same-size sparse wrong-TGZ control may
run only on the owned qualification VM with
`NOAH_INSTALLER_LOCAL_SIZE_NEGATIVE=1 node --test --test-name-pattern="same-size wrong local TGZ" scripts/download_ark_binaries.test.js`.
It performs no network call. Do not run large artifact tests on the workstation.

Keep both local inputs and actual payloads out of Git. A public owned release
path still requires the exact original full-commit URL and manifest binding;
local mode never falls back to that route or to stock artifacts.
