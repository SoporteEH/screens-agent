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

    const serverUrl = config.serverUrl || require('../config/constants').getServerUrl();

    if (serverUrl) {
        // Player Mode: load server-rendered player page per screen
        // Exception: if a screen has a saved autologin URL (sportradar/luckiatv), restore it directly
        const { handleShowUrl } = require('../handlers/commands');
        const { loadLastState } = require('./state');
        const savedState = loadLastState();
        const screens = Array.from(hardwareIdToDisplayMap.keys());

        const isAutologinUrl = (url) => url && (
            url.startsWith('https://lcr.sportradar.com') ||
            url.toLowerCase().includes('luckiatv') ||
            url.includes('luckia-tv')
        );

        screens.forEach((screenIndex, i) => {
            const screenData = savedState[String(screenIndex)];
            setTimeout(() => {
                if (isAutologinUrl(screenData?.url) && screenData.credentials) {
                    log.info(`[PLAYER]: Screen ${screenIndex} has autologin URL, restoring directly: ${screenData.url}`);
                    handleShowUrl({
                        action: 'show_url',
                        screenIndex,
                        url: screenData.url,
                        credentials: screenData.credentials,
                        refreshInterval: screenData.refreshInterval || 0,
                        silent: true,
                    });
                } else {
                    const playerUrl = `${serverUrl}/player/${config.deviceId}/${screenIndex}`;
                    log.info(`[PLAYER]: Loading player URL for screen ${screenIndex}: ${playerUrl}`);
                    handleShowUrl({
                        action: 'show_url',
                        screenIndex,
                        url: playerUrl,
                        contentName: `Player ${screenIndex}`,
                        silent: true,
                    });
                }
            }, 500 * i);
        });
    } else {
        // Fallback: legacy restore
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
        log.info('[OPTIMIZATION]: Limpiando cache.');
        managedWindows.forEach((win) => {
            if (win?.isDestroyed()) return;
            win.webContents.session.clearCache().catch(() => { });
            win.webContents.session.clearStorageData().catch(() => { });
        });
    }, CONSTANTS.GC_INTERVAL_MS);
};

const startProvisioningMode = (context) => {
    log.info('[INIT]: Sin configuracion. Modo vinculacion.');
    return context.startProvisioningHandler({
        get socket() {
            return context.socket;
        },
    });
};

module.exports = { startNormalMode, startProvisioningMode };
