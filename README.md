# ScreensWeb Agent

![Electron](https://img.shields.io/badge/electron-41-blue)
![Node](https://img.shields.io/badge/node-22%2B-green)
![Platform](https://img.shields.io/badge/platform-Windows-blue)

Desktop player (Electron) for **ScreensWeb**. Runs on each venue PC, connects to the backend over
WebSocket, and shows content full-screen in kiosk mode across up to 4 monitors. Auto-updates from
GitHub Releases.

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
  (`show_url`, `close_screen`, `refresh_screen`, `identify_screen`, `force_update`, `reboot_device`).
- Detects and manages up to 4 physical displays, shown full-screen in kiosk mode.
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

First run launches **provisioning mode** (shows the device ID to link in the panel); once
configured it starts in normal mode and connects automatically. Hot reload is not supported
(restart the app). Logs: `%APPDATA%\ScreensWeb\logs\`.

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
| `SOCKET_RECONNECT_DELAY_MS` | `3000` | `config/constants.js` — base reconnect delay |
| `SOCKET_RECONNECT_DELAY_MAX_MS` | `300000` | `config/constants.js` — max delay (circuit open) |
| `CIRCUIT_BREAKER_THRESHOLD` | `10` | `config/constants.js` — failures before circuit opens |

## Resilience

**Offline recovery** — screens always show something:

| Case | Situation | Behavior |
|---|---|---|
| 1A | Server down, external URL on screen | Keep playing |
| 1B | Server down, internal URL on screen | Local carousel after 4s |
| 2 | Internet lost | All screens → local carousel |
| 3 | Internet back, server still down | Restore external URLs; carousel for internal |
| 4 | Server back | Reconnect socket, reload URLs |

Network is checked every 15s when stable, 5s when degraded.

**Circuit breaker** — reconnection uses exponential backoff with ±50% jitter; the agent never
stops retrying. After 10 consecutive failures the circuit opens (`[CIRCUIT BREAKER]: OPEN`),
capping retries at ~5 min until a success closes it.

| Consecutive failures | Retry interval |
|---|---|
| 1–5 | 3s → 9s → 27s… |
| 8 | ~2 min |
| 10+ (open) | ~5 min + jitter |

## Security

- Config and third-party credentials (Sportradar, Luckia) encrypted with AES-256-GCM using a
  hardware-derived key.
- JWT auth (RS256); commands validated with Zod schemas.
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
