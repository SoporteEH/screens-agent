const { app, BrowserWindow, screen, net, ipcMain } = require('electron');
const { log } = require('./utils/logConfig');
const path = require('path');
const fs = require('fs');

try {
    const { configureUpdater, checkForUpdates } = require('./services/updater');
    configureUpdater();
    checkForUpdates();
} catch (updaterError) {
    log.error('Fatal: Failed to initialize auto-updater:', updaterError);
}

const context = {
    deviceId: null,
    agentToken: null,
    socket: null,
    isOnline: false,
    managedWindows: new Map(),
    identifyWindows: new Map(),
    retryManager: new Map(),
    hardwareIdToDisplayMap: new Map(),
    autoRefreshTimers: new Map(),
    fallbackTimers: new Map(),
    screenModes: new Map(),
    // ONLINE / NO_SERVER / NO_INTERNET. Starts optimistic, like the network monitor.
    networkState: 'ONLINE',
};

async function bootstrap() {
    try {
        const constants = require('./config/constants');
        const { loadConfig, saveConfig } = require('./utils/configManager');
        const {
            configureGpu,
            configureMemory,
            logGpuDiagnostics,
            registerGpuCrashHandlers,
        } = require('./services/gpu');
        const { registerIpcHandlers } = require('./handlers/ipc');
        const { startNormalMode, startProvisioningMode } = require('./services/agentModes');
        const {
            startProvisioningMode: startProvisioningHandler,
        } = require('./handlers/provisioning');
        const { createTray, updateControlWindow } = require('./services/tray');
        const { getDeviceName } = require('./services/identity');
        const commandHandlers = require('./handlers/commands');
        const stateService = require('./services/state');
        const { cleanupOldLogs, applyConfiguredLogLevel } = require('./utils/logConfig');

        cleanupOldLogs();
        applyConfiguredLogLevel();

        const socketService = require('./services/socket');
        const deviceService = require('./services/device');
        const assetsService = require('./services/assets');

        const gotTheLock = app.requestSingleInstanceLock();
        if (!gotTheLock) {
            app.quit();
            return;
        }

        configureGpu();
        configureMemory();
        registerGpuCrashHandlers();

        log.info(
            `[INIT]: ScreensWeb Agent starting on platform: ${process.platform} (Version: ${constants.AGENT_VERSION})`
        );

        deviceService.setupAutostart();

        const broadcastAppStatus = () => {
            const statusInfo = {
                serverUrl: constants.getServerUrl(),
                version: constants.AGENT_VERSION,
                status: context.isOnline ? 'Online' : 'Offline',
                deviceName: getDeviceName(),
            };
            updateControlWindow(statusInfo);
        };

        registerIpcHandlers(constants.getServerUrl, constants.AGENT_VERSION, () => ({
            isOnline: context.getIsOnline?.() ?? context.isOnline,
            deviceName: getDeviceName(),
        }));

        // isOnline is a plain boolean; expose a getter for consumers needing a function ref.
        context.getIsOnline = () => context.isOnline;
        context.saveCurrentState = stateService.saveCurrentState;
        context.handleShowUrl = (cmd, att) => commandHandlers.handleShowUrl(cmd, att);
        commandHandlers.initializeHandlers(context);

        context.CONSTANTS = constants.CONSTANTS;
        context.setDeviceId = (id) => {
            context.deviceId = id;
        };
        context.setAgentToken = (token) => {
            context.agentToken = token;
            if (context.socket) {
                context.socket.auth.token = token;
            }
        };
        context.startProvisioningHandler = startProvisioningHandler;
        context.registerDevice = () =>
            deviceService.registerDevice(
                context.socket,
                context.deviceId,
                context.hardwareIdToDisplayMap
            );
        context.sendHeartbeat = () =>
            socketService.sendHeartbeat(
                context.socket,
                Array.from(context.hardwareIdToDisplayMap.keys())
            );
        context.restoreAllContent = () =>
            stateService.restoreAllContentImmediately(
                context.hardwareIdToDisplayMap,
                context.managedWindows,
                commandHandlers.handleShowUrl,
                commandHandlers.createContentWindow
            );

        context.connectSocket = (token) => {
            context.socket = socketService.connectToSocketServer(token, {
                onConnect: () => {
                    context.isOnline = true;
                    broadcastAppStatus();
                    context.registerDevice();
                    assetsService.syncLocalAssets(context.agentToken);
                },
                onDisconnect: (_reason) => {
                    context.isOnline = false;
                    broadcastAppStatus();
                    context.onNetworkOffline('SOCKET_DISCONNECT');
                },
                // 'connect' fires on reconnections too and already re-registers the
                // device; this handler only repairs what is on the screens.
                onReconnect: () => {
                    const { loadConfig } = require('./utils/configManager');
                    const onlineConfig = loadConfig();
                    const serverUrl = onlineConfig.serverUrl || constants.getServerUrl();

                    if (!serverUrl || !onlineConfig.deviceId) {
                        setTimeout(
                            () =>
                                stateService.restoreLastState(
                                    context.hardwareIdToDisplayMap,
                                    commandHandlers.handleShowUrl
                                ),
                            1000
                        );
                        return;
                    }

                    setTimeout(() => {
                        context.fallbackTimers.forEach((t) => clearTimeout(t));
                        context.fallbackTimers.clear();
                        context.recoverScreens('SOCKET');
                    }, 3000);
                },
                onCommand: (command) => {
                    // Never log the raw command: show_url carries autologin credentials.
                    log.info(
                        `[SOCKET]: Command received: ${command.action}` +
                            (command.screenIndex ? ` (screen ${command.screenIndex})` : '')
                    );
                    const actions = {
                        show_url: commandHandlers.handleShowUrl,
                        close_screen: commandHandlers.handleCloseScreen,
                        identify_screen: commandHandlers.handleIdentifyScreen,
                        refresh_screen: commandHandlers.handleRefreshScreen,
                        reboot_device: deviceService.handleRebootDevice,
                        force_update: require('./services/updater').handleForceUpdate,
                        set_channel: (cmd) => {
                            require('./services/updater').handleSetChannel(cmd);
                            // Reports the new channel immediately so the admin panel doesn't wait for a reconnect.
                            context.registerDevice?.();
                        },
                        get_logs: commandHandlers.handleGetLogs,
                    };
                    if (actions[command.action]) actions[command.action](command);
                },
                onAssetsUpdated: () => assetsService.syncLocalAssets(context.agentToken),
                onDeviceInfo: (device) => {
                    log.info('[SOCKET]: Device info received:', device.name);
                    const { setDeviceName, getDeviceName } = require('./services/identity');
                    setDeviceName(device.name);

                    // Persists admin-configured screen count (for offline-targeted commands) and prunes slots above it.
                    try {
                        const expectedScreens = Number.isInteger(device.expectedScreens)
                            ? device.expectedScreens
                            : null;
                        saveConfig({ expectedScreens });
                        if (expectedScreens) {
                            const { applyExpectedScreens } = require('./services/displaySlots');
                            const removed = applyExpectedScreens(
                                expectedScreens,
                                Array.from(context.hardwareIdToDisplayMap.keys())
                            );
                            for (const slotId of removed) {
                                stateService.saveCurrentState(
                                    slotId,
                                    null,
                                    null,
                                    0,
                                    context.autoRefreshTimers,
                                    context.managedWindows
                                );
                            }
                        }
                    } catch (e) {
                        log.error('[SOCKET]: Error applying expectedScreens:', e);
                    }

                    broadcastAppStatus();
                },
                onForceReprovision: () => {
                    log.warn('[SOCKET]: Force-reprovision received.');
                    context.managedWindows.forEach((win) => {
                        if (win && !win.isDestroyed()) win.close();
                    });
                    try {
                        if (fs.existsSync(constants.CONFIG_FILE_PATH))
                            fs.unlinkSync(constants.CONFIG_FILE_PATH);
                        if (fs.existsSync(constants.STATE_FILE_PATH))
                            fs.unlinkSync(constants.STATE_FILE_PATH);
                    } catch (e) {
                        log.error('Error unlinking config:', e);
                    }
                    app.relaunch();
                    app.exit(0);
                },
                onResetScreens: async () => {
                    log.warn('[SOCKET]: Reset-screens received. Re-seeding slots from connected monitors.');
                    try {
                        const { clearSlots, reconcileDisplays } = require('./services/displaySlots');

                        // Snapshot slot->display and content so each monitor's content follows it (by display.id) into its new slot.
                        const oldMap = new Map(context.hardwareIdToDisplayMap);
                        const oldState = stateService.loadLastState();
                        const contentByDisplayId = new Map();
                        for (const [slotId, display] of oldMap) {
                            const entry = oldState[slotId];
                            if (entry?.url) contentByDisplayId.set(display.id, entry);
                        }

                        context.managedWindows.forEach((win) => {
                            if (win && !win.isDestroyed()) win.close();
                        });
                        context.managedWindows.clear();
                        context.identifyWindows.forEach((win) => {
                            if (win && !win.isDestroyed()) win.destroy();
                        });
                        context.identifyWindows.clear();
                        context.autoRefreshTimers.forEach((t) => clearInterval(t));
                        context.autoRefreshTimers.clear();
                        context.retryManager.forEach((r) => clearTimeout(r.timerId));
                        context.retryManager.clear();
                        context.fallbackTimers.forEach((t) => clearTimeout(t));
                        context.fallbackTimers.clear();
                        context.screenModes.clear();

                        // Wipe the persisted maps, then re-seed contiguous 1..K by position.
                        clearSlots();
                        stateService.clearAllState();
                        await reconcileDisplays(context.hardwareIdToDisplayMap);

                        const restores = [];
                        for (const [newSlotId, display] of context.hardwareIdToDisplayMap) {
                            const entry = contentByDisplayId.get(display.id);
                            if (entry?.url) restores.push({ newSlotId, entry });
                        }

                        // Persist first so registerDevice reports the correct currentUrl.
                        await Promise.all(
                            restores.map(({ newSlotId, entry }) =>
                                stateService.saveCurrentState(
                                    newSlotId,
                                    entry.url,
                                    entry.credentials || null,
                                    entry.refreshInterval || 0,
                                    context.autoRefreshTimers,
                                    context.managedWindows
                                )
                            )
                        );

                        if (context.socket?.connected) context.registerDevice();

                        restores.forEach(({ newSlotId, entry }, i) => {
                            context.screenModes.set(String(newSlotId), 'live');
                            setTimeout(() => {
                                commandHandlers.handleShowUrl({
                                    action: 'show_url',
                                    screenIndex: newSlotId,
                                    url: entry.url,
                                    credentials: entry.credentials || null,
                                    refreshInterval: entry.refreshInterval || 0,
                                    silent: true,
                                });
                            }, 500 * i);
                        });

                        log.info(
                            `[SOCKET]: Reset complete. Slots: [${Array.from(context.hardwareIdToDisplayMap.keys()).join(', ')}]`
                        );
                    } catch (e) {
                        log.error('[SOCKET]: Error during reset-screens:', e);
                    }
                },
            });
        };

        const isBlankOrErrorUrl = (url) =>
            !url || url === 'about:blank' || url.startsWith('chrome-error://');

        // In player mode the window holds the wrapper, not the stored content URL, and
        // only the wrapper dies with the server.
        const getLoadedUrl = (win) => {
            try {
                return win.webContents.getURL() || '';
            } catch {
                return '';
            }
        };

        // The wrapper publishes its content frame's health here; see playerEndpoint.js.
        const isContentStalled = (win) => {
            try {
                return (win.webContents.getTitle() || '').includes('[stalled]');
            } catch {
                return false;
            }
        };

        // Lets a network flap skip screens that already show the right thing.
        const offlineSignatures = new Map();

        // Always the wrapper: it is the only page that can show the status dot.
        const resolveOfflineTarget = (screenIdStr, reason) => {
            const {
                isServerDependentUrl,
                getCachedPlayerFileUrl,
            } = require('./services/playerCache');
            const serverUrl = constants.getServerUrl();
            const contentUrl = stateService.loadLastState()[screenIdStr]?.url || '';
            // NO_INTERNET rules out external content too; the wrapper falls to the carousel.
            const playable =
                reason !== 'NO_INTERNET' &&
                net.isOnline() &&
                !!contentUrl &&
                !isServerDependentUrl(contentUrl, serverUrl);
            const embed = playable ? contentUrl : '';

            return {
                url: getCachedPlayerFileUrl(screenIdStr, embed, serverUrl, reason),
                signature: `${reason}|${embed}`,
            };
        };

        // Terminal state: a local file cannot fail to load.
        context.loadOfflineCarousel = (screenId, win) => {
            const { getCachedPlayerFileUrl } = require('./services/playerCache');
            const screenIdStr = String(screenId);
            const reason = context.networkState === 'NO_INTERNET' ? 'NO_INTERNET' : 'NO_SERVER';
            log.info(`[NETWORK]: Screen ${screenIdStr} → local carousel.`);
            win.loadURL(
                getCachedPlayerFileUrl(screenIdStr, '', constants.getServerUrl(), reason)
            ).catch((e) => log.error(`[NETWORK]: Carousel load error on screen ${screenIdStr}:`, e));
            // Forced fallback: re-evaluate on the next network event.
            offlineSignatures.delete(screenIdStr);
            context.screenModes.set(screenIdStr, 'offline');
        };

        context.applyOfflineScreen = (screenId, win, reason = 'NO_SERVER') => {
            const screenIdStr = String(screenId);
            const target = resolveOfflineTarget(screenIdStr, reason);

            log.info(`[NETWORK]: Screen ${screenIdStr} → offline wrapper (${target.signature})`);
            win.loadURL(target.url).catch((e) =>
                log.error(`[NETWORK]: Offline load error on screen ${screenIdStr}:`, e)
            );
            offlineSignatures.set(screenIdStr, target.signature);
            context.screenModes.set(screenIdStr, 'offline');
        };

        context.applyOnlineScreen = (screenId, win) => {
            const { loadConfig } = require('./utils/configManager');
            const screenIdStr = String(screenId);
            const onlineConfig = loadConfig();
            const serverUrl = onlineConfig.serverUrl || constants.getServerUrl();
            if (!serverUrl || !onlineConfig.deviceId) return false;

            const screenData = stateService.loadLastState()[screenIdStr];
            if (screenData?.url && screenData.credentials) {
                log.info(`[NETWORK]: Re-applying autologin content for screen ${screenIdStr}`);
                commandHandlers.handleShowUrl({
                    action: 'show_url',
                    screenIndex: screenIdStr,
                    url: screenData.url,
                    credentials: screenData.credentials,
                    refreshInterval: screenData.refreshInterval || 0,
                    silent: true,
                });
            } else {
                log.info(`[NETWORK]: Reloading player URL for screen ${screenIdStr}`);
                win.loadURL(`${serverUrl}/player/${onlineConfig.deviceId}/${screenIdStr}`).catch(
                    (e) => log.error(`[NETWORK]: Recovery error screen ${screenIdStr}:`, e)
                );
            }
            offlineSignatures.delete(screenIdStr);
            context.screenModes.set(screenIdStr, 'live');
            return true;
        };

        // Both recovery paths (network monitor and socket reconnect) can fire seconds
        // apart, so each repairs only what is actually wrong.
        context.recoverScreens = (source) => {
            context.managedWindows.forEach((win, screenId) => {
                if (!win || win.isDestroyed()) return;
                if (win.webContents.isLoading()) return;

                const verdict = context.inspectScreen(screenId, win, true);
                if (verdict.ok) {
                    context.screenModes.set(String(screenId), 'live');
                    return;
                }

                log.info(`[${source}]: Screen ${screenId} is ${verdict.reason} — restoring.`);
                context.applyOnlineScreen(screenId, win);
            });
        };

        // Shared by the network handlers and the watchdog so the two cannot disagree.
        context.inspectScreen = (screenId, win, online) => {
            const { isServerDependentUrl } = require('./services/playerCache');
            const { isAutologinUrl, isSameSite } = require('./utils/autologinUrl');
            const { loadConfig } = require('./utils/configManager');
            const screenIdStr = String(screenId);
            const cfg = loadConfig();
            const serverUrl = cfg.serverUrl || constants.getServerUrl();
            const screenData = stateService.loadLastState()[screenIdStr] || {};
            const contentUrl = screenData.url || '';
            const loadedUrl = getLoadedUrl(win);

            if (isBlankOrErrorUrl(loadedUrl)) {
                return { ok: false, reason: 'blank or on an error page' };
            }

            if (!online) {
                // Without a network nothing remote can play, so only local content counts.
                if (context.networkState === 'NO_INTERNET') {
                    return loadedUrl.startsWith('file://')
                        ? { ok: true }
                        : { ok: false, reason: 'showing remote content with no network' };
                }

                if (!isServerDependentUrl(loadedUrl, serverUrl)) return { ok: true };

                // The live wrapper needs the server only to reload; its frame keeps
                // playing without it, so a healthy one is left alone rather than
                // restarted into an identical offline shell.
                const wrapperUrl =
                    cfg.deviceId && serverUrl
                        ? `${serverUrl}/player/${cfg.deviceId}/${screenIdStr}`
                        : null;
                const keepsPlaying =
                    !!wrapperUrl &&
                    loadedUrl.startsWith(wrapperUrl) &&
                    !!contentUrl &&
                    !isServerDependentUrl(contentUrl, serverUrl) &&
                    !isContentStalled(win);

                return keepsPlaying
                    ? { ok: true }
                    : { ok: false, reason: 'stuck on a server page while the server is down' };
            }

            // Autologin bypasses the wrapper by design (the injection needs the login form).
            const bypassesWrapper = !!screenData.credentials || isAutologinUrl(contentUrl);
            if (bypassesWrapper) {
                return !contentUrl || isSameSite(loadedUrl, contentUrl)
                    ? { ok: true }
                    : { ok: false, reason: 'off its assigned content' };
            }

            if (!cfg.deviceId || !serverUrl) {
                return !contentUrl || isSameSite(loadedUrl, contentUrl)
                    ? { ok: true }
                    : { ok: false, reason: 'off its assigned content' };
            }

            const playerUrl = `${serverUrl}/player/${cfg.deviceId}/${screenIdStr}`;
            if (!loadedUrl.startsWith(playerUrl)) {
                return { ok: false, reason: 'off the player wrapper while online' };
            }
            // The wrapper can be on the right URL with a dead frame behind it.
            return isContentStalled(win)
                ? { ok: false, reason: 'showing a stalled content frame' }
                : { ok: true };
        };

        context.onNetworkOffline = (reason = 'UNKNOWN') => {
            log.info(`[NETWORK]: OFFLINE state detected. Reason: ${reason}`);
            context.isOnline = false;
            broadcastAppStatus();

            if (reason === 'SOCKET_DISCONNECT') return;

            context.managedWindows.forEach((win, screenId) => {
                if (!win || win.isDestroyed()) return;
                const screenIdStr = String(screenId);

                if (context.fallbackTimers.has(screenIdStr)) {
                    clearTimeout(context.fallbackTimers.get(screenIdStr));
                    context.fallbackTimers.delete(screenIdStr);
                }

                const loadedUrl = getLoadedUrl(win);
                const target = resolveOfflineTarget(screenIdStr, reason);
                // The wrapper path is stable, so compare what it was built with instead.
                const alreadyThere =
                    !isBlankOrErrorUrl(loadedUrl) &&
                    loadedUrl.startsWith('file://') &&
                    offlineSignatures.get(screenIdStr) === target.signature;

                log.info(
                    `[NETWORK]: Screen ${screenIdStr} — loaded: "${loadedUrl}", offline target: ${target.signature}`
                );

                if (alreadyThere) {
                    log.info(`[NETWORK]: Screen ${screenIdStr} already correct, keeping playback.`);
                    return;
                }

                // Content that does not depend on the server just keeps playing: swapping
                // shells would restart the very same URL for nothing.
                if (!loadedUrl.startsWith('file://') && context.inspectScreen(screenId, win, false).ok) {
                    log.info(
                        `[NETWORK]: Screen ${screenIdStr} plays content the server does not serve, leaving it untouched.`
                    );
                    context.screenModes.set(screenIdStr, 'live');
                    return;
                }

                const timer = setTimeout(() => {
                    context.fallbackTimers.delete(screenIdStr);
                    if (win && !win.isDestroyed()) {
                        context.applyOfflineScreen(screenId, win, reason);
                    }
                }, constants.CONSTANTS.FALLBACK_DELAY_MS);
                context.fallbackTimers.set(screenIdStr, timer);
            });
        };

        context.onNetworkOnline = () => {
            log.info(
                '[NETWORK]: ONLINE state detected (internet + server reachable). Recovering...'
            );
            context.isOnline = true;
            broadcastAppStatus();

            context.fallbackTimers.forEach((timer, id) => {
                log.info(`[NETWORK]: Clearing pending fallback for screen ${id}`);
                clearTimeout(timer);
            });
            context.fallbackTimers.clear();

            if (context.socket && !context.socket.connected) context.socket.forceReconnect?.();

            const { loadConfig } = require('./utils/configManager');
            const onlineConfig = loadConfig();
            const serverUrl = onlineConfig.serverUrl || constants.getServerUrl();

            if (serverUrl && onlineConfig.deviceId) {
                setTimeout(() => context.recoverScreens('NETWORK'), 2000);

                // Recreates auto-refresh timers lost while offline — this path bypasses handleShowUrl, which normally sets them up.
                setTimeout(() => {
                    const lastState = stateService.loadLastState();
                    for (const [screenId, screenData] of Object.entries(lastState)) {
                        if (
                            (screenData.refreshInterval || 0) > 0 &&
                            !context.autoRefreshTimers.has(screenId)
                        ) {
                            const win = context.managedWindows.get(screenId);
                            if (win && !win.isDestroyed()) {
                                log.info(
                                    `[NETWORK]: Recreating missing auto-refresh timer for screen ${screenId} (${screenData.refreshInterval}s)`
                                );
                                stateService.setupAutoRefresh(
                                    screenId,
                                    screenData.refreshInterval,
                                    context.managedWindows,
                                    context.autoRefreshTimers
                                );
                            }
                        }
                    }
                }, 3500);
            } else {
                setTimeout(
                    () =>
                        stateService.restoreLastState(
                            context.hardwareIdToDisplayMap,
                            commandHandlers.handleShowUrl
                        ),
                    2000
                );
            }
        };

        app.whenReady().then(async () => {
            logGpuDiagnostics();

            // Must run before any state read.
            stateService.migrateStateEncryption();

            createTray(constants.getServerUrl(), constants.AGENT_VERSION);

            const serverArg = process.argv.find((arg) => arg.startsWith('--server='));
            const tokenArg = process.argv.find((arg) => arg.startsWith('--token='));
            const nonceArg = process.argv.find((arg) => arg.startsWith('--nonce='));

            if (serverArg) {
                const serverUrl = serverArg.split('=')[1];
                let agentToken = tokenArg ? tokenArg.split('=')[1] : null;
                const provisionNonce = nonceArg ? nonceArg.split('=')[1] : '';
                const { getMachineId } = require('./services/device');
                const deviceId = getMachineId();

                log.info(
                    `[INIT]: CLI Provisioning detected. Server: ${serverUrl}. Device ID: ${deviceId}`
                );

                if (!agentToken || agentToken.split('.').length !== 3) {
                    log.info(
                        '[INIT]: Provided token is missing or invalid. Attempting to fetch real JWT from server...'
                    );
                    try {
                        const axios = require('axios');
                        const response = await axios.post(
                            `${serverUrl}/api/auth/agent-token`,
                            { deviceId, nonce: provisionNonce }
                        );
                        agentToken = response.data.token;
                        log.info('[INIT]: Successfully retrieved JWT from server via CLI.');
                    } catch (e) {
                        log.error('[INIT]: Error fetching agent-token:', e.message);
                    }
                }

                saveConfig({
                    serverUrl,
                    agentToken,
                    deviceId,
                });
            }

            const initialConfig = loadConfig();
            if (!initialConfig.deviceId || !initialConfig.agentToken) {
                startProvisioningMode(context);
            } else {
                startNormalMode(context);
            }
        });

        app.on('before-quit', () => {
            if (context.socket?.clearCircuitBreaker) {
                context.socket.clearCircuitBreaker();
            }
        });

        app.on('window-all-closed', () => {
            if (context.provisionWindow && !context.provisionWindow.isDestroyed()) {
                app.quit();
            }
        });
    } catch (error) {
        log.error('FATAL BOOTSTRAP ERROR:', error);
        showErrorWindow(error);
    }
}

function showErrorWindow(error) {
    if (!app.isReady()) {
        app.whenReady()
            .then(() => showErrorWindow(error))
            .catch(() => {});
        return;
    }
    const errWin = new BrowserWindow({
        width: 500,
        height: 400,
        title: 'ScreensWeb Agent Update-Mode',
        frame: true,
        backgroundColor: '#1a1a1a',
    });
    errWin.setMenu(null);
    errWin.loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`
        <body style="background:#1a1a1a;color:#ff6600;font-family:sans-serif;padding:30px;text-align:center">
            <h2 style="margin-bottom:10px">Recovery Mode</h2>
            <p style="color:#ccc;margin-bottom:20px">The agent has encountered an error and is attempting to recover by downloading a new version.</p>
            <div style="background:#000;padding:15px;border-radius:8px;text-align:left;font-family:monospace;font-size:11px;color:#ef4444;height:120px;overflow:auto;border:1px solid #333">
                ${error.stack || error.message}
            </div>
            <p style="margin-top:20px;color:#666;font-size:12px">Checking for updates in the background... Please do not close this window.</p>
        </body>
    `)}`
    );
}

process.on('uncaughtException', (err) => {
    log.error('[PROCESS]: Uncaught Exception', err);
});

process.on('unhandledRejection', (reason, promise) => {
    log.error('[PROCESS]: Unhandled Rejection at:', promise, 'reason:', reason);
});

bootstrap();
