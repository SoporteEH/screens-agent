const { app, BrowserWindow, screen, net, ipcMain } = require('electron');
const { log } = require('./utils/logConfig');
const path = require('path');
const fs = require('fs');

app.commandLine.appendSwitch('js-flags', '--expose-gc');

try {
    const { configureUpdater, checkForUpdates } = require('./services/updater');
    configureUpdater();
    checkForUpdates();
} catch (updaterError) {
    log.error('Fatal: Failed to initialize auto-updater:', updaterError);
}

// GLOBAL STATE
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
};

async function bootstrap() {
    try {
        const constants = require('./config/constants');
        const { loadConfig, saveConfig } = require('./utils/configManager');
        const {
            configureGpu,
            configureMemory,
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
        const { cleanupOldLogs } = require('./utils/logConfig');

        // Initial log cleanup
        cleanupOldLogs();

        const socketService = require('./services/socket');
        const deviceService = require('./services/device');
        const assetsService = require('./services/assets');

        // SINGLE INSTANCE LOCK
        const gotTheLock = app.requestSingleInstanceLock();
        if (!gotTheLock) {
            app.quit();
            return;
        }

        // HARDWARE & MEMORY CONFIG
        configureGpu();
        configureMemory();
        registerGpuCrashHandlers();

        // AUTO-START CONFIG
        if (app.isPackaged) {
            app.setLoginItemSettings({
                openAtLogin: true,
                path: app.getPath('exe'),
                args: ['--hidden'],
            });
        }

        // HELPER: Broadcast status to control window
        const broadcastAppStatus = () => {
            const statusInfo = {
                serverUrl: constants.getServerUrl(),
                version: constants.AGENT_VERSION,
                status: context.isOnline ? 'Online' : 'Offline',
                deviceName: getDeviceName(),
            };
            updateControlWindow(statusInfo);
        };

        // IPC HANDLERS
        registerIpcHandlers(constants.getServerUrl, constants.AGENT_VERSION, () => ({
            isOnline: context.isOnline,
            deviceName: getDeviceName(),
        }));

        // COMMAND HANDLER INITIALIZATION
        context.isOnline = () => context.isOnline;
        context.saveCurrentState = stateService.saveCurrentState;
        context.handleShowUrl = (cmd, att) => commandHandlers.handleShowUrl(cmd, att);
        commandHandlers.initializeHandlers(context);

        // ENRICH CONTEXT WITH ACTIONS
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

        // SOCKET CONNECTION WRAPPER
        context.connectSocket = (token) => {
            context.socket = socketService.connectToSocketServer(token, {
                onConnect: () => {
                    context.isOnline = true;
                    broadcastAppStatus();
                    context.registerDevice();
                    assetsService.syncLocalAssets(context.agentToken);
                },
                onDisconnect: (reason) => {
                    context.isOnline = false;
                    broadcastAppStatus();
                    context.onNetworkOffline('SOCKET_DISCONNECT');
                },
                onReconnect: () => {
                    context.isOnline = true;
                    broadcastAppStatus();
                    context.registerDevice();
                    assetsService.syncLocalAssets(context.agentToken);

                    // Reload player URLs on all screens
                    const { loadConfig } = require('./utils/configManager');
                    const onlineConfig = loadConfig();
                    const serverUrl = onlineConfig.serverUrl || constants.getServerUrl();

                    if (serverUrl && onlineConfig.deviceId) {
                        const savedState = stateService.loadLastState();
                        setTimeout(() => {
                            context.managedWindows.forEach((win, screenId) => {
                                if (!win || win.isDestroyed()) return;
                                const screenData = savedState[String(screenId)];
                                const isAutologinUrl =
                                    screenData?.url &&
                                    (screenData.url.startsWith('https://lcr.sportradar.com') ||
                                        screenData.url.toLowerCase().includes('luckiatv') ||
                                        screenData.url.includes('luckia-tv'));
                                if (isAutologinUrl && screenData.credentials) {
                                    log.info(
                                        `[SOCKET]: Reconnected. Re-applying autologin for screen ${screenId}: ${screenData.url}`
                                    );
                                    commandHandlers.handleShowUrl({
                                        action: 'show_url',
                                        screenIndex: screenId,
                                        url: screenData.url,
                                        credentials: screenData.credentials,
                                        refreshInterval: screenData.refreshInterval || 0,
                                    });
                                } else {
                                    const playerUrl = `${serverUrl}/player/${onlineConfig.deviceId}/${screenId}`;
                                    log.info(
                                        `[SOCKET]: Reconnected. Reloading player URL for screen ${screenId}`
                                    );
                                    win.loadURL(playerUrl).catch(e => log.error(`[SOCKET]: Error reloading win ${screenId}:`, e));
                                }
                            });
                            // Clear all fallback timers on reconnect
                            context.fallbackTimers.forEach(t => clearTimeout(t));
                            context.fallbackTimers.clear();
                        }, 3000);
                    } else {
                        setTimeout(
                            () =>
                                stateService.restoreLastState(
                                    context.hardwareIdToDisplayMap,
                                    commandHandlers.handleShowUrl
                                ),
                            1000
                        );
                    }
                },
                onCommand: (command) => {
                    log.info('[SOCKET]: Command received:', command);
                    const actions = {
                        show_url: commandHandlers.handleShowUrl,
                        close_screen: commandHandlers.handleCloseScreen,
                        identify_screen: commandHandlers.handleIdentifyScreen,
                        refresh_screen: commandHandlers.handleRefreshScreen,
                        reboot_device: deviceService.handleRebootDevice,
                        force_update: require('./services/updater').handleForceUpdate,
                        get_logs: commandHandlers.handleGetLogs,
                    };
                    if (actions[command.action]) actions[command.action](command);
                },
                onAssetsUpdated: () => assetsService.syncLocalAssets(context.agentToken),
                onDeviceInfo: (device) => {
                    log.info('[SOCKET]: Device info received:', device.name);
                    const { setDeviceName, getDeviceName } = require('./services/identity');
                    setDeviceName(device.name);
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
            });
        };

        // NETWORK HANDLERS

        context.onNetworkOffline = (reason = 'UNKNOWN') => {
            log.info(`[NETWORK]: OFFLINE state detected. Reason: ${reason}`);
            context.isOnline = false;
            broadcastAppStatus();

            const { isServerDependentUrl, getCachedPlayerFileUrl } = require('./services/playerCache');
            const serverUrl = constants.getServerUrl();
            const lastState = stateService.loadLastState();

            context.managedWindows.forEach((win, screenId) => {
                const screenIdStr = String(screenId);
                const screenData = lastState[screenIdStr];
                const currentUrl = screenData?.url || '';

                // Clear any existing timer for this screen
                if (context.fallbackTimers.has(screenIdStr)) {
                    clearTimeout(context.fallbackTimers.get(screenIdStr));
                    context.fallbackTimers.delete(screenIdStr);
                }

                if (reason === 'NO_SERVER') {
                    if (isServerDependentUrl(currentUrl, serverUrl)) {
                        log.info(`[NETWORK]: Server down. Scheduling fallback for screen ${screenIdStr} (content is server-dependent)`);
                        const timer = setTimeout(() => {
                            if (win && !win.isDestroyed()) {
                                log.info(`[NETWORK]: Applying fallback for screen ${screenIdStr} due to NO_SERVER`);
                                const offlineUrl = getCachedPlayerFileUrl(screenIdStr, currentUrl, serverUrl);
                                win.loadURL(offlineUrl).catch(e => log.error(`Fallback error:`, e));
                            }
                            context.fallbackTimers.delete(screenIdStr);
                        }, constants.CONSTANTS.FALLBACK_DELAY_MS);
                        context.fallbackTimers.set(screenIdStr, timer);
                    } else {
                        log.info(`[NETWORK]: Server down but external URL detected on screen ${screenIdStr}. Maintaining playback.`);
                    }
                    return;
                }

                if (reason === 'NO_INTERNET') {
                    log.info(`[NETWORK]: No internet. Scheduling fallback for screen ${screenIdStr} in ${constants.CONSTANTS.FALLBACK_DELAY_MS / 1000}s`);
                    const timer = setTimeout(() => {
                        if (win && !win.isDestroyed()) {
                            log.info(`[NETWORK]: Applying fallback for screen ${screenIdStr} due to NO_INTERNET`);
                            const offlineUrl = getCachedPlayerFileUrl(screenIdStr, currentUrl, serverUrl);
                            win.loadURL(offlineUrl).catch(e => log.error(`Fallback error:`, e));
                        }
                        context.fallbackTimers.delete(screenIdStr);
                    }, constants.CONSTANTS.FALLBACK_DELAY_MS);
                    context.fallbackTimers.set(screenIdStr, timer);
                }
            });
        };

        context.onNetworkOnline = () => {
            log.info('[NETWORK]: ONLINE state detected. Attempting to reconnect...');
            context.isOnline = true;
            broadcastAppStatus();

            // Clear all pending fallback timers
            context.fallbackTimers.forEach((timer, id) => {
                log.info(`[NETWORK]: Clearing pending fallback for screen ${id}`);
                clearTimeout(timer);
            });
            context.fallbackTimers.clear();

            if (context.socket && !context.socket.connected) context.socket.connect();

            // Reload player URLs on all screens
            const { loadConfig } = require('./utils/configManager');
            const onlineConfig = loadConfig();
            const serverUrl = onlineConfig.serverUrl || constants.getServerUrl();

            if (serverUrl && onlineConfig.deviceId) {
                setTimeout(() => {
                    context.managedWindows.forEach((win, screenId) => {
                        if (win && !win.isDestroyed()) {
                            const playerUrl = `${serverUrl}/player/${onlineConfig.deviceId}/${screenId}`;
                            log.info(`[NETWORK]: Reloading player URL for screen ${screenId}`);
                            win.loadURL(playerUrl).catch(e => log.error(`Recovery error screen ${screenId}:`, e));
                        }
                    });
                }, 3000);
            } else {
                setTimeout(
                    () =>
                        stateService.restoreLastState(
                            context.hardwareIdToDisplayMap,
                            commandHandlers.handleShowUrl
                        ),
                    3000
                );
            }
        };

        // START APP
        app.whenReady().then(() => {
            createTray(constants.getServerUrl(), constants.AGENT_VERSION);

            const initialConfig = loadConfig();
            if (!initialConfig.deviceId) {
                startProvisioningMode(context);
            } else {
                startNormalMode(context);
            }
        });

        // LIFECYCLE
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
            .catch(() => { });
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

// GLOBAL ERROR HANDLERS
process.on('uncaughtException', (err) => {
    log.error('[PROCESS]: Uncaught Exception', err);
});

process.on('unhandledRejection', (reason, promise) => {
    log.error('[PROCESS]: Unhandled Rejection at:', promise, 'reason:', reason);
});

bootstrap();
