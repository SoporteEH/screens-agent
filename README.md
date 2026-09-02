# ScreensWeb Agent

![Electron](https://img.shields.io/badge/electron-41-blue)
![Node](https://img.shields.io/badge/node-22%2B-green)
![Platform](https://img.shields.io/badge/platform-Windows-blue)

Desktop player (Electron) for **ScreensWeb**. Runs on each venue PC, connects to the backend over
the site's OpenVPN tunnel, and shows content full-screen in kiosk mode on every attached monitor.
Auto-updates from GitHub Releases.

## Table of Contents

- [What it is](#what-it-is)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start (dev)](#quick-start-dev)
- [Common commands](#common-commands)
- [Configuration](#configuration)
- [Resilience](#resilience)
- [Security](#security)
- [Auto-update](#auto-update)
- [Project structure](#project-structure)
- [Troubleshooting](#troubleshooting)

## What it is

One of the three ScreensWeb pieces (`screens-api`, `screens-front`, `screens-agent`). The agent:

- Keeps a persistent WebSocket connection to the backend and runs its commands in real time
  (`show_url`, `close_screen`, `refresh_screen`, `identify_screen`, `force_update`,
  `reboot_device`, `set_channel`, `get_logs`).
- Detects and manages the attached physical displays, shown full-screen in kiosk mode. Slots
  are keyed `"1".."N"` by id, not by array position: a monitor that is switched off keeps its
  slot marked `Disconnected` instead of shifting its neighbours.
- Falls back to a local carousel on network/server failure — screens never go black.
- Syncs local assets for offline playback and auto-updates itself.

## Architecture

```
ScreensWeb Backend (API + Socket.IO)
        │ WebSocket (WSS/WS)
ScreensWeb Agent (Electron)
  ├── Main: connection, commands, network monitoring, state
  └── Renderers: content windows, identify overlay, provisioning UI
        │ display output
Physical monitors
```

## Requirements

- **Windows 10/11** (64-bit)
- **Node.js 22+** and **npm 10+** (dev only; this repo uses npm, not pnpm)
- Network access to the ScreensWeb backend

## Quick start (dev)

```bash
git clone <repository>
cd screens-agent
npm install
echo "SERVER_URL=http://localhost:3000" > .env
npm start
```

First run launches **provisioning mode**. It shows the device ID and asks for the server URL
plus a **setup code** — a single-use nonce an admin generates in the panel (Devices → Generate
nonce, valid 15 min). Without it the handshake is refused: the device ID alone is not enough
to obtain a token.

Once configured the agent starts in normal mode and connects automatically. Hot reload is not
supported (restart the app). Logs: `%APPDATA%\ScreensWeb\logs\`.

For end users: download the latest `.exe` from GitHub Releases and run it (installs, adds a
desktop shortcut, auto-starts with Windows, and opens provisioning on first run).

## Common commands

| Command | What it does |
|---|---|
| `npm start` | Run the agent in development |
| `npm run build:prod` | Build the Windows installer (`dist/ScreensWebAgent-Setup-x.y.z.exe` + `latest.yml`) |

## Configuration

The backend URL is the only required setting: `.env` `SERVER_URL` in dev; baked at build time
(`package.json` `extraMetadata` / GitHub Secrets) in production.

Runtime config is stored **encrypted** (AES-256-GCM, key derived from the device hardware ID) at
`%APPDATA%\ScreensWeb\config.json` — holds `deviceId`, `agentToken`, `serverUrl`, `maxStorageMB`.
Delete it to return to provisioning mode.

| Setting | Default | Where |
|---|---|---|
| `maxStorageMB` | `500` | config — local asset storage cap |
| `DISABLE_GPU` | unset | env — disable hardware acceleration entirely |
| `GPU_SAFE_MODE` | unset | env — keep acceleration but skip forced GPU switches (Chromium blocklist decides) |
| `DISABLE_VIDEO_DECODE` | unset | env — software video decode; for GPUs whose single decode engine starves with several screens |
| `REDUCED_MOTION` | unset | env — force `prefers-reduced-motion` in content pages |
| `SOCKET_RECONNECT_DELAY_MS` | `3000` | `config/constants.js` — base reconnect delay |
| `SOCKET_RECONNECT_DELAY_MAX_MS` | `30000` | `config/constants.js` — max backoff between reconnect attempts |
| `CIRCUIT_BREAKER_THRESHOLD` | `10` | `config/constants.js` — failures before circuit opens |

## Resilience

**Offline recovery** — screens always show something:

| Case | Situation | Behavior |
|---|---|---|
| 1A | Server down, external URL on screen | Keep playing — the window is left untouched, not reloaded |
| 1B | Server down, internal URL on screen | Local carousel after 4s |
| 2 | Internet lost | All screens → local carousel |
| 3 | Internet back, server still down | Restore external URLs; carousel for internal |
| 4 | Server back | Reconnect socket, restore the assigned URLs |

Network is checked every 15s when stable, 5s when degraded.

`inspectScreen()` in `main.js` is the single predicate deciding whether a screen is showing what
it should. The watchdog, the offline handler and both recovery paths all ask it, so they cannot
disagree. The wrapper is local, so "on the wrapper and not stalled" is healthy under any network
state; recovery is an idempotent `player:show` push the renderer ignores when nothing changed,
so a flapping network never restarts content that is already playing.

**Player wrapper** — `player.html`, shipped with the agent and loaded as `file://` with
`player-preload.js`. The main process drives it over IPC: `player:init` (screen number),
`player:show` (`{url, contentName, fallbackUrl}` — idempotent, re-pushed on every wrapper
`did-finish-load`), `player:status` (`connected`/`server-down`/`offline` for the dot) and
`player:refresh` (re-set the iframe, no window reload). Offline targets carry the local
carousel as `fallbackUrl` so a dead content URL degrades to the carousel, never to black.
`scripts/check-player-contract.js` pins the wrapper's contract in CI.

**Screen health** — a cross-origin frame reports no errors to the page embedding it, so the
wrapper (`player.html`) watches for a frame that never fires `onload`: it retries 3 times,
then appends `[stalled]` to `document.title`. The agent reads that with
`webContents.getTitle()`, which is the only way a black screen behind a correctly-loaded
wrapper becomes visible. Frame-level load failures are logged as `[CONTENT]: Frame failed`.

**Reconnection** — exponential backoff with ±50% jitter, capped at 30s, never giving up. After
10 consecutive failures the circuit opens (`[CIRCUIT BREAKER]: OPEN`) and pauses for 5 minutes.

That pause is overridden the moment the network monitor proves the server answers `/health`:
`socket.forceReconnect()` drops the manager's pending backoff and dials immediately, because
`socket.connect()` alone is a no-op while a reconnection is already scheduled.

| Consecutive failures | Retry interval |
|---|---|
| 1–4 | 3s → 9s → 27s |
| 5+ | 30s (cap) |
| 10+ (open) | 5 min, unless the monitor forces it sooner |

## Security

- Config and autologin site credentials encrypted with AES-256-GCM using a hardware-derived key.
- **Transport** is the site's OpenVPN tunnel, whose certificate is issued by Luckia's PKI and
  installed by a technician. The agent neither presents nor validates a client certificate:
  this application does no mTLS of its own.
- **Identity** is a device JWT (RS256, 180-day life, refreshed once fewer than 90 days remain).
  An admin can revoke a single device: the live socket is cut immediately and the agent is told
  to re-provision. Commands are validated with Zod schemas.
- Chromium hardening: `nodeIntegration: false`, `contextIsolation: true`, `webSecurity: true`.
- Single-instance lock; renderer memory auto-reload above 800MB; caches cleared every 4h.

## Auto-update

`electron-updater` pulls from GitHub Releases. On startup the agent waits a random 15–60s (to
avoid a thundering herd), reads its channel file, downloads in the background, and installs
silently.

| Channel | File | Audience |
|---|---|---|
| `latest` | `latest.yml` | All devices (default) |
| `beta` | `beta.yml` | Canary devices |

- A device's channel lives in its encrypted config and is switched remotely with
  `{ "action": "set_channel", "channel": "beta" }` (or `"latest"`).
- **Release**: bump `package.json` version and push a tag (`vX.Y.Z`, or `vX.Y.Z-beta.N` for
  beta). CI builds, runs a smoke test that boots the binary, and only publishes if it passes.
- **Rollback**: `allowDowngrade` is on — publish/point the channel file to an older version and
  agents move back on the next check.

## Structure

```
screens-agent/
├── config/constants.js     # URLs, timeouts, paths
├── handlers/               # commands, ipc, provisioning
├── services/               # socket, network, assets, auth, updater, state, monitors, tray...
├── utils/                  # configManager (encrypted store), logConfig
├── css/ js/                # control panel UI
├── main.js                 # main process orchestrator
├── preload.js              # renderer bridge
├── *.html                  # control, fallback, identify, provision
└── package.json
```

## Troubleshooting

Logs: `%APPDATA%\ScreensWeb\logs\main.log`.

- **Won't start**: another instance running (single-instance lock), or corrupted config → delete
  `%APPDATA%\ScreensWeb\config.json`.
  
Reset (Windows shell):

```cmd
rmdir /s "%APPDATA%\ScreensWeb"                  :: full reset → provisioning mode
del "%APPDATA%\ScreensWeb\state.json"            :: clear screen state only
rmdir /s "%APPDATA%\ScreensWeb\content"          :: clear local assets (re-download next sync)
```
