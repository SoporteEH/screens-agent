# ScreensWeb Agent

![Electron](https://img.shields.io/badge/electron-44-blue)
![Node](https://img.shields.io/badge/node-22%2B-green)
![Platform](https://img.shields.io/badge/platform-Windows-blue)

Desktop player (Electron) for **ScreensWeb**. It runs on each venue PC (Windows 10/11, 64-bit),
connects to the API over the site's OpenVPN tunnel and shows content full-screen, in kiosk mode, on
every attached monitor:

- runs the API's commands in real time (`show_url`, `close_screen`, `refresh_screen`,
  `identify_screen`, `force_update`, `reboot_device`, `set_channel`, `get_logs`);
- keys monitor slots `"1".."N"` by id: a monitor switched off keeps its slot as `Disconnected`
  instead of shifting its neighbours;
- plays playlists and synced local files offline, and falls back to a local carousel when the
  network or the server fails, so a screen never goes black;
- updates itself from GitHub Releases.

## Run locally

Needs Node.js 22+ and **npm** 10+ (not pnpm: electron-builder packages the dependencies with npm).

```bash
npm install
echo "SERVER_URL=http://localhost:3000" > .env
npm start   # the first run downloads Electron
```

The first launch opens the **setup screen**: it shows the device ID and asks for the server URL and
a **setup code**, which admin or support generate in the panel (salon → "Agregar dispositivo", step
1; single use, 15 minutes). Step 2 of that dialog links the device ID to the salon. The agent then
restarts in normal mode. There is no hot reload.

Installed builds: run the `.exe` from GitHub Releases. It installs, adds a desktop shortcut, starts
with Windows and opens the setup screen on first run.

| Command                 | What it does                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `npm start`             | Run the agent                                                                                                                          |
| `npm run lint`          | ESLint                                                                                                                                 |
| `npm run format`        | Prettier; `npm run format:check` only checks                                                                                           |
| `npm test`              | `node --test`: schedule rules against the shared fixtures, playlist sequencer, manifest and local file resolution                      |
| `npm run test:contract` | Static checks on the player wrapper and its playlist engine                                                                            |
| `npm run build:prod`    | Inject `SERVER_URL` and the theme, build the installer (`dist/ScreensWebAgent-Setup-x.y.z.exe` + `latest.yml`), restore `package.json` |

## Configuration

`SERVER_URL` is the only required setting: `.env` in development, baked into `package.json`
(`config.serverUrl`) by `scripts/inject-config.js` for production builds. The setup screen can
override it.

Everything lives in `%APPDATA%\local-agent` (Electron's userData, named after the package, also in
installed builds):

| Path                                                 | Contents                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config.json`                                        | electron-store, encrypted with a hardware-derived key: `deviceId`, `agentToken`, `serverUrl`, `updateChannel`, `expectedScreens`, `restartSchedule`, `maxStorageMB`. Delete it to provision again |
| `ScreensWeb\state.json`                              | What each screen shows, playlist manifests included; autologin credentials encrypted                                                                                                              |
| `ScreensWeb\displays.json`                           | Monitor ↔ slot map                                                                                                                                                                                |
| `ScreensWeb\content\`, `ScreensWeb\asset-index.json` | Synced local files and their index                                                                                                                                                                |
| `gpu-config.json`                                    | GPU switches                                                                                                                                                                                      |
| `logs\`                                              | `general-YYYY-MM-DD.log`, `error-YYYY-MM-DD.log`; daily, kept 30 days                                                                                                                             |

| Setting                                                                                   | Default               | Where / effect                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxStorageMB`                                                                            | `500`                 | config: local file storage cap                                                                                                                                                             |
| `softwareVideoDecode`                                                                     | `false`               | `gpu-config.json`: software decode, for GPUs whose single decode engine starves with several screens. Survives updates and GPU-crash resets; env `DISABLE_VIDEO_DECODE=true` does the same |
| `DISABLE_GPU`                                                                             | unset                 | env: no hardware acceleration                                                                                                                                                              |
| `GPU_SAFE_MODE`                                                                           | unset                 | env: keep acceleration, skip the forced GPU switches                                                                                                                                       |
| `REDUCED_MOTION`                                                                          | unset                 | env: force `prefers-reduced-motion` in content pages                                                                                                                                       |
| `SOCKET_RECONNECT_DELAY_MS`, `SOCKET_RECONNECT_DELAY_MAX_MS`, `CIRCUIT_BREAKER_THRESHOLD` | `3000`, `30000`, `10` | `config/constants.js`                                                                                                                                                                      |

## Resilience

| Situation                           | Behaviour                                                |
| ----------------------------------- | -------------------------------------------------------- |
| Server down, external URL on screen | Keeps playing; the window is not reloaded                |
| Server down, internal URL on screen | Local carousel after 4 s                                 |
| Internet lost                       | Local carousel; a playlist keeps playing its local files |
| Internet back, server still down    | External URLs restored; carousel for internal ones       |
| Server back                         | Socket reconnects, the assigned URLs are restored        |

The network is checked every 15 s when stable, 5 s when degraded.

- **One health predicate.** `inspectScreen()` in `main.js` decides whether a screen shows what it
  should; the watchdog, the offline handler and both recovery paths ask it. Recovery is an
  idempotent `player:show` the wrapper ignores when nothing changed, so a flapping network never
  restarts content already playing.
- **Player wrapper.** `player.html` (with `player-preload.js`) ships in the agent, loads as
  `file://` and is driven over IPC: `player:init` (screen number), `player:show`
  (`{ url, contentName, fallbackUrl, playlist }`, re-pushed on every `did-finish-load`),
  `player:status` (`connected`, `server-down`, `offline`) and `player:refresh` (resets the iframe
  without reloading the window). Offline targets carry the local carousel as `fallbackUrl`.
  `scripts/check-player-contract.js` pins this contract in CI.
- **Screen health.** A cross-origin frame reports no errors to its parent, so the wrapper watches
  for a frame that never fires `onload`, retries 3 times and then appends `[stalled]` to
  `document.title`; the agent reads it with `webContents.getTitle()`. Frame load failures are
  logged as `[CONTENT]: Frame failed`.
- **Playlists.** The manifest arrives with `show_url` of `playlist:<id>`, is stored in `state.json`
  and is played by `js/playlist-engine.js` inside the wrapper, so it keeps its schedule with the API
  down and after a reboot. Rules, ordering and fallbacks:
  `screens-api/documentation/PLAYLISTS.md`. The heartbeat reports the PC clock and storage so the
  panel can flag a wrong clock or a full disk.
- **Local files.** The API names them `local:<assetId>` and lists, per device, the rendition of its
  media profile (H.264 1080p or 720p). `asset-index.json` maps ids to files (it sits outside
  `content\`, which the sync prunes). Files of the playlists on screen download first; an
  `assets-updated` sync waits up to 60 s of jitter so an estate-wide change does not hit every
  tunnel at once.
- **Reconnection.** Exponential backoff, never giving up: 3 → 6 → 12 → 24 s, then 30 s (±50%).
  After 10 consecutive failures the circuit opens (`[CIRCUIT BREAKER]: OPEN`) for 5 minutes, unless
  the network monitor sees the server answer `/health`: `socket.forceReconnect()` then dials at once
  (`socket.connect()` is a no-op while a reconnection is scheduled).

## Security

- `config.json` (electron-store) and the autologin credentials in `state.json` (AES-256-GCM) are
  encrypted with a key derived from the hardware ID; without a readable hardware ID the token is
  not persisted.
- Transport is the site's OpenVPN tunnel; the agent presents no client certificate. Identity is a
  device JWT (180 days, refreshed once fewer than 90 remain); revoking a device cuts its socket and
  sends it back to setup.
- Only `http`, `https`, `local:` and `playlist:` URLs are accepted. Content windows run with
  `nodeIntegration: false`, `contextIsolation: true`, `webSecurity: true` and `sandbox: true`.
- Web permissions are denied except `fullscreen` and `mediaKeySystem` (what the wrapper delegates to
  its frames), and no page gets a HID, USB or serial device (`services/permissions.js`). Denials are
  logged once per origin as `[PERMISSIONS]`.
- Single-instance lock; a renderer above 800 MB is reloaded; content pages' `localStorage` and
  `sessionStorage` are cleared every 4 h.

Full model: `screens-api/documentation/SECURITY.md`.

## Auto-update

`electron-updater` checks GitHub Releases on startup (so a build that fails to load can still be
replaced), again 15–60 s after entering normal mode, and then hourly; downloads run in the
background. A routine update installs silently between 03:00 and 06:00 or at a scheduled restart;
`force_update` installs at once.

| Channel  | File         | Devices       |
| -------- | ------------ | ------------- |
| `latest` | `latest.yml` | All (default) |
| `beta`   | `beta.yml`   | Canary        |

- The channel is stored in the encrypted config and switched remotely with `set_channel`.
- **Release**: push a tag `vX.Y.Z` (or `vX.Y.Z-beta.N`); the workflow takes the version from it,
  builds, boots the binary in a smoke test and publishes only if it passes.
- **Rollback**: `allowDowngrade` is on; point the channel file to an older version and agents move
  back on the next check.

## Structure

```
screens-agent/
├── config/        # constants (URLs, timeouts, paths), agentThemes
├── handlers/      # commands, ipc, provisioning
├── services/      # socket, network, assets, auth, updater, state, monitors, displaySlots,
│                  # localCarousel, screenWatchdog, restartScheduler, gpu, permissions, tray…
├── utils/         # configManager (encrypted store), logConfig, atomicWrite, playlistManifest…
├── css/, js/      # control panel UI; js/ also holds the playlist engine, sequencer, schedule
│                  # rules and the shared media watchdog
├── scripts/       # inject/restore config, player contract check, smoke test
├── tests/         # node --test suites and the shared schedule fixtures
├── main.js        # main process
├── player.html    # content wrapper (with player-preload.js)
├── preload.js, identify-preload.js   # renderer bridges
└── *.html         # control, fallback, identify, provision
```

## Troubleshooting

Logs: `%APPDATA%\local-agent\logs\general-<date>.log` (warnings and errors also in
`error-<date>.log`); staff can pull them from the panel (device → logs). If the agent will not
start, another instance is running or the config is corrupt.

```cmd
del "%APPDATA%\local-agent\config.json"                :: back to the setup screen
del "%APPDATA%\local-agent\ScreensWeb\state.json"      :: clear screen state only
rmdir /s "%APPDATA%\local-agent\ScreensWeb\content"    :: clear local files (re-downloaded on the next sync)
```
