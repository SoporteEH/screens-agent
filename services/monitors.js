/**
 * Display & Network Monitors
 */

const { screen } = require('electron');
const { log } = require('../utils/logConfig');
const { startNetworkMonitoring } = require('./network');
const { buildDisplayMap, loadLastState } = require('./state');

let screenChangeTimeout;

const initializeMonitors = (context) => {
    const onScreenChange = (reason) => {
        const {
            hardwareIdToDisplayMap,
            managedWindows,
            handleShowUrl,
            socket,
            registerDevice,
            CONSTANTS,
        } = context;

        if (screenChangeTimeout) clearTimeout(screenChangeTimeout);
        log.info(`[DISPLAY]: Change detected (${reason})`);

        screenChangeTimeout = setTimeout(async () => {
            log.info('[DISPLAY]: Updating display map.');

            const previousIds = Array.from(hardwareIdToDisplayMap.keys());
            await buildDisplayMap(hardwareIdToDisplayMap);
            const currentIds = Array.from(hardwareIdToDisplayMap.keys());

            if (reason === 'removed') {
                const orphanedIds = previousIds.filter((id) => !currentIds.includes(id));
                for (const id of orphanedIds) {
                    const win = managedWindows.get(id);
                    if (win && !win.isDestroyed()) {
                        log.info(`[DISPLAY]: Closing orphaned window: ${id}`);
                        win.close();
                    }
                    managedWindows.delete(id);
                }
            }

            if (reason === 'added') {
                const newIds = currentIds.filter((id) => !previousIds.includes(id));
                if (newIds.length > 0) {
                    log.info(`[DISPLAY]: New displays: ${newIds.join(', ')}`);
                    const lastState = loadLastState();
                    for (const id of newIds) {
                        if (lastState[id]) {
                            log.info(`[DISPLAY]: Restoring ${id}: ${lastState[id].url}`);
                            setTimeout(() => {
                                handleShowUrl({
                                    action: 'show_url',
                                    screenIndex: id,
                                    url: lastState[id].url,
                                    credentials: lastState[id].credentials || null,
                                });
                            }, 500);
                        }
                    }
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
