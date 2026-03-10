/**
 * Agent Modes - Normal and Provisioning
 */

const { log } = require('../utils/logConfig');
const { loadConfig } = require('../utils/configManager');
const { startTokenRefreshLoop } = require('./auth');
const { buildDisplayMap, loadLastState } = require('./state');
const { checkForUpdates } = require('./updater');
const { initializeMonitors } = require('./monitors');
const { pingServer } = require('./network');
const { getCachedPlayerFileUrl, hasCachedPlayer, isServerDependentUrl } = require('./playerCache');
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
    await buildDisplayMap(hardwareIdToDisplayMap);

    const serverUrl = config.serverUrl || require('../config/constants').getServerUrl();

    if (serverUrl) {
        const { handleShowUrl, createContentWindow } = require('../handlers/commands');
        const savedState = loadLastState();
        const screens = Array.from(hardwareIdToDisplayMap.keys());
        const serverAvailable = await pingServer();

        log.info(`[NORMAL]: Server available: ${serverAvailable}`);

        const isAutologinUrl = (url) =>
            url &&
            (url.startsWith('https://lcr.sportradar.com') ||
                url.toLowerCase().includes('luckiatv') ||
                url.includes('luckia-tv'));

        screens.forEach((screenIndex, i) => {
            const screenData = savedState[String(screenIndex)];
            setTimeout(() => {
                if (isAutologinUrl(screenData?.url) && screenData.credentials) {
                    log.info(
                        `[PLAYER]: Screen ${screenIndex} has autologin URL, restoring directly: ${screenData.url}`
                    );
                    handleShowUrl({
                        action: 'show_url',
                        screenIndex,
                        url: screenData.url,
                        credentials: screenData.credentials,
                        refreshInterval: screenData.refreshInterval || 0,
                        silent: true,
                    });
                } else if (serverAvailable) {
                    const playerUrl = `${serverUrl}/player/${config.deviceId}/${screenIndex}`;
                    log.info(
                        `[PLAYER]: Loading player URL for screen ${screenIndex}: ${playerUrl}`
                    );
                    handleShowUrl({
                        action: 'show_url',
                        screenIndex,
                        url: playerUrl,
                        contentName: `Player ${screenIndex}`,
                        silent: true,
                    });
                } else {
                    const currentUrl = screenData?.url || '';
                    const hasInternet = net.isOnline();
                    const targetDisplay = hardwareIdToDisplayMap.get(screenIndex);

                    if (
                        currentUrl &&
                        !isServerDependentUrl(currentUrl, serverUrl) &&
                        hasInternet
                    ) {
                        log.info(
                            `[PLAYER]: Server offline but external URL available for screen ${screenIndex}: ${currentUrl}`
                        );
                        if (targetDisplay) {
                            createContentWindow(targetDisplay, currentUrl, {
                                action: 'show_url',
                                screenIndex,
                                url: currentUrl,
                                credentials: screenData.credentials || null,
                                refreshInterval: screenData.refreshInterval || 0,
                                contentName: `Screen ${screenIndex} (direct)`,
                                silent: true,
                            });
                        }
                    } else if (hasCachedPlayer(screenIndex) || currentUrl) {
                        const offlineUrl = getCachedPlayerFileUrl(
                            screenIndex,
                            currentUrl,
                            serverUrl
                        );
                        log.info(
                            `[PLAYER]: Server offline. Loading cached player for screen ${screenIndex} (content: ${currentUrl || 'none'})`
                        );
                        if (targetDisplay) {
                            createContentWindow(targetDisplay, offlineUrl, {
                                action: 'show_url',
                                screenIndex,
                                url: currentUrl || `${serverUrl}/player/${config.deviceId}/${screenIndex}`,
                                contentName: `Player ${screenIndex} (offline)`,
                                silent: true,
                            });
                        }
                    } else {
                        log.info(
                            `[PLAYER]: Server offline, no cache for screen ${screenIndex}. Showing fallback.`
                        );
                        if (targetDisplay) {
                            const fallbackPath = `file://${require('path').join(__dirname, '../fallback.html')}`;
                            createContentWindow(targetDisplay, fallbackPath, {
                                action: 'show_url',
                                screenIndex,
                                url: '',
                                contentName: `Player ${screenIndex} (fallback)`,
                                silent: true,
                            });
                        }
                    }
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
        log.info('[OPTIMIZATION]: Clearing HTTP cache (preserving storageData).');
        managedWindows.forEach((win) => {
            if (win?.isDestroyed()) return;
            win.webContents.session.clearCache().catch(() => { });
        });
    }, CONSTANTS.GC_INTERVAL_MS);
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