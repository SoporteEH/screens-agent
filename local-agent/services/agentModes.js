/**
 * Agent Modes - Normal y Provisioning
 */

const { log } = require('../utils/logConfig');
const { loadConfig } = require('../utils/configManager');
const { startTokenRefreshLoop } = require('./auth');
const { buildDisplayMap } = require('./state');
const { checkForUpdates } = require('./updater');
const { initializeMonitors } = require('./monitors');

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
    await buildDisplayMap(hardwareIdToDisplayMap);
    restoreAllContent();
    connectSocket(config.agentToken);
    initializeMonitors(context);

    const updateDelay =
        CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS +
        Math.random() * (CONSTANTS.UPDATE_CHECK_MAX_DELAY_MS - CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS);
    setTimeout(checkForUpdates, updateDelay);

    setInterval(sendHeartbeat, CONSTANTS.HEARTBEAT_INTERVAL_MS);

    setInterval(() => {
        if (managedWindows.size === 0) return;
        log.info('[OPTIMIZATION]: Limpiando caché.');
        managedWindows.forEach((win) => {
            if (win?.isDestroyed()) return;
            win.webContents.session.clearCache().catch(() => {});
            win.webContents.session.clearStorageData().catch(() => {});
        });
    }, CONSTANTS.GC_INTERVAL_MS);
};

const startProvisioningMode = (context) => {
    log.info('[INIT]: Sin configuración. Modo vinculación.');
    return context.startProvisioningHandler({
        get socket() {
            return context.socket;
        },
    });
};

module.exports = { startNormalMode, startProvisioningMode };
