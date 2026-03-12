const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const axios = require('axios');
const { CONTENT_DIR } = require('../config/constants');
const { cachePlayerHTML, cacheContentURL } = require('../services/playerCache');

let context = {};

// Initializes handlers with global context
function initializeHandlers(ctx) {
    context = ctx;
}

// Sends command feedback to the server
function sendCommandFeedback(command, status, message) {
    if (!command || !command.commandId) return;
    if (command.silent) return;

    if (context.socket && context.socket.connected) {
        context.socket.emit('command-feedback', {
            deviceId: context.deviceId,
            commandId: command.commandId,
            action: command.action,
            status,
            message,
        });
        log.info(`[FEEDBACK]: Sending feedback for commandId ${command.commandId}: ${status}`);
    }
}

// Schedules retry with exponential backoff
const MAX_RETRY_DELAY_MS = 2 * 60 * 1000;

function scheduleRetry(command) {
    const { screenIndex } = command;
    const attempt = (context.retryManager.get(screenIndex)?.attempt || 0) + 1;

    const delayMs = Math.min(Math.pow(2, attempt - 1) * 30 * 1000, MAX_RETRY_DELAY_MS);
    log.info(
        `[RETRY]: Scheduling retry #${attempt} for screen ${screenIndex} in ${delayMs / 1000} seconds.`
    );

    const timerId = setTimeout(() => {
        log.info(`[RETRY]: Executing retry #${attempt} for screen ${screenIndex}...`);
        handleShowUrl(command, attempt);
    }, delayMs);

    context.retryManager.set(screenIndex, { attempt, timerId });
}

/**
 * Creates a content window optimized for digital signage.
 */
function createContentWindow(display, urlToLoad, command) {
    const { screenIndex, url: originalUrl, contentName } = command;
    const fallbackPath = `file://${path.join(__dirname, '../fallback.html')}`;

    log.info(
        `[COMMAND]: Creating window on screen ${screenIndex} (${display.bounds.width}x${display.bounds.height})`
    );

    const win = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        fullscreen: true,
        kiosk: true,
        frame: false,
        show: false,
        backgroundColor: '#000000',
        paintWhenInitiallyHidden: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            nodeIntegrationInSubFrames: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            backgroundThrottling: true,
            devTools: false,
            spellcheck: false,
            enableWebSQL: false,
            navigateOnDragDrop: false,
            autoplayPolicy: 'no-user-gesture-required',
        },
    });

    win.webContents.setZoomFactor(1);
    win.webContents.setVisualZoomLevelLimits(1, 1);

    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const responseHeaders = Object.keys(details.responseHeaders).reduce((acc, key) => {
            const lowerKey = key.toLowerCase();
            if (lowerKey === 'x-frame-options' || lowerKey === 'frame-options') {
                return acc;
            }
            if (lowerKey === 'content-security-policy') {
                let cspMatch = details.responseHeaders[key][0];
                cspMatch = cspMatch.replace(/frame-ancestors[^;]+;?/gi, '');
                acc[key] = [cspMatch];
                return acc;
            }
            acc[key] = details.responseHeaders[key];
            return acc;
        }, {});

        callback({ cancel: false, responseHeaders });
    });

    win.once('ready-to-show', () => win.show());

    // Fallback timer to ensure window visibility
    setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 2000);

    win.webContents.on('did-finish-load', () => {
        const loadedUrl = win.webContents.getURL();
        if (loadedUrl.includes('/player/') && screenIndex) {
            win.webContents
                .executeJavaScript('document.documentElement.outerHTML')
                .then((html) => cachePlayerHTML(screenIndex, html))
                .catch(() => { });
            if (context.retryManager.has(screenIndex)) {
                clearTimeout(context.retryManager.get(screenIndex).timerId);
                context.retryManager.delete(screenIndex);
            }
        }
    });

    win.webContents.on(
        'did-fail-load',
        (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (!isMainFrame) return;

            log.error(
                `[RESILIENCE]: Failed to load URL '${validatedURL}'. Reason: ${errorDescription}`
            );

            if (validatedURL === fallbackPath) return;

            if (command.commandId) {
                const displayName = contentName ? `'${contentName}'` : `URL '${originalUrl}'`;
                sendCommandFeedback(
                    command,
                    'error',
                    `Failed to load ${displayName}. Reason: ${errorDescription}`
                );
            }

            const isNetworkError = errorCode <= -100 && errorCode >= -199;
            if (!originalUrl.startsWith('local:') && isNetworkError) {
                scheduleRetry(command);
            }
            win.loadURL(fallbackPath);
        }
    );

    const windowSession = win.webContents.session;
    win.on('closed', () => {
        context.managedWindows.delete(screenIndex);
        if (context.retryManager.has(screenIndex)) {
            clearTimeout(context.retryManager.get(screenIndex).timerId);
            context.retryManager.delete(screenIndex);
        }
        if (windowSession) {
            windowSession.clearCache().catch(() => { });
            windowSession.clearStorageData().catch(() => { });
        }
    });

    win.loadURL(urlToLoad);
    context.managedWindows.set(screenIndex, win);
    return win;
}

/**
 * Handles 'show_url' command.
 */
function handleShowUrl(command, _currentAttempt = 0) {
    const { screenIndex, url, credentials, contentName, refreshInterval } = command;

    if (!url || !url.trim()) {
        log.error(`[COMMAND]: Empty URL received for screen ${screenIndex}. Ignoring.`);
        sendCommandFeedback(command, 'error', `Empty URL, cannot load`);
        return;
    }
    if (context.retryManager.has(screenIndex)) {
        clearTimeout(context.retryManager.get(screenIndex).timerId);
        context.retryManager.delete(screenIndex);
    }

    const targetDisplay = context.hardwareIdToDisplayMap.get(screenIndex);
    if (!targetDisplay) {
        sendCommandFeedback(
            command,
            'error',
            `Display with hardware ID '${screenIndex}' not found.`
        );
        return;
    }

    const isPlayerWrapperUrl = url.includes('/player/');
    if (context.saveCurrentState && !isPlayerWrapperUrl) {
        context.saveCurrentState(
            screenIndex,
            url,
            credentials,
            refreshInterval || 0,
            context.autoRefreshTimers,
            context.managedWindows
        );
    }

    const { net } = require('electron');
    const hasInternet = net.isOnline();

    if (!hasInternet && !url.startsWith('local:')) {
        const errorMsg = `Error: No connection. Cannot load URL '${url}'. Will retry when connection is restored.`;
        log.error(`[RESILIENCE]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
        scheduleRetry(command);
        return;
    }

    let finalUrl = url;

    // PLAYER MODE CHECK
    const { loadConfig } = require('../utils/configManager');
    const { getServerUrl } = require('../config/constants');
    const config = loadConfig();
    const serverUrl = config.serverUrl || getServerUrl();
    const isPlayerMode = !!serverUrl && config.deviceId;

    // For autologin URLs bypass Player Mode and load directly
    const checkIsAutologinUrl = (testUrl) => {
        if (!testUrl) return false;
        return (
            testUrl.startsWith('https://lcr.sportradar.com') ||
            testUrl.toLowerCase().includes('luckiatv') ||
            testUrl.includes('luckia-tv')
        );
    };

    if (isPlayerMode && !checkIsAutologinUrl(url)) {
        const playerUrl = `${serverUrl}/player/${config.deviceId}/${screenIndex}`;

        if (url !== playerUrl) {
            log.info(`[COMMAND]: Player Mode active. Delegating content '${url}' to player page.`);

            if (url.includes('/view/')) {
                cacheContentURL(url, serverUrl).catch(() => { });
            }

            let win = context.managedWindows.get(screenIndex);
            if (!win || win.isDestroyed()) {
                log.info(`[COMMAND]: Window missing in Player Mode. Recreating with player URL.`);
                win = createContentWindow(targetDisplay, playerUrl, { ...command, url: playerUrl });
            }

            const currentWinUrl = win.webContents.getURL();
            if (!currentWinUrl.includes('/player/')) {
                log.info(`[COMMAND]: Restoring player URL on screen ${screenIndex}.`);
                win.loadURL(playerUrl);
            }

            return;
        }
    }

    if (url.startsWith('local:')) {
        const filename = path.basename(url.substring(6));
        const filePath = path.join(CONTENT_DIR, filename);
        if (!fs.existsSync(filePath)) {
            const errorMsg = `Error: Local asset not found: ${filename}.`;
            log.error(`[COMMAND]: ${errorMsg}`);
            sendCommandFeedback(command, 'error', errorMsg);
            return;
        }
        finalUrl = `file://${filePath}`;
    }

    try {
        let win = context.managedWindows.get(screenIndex);
        if (!win || win.isDestroyed()) {
            win = createContentWindow(targetDisplay, 'about:blank', command);
        }

        win.webContents.removeAllListeners('did-finish-load');
        win.webContents.removeAllListeners('did-navigate-in-page');
        win.webContents.removeAllListeners('did-navigate');

        // Logic for Sportradar / LuckiaTV autologin
        const checkIsTargetUrl = (testUrl) => {
            if (!testUrl) return false;
            return (
                testUrl.startsWith('https://lcr.sportradar.com') ||
                testUrl.toLowerCase().includes('luckiatv') ||
                testUrl.includes('luckia-tv')
            );
        };

        if (!!credentials) {
            const injectionScript = `
                (() => {
                    if (window.__autologinStarted) return;
                    window.__autologinStarted = true;
                    console.log('[AUTOLOGIN] Script started at: ' + window.location.href);

                    const setNativeValue = (element, value) => {
                        const valueSetter = Object.getOwnPropertyDescriptor(element, 'value').set;
                        const prototype = Object.getPrototypeOf(element);
                        const prototypeValueSetter = Object.getOwnPropertyDescriptor(prototype, 'value').set;
                        if (valueSetter && valueSetter !== prototypeValueSetter) {
                            prototypeValueSetter.call(element, value);
                        } else {
                            valueSetter.call(element, value);
                        }
                        element.dispatchEvent(new Event('input', { bubbles: true }));
                    };

                    let attempts = 0;
                    const maxAttempts = 60;

                    const tryLogin = () => {
                        const userField = document.querySelector('input[name="username"], input[id*="user"], input[type="text"]');
                        const passField = document.querySelector('input[name="password"], input[id*="pass"], input[type="password"]');
                        const loginBtn = document.querySelector('button[type="submit"], button.login, .btn-primary, button[id*="login"]');

                        if (userField && passField && loginBtn) {
                            console.log('[AUTOLOGIN] Form found. Filling credentials...');
                            setNativeValue(userField, ${JSON.stringify(credentials.username)});
                            setNativeValue(passField, ${JSON.stringify(credentials.password)});
                            setTimeout(() => {
                                console.log('[AUTOLOGIN] Clicking login button...');
                                loginBtn.click();
                            }, 500);
                            return;
                        }

                        if (attempts++ < maxAttempts) {
                            setTimeout(tryLogin, 500);
                        } else {
                            console.warn('[AUTOLOGIN] Form not found after ' + maxAttempts + ' attempts.');
                        }
                    };

                    tryLogin();
                })();
            `;

            let lastLoggedUrl = null;
            const injectIfTarget = (sourceUrl) => {
                if (!win.isDestroyed() && checkIsTargetUrl(sourceUrl)) {
                    const shouldLog = lastLoggedUrl !== sourceUrl;
                    if (shouldLog) {
                        log.info(`[AUTOLOGIN]: Injecting into ${sourceUrl}`);
                        lastLoggedUrl = sourceUrl;
                    }
                    win.webContents.executeJavaScript(injectionScript).catch((err) => {
                        if (shouldLog) log.error('[AUTOLOGIN] Execution Error:', err);
                    });
                }
            };

            // Fires when main frame finishes loading (initial load)
            win.webContents.on('did-finish-load', () => {
                injectIfTarget(win.webContents.getURL());
            });

            // Fires on SPA hash/history navigation (e.g. redirect to /#/login)
            win.webContents.on('did-navigate-in-page', (event, navUrl) => {
                injectIfTarget(navUrl);
            });

            // Fires on full cross-origin navigations
            win.webContents.on('did-navigate', (event, navUrl) => {
                lastLoggedUrl = null; // Reset on full navigation
                injectIfTarget(navUrl);
            });
        }

        win.loadURL(finalUrl);
        win.focus();

        if (context.socket && context.socket.connected) {
            context.socket.emit('reportScreenState', {
                deviceId: context.deviceId,
                screenId: screenIndex,
                url,
            });
        }

        const displayName = contentName || url;
        sendCommandFeedback(
            command,
            'success',
            `Sending '${displayName}' to screen ${screenIndex}`
        );
    } catch (error) {
        const errorMsg = `Unexpected error executing show_url: ${error.message}`;
        log.error(`[COMMAND]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
    }
}

/**
 * Handles 'close_screen' command.
 */
function handleCloseScreen(command) {
    const { screenIndex } = command;
    try {
        const win = context.managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) win.close();

        if (context.saveCurrentState) {
            context.saveCurrentState(
                screenIndex,
                null,
                null,
                0,
                context.autoRefreshTimers,
                context.managedWindows
            );
        }
        if (context.socket && context.socket.connected) {
            context.socket.emit('reportScreenState', {
                deviceId: context.deviceId,
                screenId: screenIndex,
                url: '',
            });
        }
        sendCommandFeedback(command, 'success', `Screen ${screenIndex} closed`);
    } catch (error) {
        sendCommandFeedback(
            command,
            'error',
            `Error closing screen ${screenIndex}: ${error.message}`
        );
    }
}

/**
 * Handles 'refresh_screen' command.
 */
function handleRefreshScreen(command) {
    const { screenIndex } = command;
    try {
        const win = context.managedWindows.get(screenIndex);
        if (!win || win.isDestroyed()) {
            sendCommandFeedback(
                command,
                'error',
                `Screen ${screenIndex} has no active content`
            );
            return;
        }
        win.webContents.reload();
        sendCommandFeedback(command, 'success', `Screen ${screenIndex} reloaded`);
    } catch (error) {
        sendCommandFeedback(
            command,
            'error',
            `Error reloading screen ${screenIndex}: ${error.message}`
        );
    }
}

/**
 * Handles 'identify_screen' command.
 */
function handleIdentifyScreen(command) {
    const { screenIndex, identifierText } = command;
    const targetDisplay = context.hardwareIdToDisplayMap.get(screenIndex);
    if (!targetDisplay) return;

    const existingWin = context.identifyWindows.get(screenIndex);
    if (existingWin && !existingWin.isDestroyed()) {
        existingWin.destroy();
        context.identifyWindows.delete(screenIndex);
        return;
    }

    const identifyWin = new BrowserWindow({
        x: targetDisplay.bounds.x,
        y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width,
        height: targetDisplay.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: { preload: path.join(__dirname, '../identify-preload.js') },
    });
    identifyWin.setMenu(null);
    identifyWin.loadFile(path.join(__dirname, '../identify.html'));
    identifyWin.webContents.on('did-finish-load', () => {
        identifyWin.webContents.send('set-identifier', identifierText);
    });

    context.identifyWindows.set(screenIndex, identifyWin);
    identifyWin.on('closed', () => context.identifyWindows.delete(screenIndex));

    setTimeout(() => {
        if (identifyWin && !identifyWin.isDestroyed()) identifyWin.destroy();
    }, 10000);
}

async function handleGetLogs(command) {
    const { getAllLogPaths, getLogDir } = require('../utils/logConfig');
    const archiver = require('archiver');
    const logFiles = getAllLogPaths();
    const date = new Date().toISOString().split('T')[0];
    const zipPath = path.join(getLogDir(), `all-logs-${context.deviceId}-${date}.zip`);

    try {
        const existingFiles = logFiles.filter((f) => fs.existsSync(f.path));
        if (existingFiles.length === 0) {
            sendCommandFeedback(command, 'error', 'No log files found.');
            return;
        }

        log.info(`[COMMAND]: Compressing ${existingFiles.length} log files into zip archive`);

        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            for (const entry of existingFiles) {
                // Keep file names unique in zip if multiple rotations exist
                archive.file(entry.path, { name: entry.path.slice(getLogDir().length + 1) });
            }
            archive.finalize();
        });

        log.info(`[COMMAND]: Uploading all logs: ${zipPath}`);

        const fileContent = fs.readFileSync(zipPath);
        const FormData = require('form-data');
        const form = new FormData();
        form.append('logFile', fileContent, { filename: path.basename(zipPath) });

        const constants = require('../config/constants');
        const uploadUrl = `${constants.getServerUrl()}/api/logs/upload-debug`;

        const response = await axios.post(uploadUrl, form, {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${context.agentToken}`,
            },
        });

        if (response.data && response.data.success) {
            sendCommandFeedback(
                command,
                'success',
                `Logs listos. Download URL: ${response.data.downloadUrl}`
            );
        } else {
            throw new Error('Invalid server response');
        }

        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } catch (error) {
        log.error('[COMMAND]: Error in GetLogs:', error);
        sendCommandFeedback(command, 'error', `Error processing logs: ${error.message}`);
        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    }
}

module.exports = {
    initializeHandlers,
    handleShowUrl,
    handleCloseScreen,
    handleIdentifyScreen,
    handleRefreshScreen,
    sendCommandFeedback,
    createContentWindow,
    handleGetLogs,
};
