/**
 * Display & Network Monitors
 */

const { screen } = require('electron');
const { log } = require('../utils/logConfig');
const { startNetworkMonitoring } = require('./network');
const { reconcileDisplays } = require('./displaySlots');
const { loadLastState } = require('./state');

let screenChangeTimeout;

const initializeMonitors = (context) => {
    const onScreenChange = (reason) => {
        const {
            hardwareIdToDisplayMap,
            managedWindows,
            identifyWindows,
            handleShowUrl,
            socket,
            registerDevice,
            CONSTANTS,
        } = context;

        if (screenChangeTimeout) clearTimeout(screenChangeTimeout);
        log.info(`[DISPLAY]: Change detected (${reason})`);

        screenChangeTimeout = setTimeout(async () => {
            log.info('[DISPLAY]: Reconciling display slots.');

            // Branch on the computed slot diff, never on `reason`: a cable
            // flicker can collapse removed+added into one debounced run.
            const result = await reconcileDisplays(hardwareIdToDisplayMap);
            const currentIds = result.boundSlotIds;

            for (const id of result.newlyUnbound) {
                log.info(
                    `[DISPLAY]: Slot ${id} disconnected. Closing its window (saved state is kept).`
                );
                const win = managedWindows.get(id);
                if (win && !win.isDestroyed()) win.close();
                managedWindows.delete(id);

                const identifyWin = identifyWindows?.get(id);
                if (identifyWin && !identifyWin.isDestroyed()) identifyWin.destroy();
                identifyWindows?.delete(id);
            }

            if (result.newlyBound.length > 0) {
                log.info(`[DISPLAY]: Slots reconnected: ${result.newlyBound.join(', ')}`);
                const { loadConfig } = require('../utils/configManager');
                const config = loadConfig();
                const serverUrl =
                    config.serverUrl || require('../config/constants').getServerUrl();
                const lastState = loadLastState();

                for (const id of result.newlyBound) {
                    const screenData = lastState[id];
                    setTimeout(() => {
                        if (screenData?.url) {
                            log.info(`[DISPLAY]: Restoring slot ${id}: ${screenData.url}`);
                            handleShowUrl({
                                action: 'show_url',
                                screenIndex: id,
                                url: screenData.url,
                                credentials: screenData.credentials || null,
                                refreshInterval: screenData.refreshInterval || 0,
                                silent: true,
                            });
                        } else if (serverUrl && config.deviceId) {
                            // No local state (e.g. content pinned while the monitor
                            // was off): the player wrapper picks it up from the server.
                            const playerUrl = `${serverUrl}/player/${config.deviceId}/${id}`;
                            log.info(`[DISPLAY]: Loading player URL for slot ${id}`);
                            handleShowUrl({
                                action: 'show_url',
                                screenIndex: id,
                                url: playerUrl,
                                contentName: `Player ${id}`,
                                silent: true,
                            });
                        }
                        context.screenModes?.set(String(id), 'live');
                    }, 500);
                }
            }

            // Ensure existing windows are correctly positioned
            for (const id of currentIds) {
                const win = managedWindows.get(id);
                if (win && !win.isDestroyed()) {
                    const display = hardwareIdToDisplayMap.get(id);
                    if (display) {
                        const currentBounds = win.getBounds();
                        const targetBounds = display.bounds;
                        
                        // Check if bounds mismatch
                        if (currentBounds.x !== targetBounds.x || 
                            currentBounds.y !== targetBounds.y || 
                            currentBounds.width !== targetBounds.width || 
                            currentBounds.height !== targetBounds.height) {
                            
                            log.info(`[DISPLAY]: Restoring bounds for screen ${id} to x:${targetBounds.x} y:${targetBounds.y}`);
                            win.setBounds(targetBounds);
                        }
                        
                        // Force window to show and focus
                        if (!win.isVisible()) win.show();
                        win.setAlwaysOnTop(true, 'screen-saver');
                        win.setAlwaysOnTop(false);
                    }
                }
            }

            if (socket?.connected) registerDevice();
        }, CONSTANTS.SCREEN_DEBOUNCE_MS);
    };

    screen.on('display-added', () => onScreenChange('added'));
    screen.on('display-removed', () => onScreenChange('removed'));
    screen.on('display-metrics-changed', () => onScreenChange('metrics-changed'));

    startNetworkMonitoring({
        onOffline: (reason) => context.onNetworkOffline(reason),
        onOnline: () => context.onNetworkOnline(),
        onCheckOnline: () => {
            if (context.socket && !context.socket.connected) {
                log.info('[NETWORK]: Socket disconnected. Reconnecting...');
                context.socket.connect();
            }
        },
    });
};

module.exports = { initializeMonitors };
