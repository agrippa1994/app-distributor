<img src="assets/icon.svg" width="64" height="64" alt="">

# app-distributor

Self-hosted over-the-air distribution for your own iOS (`.ipa`) and Android
(`.apk`) builds. Upload with the `appdist` CLI or `curl`, open the site on your phone, tap
**Install**. Every upload is kept as a version so you can roll back to any
earlier build.

- Login with htpasswd-style users (bcrypt hashes or plain passwords)
- Upload via `curl` (Basic auth) or drag & drop in the browser
- Name, bundle id, version and build number are read from the binary; iOS
  provisioning (ad-hoc / development / enterprise, device count, expiry) is
  shown per version
- iOS install via `itms-services://` from Safari; signed, expiring links so
  the iOS installer can download without a session
- Optional device identification (UDID) on iPhone/iPad, so the UI shows which
  builds are provisioned for that device
- Plain-file storage in one directory (`/data`) — easy to back up

Stack: TanStack Start + TanStack Query, shadcn/ui, Bun, Vite+ (`vp`).

Preparing an Expo app for this workflow: **[docs/expo-workflow.md](docs/expo-workflow.md)**.

## Configuration

| Variable            | Default                      | Description                                                                                                                                            |
| ------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `USERS`             | –                            | Users as `user:hash` entries separated by newlines or commas. Hash from `htpasswd -nbB user pass` (bcrypt), `{SHA}` or plain text.                     |
| `USERS_FILE`        | –                            | Path to an htpasswd file (combined with `USERS`). Read at startup.                                                                                     |
| `SESSION_SECRET`    | random                       | Signs session cookies and install links. **Set it in production**, otherwise everyone is logged out and links break on restart. `openssl rand -hex 32` |
| `PUBLIC_URL`        | from request                 | External base URL, e.g. `https://apps.example.com`. Without it the URL is derived from `X-Forwarded-Proto`/`X-Forwarded-Host`/`Host`.                  |
| `DATA_DIR`          | `./data` (`/data` in Docker) | Where builds and metadata are stored.                                                                                                                  |
| `KEEP_VERSIONS`     | `0`                          | Keep at most N versions per app; older ones are deleted on upload. `0` keeps everything.                                                               |
| `MAX_UPLOAD_MB`     | `4096`                       | Maximum upload size.                                                                                                                                   |
| `SESSION_TTL_HOURS` | `720`                        | Login session lifetime.                                                                                                                                |
| `LINK_TTL_HOURS`    | `24`                         | Lifetime of install/download links (the UI refreshes them automatically).                                                                              |
| `PORT` / `HOST`     | `3000` / `0.0.0.0`           | Listen address.                                                                                                                                        |

## API

| Method       | Path                                                     | Auth             |                                                                                                                   |
| ------------ | -------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `PUT`/`POST` | `/api/upload`                                            | Basic or session | Raw body (`curl -T file`) or multipart field `file`. Notes via `?notes=`, `X-Notes` header or form field `notes`. |
| `GET`        | `/api/dl/<token>/manifest.plist` · `app.ipa` · `app.apk` | signed token     | Used by the install buttons. Supports `Range`.                                                                    |
| `GET`        | `/api/device/profile`                                    | session          | UDID enrollment profile (iOS).                                                                                    |
| `GET`        | `/api/me`                                                | Basic or session | Returns `{ "user": ... }`; used to check credentials.                                                             |
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
  generated `build.gradle` stays untouched. `ANDROID_HOME` defaults to
  `~/Library/Android/sdk`.
- `--skip-upload` only builds; `--verbose` shows the full build output.

## Development

```sh
bun install
USERS=dev:dev bun run dev        # http://localhost:3000
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
```

Deleting a version directory removes it from the UI. There is no database.

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
htpasswd -cbB users.htpasswd me 'password' # add more users with -bB (without -c)
chmod 644 users.htpasswd                   # container runs as non-root
docker compose up -d
```

Restart the container after editing `users.htpasswd`.

**Traefik v3 and large uploads:** Traefik v3 closes requests whose body takes
longer than 60 s to read. Raise the timeout on the entrypoint used for uploads,
e.g. in Traefik's static config:

```yaml
- --entrypoints.websecure.transport.respondingTimeouts.readTimeout=15m
```
