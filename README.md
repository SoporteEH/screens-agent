# ScreensWeb Agent

Desktop application for Windows-based digital signage systems. Connects to the ScreensWeb backend via WebSockets and manages content display across multiple physical screens.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Technology Stack](#technology-stack)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Development](#development)
- [Build and Distribution](#build-and-distribution)
- [Auto-Update System](#auto-update-system)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)

## Overview

The ScreensWeb Agent is installed on venue PCs to display dynamic content on one or more screens. It maintains a persistent WebSocket connection to the central platform and executes remote commands in real-time.

**Core Responsibilities:**
- Establish and maintain WebSocket connection to ScreensWeb backend
- Receive and execute commands (display URL, show local assets, close content, identify screens)
- Detect and manage multiple physical displays (up to 4 per device)
- Display content in full-screen kiosk mode
- Handle connection and network failures with automatic recovery — screens must never show black
- Sync local asset files for offline playback
- Auto-update from GitHub Releases using electron-updater

## Features

**Multi-Monitor Support**
- Automatic detection of physical displays
- Predictable screen IDs (1, 2, 3, 4) ordered left-to-right by position
- Independent content management per screen
- Position-based state persistence across restarts

**Offline/Recovery Logic**

The agent handles 4 critical network failure cases, always keeping screens showing something:

| Case | Situation | Behavior |
|------|-----------|----------|
| 1A | Server down, screen shows external URL | Keep playing (no change) |
| 1B | Server down, screen shows internal URL | Switch to local carousel after 4s |
| 2 | Internet lost entirely | All screens switch to local carousel |
| 3 | Internet restored, server still down | Restore external URLs; keep carousel for internal URLs |
| 4 | Server restored | Socket reconnects, reload player URLs |

Network is monitored adaptively:
- **Stable** (all OK): check every 15 seconds
- **Degraded** (something down): check every 5 seconds

**Socket Circuit Breaker**

The WebSocket connection uses exponential backoff with a circuit breaker to avoid hammering the server during extended outages (thundering herd problem):

| Consecutive failures | Retry interval |
|---|---|
| 1–5 | 3s → 9s → 27s... |
| 8 | ~2 min |
| 10+ (circuit OPEN) | ~5 min + jitter |

- The agent **never stops retrying** — there is no user to restart it
- Jitter (±50%) spreads retries across all agents so they don't hit the server simultaneously
- On successful reconnect the counter resets and the circuit closes (`[CIRCUIT BREAKER]: CLOSED` in logs)

**Security**
- Configuration encrypted using a key derived from the device's hardware ID (via `node-machine-id`)
- Third-party credentials (e.g. Sportradar, Luckia) stored encrypted in `state.json` using AES-256-GCM
- JWT-based authentication (RS256)
- Command validation with Zod schemas
- Chromium hardening: `nodeIntegration: false`, `contextIsolation: true`, `webSecurity: true`
- Renderer process limit: 10 (supports up to 4 screens + control window + identify overlays)

**Asset Management**
- Local asset synchronization from central platform
- Validation on download: file extension allowlist + MD5 checksum verification
- Storage cap: 750MB by default (configurable via `maxStorageMB` in agent config)
- Automatic cleanup of obsolete files

**Stability (24/7 Operation)**
- HTTP cache cleared every 4 hours
- DOM storage (localStorage/sessionStorage) cleared every 4 hours
- Memory monitored hourly per renderer: auto-reload if a renderer exceeds 800MB
- `state.json` writes serialized through a mutex to prevent corruption under concurrent commands
- Single-instance lock prevents multiple agent processes

## Architecture

```
┌─────────────────────────────┐
│  ScreensWeb Backend         │
│  (API + Socket.IO Server)   │
└──────────────┬──────────────┘
               │ WebSocket (WSS/WS)
┌──────────────▼──────────────┐
│     ScreensWeb Agent        │
│     (Electron App)          │
├─────────────────────────────┤
│  Main Process               │
│  - Connection Management    │
│  - Command Handling         │
│  - Network Monitoring       │
│  - State Persistence        │
├─────────────────────────────┤
│  Renderer Processes         │
│  - Content Windows          │
│  - Identify Overlay         │
│  - Provisioning UI          │
└──────────────┬──────────────┘
               │ Display Output
┌──────────────▼──────────────┐
│    Physical Monitors        │
└─────────────────────────────┘
```

## Technology Stack

**Core:**
- Electron 38.x
- Node.js 22+
- Socket.IO Client 4.x

**Build & Distribution:**
- electron-builder
- electron-updater 6.x
- GitHub Actions

**Storage & Security:**
- electron-store 8.1.0 (CommonJS compatible)
- node-machine-id (hardware-derived encryption key)
- JWT authentication (RS256)
- Zod schema validation

**Development:**
- electron-log for logging
- dotenv for environment configuration

## Requirements

**Production (End User):**
- Windows 10/11 (64-bit)
- Network connectivity to ScreensWeb backend

**Development:**
- Windows 10/11
- Node.js 22+
- npm 9+
- Git

## Installation

### Development Setup

```bash
git clone <repository-url>
cd screens-agent
npm install
```

### Production Installation

Download the latest `.exe` installer from GitHub Releases and run it. The agent will:
1. Install to `C:\Program Files\ScreensWeb Agent\`
2. Create desktop shortcut
3. Configure auto-start with Windows
4. Launch provisioning mode on first run

## Configuration

The agent requires the backend server URL for operation.

### Development Configuration

Create a `.env` file in the root directory:

```env
SERVER_URL=http://localhost:3000
```

### Production Configuration

For production builds, the `SERVER_URL` is injected during the build process via `package.json` `extraMetadata` or GitHub Secrets.

### Configuration Storage

The agent stores its configuration encrypted in `electron-store`:
- **Location:** `%APPDATA%\ScreensWeb\config.json`
- **Encryption:** AES-256-GCM key derived from device hardware ID
- **Content:** `deviceId`, `agentToken`, `serverUrl`, `maxStorageMB` (optional)
- **Reset:** Delete this file to return to provisioning mode

### Configurable Parameters

| Key | Default | Description |
|-----|---------|-------------|
| `maxStorageMB` | `750` | Maximum total size of local asset storage in MB |

Socket reconnection constants (in `config/constants.js`):

| Constant | Default | Description |
|----------|---------|-------------|
| `SOCKET_RECONNECT_DELAY_MS` | `3000` | Base reconnection delay |
| `SOCKET_RECONNECT_DELAY_MAX_MS` | `300000` | Max delay when circuit is open (5 min) |
| `CIRCUIT_BREAKER_THRESHOLD` | `10` | Consecutive failures before circuit opens |

---

## Development

Start the agent in development mode:

```bash
npm start
```

**Expected Behavior:**
- **First Run:** Launches in Provisioning Mode, displays device ID for linking
- **Configured:** Launches in Normal Mode, connects to backend automatically

**Development Tools:**
- DevTools enabled in development mode
- Hot reload not supported (requires app restart)
- Logs written to console and file (`%APPDATA%\ScreensWeb\logs\`)

## Build and Distribution

Generate the Windows installer:

```bash
npm run build:prod
```

**Output:**
- `dist/ScreensWebAgent-Setup-1.x.x.exe` - NSIS installer
- `dist/latest.yml` - Update metadata for electron-updater
- `dist/win-unpacked/` - Unpacked application files

## Auto-Update System

The agent uses `electron-updater` for seamless updates.

### Release Process (Developer)

1. Update version in `package.json`:
   ```json
   {
     "version": "1.1.33"
   }
   ```

2. Commit and create a git tag:
   ```bash
   git add package.json
   git commit -m "Bump version to 1.1.33"
   git tag v1.1.33
   git push origin main --tags
   ```

3. GitHub Actions automatically:
   - Builds the application
   - Generates installer and `latest.yml`
   - Creates a GitHub Release with artifacts

### Update Process (Agent)

1. Agent checks for updates at startup (random delay 15–60s to avoid thundering herd with 350 devices)
2. Detects new version from `latest.yml`
3. Downloads installer in background
4. Installs silently and restarts

## Project Structure

```
screens-agent/
├── config/
│   └── constants.js           # Centralized configuration (URLs, timeouts, paths)
├── handlers/
│   ├── commands.js            # Remote command handlers (show_url, close_screen, etc.)
│   ├── ipc.js                 # IPC message handlers between main and renderer
│   └── provisioning.js        # Device provisioning flow
├── services/
│   ├── agentModes.js          # Normal mode vs provisioning mode startup logic
│   ├── assets.js              # Local asset synchronization with validation
│   ├── auth.js                # JWT token refresh loop
│   ├── device.js              # Device registration and system commands
│   ├── gpu.js                 # GPU configuration and crash handling
│   ├── localCarousel.js       # Offline carousel builder from local assets
│   ├── monitors.js            # Screen and network monitor initialization
│   ├── network.js             # Adaptive network connectivity monitoring
│   ├── playerCache.js         # Offline cache of player HTML
│   ├── socket.js              # WebSocket connection management
│   ├── state.js               # Screen state persistence (state.json, mutex)
│   ├── tray.js                # System tray icon and menu
│   └── updater.js             # Auto-update orchestration
├── utils/
│   ├── configManager.js       # electron-store wrapper with per-device encryption
│   └── logConfig.js           # Logging configuration
├── icons/                     # Application icons
├── main.js                    # Main process orchestrator and context
├── preload.js                 # Preload script for renderer security
├── identify-preload.js        # Preload for screen identification overlay
├── control.html               # Control panel UI
├── fallback.html              # Offline fallback page
├── identify.html              # Screen identification overlay
├── provision.html             # Provisioning mode UI
├── package.json               # Project metadata and Electron config
└── README.md                  # This file
```

### Architecture Layers

| Layer | Responsibility |
|-------|----------------|
| **main.js** | Application orchestration, global context, network event handlers |
| **services/** | Independent modules with single responsibility |
| **handlers/** | Command execution and user flows |
| **config/** | Centralized constants and configuration |
| **utils/** | Reusable utilities (config storage, logging) |

## Troubleshooting

**Check logs:** `%APPDATA%\ScreensWeb\logs\main.log`

**Common causes:**
- Another instance already running (single-instance lock)
- Corrupted config file → Delete `%APPDATA%\ScreensWeb\config.json`
- Missing dependencies → Reinstall agent

**Wrong screen count:**
- Restart agent after connecting monitors
- Ensure "Extend these displays" mode in Windows display settings

### Reset Agent

**Full reset (returns to provisioning mode):**
```cmd
rmdir /s "%APPDATA%\ScreensWeb"
```

**Clear only state (keeps config and credentials):**
```cmd
del "%APPDATA%\ScreensWeb\state.json"
```

**Clear only local assets (forces re-download on next sync):**
```cmd
rmdir /s "%APPDATA%\ScreensWeb\content"
rmdir /s "%APPDATA%\ScreensWeb\playlist-assets"
```
