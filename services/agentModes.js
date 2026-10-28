const { log } = require('../utils/logConfig');
const { loadConfig } = require('../utils/configManager');
const { startTokenRefreshLoop } = require('./auth');
const { loadLastState, rearmAutoRefreshTimers } = require('./state');
const { reconcileDisplays } = require('./displaySlots');
const { checkForUpdates } = require('./updater');
const { initializeMonitors } = require('./monitors');
const { pingServer } = require('./network');
const { startMemoryWatchdog } = require('./memoryWatchdog');
const { net } = require('electron');

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

    // The startup refresh may have replaced it.
    connectSocket(context.agentToken);
    initializeMonitors(context);

    const updateDelay =
        CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS +
        Math.random() * (CONSTANTS.UPDATE_CHECK_MAX_DELAY_MS - CONSTANTS.UPDATE_CHECK_MIN_DELAY_MS);
    setTimeout(checkForUpdates, updateDelay);

    setInterval(sendHeartbeat, CONSTANTS.HEARTBEAT_INTERVAL_MS);
    startMemoryWatchdog(managedWindows);
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
