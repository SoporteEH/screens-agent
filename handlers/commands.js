const { BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const axios = require('axios');
const { CONTENT_DIR } = require('../config/constants');
const { cachePlayerHTML, cacheContentURL } = require('../services/playerCache');

let context = {};

// Inicializa handlers con contexto global
function initializeHandlers(ctx) {
    context = ctx;
}

// Envia feedback del comando al servidor
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
        log.info(`[FEEDBACK]: Enviando feedback para commandId ${command.commandId}: ${status}`);
    }
}

// Programa reintento con backoff exponencial
const MAX_RETRY_DELAY_MS = 2 * 60 * 1000;

function scheduleRetry(command) {
    const { screenIndex } = command;
    const attempt = (context.retryManager.get(screenIndex)?.attempt || 0) + 1;

    const delayMs = Math.min(Math.pow(2, attempt - 1) * 30 * 1000, MAX_RETRY_DELAY_MS);
    log.info(
        `[RETRY]: Programando reintento #${attempt} para la pantalla ${screenIndex} en ${delayMs / 1000} segundos.`
    );

    const timerId = setTimeout(() => {
        log.info(`[RETRY]: Ejecutando reintento #${attempt} para la pantalla ${screenIndex}...`);
        handleShowUrl(command, attempt);
    }, delayMs);

    context.retryManager.set(screenIndex, { attempt, timerId });
}

/**
 * Crea una ventana de contenido perfectamente configurada para senalizacion.
 */
function createContentWindow(display, urlToLoad, command) {
    const { screenIndex, url: originalUrl, contentName } = command;
    const fallbackPath = `file://${path.join(__dirname, '../fallback.html')}`;

    log.info(
        `[COMMAND]: Creando ventana en pantalla ${screenIndex} (${display.bounds.width}x${display.bounds.height})`
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

    // Fallback timer para mostrar ventana
    setTimeout(() => {
        if (!win.isDestroyed() && !win.isVisible()) win.show();
    }, 2000);

    win.webContents.on('did-finish-load', () => {
        const loadedUrl = win.webContents.getURL();
        if (loadedUrl.includes('/player/') && screenIndex) {
            win.webContents
                .executeJavaScript('document.documentElement.outerHTML')
                .then((html) => cachePlayerHTML(screenIndex, html))
                .catch(() => {});
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
                `[RESILIENCE]: Fallo al cargar URL '${validatedURL}'. Razon: ${errorDescription}`
            );

            if (validatedURL === fallbackPath) return;

            if (command.commandId) {
                const displayName = contentName ? `'${contentName}'` : `la URL '${originalUrl}'`;
                sendCommandFeedback(
                    command,
                    'error',
                    `Fallo al cargar ${displayName}. Razon: ${errorDescription}`
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
            windowSession.clearCache().catch(() => {});
            windowSession.clearStorageData().catch(() => {});
        }
    });

    win.loadURL(urlToLoad);
    context.managedWindows.set(screenIndex, win);
    return win;
}

/**
 * Maneja el comando 'show_url'.
 */
function handleShowUrl(command, _currentAttempt = 0) {
    const { screenIndex, url, credentials, contentName, refreshInterval } = command;

    if (!url || !url.trim()) {
        log.error(`[COMMAND] URL vacía recibida para pantalla ${screenIndex}. Ignorando.`);
        sendCommandFeedback(command, 'error', `URL vacía, no se puede cargar`);
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
            `Pantalla con ID de hardware '${screenIndex}' no encontrada.`
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
        const errorMsg = `Error: Sin conexion. No se puede cargar la URL '${url}'. Se reintentara cuando vuelva la conexion.`;
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
                cacheContentURL(url, serverUrl).catch(() => {});
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
            const errorMsg = `Error: Activo local no encontrado: ${filename}.`;
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
            `Enviando '${displayName}' a la pantalla ${screenIndex}`
        );
    } catch (error) {
        const errorMsg = `Error inesperado al ejecutar show_url: ${error.message}`;
        log.error(`[COMMAND]: ${errorMsg}`);
        sendCommandFeedback(command, 'error', errorMsg);
    }
}

/**
 * Maneja el comando 'close_screen'.
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
        sendCommandFeedback(command, 'success', `Pantalla ${screenIndex} cerrada`);
    } catch (error) {
        sendCommandFeedback(
            command,
            'error',
            `Error al cerrar pantalla ${screenIndex}: ${error.message}`
        );
    }
}

/**
 * Maneja el comando 'refresh_screen'.
 */
function handleRefreshScreen(command) {
    const { screenIndex } = command;
    try {
        const win = context.managedWindows.get(screenIndex);
        if (!win || win.isDestroyed()) {
            sendCommandFeedback(
                command,
                'error',
                `Pantalla ${screenIndex} no tiene contenido activo`
            );
            return;
        }
        win.webContents.reload();
        sendCommandFeedback(command, 'success', `Pantalla ${screenIndex} recargada`);
    } catch (error) {
        sendCommandFeedback(
            command,
            'error',
            `Error al recargar pantalla ${screenIndex}: ${error.message}`
        );
    }
}

/**
 * Maneja el comando 'identify_screen'.
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
    const { getTodayLogPaths, getLogDir } = require('../utils/logConfig');
    const archiver = require('archiver');
    const logFiles = getTodayLogPaths();
    const date = new Date().toISOString().split('T')[0];
    const zipPath = path.join(getLogDir(), `logs-${date}.zip`);

    try {
        const existingFiles = logFiles.filter((f) => fs.existsSync(f.path));
        if (existingFiles.length === 0) {
            sendCommandFeedback(command, 'error', 'No se encontraron archivos de logs.');
            return;
        }

        log.info(`[COMMAND] Comprimiendo ${existingFiles.length} archivos de logs en zip`);

        await new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', { zlib: { level: 9 } });
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);
            for (const entry of existingFiles) {
                archive.file(entry.path, { name: `${entry.name}-${date}.log` });
            }
            archive.finalize();
        });

        log.info(`[COMMAND] Subiendo logs: ${zipPath}`);

        const fileContent = fs.readFileSync(zipPath);
        const FormData = require('form-data');
        const form = new FormData();
        form.append('logFile', fileContent, { filename: `agent-${context.deviceId}.zip` });

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
                `Logs listos. URL de descarga: ${response.data.downloadUrl}`
            );
        } else {
            throw new Error('Respuesta de servidor inválida');
        }

        if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    } catch (error) {
        log.error('[COMMAND] Error en GetLogs:', error);
        sendCommandFeedback(command, 'error', `Error al procesar logs: ${error.message}`);
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
