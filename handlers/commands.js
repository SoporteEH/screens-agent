const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const axios = require('axios');
const { getServerUrl, CONSTANTS } = require('../config/constants');
const { isServerDependentUrl, localAssetPath } = require('../utils/contentUrl');
const { isWrapperUrl } = require('../utils/wrapperUrl');
const { isAutologinUrl } = require('../utils/autologinUrl');

let context = {};
const isLinux = process.platform === 'linux';

function isNavigationAllowed(targetUrl, currentUrl) {
    if (!targetUrl) return false;
    if (/^(file:|about:|data:|blob:|local:)/i.test(targetUrl)) return true;
    if (isAutologinUrl(targetUrl)) return true;

    let target;
    try {
        target = new URL(targetUrl);
    } catch {
        return false;
    }
    try {
        if (currentUrl && new URL(currentUrl).origin === target.origin) return true;
    } catch {}
    try {
        const serverUrl = getServerUrl();
        if (serverUrl && new URL(serverUrl).origin === target.origin) return true;
    } catch {}
    return false;
}

function initializeHandlers(ctx) {
    context = ctx;
}

function sendCommandFeedback(command, status, message, messageKey, messageParams, data) {
    if (!command || !command.commandId) return;
    if (command.silent) return;

    if (context.socket && context.socket.connected) {
        context.socket.emit('command-feedback', {
            deviceId: context.deviceId,
            commandId: command.commandId,
            action: command.action,
            status,
            message,
            ...(messageKey ? { messageKey, messageParams: messageParams || {} } : {}),
            ...(data ? { data } : {}),
        });
        log.debug(`[FEEDBACK]: Sending feedback for commandId ${command.commandId}: ${status}`);
    }
}

const MAX_RETRY_DELAY_MS = 2 * 60 * 1000;

function scheduleRetry(command) {
    const { screenIndex } = command;
    const attempt = (context.retryManager.get(screenIndex)?.attempt || 0) + 1;

    const delayMs = Math.min(
        Math.pow(2, attempt - 1) * CONSTANTS.RETRY_BACKOFF_BASE_MS,
        MAX_RETRY_DELAY_MS
    );
    log.info(
        `[RETRY]: Scheduling retry #${attempt} for screen ${screenIndex} in ${delayMs / 1000} seconds.`
    );

    const timerId = setTimeout(() => {
        log.info(`[RETRY]: Executing retry #${attempt} for screen ${screenIndex}...`);
        handleShowUrl(command, attempt);
    }, delayMs);

    context.retryManager.set(screenIndex, { attempt, timerId });
}

function createContentWindow(display, urlToLoad, command, opts = {}) {
    const { screenIndex, url: originalUrl, contentName } = command;
    const fallbackPath = `file://${path.join(__dirname, '../fallback.html')}`;
    const isWrapperWindow = !!opts.wrapper;

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
        show: isLinux,
        backgroundColor: '#000000',
        paintWhenInitiallyHidden: false,
        webPreferences: {
            // Wrapper only: third-party content pages must not see playerAPI.
            ...(opts.wrapper ? { preload: path.join(__dirname, '../player-preload.js') } : {}),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            nodeIntegrationInSubFrames: false,
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

    // Deny popups and confine renderer-initiated navigation to known origins.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, targetUrl) => {
        if (isNavigationAllowed(targetUrl, win.webContents.getURL())) return;
        log.warn(`[SECURITY]: Blocked navigation to ${targetUrl}`);
        event.preventDefault();
    });

    win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders;
        const keys = Object.keys(headers);
        const xframeKey = keys.find((k) => {
            const l = k.toLowerCase();
            return l === 'x-frame-options' || l === 'frame-options';
        });
        const cspKey = keys.find((k) => k.toLowerCase() === 'content-security-policy');

        if (!xframeKey && !cspKey) {
            callback({ cancel: false });
            return;
        }

        const responseHeaders = { ...headers };
        if (xframeKey) delete responseHeaders[xframeKey];
        if (cspKey) {
            responseHeaders[cspKey] = [
                responseHeaders[cspKey][0].replace(/frame-ancestors[^;]+;?/gi, ''),
            ];
        }

        callback({ cancel: false, responseHeaders });
    });

    win.once('ready-to-show', () => {
        win.show();
        if (isLinux) {
            win.setFullScreen(true);
            win.focus();
            win.moveTop();
        }
    });

    // Fallback if 'ready-to-show' never fires
    setTimeout(() => {
        if (!win.isDestroyed()) {
            win.show();
            if (isLinux) {
                win.setFullScreen(true);
                win.focus();
                win.moveTop();
            }
        }
    }, 1000);

    // The wrapper is cross-origin with everything it embeds, so its own console is all
    // it can report; forwarding it is what leaves a trace of a dark screen in the log.
    win.webContents.on('console-message', (details) => {
        if (!details?.message?.startsWith('[PLAYER]')) return;
        const line = `[SCREEN ${screenIndex}]: ${details.message}`;
        if (details.level === 'error' || details.level === 'warning') log.warn(line);
        else log.info(line);
    });

    win.webContents.on('did-finish-load', () => {
        if (!isWrapperWindow || !screenIndex) return;
        if (!isWrapperUrl(win.webContents.getURL())) return;

        if (context.retryManager.has(screenIndex)) {
            clearTimeout(context.retryManager.get(screenIndex).timerId);
            context.retryManager.delete(screenIndex);
        }
        // Re-push on every wrapper load: covers refresh, memory and crash reloads.
        context.pushPlayerState?.(screenIndex, win);
    });

    // Without this a dead renderer keeps its old URL, so the watchdog sees a healthy screen.
    win.webContents.on('render-process-gone', (_event, details) => {
        if (details.reason === 'clean-exit') return;
        log.error(
            `[RENDERER]: Screen ${screenIndex} renderer gone (${details.reason}). Reloading.`
        );
        if (!win.isDestroyed()) win.webContents.reload();
    });

    win.webContents.on(
        'did-fail-load',
        (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
            if (!isMainFrame) {
                // ERR_ABORTED is the double buffer discarding a frame, not a failure.
                if (errorCode === -3) return;
                // A black screen behind a healthy wrapper is only explained here: the
                // frame's real error never reaches the page that embeds it.
                log.warn(
                    `[CONTENT]: Frame failed on screen ${screenIndex}: '${validatedURL}' — ${errorDescription} (${errorCode})`
                );
                // A playlist benches the item and moves on instead of holding a dead frame.
                if (isWrapperWindow)
                    win.webContents.send('player:item-failed', { url: validatedURL });
                return;
            }

            log.error(
                `[RESILIENCE]: Failed to load URL '${validatedURL}'. Reason: ${errorDescription}`
            );

            if (validatedURL === fallbackPath) return;

            if (command.commandId) {
                const displayName = contentName ? `'${contentName}'` : `URL '${originalUrl}'`;
                sendCommandFeedback(
                    command,
                    'error',
                    `Failed to load ${displayName}. Reason: ${errorDescription}`,
                    'contentLoadFailed',
                    { name: displayName, reason: errorDescription }
                );
            }

            const isNetworkError = errorCode <= -100 && errorCode >= -199;
            if (originalUrl.startsWith('local:') || !isNetworkError) return;

            // Retrying while offline just re-lands on an error page with no script to recover it.
            if (context.networkState && context.networkState !== 'ONLINE') {
                const reason = context.networkState === 'NO_INTERNET' ? 'NO_INTERNET' : 'NO_SERVER';

                if (
                    isServerDependentUrl(validatedURL, getServerUrl()) &&
                    context.applyOfflineScreen
                ) {
                    log.warn(
                        `[RESILIENCE]: Server page failed on screen ${screenIndex} (${reason}). Switching to offline content.`
                    );
                    context.applyOfflineScreen(screenIndex);
                    return;
                }
                if (context.loadOfflineCarousel) {
                    log.warn(
                        `[RESILIENCE]: Content unreachable on screen ${screenIndex}. Falling back to carousel.`
                    );
                    context.loadOfflineCarousel(screenIndex);
                    return;
                }
            }

            scheduleRetry(command);
        }
    );

    // Session is shared across screens — don't clear cache/storage here, it'd wipe every screen's cookies.
    win.on('closed', () => {
        if (context.managedWindows.get(screenIndex) === win) {
            context.managedWindows.delete(screenIndex);
        }
        if (context.retryManager.has(screenIndex)) {
            clearTimeout(context.retryManager.get(screenIndex).timerId);
            context.retryManager.delete(screenIndex);
        }
    });

    win.loadURL(urlToLoad);
    context.managedWindows.set(screenIndex, win);
    return win;
}

function handleShowUrl(command, _currentAttempt = 0) {
    const { screenIndex, url, credentials, contentName, refreshInterval } = command;

    if (!url || !url.trim()) {
        log.error(`[COMMAND]: Empty URL received for screen ${screenIndex}. Ignoring.`);
        sendCommandFeedback(command, 'error', 'Empty URL, cannot load', 'emptyUrl');
        return;
    }

    const trimmedUrl = url.trim();
    const allowedSchemes = ['http:', 'https:', 'local:', 'playlist:'];
    let parsedUrl;
    try {
        parsedUrl = new URL(trimmedUrl);
    } catch {
        log.error(`[COMMAND]: Malformed URL for screen ${screenIndex}: ${trimmedUrl}`);
        sendCommandFeedback(command, 'error', 'Malformed URL, cannot load', 'malformedUrl');
        return;
    }
    if (!allowedSchemes.includes(parsedUrl.protocol)) {
        log.error(
            `[COMMAND]: Blocked disallowed URL scheme '${parsedUrl.protocol}' for screen ${screenIndex}`
        );
        sendCommandFeedback(command, 'error', 'URL scheme not allowed', 'urlSchemeNotAllowed');
        return;
    }
    if (context.retryManager.has(screenIndex)) {
        clearTimeout(context.retryManager.get(screenIndex).timerId);
        context.retryManager.delete(screenIndex);
    }

    // The API sends a null manifest for a playlist that is gone or inactive.
    const isPlaylist = trimmedUrl.startsWith('playlist:');
    const playlistManifest = isPlaylist ? command.playlist || null : null;
    if (isPlaylist && !playlistManifest) {
        log.warn(
            `[COMMAND]: Playlist ${trimmedUrl} is no longer available. Clearing screen ${screenIndex}.`
        );
        handleCloseScreen({ ...command, action: 'close_screen' });
        return;
    }

    const targetDisplay = context.hardwareIdToDisplayMap.get(screenIndex);
    if (!targetDisplay) {
        // Monitor is off: park as desired state, applied automatically on reconnect.
        const { hasSlot, ensureSlot } = require('../services/displaySlots');
        const { loadConfig } = require('../utils/configManager');
        const expectedScreens = Number(loadConfig().expectedScreens) || 0;
        const slotNumber = Number(screenIndex);
        const isKnownSlot =
            hasSlot(screenIndex) ||
            (Number.isInteger(slotNumber) && slotNumber >= 1 && slotNumber <= expectedScreens);
        const isPlayerWrapperCmd = isWrapperUrl(trimmedUrl);

        if (isKnownSlot && !isPlayerWrapperCmd && context.saveCurrentState) {
            ensureSlot(screenIndex);
            context.saveCurrentState(
                screenIndex,
                url,
                credentials,
                refreshInterval || 0,
                context.autoRefreshTimers,
                context.managedWindows,
                playlistManifest
            );
            log.info(
                `[COMMAND]: Screen ${screenIndex} is disconnected. Content saved for reconnect: ${url}`
            );
            sendCommandFeedback(
                command,
                'saved_offline',
                `Screen ${screenIndex} is disconnected. Content will be applied on reconnect.`,
                'screenOfflineSaved',
                { screen: screenIndex }
            );
            return;
        }

        sendCommandFeedback(
            command,
            'error',
            `Display with hardware ID '${screenIndex}' not found.`,
            'displayNotFound',
            { screen: screenIndex }
        );
        return;
    }

    // State purity: the wrapper URL must never land in state.json or registerDevice.
    const isPlayerWrapperUrl = isWrapperUrl(url);
    if (context.saveCurrentState && !isPlayerWrapperUrl) {
        context.saveCurrentState(
            screenIndex,
            url,
            credentials,
            refreshInterval || 0,
            context.autoRefreshTimers,
            context.managedWindows,
            playlistManifest
        );
    }

    const { net } = require('electron');
    const hasInternet = net.isOnline();

    // A playlist keeps going offline on its local files; only its web items wait.
    if (!hasInternet && !url.startsWith('local:') && !isPlaylist) {
        const errorMsg = `Error: No connection. Cannot load URL '${url}'. Will retry when connection is restored.`;
        log.error(`[RESILIENCE]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg, 'noConnectionWillRetry', { url });
        scheduleRetry(command);
        return;
    }

    let finalUrl = url;

    const { loadConfig } = require('../utils/configManager');
    const { getServerUrl } = require('../config/constants');
    const config = loadConfig();
    const serverUrl = config.serverUrl || getServerUrl();
    const isPlayerMode = !!serverUrl && config.deviceId;

    // Autologin bypasses the player iframe (injection needs the login form); credentials signal it, host list is fallback.
    const { isAutologinUrl: checkIsAutologinUrl } = require('../utils/autologinUrl');

    if (isPlayerMode && !credentials && !checkIsAutologinUrl(url)) {
        log.info(
            `[COMMAND]: Player Mode active. Routing screen ${screenIndex} through the local wrapper.`
        );

        // A wrapper URL is never content (retry of a failed wrapper load): re-assert
        // the recorded target instead of framing the wrapper inside itself.
        const target = isPlayerWrapperUrl
            ? context.resolveScreenTarget?.(screenIndex) || { url: '' }
            : isPlaylist
              ? context.playlistTarget(trimmedUrl, playlistManifest, contentName)
              : { url: trimmedUrl, contentName: contentName || '' };

        // Live wrapper → crossfade push; missing/foreign window → wrapper recreation.
        const win = context.ensurePlayerScreen?.(screenIndex, target);

        if (!win) {
            sendCommandFeedback(
                command,
                'error',
                `No display available for screen ${screenIndex}`,
                'noDisplayAvailable',
                { screen: screenIndex }
            );
            return;
        }

        if (!isPlayerWrapperUrl && context.socket && context.socket.connected) {
            context.socket.emit('reportScreenState', {
                deviceId: context.deviceId,
                screenId: screenIndex,
                url: trimmedUrl,
            });
        }
        sendCommandFeedback(
            command,
            'success',
            `Sending '${contentName || trimmedUrl}' to screen ${screenIndex}`,
            'contentSent',
            { name: contentName || trimmedUrl, screen: screenIndex }
        );
        return;
    }

    if (isPlaylist) {
        sendCommandFeedback(
            command,
            'error',
            'Playlists need the player wrapper',
            'playlistNeedsPlayer'
        );
        return;
    }

    if (url.startsWith('local:')) {
        const filePath = localAssetPath(url);
        if (!filePath) {
            const filename = url.slice('local:'.length);
            const errorMsg = `Error: Local asset not found: ${filename}.`;
            log.error(`[COMMAND]: ${errorMsg}`);
            sendCommandFeedback(command, 'error', errorMsg, 'localAssetNotFound', { filename });
            return;
        }
        finalUrl = `file://${filePath}`;
    }

    try {
        const oldWin = context.managedWindows.get(screenIndex);

        const win = createContentWindow(targetDisplay, 'about:blank', command);

        if (oldWin && !oldWin.isDestroyed() && oldWin !== win) {
            win.once('ready-to-show', () => {
                setTimeout(() => {
                    if (oldWin && !oldWin.isDestroyed()) {
                        log.info(
                            `[COMMAND]: Closing old window for screen ${screenIndex} after new one is ready.`
                        );
                        oldWin.close();
                    }
                }, 300);
            });
            // Force-close if 'ready-to-show' never fires
            setTimeout(() => {
                if (oldWin && !oldWin.isDestroyed()) oldWin.close();
            }, 5000);
        }

        win.webContents.removeAllListeners('did-finish-load');
        win.webContents.removeAllListeners('did-navigate-in-page');
        win.webContents.removeAllListeners('did-navigate');

        const { isAutologinUrl: checkIsTargetUrl, isSameSite } = require('../utils/autologinUrl');

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
                const isTarget = isSameSite(sourceUrl, trimmedUrl) || checkIsTargetUrl(sourceUrl);
                if (!win.isDestroyed() && isTarget) {
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

            win.webContents.on('did-finish-load', () => {
                injectIfTarget(win.webContents.getURL());
            });

            win.webContents.on('did-navigate-in-page', (event, navUrl) => {
                injectIfTarget(navUrl);
            });

            win.webContents.on('did-navigate', (event, navUrl) => {
                lastLoggedUrl = null;
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
            `Sending '${displayName}' to screen ${screenIndex}`,
            'contentSent',
            { name: displayName, screen: screenIndex }
        );
    } catch (error) {
        const errorMsg = `Unexpected error executing show_url: ${error.message}`;
        log.error(`[COMMAND]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg, 'showUrlFailed', { reason: error.message });
    }
}

function handleCloseScreen(command) {
    const { screenIndex } = command;
    try {
        const win = context.managedWindows.get(screenIndex);
        if (win && !win.isDestroyed()) win.close();
        context.screenContent?.delete(String(screenIndex));
        context.nowPlaying?.delete(String(screenIndex));

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
        sendCommandFeedback(command, 'success', `Screen ${screenIndex} closed`, 'screenClosed', {
            screen: screenIndex,
        });
    } catch (error) {
        sendCommandFeedback(
            command,
            'error',
            `Error closing screen ${screenIndex}: ${error.message}`,
            'screenCloseFailed',
            { screen: screenIndex, reason: error.message }
        );
    }
}

// What each playlist screen shows right now, as its engine last reported it. Asked on demand
// rather than pushed on every rotation, which would be steady traffic for nothing.
function handleGetNowPlaying(command) {
    const screens = {};
    for (const [screenId, target] of context.screenContent) {
        if (!target?.playlist) continue;
        screens[screenId] = context.nowPlaying.get(screenId) || {
            playlistId: target.playlist.playlistId,
            itemId: null,
            state: 'starting',
        };
    }
    sendCommandFeedback(command, 'success', 'Now playing', 'nowPlaying', {}, { screens });
}

function handleRefreshScreen(command) {
    const { screenIndex } = command;
    try {
        const win = context.managedWindows.get(screenIndex);
        if (!win || win.isDestroyed()) {
            sendCommandFeedback(
                command,
                'error',
                `Screen ${screenIndex} has no active content`,
                'screenNoContent',
                { screen: screenIndex }
            );
            return;
        }
        if (isWrapperUrl(win.webContents.getURL())) {
            // Refresh the content frame, not the wrapper: no black flash.
            win.webContents.send('player:refresh');
        } else {
            win.webContents.reload();
        }
        sendCommandFeedback(
            command,
            'success',
            `Screen ${screenIndex} reloaded`,
            'screenReloaded',
            { screen: screenIndex }
        );
    } catch (error) {
        sendCommandFeedback(
            command,
            'error',
            `Error reloading screen ${screenIndex}: ${error.message}`,
            'screenReloadFailed',
            { screen: screenIndex, reason: error.message }
        );
    }
}

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
        backgroundColor: '#00000000',
        hasShadow: false,
        show: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        webPreferences: {
            partition: 'identify-overlay',
            preload: path.join(__dirname, '../identify-preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true,
            webSecurity: true,
        },
    });
    identifyWin.setMenu(null);
    identifyWin.loadFile(path.join(__dirname, '../identify.html'));
    identifyWin.webContents.on('did-finish-load', () => {
        identifyWin.webContents.send('set-identifier', identifierText);
    });
    // Showing only once painted avoids the white frame a transparent window flashes first.
    identifyWin.once('ready-to-show', () => {
        if (!identifyWin.isDestroyed()) identifyWin.show();
    });

    context.identifyWindows.set(screenIndex, identifyWin);
    identifyWin.on('closed', () => context.identifyWindows.delete(screenIndex));

    setTimeout(() => {
        if (identifyWin && !identifyWin.isDestroyed()) identifyWin.destroy();
    }, 10000);
}

const DEFAULT_LOG_DAYS = 3;
const LOG_UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// Success is the upload itself; only failures send feedback.
async function handleGetLogs(command) {
    const { getLogPathsForDays, getLogDir } = require('../utils/logConfig');
    const archiver = require('archiver');
    const FormData = require('form-data');
    const days = Math.min(Math.max(Number(command.days) || DEFAULT_LOG_DAYS, 1), 30);
    const zipPath = path.join(getLogDir(), `logs-${command.commandId}.zip`);
    const limitMb = Math.round(CONSTANTS.LOG_UPLOAD_MAX_BYTES / (1024 * 1024));
    let sizeMb = 0;

    const removeZip = () => {
        try {
            if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
        } catch (e) {
            log.warn(`[COMMAND]: Could not remove log archive: ${e.message}`);
        }
    };

    try {
        const logFiles = getLogPathsForDays(days);
        if (logFiles.length === 0) {
            sendCommandFeedback(command, 'error', 'No log files found.', 'noLogFiles', { days });
            return;
        }

        log.info(
            `[COMMAND]: Archiving ${logFiles.length} log file(s) from the last ${days} day(s)`
        );

        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 6 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            // Already gzipped.
            for (const file of logFiles) {
                archive.file(file.path, { name: file.name, store: file.compressed });
            }
            archive.finalize();
        });

        const zipBytes = fs.statSync(zipPath).size;
        sizeMb = Math.round(zipBytes / (1024 * 1024));
        if (zipBytes > CONSTANTS.LOG_UPLOAD_MAX_BYTES) {
            log.error(`[COMMAND]: Log archive is ${sizeMb} MB, over the ${limitMb} MB limit`);
            sendCommandFeedback(
                command,
                'error',
                `Log archive too large: ${sizeMb} MB (limit ${limitMb} MB).`,
                'logsTooLarge',
                { sizeMb, limitMb }
            );
            return;
        }

        log.info(`[COMMAND]: Uploading log archive (${sizeMb} MB)`);

        // requestId must precede the file.
        const form = new FormData();
        form.append('requestId', command.commandId);
        form.append('logFile', fs.createReadStream(zipPath), {
            filename: path.basename(zipPath),
            knownLength: zipBytes,
        });

        await axios.post(`${getServerUrl()}/api/logs/upload`, form, {
            headers: { ...form.getHeaders(), Authorization: `Bearer ${context.agentToken}` },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: LOG_UPLOAD_TIMEOUT_MS,
        });
        log.info('[COMMAND]: Log archive uploaded.');
    } catch (error) {
        log.error('[COMMAND]: Error in GetLogs:', error.message);
        if (error.response?.status === 413) {
            sendCommandFeedback(
                command,
                'error',
                `Log archive too large: ${sizeMb} MB (limit ${limitMb} MB).`,
                'logsTooLarge',
                { sizeMb, limitMb }
            );
        } else {
            sendCommandFeedback(
                command,
                'error',
                `Error processing logs: ${error.message}`,
                'logsFailed',
                { reason: error.message }
            );
        }
    } finally {
        removeZip();
    }
}

module.exports = {
    initializeHandlers,
    handleShowUrl,
    handleCloseScreen,
    handleGetNowPlaying,
    handleIdentifyScreen,
    handleRefreshScreen,
    sendCommandFeedback,
    createContentWindow,
    handleGetLogs,
};
