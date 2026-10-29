# ScreensWeb Agent

![Electron](https://img.shields.io/badge/electron-44-blue)
![Node](https://img.shields.io/badge/node-22%2B-green)
![Platform](https://img.shields.io/badge/platform-Windows-blue)

Desktop player (Electron) for **ScreensWeb**. It runs on each venue PC (Windows 10/11, 64-bit),
connects to the API and shows content full-screen, in kiosk mode, on every attached monitor:

- runs the API's commands in real time (`show_url`, `close_screen`, `refresh_screen`,
  `identify_screen`, `force_update`, `reboot_device`, `set_channel`, `get_logs`);
- keys monitor slots `"1".."N"` by id: a monitor switched off keeps its slot as `Disconnected`;
- plays playlists and local files offline, with a local carousel as fallback: a screen never goes
  black;
- updates itself from GitHub Releases.

## Run locally

Needs Node.js 22+ and **npm** 10+ (not pnpm: electron-builder packages the dependencies with npm).

```bash
npm install
echo "SERVER_URL=http://localhost:3000" > .env
npm start   # the first run downloads Electron
```

The first launch opens the **setup screen**: server URL and a **setup code** generated in the panel
(salon → "Agregar dispositivo"; single use, 15 minutes). The agent then restarts in normal mode.
Installed builds (`.exe` from GitHub Releases) start with Windows and open the same screen.

| Command                 | What it does                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `npm start`             | Run the agent                                                                                    |
| `npm run lint`          | ESLint                                                                                           |
| `npm run format`        | Prettier; `npm run format:check` only checks                                                     |
| `npm test`              | `node --test`: schedule rules, sequencer, manifest, local files, memory watchdog                 |
| `npm run test:contract` | Static checks on the player wrapper and its playlist engine                                      |
| `npm run build:prod`    | Installer in `dist/` with `SERVER_URL` baked in; restores `package.json` even if the build fails |

## Configuration

`SERVER_URL` is the only required setting (`.env` in development, baked into `package.json` for
production builds; the setup screen can override it). Everything lives in `%APPDATA%\local-agent`:

| Path                                      | Contents                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `config.json`                             | Encrypted store: device ID, token, server URL, channel. Delete it to provision again |
| `ScreensWeb\state.json`, `displays.json`  | What each screen shows; monitor ↔ slot map                                           |
| `ScreensWeb\content\`, `asset-index.json` | Synced local files and their index                                                   |
| `gpu-config.json`                         | `softwareVideoDecode: true` forces software video decode                             |
| `logs\`                                   | `general-<date>.log`, `error-<date>.log`; kept 30 days                               |

Env switches: `DISABLE_GPU`, `GPU_SAFE_MODE`, `DISABLE_VIDEO_DECODE`, `REDUCED_MOTION`. Timeouts
and reconnection delays: `config/constants.js`.

Three GPU process crashes within an hour set `gpuFailed` in `gpu-config.json`: the PC renders in
software for 7 days (delete the key to retry sooner). A page crashing does not count.

## Resilience

| Situation                           | Behaviour                                        |
| ----------------------------------- | ------------------------------------------------ |
| Server down, external URL on screen | Keeps playing                                    |
| Server down, internal URL on screen | Local carousel after 4 s                         |
| Internet lost                       | Local carousel; playlists keep their local files |
| Server back                         | Socket reconnects and restores the assigned URLs |

- `player.html` wraps every screen and is driven over IPC (`player:init/show/status/refresh`);
  `scripts/check-player-contract.js` pins that contract.
- A frame that never loads gets `[stalled]` in its title; the screen watchdog reads it and recovers.
- Every 10 minutes, a page using more than 15 % of the RAM (350 MB to 1 GB per renderer) is
  reloaded, at most once an hour per screen (`services/memoryWatchdog.js`). Each check logs the
  agent's memory by process, with the sites and screens each one holds, as a `[MEMORY]` line.
- Playlists run inside the wrapper (`js/playlist-engine.js`), so they keep their schedule with the
  API down. Rules: `screens-api/documentation/PLAYLISTS.md`.
- Reconnection backs off to 30 s and never gives up; after 10 failures a circuit breaker waits
  5 minutes, unless `/health` answers first.
- The network monitor probes the internet every 15 s (5 s while degraded) with one request, a second
  target only if it fails. `/health` is asked only while the socket is down, and at once when it drops.

## Security

- `config.json` and the autologin credentials are encrypted with a hardware-derived key.
- Identity is a device JWT (180 days, renewed with under 90 left); there is no client certificate.
  Revoking a device sends it back to setup.
- Only `http`, `https`, `local:` and `playlist:` URLs; content runs sandboxed, without Node.
- Web permissions are denied except `fullscreen` and `mediaKeySystem` (`services/permissions.js`),
  Local Network Access included; denials are logged once per origin as `[PERMISSIONS]`.

Full model: `screens-api/documentation/SECURITY.md`.

## Auto-update and release

`electron-updater` checks GitHub Releases at startup and hourly. Routine updates install between
03:00 and 06:00 or at a scheduled restart; `force_update` installs at once. Channels are `latest`
(default) and `beta` (canary), switched remotely with `set_channel`.

- **Release**: push a tag `vX.Y.Z` (or `vX.Y.Z-beta.N`); CI builds, smoke-tests and publishes.
- **Rollback**: point the channel file to an older version (`allowDowngrade` is on).

## Troubleshooting

Logs are in `%APPDATA%\local-agent\logs\`; staff can also pull them from the panel (device → logs).

```cmd
del "%APPDATA%\local-agent\config.json"                :: back to the setup screen
del "%APPDATA%\local-agent\ScreensWeb\state.json"      :: clear screen state
rmdir /s "%APPDATA%\local-agent\ScreensWeb\content"    :: clear local files (re-downloaded)
```
