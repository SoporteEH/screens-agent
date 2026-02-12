/**
 * ScreensWeb Local Agent
 * Orchestrator Main Process
 */

const { app, BrowserWindow, screen, net, ipcMain } = require('electron');
const { log } = require('./utils/logConfig');
const path = require('path');
const fs = require('fs');

// OPTIMIZATION: Manual GC
app.commandLine.appendSwitch('js-flags', '--expose-gc');

// AUTO-UPDATER INITIALIZATION
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
};

// BOOTSTRAP
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
                    context.registerDevice();
                    assetsService.syncLocalAssets(context.agentToken);
                },
                onDisconnect: () => {
                    context.isOnline = false;
                    broadcastAppStatus();
                    context.onNetworkOffline();
                },
                onReconnect: () => {
                    context.isOnline = true;
                    broadcastAppStatus();
                    context.registerDevice();
                    assetsService.syncLocalAssets(context.agentToken);
                    setTimeout(
                        () =>
                            stateService.restoreLastState(
                                context.hardwareIdToDisplayMap,
                                commandHandlers.handleShowUrl
                            ),
                        1000
                    );
                },
                onCommand: (command) => {
                    log.info('[SOCKET]: Comando recibido:', command);
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
        let fallbackApplied = false;

        context.onNetworkOffline = () => {
            if (fallbackApplied) {
                log.info('[NETWORK]: Fallback ya aplicado, ignorando evento duplicado.');
                context.isOnline = false;
                return;
            }
            log.info('[NETWORK]: Detectado OFFLINE. Iniciando fallback...');
            context.isOnline = false;
            fallbackApplied = true;
            broadcastAppStatus();

            const fallbackPath = `file://${path.join(__dirname, 'fallback.html')}`;
            const lastState = stateService.loadLastState();

            context.managedWindows.forEach((win, screenId) => {
                if (win && !win.isDestroyed()) {
                    // Normalizamos screenId a string para asegurar match con lastState keys
                    const screenIdStr = String(screenId);
                    const screenData = lastState[screenIdStr];

                    // Si no hay data (asumimos remoto) o si hay data y no es local -> Fallback
                    if (!screenData || (screenData.url && !screenData.url.startsWith('local:'))) {
                        log.info(`[NETWORK]: Aplicando fallback en pantalla ${screenIdStr}`);
                        try {
                            win.loadURL(fallbackPath);
                        } catch (e) {
                            log.error(`[NETWORK]: Error aplicando fallback en pantalla ${screenIdStr}:`, e);
                        }
                    }
                }
            });
        };
        context.onNetworkOnline = () => {
            log.info('[NETWORK]: Detectado ONLINE. Intentando reconectar...');
            context.isOnline = true;
            fallbackApplied = false;
            broadcastAppStatus();
            if (context.socket && !context.socket.connected) context.socket.connect();
            // Usar restoreLastState (runtime) en vez de restoreAllContent (startup)
            setTimeout(
                () =>
                    stateService.restoreLastState(
                        context.hardwareIdToDisplayMap,
                        commandHandlers.handleShowUrl
                    ),
                2000
            );
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
            <h2 style="margin-bottom:10px">Modo reparacion</h2>
            <p style="color:#ccc;margin-bottom:20px">El agente ha encontrado un error y se esta intentando corregir descargando una nueva version.</p>
            <div style="background:#000;padding:15px;border-radius:8px;text-align:left;font-family:monospace;font-size:11px;color:#ef4444;height:120px;overflow:auto;border:1px solid #333">
                ${error.stack || error.message}
            </div>
            <p style="margin-top:20px;color:#666;font-size:12px">Buscando actualizaciones en segundo plano... No cierre esta ventana.</p>
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
