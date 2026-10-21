# Distributing Expo apps with App Distributor

This guide shows how to turn an Expo project into installable builds for App
Distributor: an **ad-hoc signed `.ipa`** for iPhones/iPads and a **signed
`.apk`** for Android, uploaded with `curl`.

App Distributor reads everything it needs (name, bundle id, version, build
number, provisioning profile) from the binary itself, so no extra metadata is
required. Every upload becomes a new version; older versions stay installable
until you delete them.

---

## 1. One-time setup

### 1.1 Tools

```sh
npm i -g eas-cli        # or use `npx eas-cli` everywhere below
eas login
eas build:configure     # creates eas.json if you don't have one yet
```

### 1.2 Add a build profile for internal distribution

`eas.json`:

```jsonc
{
  "cli": {
    "version": ">= 16.0.0",
    // Let EAS own build numbers so every build gets a new one automatically.
    "appVersionSource": "remote",
  },
  "build": {
    "distribute": {
      // iOS: ad-hoc provisioning profile (only registered devices can install).
      "distribution": "internal",
      // Bumps ios.buildNumber / android.versionCode on every build.
      "autoIncrement": true,
      "android": {
        // Default is an .aab (Play Store only) - devices need an .apk.
        "buildType": "apk",
      },
      "ios": {
        // Ad-hoc builds must not be simulator builds.
        "simulator": false,
      },
      // Optional: "channel": "distribute"  (if you use expo-updates)
    },
  },
}
```

Why each setting matters:

| Setting                                        | Why                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `distribution: "internal"`                     | iOS builds are signed with an **ad-hoc** profile. Safari can only install ad-hoc, development or enterprise-signed apps; App Store-signed builds cannot be installed this way. |
| `android.buildType: "apk"`                     | Android can only sideload `.apk` files. `.aab` is for Google Play.                                                                                                             |
| `autoIncrement` + `appVersionSource: "remote"` | Each upload gets a unique, increasing build number, which makes versions easy to tell apart in the UI and lets devices update in place.                                        |

### 1.3 (Optional) Install side-by-side with the store version

If the app is also on the App Store / Play Store, give internal builds a
different bundle id so both can be installed at the same time. In
`app.config.ts`:

```ts
const variant = process.env.APP_VARIANT; // set per build profile
export default {
  name: variant === "distribute" ? "MyApp (Beta)" : "MyApp",
  ios: { bundleIdentifier: variant === "distribute" ? "com.me.myapp.beta" : "com.me.myapp" },
  android: { package: variant === "distribute" ? "com.me.myapp.beta" : "com.me.myapp" },
};
```

and in the `distribute` profile: `"env": { "APP_VARIANT": "distribute" }`.

---

## 2. iOS: register devices

Ad-hoc builds only install on devices whose **UDID** is in the provisioning
profile (max. 100 devices per device type per year on a paid Apple Developer
account).

1. **Find the UDID.** Open App Distributor in Safari on the iPhone, go to
   **Device → Identify this device**, allow the download, then open
   _Settings → Profile Downloaded → Install_. You are sent back to the page,
   which now shows (and remembers) the UDID. Nothing stays installed.
   Alternatively run `eas device:create`, which offers the same flow via a
   QR code.
2. **Register it with Apple.**
   ```sh
   eas device:create      # choose "Input manually" and paste the UDID
   ```
3. **Rebuild.** The provisioning profile is regenerated to include the new
   device on the next build (EAS asks whether to update the profile). Builds
   made before the device was added will **not** install on it — the app
   page marks them as _Not for this device_ once the device is identified.

Notes:

- Ad-hoc provisioning profiles expire after one year; the app page shows the
  expiry date. Expired builds no longer launch.
- Development-signed builds (`developmentClient: true`) additionally need
  _Developer Mode_ enabled on the device (iOS 16+). Ad-hoc builds do not.
- An Apple **Enterprise** profile installs on any device; App Distributor
  detects it and marks it accordingly.

---

## 3. Android: signing

`.apk` files are installable on any device, but Android only **updates** an
installed app if the new build is signed with the **same key**.

- Let EAS manage the keystore (default) and keep using the same profile.
  Never switch between debug-signed and release-signed builds for the same
  package name, or you will have to uninstall first.
- Installing requires allowing _Install unknown apps_ for the browser once
  (Android prompts automatically).

---

## 4. Build

### Local build (no EAS cloud minutes)

Requires Xcode (iOS) / Android SDK + JDK (Android) on your machine:

```sh
eas build --platform ios     --profile distribute --local --output dist/app.ipa
eas build --platform android --profile distribute --local --output dist/app.apk
```

### EAS cloud build

```sh
eas build --platform ios --profile distribute --non-interactive --wait --json > build.json
curl -fL -o dist/app.ipa "$(jq -r '.[0].artifacts.buildUrl' build.json)"
```

---

## 5. Upload

With the `appdist` CLI (see [CLI](../README.md#cli)):

```sh
appdist init                                    # once: server URL + credentials
appdist upload dist/app.ipa -n "Fix crash on login"
```

Or with curl:

```sh
# Streams the file - best for large builds
curl -fu "$DIST_USER:$DIST_PASSWORD" -T dist/app.ipa https://apps.example.com/api/upload

# With release notes
curl -fu "$DIST_USER:$DIST_PASSWORD" -T dist/app.apk \
  --url-query "notes=Fix crash on login" \
  https://apps.example.com/api/upload

# Multipart works too (the server buffers it in memory, so prefer -T for big files)
curl -fu "$DIST_USER:$DIST_PASSWORD" -F file=@dist/app.apk -F notes="Fix crash on login" \
  https://apps.example.com/api/upload
```

Successful response (`201 Created`, or `200` with `"duplicate": true` if the
exact same file was already uploaded):

```json
{
  "duplicate": false,
  "app": "ios-com.me.myapp",
  "id": "0mvii7htf-1c52c2",
  "platform": "ios",
  "bundleId": "com.me.myapp",
  "name": "MyApp",
  "version": "1.2.0",
  "build": "42",
  "url": "https://apps.example.com/apps/ios-com.me.myapp"
}
```

Errors return a JSON `{ "error": "..." }` with `401` (bad credentials), `413`
(larger than `MAX_UPLOAD_MB`) or `422` (not a valid `.ipa` / `.apk`).

### All-in-one script

`scripts/distribute.sh` in your Expo project:

```sh
#!/usr/bin/env bash
# Usage: DIST_URL=https://apps.example.com DIST_USER=me DIST_PASSWORD=... ./scripts/distribute.sh ios|android ["notes"]
set -euo pipefail
: "${DIST_URL:?}" "${DIST_USER:?}" "${DIST_PASSWORD:?}"

platform="${1:?ios or android}"
notes="${2:-$(git log -1 --pretty=%s)}"
ext=$([ "$platform" = ios ] && echo ipa || echo apk)
out="dist/app.$ext"

mkdir -p dist
npx eas-cli build --platform "$platform" --profile distribute --local --non-interactive --output "$out"
curl -fsS -u "$DIST_USER:$DIST_PASSWORD" -T "$out" --url-query "notes=$notes" "$DIST_URL/api/upload"
echo
```

Use a dedicated user for CI/scripts (see `USERS` in the server README) so it
can be rotated independently.

---

## 6. Installing and rolling back

- Open App Distributor on the phone, pick the app and tap **Install** on any
  version. On a desktop the app page shows a QR code to open it on the phone.
- **iOS**: Safari asks to install; the app appears on the home screen. Install
  links require HTTPS with a publicly trusted certificate.
- **Android**: the `.apk` downloads; open it to install.
- **Rollback**: tap **Install** on an older version.
  - iOS installs the older build over the current one and keeps app data.
    If iOS refuses, delete the app first.
  - Android refuses to install a lower `versionCode` over a higher one. To
    roll back, uninstall the app first (this deletes its data), then install
    the older version.

## Troubleshooting

| Symptom                                          | Cause                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| iOS: "Unable to install" / nothing happens       | Device UDID not in the profile, profile expired, or an App Store-signed build. Check the badges on the app page.             |
| iOS: install prompt never appears                | Server not reachable over HTTPS with a valid certificate, or `PUBLIC_URL` / `X-Forwarded-*` headers produce `http://` links. |
| Android: "App not installed"                     | Signed with a different key than the installed copy, or a downgrade. Uninstall first.                                        |
| Upload returns 422 "neither an .ipa nor an .apk" | You uploaded an `.aab` or a simulator build (`.tar.gz`/`.app`). Check the build profile.                                     |
| Upload of large files fails behind Traefik       | Traefik v3 defaults to a 60s read timeout; raise `respondingTimeouts.readTimeout` (see README).                              |
