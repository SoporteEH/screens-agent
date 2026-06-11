/**
 * State Service
 * Manages display mapping and state persistence
 */

const { screen } = require('electron');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const { STATE_FILE_PATH } = require('../config/constants');
const { encryptCredentials, decryptCredentials } = require('../utils/configManager');

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

    log.info('[DISPLAY_MAP]: Display map updated:', Array.from(hardwareIdToDisplayMap.keys()));
}

// Loads last state from JSON file
// Credentials are stored encrypted; plain-object credentials (legacy) are decrypted in-memory
// and will be re-encrypted on the next saveCurrentState call.
function loadLastState() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8')) || {};
            const migratedState = {}; // in-memory view (credentials decrypted)
            const persistedState = {}; // on-disk view (credentials stay encrypted)
            let needsStructuralMigration = false;

            for (const [key, value] of Object.entries(state)) {
                if (typeof value === 'string') {
                    // Legacy format: bare URL string
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
                        // Encrypted format — decrypt in memory ONLY. The persisted copy
                        // keeps the encrypted string; writing the decrypted value back
                        // to disk would silently undo the encryption on every startup.
                        entry.credentials = decryptCredentials(entry.credentials);
                    }
                    // Plain object credentials are kept as-is (legacy, re-encrypted on next save)
                    migratedState[key] = entry;
                    persistedState[key] = value;
                }
            }

            // Only rewrite the file for the legacy string->object migration.
            if (needsStructuralMigration) {
                fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(persistedState, null, 2));
            }
            return migratedState;
        }
    } catch (error) {
        log.error('[STATE]: Error reading or parsing state file:', error);
    }
    return {};
}

/**
 * Reads state.json as-is without decrypting credentials.
 * Use when you only need to filter/write entries and don't need the credential values.
 */
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

/**
 * One-time startup migration: re-encrypts any plaintext credential objects left
 * in state.json by older agent versions (a historical bug wrote the decrypted
 * state back to disk). Idempotent — already-encrypted entries (strings) are
 * untouched, and entries are only rewritten when encryption actually succeeds,
 * so credentials are never lost if the hardware key is unavailable.
 */
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
            fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
            log.info(
                `[STATE]: Re-encrypted plaintext credentials for ${migrated} screen(s) in state.json`
            );
        }
    } catch (error) {
        log.error('[STATE]: Credential re-encryption migration failed:', error);
    }
}

/**
 * Clears state for displays that no longer exist.
 * Operates on raw (encrypted) state to avoid writing credentials in plaintext.
 * @param {Map} hardwareIdToDisplayMap
 */
function cleanOrphanedState(hardwareIdToDisplayMap) {
    const state = loadRawState();
    const validIds = Array.from(hardwareIdToDisplayMap.keys());
    const cleanedState = {};

    for (const [id, entry] of Object.entries(state)) {
        if (validIds.includes(id)) {
            cleanedState[id] = entry;
        } else {
            log.info(`[STATE]: Clearing orphaned entry for non-existent display: ${id}`);
        }
    }

    try {
        fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(cleanedState, null, 2));
    } catch (error) {
        log.error('[STATE]: Error cleaning orphaned state:', error);
    }

    // Return decrypted state for callers that need credential values
    return loadLastState();
}

/**
 * Configures an auto-refresh timer for a specific screen.
 * @param {string} screenIndex
 * @param {number} intervalSeconds - interval in seconds (e.g. 600 = 10 min)
 */
function setupAutoRefresh(screenIndex, intervalSeconds, managedWindows, autoRefreshTimers) {
    const intervalMs = intervalSeconds * 1000;
    const intervalMin = Math.round(intervalSeconds / 60);

    log.info(
        `[AUTO-REFRESH]: Setting up auto-refresh every ${intervalMin} minutes (${intervalSeconds}s) for screen ${screenIndex}`
    );

    const timerId = setInterval(() => {
        const win = managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) {
            log.info(`[AUTO-REFRESH]: Reloading screen ${screenIndex} (every ${intervalMin}min)`);
            win.webContents.reload();
        } else {
            // Window temporarily unavailable (offline mode, transition, etc.) — skip this cycle
            log.info(`[AUTO-REFRESH]: Window ${screenIndex} not available, skipping reload cycle`);
        }
    }, intervalMs);

    autoRefreshTimers.set(screenIndex, timerId);
}

// Write lock: prevents concurrent writes from corrupting state.json
// when multiple handleShowUrl calls arrive simultaneously
let writeLock = Promise.resolve();

/**
 * Saves the current state of a screen.
 * Serialized through writeLock to prevent race conditions.
 */
function saveCurrentState(
    screenIndex,
    url,
    credentials,
    refreshInterval,
    autoRefreshTimers,
    managedWindows
) {
    writeLock = writeLock
        .then(() =>
            _saveCurrentState(
                screenIndex,
                url,
                credentials,
                refreshInterval,
                autoRefreshTimers,
                managedWindows
            )
        )
        .catch(() => {});
    return writeLock;
}

function _saveCurrentState(
    screenIndex,
    url,
    credentials,
    refreshInterval,
    autoRefreshTimers,
    managedWindows
) {
    // Operate on the RAW state so the other screens' credentials stay encrypted
    // on disk. loadLastState() here would write every entry back decrypted.
    const state = loadRawState();

    if (autoRefreshTimers.has(screenIndex)) {
        clearInterval(autoRefreshTimers.get(screenIndex));
        autoRefreshTimers.delete(screenIndex);
        log.info(`[AUTO-REFRESH]: Timer cleared for screen ${screenIndex}`);
    }

    if (url) {
        const encryptedCredentials = credentials ? encryptCredentials(credentials) : null;
        state[screenIndex] = {
            url: url,
            credentials: encryptedCredentials ?? credentials ?? null,
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

    // Log screens/urls only — never the decrypted credentials.
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

                    const { buildLocalCarouselUrl } = require('./localCarousel');
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
    migrateStateEncryption,
    setupAutoRefresh,
    saveCurrentState,
    restoreLastState,
    restoreAllContentImmediately,
};
