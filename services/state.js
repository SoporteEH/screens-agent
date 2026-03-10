/**
 * State Service
 * Manages display mapping and state persistence
 */

const { screen } = require('electron');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const { STATE_FILE_PATH } = require('../config/constants');

// Builds display map ordered by position
async function buildDisplayMap(hardwareIdToDisplayMap) {
    hardwareIdToDisplayMap.clear();
    const displays = screen.getAllDisplays();

    // Orders displays by X position (left to right)
    displays.sort((a, b) => a.bounds.x - b.bounds.x);

    displays.forEach((display, index) => {
        const simpleId = String(index + 1);
        hardwareIdToDisplayMap.set(simpleId, display);
    });

    log.info(
        '[DISPLAY_MAP]: Display map updated:',
        Array.from(hardwareIdToDisplayMap.keys())
    );
}

// Loads last state from JSON file
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8')) || {};
            const migratedState = {};
            for (const [key, value] of Object.entries(state)) {
                if (typeof value === 'string') {
                    migratedState[key] = {
                        url: value,
                        credentials: null,
                        timestamp: new Date().toISOString(),
                    };
                } else {
                    migratedState[key] = value;
                }
            }
            if (JSON.stringify(state) !== JSON.stringify(migratedState)) {
                fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(migratedState, null, 2));
            }
            return migratedState;
        }
    } catch (error) {
        log.error('[STATE]: Error reading or parsing state file:', error);
    }
    return {};
}

/**
 * Clears state for displays that no longer exist.
 * @param {Map} hardwareIdToDisplayMap
 */
function cleanOrphanedState(hardwareIdToDisplayMap) {
    const state = loadLastState();
    const validIds = Array.from(hardwareIdToDisplayMap.keys());
    const cleanedState = {};

    for (const [id, url] of Object.entries(state)) {
        if (validIds.includes(id)) {
            cleanedState[id] = url;
        } else {
            log.info(`[STATE]: Clearing orphaned entry for non-existent display: ${id}`);
        }
    }

    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(cleanedState, null, 2));
    } catch (error) {
        log.error('[STATE]: Error cleaning orphaned state:', error);
    }

    return cleanedState;
}

/**
 * Configures an auto-refresh timer for a specific screen.
 */
function setupAutoRefresh(screenIndex, intervalMinutes, managedWindows, autoRefreshTimers) {
    const intervalMs = intervalMinutes * 60 * 1000;

    log.info(
        `[AUTO-REFRESH]: Setting up auto-refresh every ${intervalMinutes} minutes for screen ${screenIndex}`
    );

    const timerId = setInterval(() => {
        const win = managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) {
            log.info(
                `[AUTO-REFRESH]: Reloading screen ${screenIndex} (scheduled every ${intervalMinutes}min)`
            );
            win.webContents.reload();
        } else {
            log.info(`[AUTO-REFRESH]: Window ${screenIndex} does not exist, clearing timer`);
            clearInterval(timerId);
            autoRefreshTimers.delete(screenIndex);
        }
    }, intervalMs);

    autoRefreshTimers.set(screenIndex, timerId);
}

/**
 * Saves the current state of a screen.
 */
function saveCurrentState(
    screenIndex,
    url,
    credentials,
    refreshInterval,
    autoRefreshTimers,
    managedWindows
) {
    const state = loadLastState();

    if (autoRefreshTimers.has(screenIndex)) {
        clearInterval(autoRefreshTimers.get(screenIndex));
        autoRefreshTimers.delete(screenIndex);
        log.info(`[AUTO-REFRESH]: Timer cleared for screen ${screenIndex}`);
    }

    if (url) {
        state[screenIndex] = {
            url: url,
            credentials: credentials || null,
            refreshInterval: refreshInterval || 0,
            timestamp: new Date().toISOString(),
        };

        if (refreshInterval > 0) {
            setupAutoRefresh(screenIndex, refreshInterval, managedWindows, autoRefreshTimers);
        }
    } else {
        delete state[screenIndex];
    }

    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
        log.info(
            `[STATE]: State saved for screen ${screenIndex}: ${url || '(empty)'}${refreshInterval ? ` (auto-refresh: ${refreshInterval}min)` : ''}`
        );
    } catch (error) {
        log.error('[STATE]: Error saving state:', error);
    }
}

const { net } = require('electron');
const path = require('path');

/**
 * Restores saved URLs.
 */
function restoreLastState(hardwareIdToDisplayMap, handleShowUrlCallback) {
    log.info('[STATE]: Initiating state restoration...');
    const lastState = cleanOrphanedState(hardwareIdToDisplayMap);

    if (Object.keys(lastState).length === 0) {
        log.info('[STATE]: No previous state found to restore (file empty or non-existent).');
        return;
    }

    log.info('[STATE]: Restoring last known state:', JSON.stringify(lastState, null, 2));

    let restoredCount = 0;
    for (const [stableId, screenData] of Object.entries(lastState)) {
        if (hardwareIdToDisplayMap.has(stableId)) {
            log.info(
                `[STATE]: Restoring screen ${stableId} with URL: ${screenData.url}${screenData.refreshInterval ? ` (auto-refresh: ${screenData.refreshInterval}min)` : ''}`
            );
            const command = {
                action: 'show_url',
                screenIndex: stableId,
                url: screenData.url,
                credentials: screenData.credentials || null,
                refreshInterval: screenData.refreshInterval || 0,
            };

            setTimeout(() => {
                handleShowUrlCallback(command);
            }, 500 * restoredCount);
            restoredCount++;
        }
    }

    log.info(`[STATE]: Restoration completed. ${restoredCount} screens restored.`);
}

/**
 * Restores ALL content immediately without server dependency.
 * Runs at startup to ensure screens display content even if 
 * the server is unavailable.
 */
function restoreAllContentImmediately(
    hardwareIdToDisplayMap,
    managedWindows,
    handleShowUrl,
    createContentWindow
) {
    const lastState = loadLastState();
    if (Object.keys(lastState).length === 0) {
        log.info('[STARTUP]: No previous state found to restore.');
        return;
    }

    const hasInternet = net.isOnline();
    log.info(`[STARTUP]: Restoring content (Internet: ${hasInternet ? 'YES' : 'NO'})...`);

    const fallbackPath = `file://${path.join(__dirname, '../fallback.html')}`;
    let restoredCount = 0;

    for (const [stableId, screenData] of Object.entries(lastState)) {
        if (screenData.url && hardwareIdToDisplayMap.has(stableId)) {
            const isLocalContent = screenData.url.startsWith('local:');
            const targetDisplay = hardwareIdToDisplayMap.get(stableId);

            if (!hasInternet && !isLocalContent) {
                // No internet and remote content: create window directly with fallback
                log.info(
                    `[STARTUP]: No internet - creating fallback window on display ${stableId}`
                );

                setTimeout(() => {
                    const existingWin = managedWindows.get(stableId);
                    if (existingWin && !existingWin.isDestroyed()) {
                        existingWin.close();
                    }

                    const command = {
                        action: 'show_url',
                        screenIndex: stableId,
                        url: screenData.url,
                        credentials: screenData.credentials || null,
                        refreshInterval: screenData.refreshInterval || 0,
                    };

                    createContentWindow(targetDisplay, fallbackPath, command);
                }, 500 * restoredCount);
            } else {
                log.info(`[STARTUP]: Restoring screen ${stableId}: ${screenData.url}`);

                setTimeout(() => {
                    handleShowUrl({
                        action: 'show_url',
                        screenIndex: stableId,
                        url: screenData.url,
                        credentials: screenData.credentials || null,
                        refreshInterval: screenData.refreshInterval || 0,
                    });
                }, 500 * restoredCount);
            }
            restoredCount++;
        }
    }
    log.info(`[STARTUP]: ${restoredCount} screens processed.`);
}

module.exports = {
    buildDisplayMap,
    loadLastState,
    cleanOrphanedState,
    setupAutoRefresh,
    saveCurrentState,
    restoreLastState,
    restoreAllContentImmediately,
};
