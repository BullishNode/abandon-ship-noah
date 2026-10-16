# B Signet runtime profile (WIP, Android only)

This is a new opt-in source profile, not a deployed or financially qualified app.
Stock builds keep their existing configuration and application IDs. B Signet uses
`com.noahwallet.trackb.signet`, with a separate Android UID, keystore and private
files from stock Signet. Shared Java/Kotlin namespace stays`com.noahwallet`;
getAppVariant still reads Signet from the app BuildConfig, and the push loader
still recognizes the`.signet` suffix. Build JS and Android together with
`EXPO_PUBLIC_NOAH_PROFILE=track-b` and
`EXPO_PUBLIC_NOAH_PUSH_TRANSPORT=unifiedpush`; retain that exact environment and APK/JS
provenance. Unknown selectors refuse. No B iOS build or standalone iOS intent is
supported; JS B wallet paths refuse on iOS. Do not install a B iOS artifact.

The B native application ID and JavaScript B selector now require each other.
Android checks the B application ID against its build flag before push dispatch,
the already-loaded wallet shortcut, wallet loading and config reads. Selected
fresh-process identity mocks and profile controls pass; these are not native
runtime or APK qualification. Matching build environment values alone are not
sufficient evidence.

A tests-first counterexample exposed foreign owned native IDs entering stock
JavaScript. The source now rejects the three declared Track A/B/C IDs in stock
selection and requires the exact B ID for B selection. All sixteen fresh-process
identity mocks and the existing profile controls pass. This closes the selected
mocked admission cases; native entry guards, actual APK/JS pairing and device
behavior remain unqualified. Ordinary stock and null identity semantics are
preserved; this is not a general application-ID allowlist.

Before first app launch, the runtime owner must provision exactly one private
`track-b-signet-profile.json` in the Android app files directory, owned by that
app UID, regular/non-symlink and mode0600. Native Android validates these file
properties; JS uses the same DocumentDirectoryPath file. It must never be
packaged, committed, printed, passed in EXPO_PUBLIC values, or copied into a
source/test archive. Android backup and device-transfer rules exclude this file.
Both processes pin its exact accepted bytes; stop the app before any reviewed
configuration replacement. This file is not a readiness or ownership receipt.

The exact schema is `TrackBSignetProfile` in `client/src/lib/trackBProfile.ts`.
All14 fields are mandatory, with version1/profiletrack-b/networksignet. Ark and
Noah backend URLs require HTTPS or literal-loopback HTTP with an explicit port;
LNURL requires the actual owned hostname. Public stock Second/Noah domains are
rejected. The Core URL must be HTTP literal127.0.0.1 or[::1] with an explicit port,
and an actual privately provisioned restricted gateway username/password.

The declared SDK's synchronous Core client uses raw TCP even for an HTTPS URL.
A root-owned authenticated restricted gateway over SSH and adb reverse to
app-loopback is the planned existing-component route. It is REQUIRED and has NOT
been provisioned or qualified for B. Synchronous Core TLS is not claimed.
The gateway, SSH tunnel/reverse, owned Ark/backend/LNURL, RPC method restriction,
Core txindex/network, actual credentials and matching endpoint ownership must be
independently verified before first app open. No gateway credentials, real host
names or private URLs are included here. No authless or placeholder mode exists.

B foreground create/open/seed restore preflight this profile before native wallet
access. Android push uses the same file before reflective native wallet access.
B clears SDK Esplora and ignores custom Esplora overrides; blockheight uses
existing authenticated Core JSON-RPC rather than REST. The private fields also
supply the explicit wallet policy values; runtime qualification must verify those
against the actual B server and configured deadlines. No financial retry,
readiness bypass, wallet migration or existing recovery rollback is introduced.

Selected mocked Bun identity/profile controls pass, and the owned packed Nitro
package is hash-verified. Qualification pending: full client typecheck, actual
Kotlin/JNI/native Gradle integration, full APK link, app-private file
permission/path agreement, actual endpoint/tunnel/RPC traces and native awake/
background journeys. Synthetic profile controls are not proof of any of these.
Run each Bun mock test file in a separate process to avoid module-mock leakage.

B explicitly selects the existing UnifiedPush path on owned Android/emulators.
It requires an actual owned distributor and endpoint; missing/failed registration
returns an error with no fallback to Expo/FCM. The Google-services Gradle plugin
is omitted only for this exact declared B+UnifiedPush pair; stock builds retain
it. This does not qualify FCM, physical phones or iOS. Existing UnifiedPush does
not support recurring payment wakeups, so that feature remains unavailable for
B and its required goal gates remain open. Emulator identity stays truthful;
this source does not claim a physical device or successful push delivery.
