<img src="assets/icon.svg" width="64" height="64" alt="">

# app-distributor

Self-hosted over-the-air distribution for your own iOS (`.ipa`) and Android
(`.apk`) builds. Upload with the `appdist` CLI or `curl`, open the site on your phone, tap
**Install**. Every upload is kept as a version so you can roll back to any
earlier build.

- Accounts managed in the web UI, each with read and/or push permission for
  all apps or a chosen set of apps; an admin account is created on first start
- Upload via `curl` (Basic auth) or drag & drop in the browser
- Name, bundle id, version and build number are read from the binary; iOS
  provisioning (ad-hoc / development / enterprise, device count, expiry) is
  shown per version
- iOS install via `itms-services://` from Safari; signed, expiring links so
  the iOS installer can download without a session
- Optional device identification (UDID) on iPhone/iPad, so the UI shows which
  builds are provisioned for that device
- Everything in one directory (`/data`): builds as plain files, accounts in
  SQLite with a consistent snapshot that is safe to back up while running

Stack: TanStack Start + TanStack Query, shadcn/ui, Bun, Vite+ (`vp`).

Preparing an Expo app for this workflow: **[docs/expo-workflow.md](docs/expo-workflow.md)**.

## Configuration

| Variable               | Default                      | Description                                                                                                                                            |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SESSION_SECRET`       | random                       | Signs session cookies and install links. **Set it in production**, otherwise everyone is logged out and links break on restart. `openssl rand -hex 32` |
| `PUBLIC_URL`           | from request                 | External base URL, e.g. `https://apps.example.com`. Without it the URL is derived from `X-Forwarded-Proto`/`X-Forwarded-Host`/`Host`.                  |
| `DATA_DIR`             | `./data` (`/data` in Docker) | Where builds and metadata are stored.                                                                                                                  |
| `KEEP_VERSIONS`        | `0`                          | Keep at most N versions per app; older ones are deleted on upload. `0` keeps everything.                                                               |
| `MAX_UPLOAD_MB`        | `4096`                       | Maximum upload size.                                                                                                                                   |
| `SESSION_TTL_HOURS`    | `720`                        | Login session lifetime.                                                                                                                                |
| `LINK_TTL_HOURS`       | `24`                         | Lifetime of install/download links (the UI refreshes them automatically).                                                                              |
| `PORT` / `HOST`        | `3000` / `0.0.0.0`           | Listen address.                                                                                                                                        |
| `RESET_ADMIN_PASSWORD` | –                            | `true` gives the `admin` account a new generated password (printed in the log) on start. Remove it again afterwards. See below.                        |

## Accounts and permissions

On the first start (no accounts yet) the server creates the account `admin`
with a random password and prints both to the log, once:

```
========================================================================
Created the admin account in /data/accounts.db.

  Username: admin
  Password: 8wvexgQ4-5yOtXpl

Sign in and change the password; until then the account can do nothing else.
This password is not shown again.
========================================================================
```

Find it with `docker compose logs app-distributor`. Until its password is
changed the account is limited to the **Change password** page; the API
(uploads, CLI) rejects it with `403`. Every user can change their own password
under **Change password** in the account menu. Admins manage all accounts
under **Accounts**.

Lost the admin password (or locked every admin out)? Start the container once
with `RESET_ADMIN_PASSWORD=true`. The `admin` account (created again if it was
deleted) becomes an admin with a new generated password, printed to the log
as above. Then remove the variable, or the password is reset on every start.

Each account has a password and either the **Admin** flag or a list of
permissions. A permission targets **All apps** or one app (key
`<platform>-<bundleId>`, e.g. `ios-com.example.app`; it can be entered before
the app's first upload) and grants:

- **Read**: see the app, install and download its versions.
- **Push**: upload new versions of the app (`/api/upload`, CLI, browser) and
  delete versions. An upload of an app the account can't push to is rejected
  with `403`.

Apps without read permission are hidden. Changing an account's password signs
it out everywhere; deleting an account signs it out immediately. Install links
already handed out stay valid until they expire (`LINK_TTL_HOURS`).

## API

| Method       | Path                                                     | Auth             |                                                                                                                   |
| ------------ | -------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PUT`/`POST` | `/api/upload`                                            | Basic or session | Raw body (`curl -T file`) or multipart field `file`. Notes via `?notes=`, `X-Notes` header or form field `notes`. |
| `GET`        | `/api/dl/<token>/manifest.plist` · `app.ipa` · `app.apk` | signed token     | Used by the install buttons. Supports `Range`.                                                                    |
| `GET`        | `/api/device/profile`                                    | session          | UDID enrollment profile (iOS).                                                                                    |
| `GET`        | `/api/me`                                                | Basic or session | Returns `{ "user", "admin", "grants" }`; used to check credentials.                                               |
| `GET`        | `/api/health`                                            | –                | Health check.                                                                                                     |

```sh
curl -fu me -T build.ipa https://apps.example.com/api/upload
```

## CLI

`cli/appdist.ts` wraps the upload API (streams the file, shows progress, no
dependencies). Runs on Bun or Node ≥ 23.6.

```sh
bun link                                  # puts `appdist` on your PATH (from this repo)
# or: bun run build:cli                   # standalone binary at dist/appdist

appdist init                              # prompts for server URL, username, password
appdist upload build.ipa -n "Fix login"   # prints the app page URL
appdist upload app.apk --json             # full server response
```

`init` verifies the credentials against `/api/me` and stores them in
`~/.config/app-distributor/config.json` (mode `0600`; respects
`XDG_CONFIG_HOME`, or set `APPDIST_CONFIG`). It can also run
non-interactively: `appdist init --url ... --user ... --password ...`.

In CI skip `init` and set `APPDIST_URL`, `APPDIST_USER` and
`APPDIST_PASSWORD`; they override the stored config.

### Building Expo apps without EAS

`appdist build` builds the Expo project in the current directory locally with
Xcode / Gradle and uploads the result. Run `npx expo install` (or your package
manager's install) and `npx expo prebuild` once; after that:

```sh
appdist build ios -n "Fix login"   # xcodebuild archive + export (ad-hoc) → upload .ipa
appdist build android              # gradlew app:assembleRelease → upload .apk
appdist build all                  # both, each uploaded right after it's built
appdist build android --aab        # gradlew app:bundleRelease → print .aab path, no upload
```

- The JS bundle gets **only** the variables from `.env.production.local`
  (`--env-file` to change). Expo's own `.env*` loading is turned off, so
  development values in `.env.local` can't end up in a release build.
- iOS uses automatic signing with the team from the Xcode project
  (`-allowProvisioningUpdates`). `--export-method development|enterprise`
  switches the export method. Output: `ios/build/appdist/`.
- Android signs with the debug keystore unless `APPDIST_ANDROID_KEYSTORE`,
  `APPDIST_ANDROID_KEYSTORE_PASSWORD`, `APPDIST_ANDROID_KEY_ALIAS` (and
  optionally `APPDIST_ANDROID_KEY_PASSWORD`) are set, in the environment or the
  env file. They're passed as Gradle's injected signing properties, so the
  generated `build.gradle` stays untouched. `APPDIST_ANDROID_KEY_PASSWORD`
  defaults to the keystore password. `ANDROID_HOME` defaults to
  `~/Library/Android/sdk`.
- `--aab` builds a bundle for Google Play. It fails if the keystore settings are
  missing, because Play rejects a debug-signed bundle. The server can't install
  an `.aab`, so it isn't uploaded: the path is printed for you to upload to Play
  Console (`android/app/build/outputs/bundle/release/app-release.aab`).
- `--skip-upload` only builds; `--verbose` shows the full build output.

## Development

```sh
bun install
bun run dev                      # http://localhost:3000; admin password in the output
bun --bun vp check               # format, lint, typecheck
bun --bun run build && bun start.mjs
```

iOS installs only work over HTTPS with a trusted certificate, so test the
install flow on a deployed instance (or through a tunnel such as
`cloudflared tunnel --url http://localhost:3000`).

## Storage layout

```
$DATA_DIR/apps/<platform>-<bundleId>/<versionId>/meta.json
$DATA_DIR/apps/<platform>-<bundleId>/<versionId>/app.ipa|app.apk
$DATA_DIR/tmp/                       # in-flight uploads
$DATA_DIR/accounts.db                # accounts and permissions (SQLite)
$DATA_DIR/accounts.snapshot.db       # consistent copy, rewritten after every change
```

Deleting a version directory removes it from the UI.

### Backing up accounts

A file copy of a running container's volume can catch `accounts.db` in the
middle of a write. So after every account change the server also writes
`accounts.snapshot.db` (SQLite `VACUUM INTO` to a temp file, then an atomic
rename). The snapshot is always a complete database, so backing up the whole
data volume while the container runs (e.g. the `backup.volume` label in
`deploy/`) is enough.

On startup, if `accounts.db` is missing or fails SQLite's integrity check, it
is restored from `accounts.snapshot.db` (a corrupt file is kept as
`accounts.db.corrupt-<timestamp>`). To restore by hand, stop the container and
copy `accounts.snapshot.db` over `accounts.db`.

## Docker image & CI

`.github/workflows/docker.yml` builds the image on every push to `main` (and
`v*` tags) and pushes it to `registry.mani.codes/app-distributor` with tags
`latest`, `sha-<short>` and, for tags, `<version>` / `<major>.<minor>`.

Required repository secrets: `REGISTRY_USERNAME`, `REGISTRY_PASSWORD`.

Kept within the free plan for private repos (2,000 min/month, 10 GB cache):

- Docs-only changes (`**.md`, `docs/**`) don't trigger a build
- Superseded runs on the same branch are cancelled
- `linux/amd64` only — no QEMU arm64 emulation
- Docker layers are cached in the GitHub Actions cache (`type=gha`, one
  shared scope); unchanged `bun.lock` means the dependency layer is reused

Build locally: `docker build -t app-distributor .`

## Deployment

[`deploy/`](deploy/) contains a compose stack for a Traefik-fronted host (joins
the external `proxy` network, Let's Encrypt via the `letsencrypt` resolver,
data volume labeled for the `backup` tool):

```sh
cd deploy
cp .env.example .env                       # set tag, domain, SESSION_SECRET
docker compose up -d
docker compose logs app-distributor        # generated admin password (first start only)
```

**Traefik v3 and large uploads:** Traefik v3 closes requests whose body takes
longer than 60 s to read. Raise the timeout on the entrypoint used for uploads,
e.g. in Traefik's static config:

```yaml
- --entrypoints.websecure.transport.respondingTimeouts.readTimeout=15m
```
