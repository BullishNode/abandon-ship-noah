# C Signet runtime profile (WIP, Android only)

This is a new opt-in source profile, not a deployed or financially qualified app.
Stock builds keep their existing configuration and application IDs. C Signet uses
`com.noahwallet.trackc.signet`, with a separate Android UID, keystore and private
files from stock Signet. Shared Java/Kotlin namespace stays`com.noahwallet`;
getAppVariant still reads Signet from the app BuildConfig, and the push loader
still recognizes the`.signet` suffix. Build JS and Android together with
`EXPO_PUBLIC_NOAH_PROFILE=track-c`; retain that exact environment and APK/JS
provenance. Unknown selectors refuse. No C iOS build or standalone iOS intent is
supported; JS C wallet paths refuse on iOS. Do not install a C iOS artifact.

Before first app launch, the runtime owner must provision exactly one private
`track-c-signet-profile.json` in the Android app files directory, owned by that
app UID, regular/non-symlink and mode0600. Native Android validates these file
properties; JS uses the same DocumentDirectoryPath file. It must never be
packaged, committed, printed, passed in EXPO_PUBLIC values, or copied into a
source/test archive. Android backup and device-transfer rules exclude this file.
Both processes pin its exact accepted bytes; stop the app before any reviewed
configuration replacement. This file is not a readiness or ownership receipt.

The exact schema is `TrackCSignetProfile` in `client/src/lib/trackCProfile.ts`.
All14 fields are mandatory, with version1/profiletrack-c/networksignet. Ark and
Noah backend URLs require HTTPS or literal-loopback HTTP with an explicit port;
LNURL requires the actual owned hostname. Public stock Second/Noah domains are
rejected. The Core URL must be HTTP literal127.0.0.1 or[::1] with an explicit port,
and an actual privately provisioned restricted gateway username/password.

The declared SDK's synchronous Core client uses raw TCP even for an HTTPS URL.
Consequently C uses root-owned authenticated restricted gateway transport over
SSH and adb reverse to app-loopback; it does not claim synchronous Core TLS.
The gateway, SSH tunnel/reverse, owned Ark/backend/LNURL, RPC method restriction,
Core txindex/network, actual credentials and matching endpoint ownership must be
independently verified before first app open. No gateway credentials, real host
names or private URLs are included here. No authless or placeholder mode exists.

C foreground create/open/seed restore preflight this profile before native wallet
access. Android push uses the same file before reflective native wallet access.
C clears SDK Esplora and ignores custom Esplora overrides; blockheight uses
existing authenticated Core JSON-RPC rather than REST. The private fields also
supply the explicit wallet policy values; runtime qualification must verify those
against the actual C server and configured deadlines. No financial retry,
readiness bypass, wallet migration or existing recovery rollback is introduced.

Qualification pending: exact Bun controls and typecheck, actual Kotlin/Gradle
compilation, owned packed Nitro/generated API, full APK link, app-private file
permission/path agreement, actual endpoint/tunnel/RPC traces and native awake/
background journeys. Synthetic profile controls are not proof of any of these.
Run each Bun mock test file in a separate process to avoid module-mock leakage.
