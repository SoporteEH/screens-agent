const fs = require('fs');
const path = require('path');
const { net } = require('electron');
const { log } = require('../utils/logConfig');
const { STATE_FILE_PATH } = require('../config/constants');
const { encryptCredentials, decryptCredentials } = require('../utils/configManager');
const { writeFileAtomic } = require('../utils/atomicWrite');
const { isWrapperUrl } = require('../utils/wrapperUrl');
const { loadSlots } = require('./displaySlots');
const { buildLocalCarouselUrl } = require('./localCarousel');

// Credentials are stored encrypted and come back decrypted.
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8')) || {};
            const migratedState = {};
            const persistedState = {};
            let needsStructuralMigration = false;

            for (const [key, value] of Object.entries(state)) {
                if (typeof value === 'string') {
                    const migrated = {
                        url: value,
                        credentials: null,
                        timestamp: new Date().toISOString(),
                    };
                    migratedState[key] = migrated;
                    persistedState[key] = migrated;
                    needsStructuralMigration = true;
                } else {
                    const entry = { ...value };
                    if (typeof entry.credentials === 'string') {
                        entry.credentials = decryptCredentials(entry.credentials);
                    }
                    migratedState[key] = entry;
                    persistedState[key] = value;
                }
            }

            // Only rewrite the file for the legacy string->object migration.
            if (needsStructuralMigration) {
                writeFileAtomic(STATE_FILE_PATH, JSON.stringify(persistedState, null, 2));
            }
            return migratedState;
        }
    } catch (error) {
        log.error('[STATE]: Error reading or parsing state file:', error);
    }
    return {};
}

// Raw (still-encrypted) read — use when you don't need credential values.
function loadRawState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            return JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8')) || {};
        }
    } catch (error) {
        log.error('[STATE]: Error reading raw state file:', error);
    }
    return {};
}

// Re-encrypts plaintext credentials in state.json; idempotent
function migrateStateEncryption() {
    try {
        const state = loadRawState();
        let migrated = 0;

        for (const entry of Object.values(state)) {
            if (
                entry &&
                typeof entry === 'object' &&
                entry.credentials &&
                typeof entry.credentials === 'object'
            ) {
                const encrypted = encryptCredentials(entry.credentials);
                if (encrypted) {
                    entry.credentials = encrypted;
                    migrated++;
                }
            }
        }

        if (migrated > 0) {
            writeFileAtomic(STATE_FILE_PATH, JSON.stringify(state, null, 2));
            log.info(
                `[STATE]: Re-encrypted plaintext credentials for ${migrated} screen(s) in state.json`
            );
        }
    } catch (error) {
        log.error('[STATE]: Credential re-encryption migration failed:', error);
    }
}

// Drops the entries of slots that are no longer in the slot map.
function cleanOrphanedState(validSlotIds) {
    const state = loadRawState();
    const cleanedState = {};

    for (const [id, entry] of Object.entries(state)) {
        if (validSlotIds.includes(id)) {
            cleanedState[id] = entry;
        } else {
            log.info(`[STATE]: Clearing orphaned entry for removed slot: ${id}`);
        }
    }

    try {
        writeFileAtomic(STATE_FILE_PATH, JSON.stringify(cleanedState, null, 2));
    } catch (error) {
        log.error('[STATE]: Error cleaning orphaned state:', error);
    }

    return loadLastState();
}

function clearAllState() {
    try {
        writeFileAtomic(STATE_FILE_PATH, JSON.stringify({}));
        log.info('[STATE]: All screen state cleared.');
    } catch (error) {
        log.error('[STATE]: Error clearing state file:', error);
    }
}

function setupAutoRefresh(screenIndex, intervalSeconds, managedWindows, autoRefreshTimers) {
    const intervalMs = intervalSeconds * 1000 + Math.floor(Math.random() * 15000);
    const intervalMin = Math.round(intervalSeconds / 60);

    log.debug(
        `[AUTO-REFRESH]: Setting up auto-refresh every ${intervalMin} minutes (${intervalSeconds}s) for screen ${screenIndex}`
    );

    const timerId = setInterval(() => {
        const win = managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) {
            log.debug(`[AUTO-REFRESH]: Reloading screen ${screenIndex} (every ${intervalMin}min)`);
            if (isWrapperUrl(win.webContents.getURL())) {
                // Refresh the content frame, not the wrapper: no black flash.
                win.webContents.send('player:refresh');
            } else {
                win.webContents.reload();
            }
        } else {
            log.debug(`[AUTO-REFRESH]: Window ${screenIndex} not available, skipping reload cycle`);
        }
    }, intervalMs);

    autoRefreshTimers.set(screenIndex, timerId);
}

// state.json is the only record of refreshInterval
function rearmAutoRefreshTimers(managedWindows, autoRefreshTimers) {
    for (const [screenId, screenData] of Object.entries(loadLastState())) {
        const interval = screenData.refreshInterval || 0;
        if (interval <= 0 || autoRefreshTimers.has(screenId)) continue;

        const win = managedWindows.get(screenId);
        if (!win || win.isDestroyed()) continue;

        log.info(`[AUTO-REFRESH]: Re-arming timer for screen ${screenId} (${interval}s)`);
        setupAutoRefresh(screenId, interval, managedWindows, autoRefreshTimers);
    }
}

// Serializes writes to state.json
let writeLock = Promise.resolve();

// `playlist` is the manifest of a `playlist:` URL: state.json is what plays it after a reboot
// with the API down.
function saveCurrentState(
    screenIndex,
    url,
    credentials,
    refreshInterval,
    autoRefreshTimers,
    managedWindows,
    playlist = null
) {
    writeLock = writeLock
        .then(() =>
            _saveCurrentState(
                screenIndex,
                url,
                credentials,
                refreshInterval,
                autoRefreshTimers,
                managedWindows,
                playlist
            )
        )
        // A failed write (already logged) must not block the ones queued after it.
        .catch(() => {});
    return writeLock;
}

function _saveCurrentState(
    screenIndex,
    url,
    credentials,
    refreshInterval,
    autoRefreshTimers,
    managedWindows,
    playlist
) {
    const state = loadRawState();

    if (autoRefreshTimers.has(screenIndex)) {
        clearInterval(autoRefreshTimers.get(screenIndex));
        autoRefreshTimers.delete(screenIndex);
        log.debug(`[AUTO-REFRESH]: Timer cleared for screen ${screenIndex}`);
    }

    if (url) {
        const encryptedCredentials = credentials ? encryptCredentials(credentials) : null;
        state[screenIndex] = {
            url,
            credentials: encryptedCredentials ?? credentials ?? null,
            refreshInterval: refreshInterval || 0,
            ...(playlist ? { playlist } : {}),
            timestamp: new Date().toISOString(),
        };

        if (refreshInterval > 0) {
            setupAutoRefresh(screenIndex, refreshInterval, managedWindows, autoRefreshTimers);
        }
    } else {
        delete state[screenIndex];
    }

    try {
        writeFileAtomic(STATE_FILE_PATH, JSON.stringify(state, null, 2));
        log.debug(
            `[STATE]: State saved for screen ${screenIndex}: ${url || '(empty)'}${refreshInterval ? ` (auto-refresh: ${refreshInterval}s)` : ''}`
        );
    } catch (error) {
        log.error('[STATE]: Error saving state:', error);
    }
}

function restoreLastState(hardwareIdToDisplayMap, handleShowUrlCallback) {
    log.info('[STATE]: Initiating state restoration...');
    const lastState = cleanOrphanedState(Object.keys(loadSlots()));

    if (Object.keys(lastState).length === 0) {
        log.info('[STATE]: No previous state found to restore (file empty or non-existent).');
        return;
    }

    // Screens and URLs only: never the decrypted credentials.
    log.info(
        '[STATE]: Restoring last known state:',
        JSON.stringify(
            Object.fromEntries(
                Object.entries(lastState).map(([id, s]) => [
                    id,
                    {
                        url: s.url,
                        hasCredentials: !!s.credentials,
                        refreshInterval: s.refreshInterval || 0,
                    },
                ])
            )
        )
    );

    let restoredCount = 0;
    for (const [stableId, screenData] of Object.entries(lastState)) {
        if (hardwareIdToDisplayMap.has(stableId)) {
            log.info(
                `[STATE]: Restoring screen ${stableId} with URL: ${screenData.url}${screenData.refreshInterval ? ` (auto-refresh: ${screenData.refreshInterval}s)` : ''}`
            );
            const command = {
                action: 'show_url',
                screenIndex: stableId,
                url: screenData.url,
                credentials: screenData.credentials || null,
                refreshInterval: screenData.refreshInterval || 0,
                playlist: screenData.playlist || null,
                silent: true,
            };

            setTimeout(() => {
                handleShowUrlCallback(command);
            }, 500 * restoredCount);
            restoredCount++;
        }
    }

    log.info(`[STATE]: Restoration completed. ${restoredCount} screens restored.`);
}

// Restores content at startup without depending on the server being reachable.
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
            // A playlist plays its local files offline; only its web items wait for the network.
            const isLocalContent =
                screenData.url.startsWith('local:') || screenData.url.startsWith('playlist:');
            const targetDisplay = hardwareIdToDisplayMap.get(stableId);

            if (!hasInternet && !isLocalContent) {
                log.info(
                    `[STARTUP]: No internet - attempting local carousel fallback on display ${stableId}`
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

                    const carouselUrl = buildLocalCarouselUrl();
                    const pathToLoad = carouselUrl || fallbackPath;

                    createContentWindow(targetDisplay, pathToLoad, command);
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
                        playlist: screenData.playlist || null,
                        silent: true,
                    });
                }, 500 * restoredCount);
            }
            restoredCount++;
        }
    }
    log.info(`[STARTUP]: ${restoredCount} screens processed.`);
}

module.exports = {
    loadLastState,
    clearAllState,
    migrateStateEncryption,
    rearmAutoRefreshTimers,
    saveCurrentState,
    restoreLastState,
    restoreAllContentImmediately,
};
