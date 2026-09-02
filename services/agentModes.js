const { log } = require('../utils/logConfig');
const { loadConfig } = require('../utils/configManager');
const { startTokenRefreshLoop } = require('./auth');
const { loadLastState, rearmAutoRefreshTimers } = require('./state');
const { reconcileDisplays } = require('./displaySlots');
const { checkForUpdates } = require('./updater');
const { initializeMonitors } = require('./monitors');
const { pingServer } = require('./network');
const { net, app } = require('electron');

const startNormalMode = async (context) => {
    const {
        setDeviceId,
        setAgentToken,
        hardwareIdToDisplayMap,
        restoreAllContent,
        connectSocket,
        CONSTANTS,
        sendHeartbeat,
        managedWindows,
    } = context;

    const config = loadConfig();
    setDeviceId(config.deviceId);
    setAgentToken(config.agentToken);

    log.info(`[NORMAL]: Device ID: ${config.deviceId}`);

    startTokenRefreshLoop(config.agentToken, setAgentToken);
    require('./restartScheduler').applyRestartSchedule(config.restartSchedule);
    await reconcileDisplays(hardwareIdToDisplayMap);

    const serverUrl = config.serverUrl || require('../config/constants').getServerUrl();

    if (serverUrl) {
        const { handleShowUrl } = require('../handlers/commands');
        const savedState = loadLastState();
        const screens = Array.from(hardwareIdToDisplayMap.keys());
        const serverAvailable = await pingServer();

        // resolveScreenTarget keys off networkState; set it before painting screens.
        context.networkState = serverAvailable
            ? 'ONLINE'
            : net.isOnline()
              ? 'NO_SERVER'
              : 'NO_INTERNET';
        log.info(`[NORMAL]: Server available: ${serverAvailable}`);

        screens.forEach((screenIndex, i) => {
            const screenData = savedState[String(screenIndex)];
            setTimeout(() => {
                if (screenData?.url && screenData.credentials) {
                    log.info(
                        `[PLAYER]: Screen ${screenIndex} has autologin content, restoring directly: ${screenData.url}`
                    );
                    handleShowUrl({
                        action: 'show_url',
                        screenIndex,
                        url: screenData.url,
                        credentials: screenData.credentials,
                        refreshInterval: screenData.refreshInterval || 0,
                        silent: true,
                    });
                } else {
                    const target = context.resolveScreenTarget(screenIndex);
                    log.info(
                        `[PLAYER]: Screen ${screenIndex} → local wrapper (${context.networkState}${target.url ? `: ${target.url}` : ': no content'})`
                    );
                    context.ensurePlayerScreen(screenIndex, target);
                }
            }, 500 * i);
        });

        setTimeout(
            () => rearmAutoRefreshTimers(context.managedWindows, context.autoRefreshTimers),
            500 * screens.length + 3000
        );
    } else {
        log.info('[NORMAL]: No server URL, using legacy content restore');
        restoreAllContent();
    }

    connectSocket(config.agentToken);
    initializeMonitors(context);

    const updateDelay =
        CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS +
        Math.random() * (CONSTANTS.UPDATE_CHECK_MAX_DELAY_MS - CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS);
    setTimeout(checkForUpdates, updateDelay);

    setInterval(sendHeartbeat, CONSTANTS.HEARTBEAT_INTERVAL_MS);

    setInterval(() => {
        if (managedWindows.size === 0) return;
        log.debug('[OPTIMIZATION]: Clearing DOM storage.');
        managedWindows.forEach((win) => {
            if (win?.isDestroyed()) return;
            win.webContents
                .executeJavaScript(
                    'try { localStorage.clear(); sessionStorage.clear(); } catch(e) {}'
                )
                .catch(() => {});
        });
    }, CONSTANTS.GC_INTERVAL_MS);

    setInterval(
        () => {
            const metrics = app.getAppMetrics();
            for (const [screenId, win] of managedWindows) {
                if (!win || win.isDestroyed()) continue;
                try {
                    const pid = win.webContents.getOSProcessId();
                    const metric = metrics.find((m) => m.pid === pid);
                    if (!metric) continue;
                    const memMB = metric.memory.privateBytes / (1024 * 1024);
                    log.debug(`[MEMORY]: Screen ${screenId}: ${memMB.toFixed(0)}MB`);
                    if (memMB > 800) {
                        log.warn(
                            `[MEMORY]: Screen ${screenId} exceeds 800MB — reloading renderer.`
                        );
                        win.webContents.reload();
                    }
                } catch (e) {
                    log.error(`[MEMORY]: Failed to check memory for screen ${screenId}:`, e);
                }
            }
        },
        60 * 60 * 1000
    );
};

const startProvisioningMode = (context) => {
    log.info('[INIT]: No configuration found. Entering provisioning mode.');
    return context.startProvisioningHandler({
        get socket() {
            return context.socket;
        },
    });
};

module.exports = { startNormalMode, startProvisioningMode };
