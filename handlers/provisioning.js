const { BrowserWindow, app, ipcMain } = require('electron');
const path = require('path');

const https = require('https');
const { io } = require('socket.io-client');
const { log } = require('../utils/logConfig');
const { SERVER_URL } = require('../config/constants');
const { saveConfig } = require('../utils/configManager');
const { getMachineId } = require('../services/device');

function isPrivateHost(serverUrl) {
    let hostname;
    try {
        hostname = new URL(serverUrl).hostname;
    } catch {
        return false;
    }
    return (
        hostname === 'localhost' ||
        hostname === '::1' ||
        /^127\./.test(hostname) ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
        /^169\.254\./.test(hostname)
    );
}

function startProvisioningMode() {
    const deviceId = getMachineId();
    let pendingServerUrl = '';
    let agentTokenNonce = '';
    let socket = null;

    log.info(`[PROVISIONING]: Machine ID: ${deviceId}`);

    const provisionWindow = new BrowserWindow({
        width: 800,
        height: 400,
        center: true,
        icon: path.join(__dirname, '../icons/icon.ico'),
        webPreferences: {
            preload: path.join(__dirname, '../preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
            backgroundThrottling: true,
            devTools: false,
        },
        title: 'Linking - ScreensWeb',
        backgroundColor: '#0a0a0a',
        frame: false,
        resizable: false,
    });

    provisionWindow.setMenu(null);

    ipcMain.on('set-server-url', (event, payload) => {
        if (socket) {
            socket.disconnect();
            socket.removeAllListeners();
        }

        const { url, nonce } = typeof payload === 'string' ? { url: payload, nonce: '' } : payload;
        pendingServerUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        agentTokenNonce = '';
        log.info(`[PROVISIONING]: Attempting to connect to: ${pendingServerUrl}`);

        const isHttps = pendingServerUrl.startsWith('https://');

        // Packaged builds must provision over HTTPS with a validated cert: first contact
        if (app.isPackaged && !isHttps && !isPrivateHost(pendingServerUrl)) {
            log.error(`[PROVISIONING]: Rejected non-HTTPS server URL in packaged build: ${pendingServerUrl}`);
            provisionWindow.webContents.send('provision-status', {
                type: 'error',
                message: 'The server URL must use HTTPS (plain HTTP is only allowed for local network addresses).',
            });
            return;
        }
        if (!isHttps) {
            log.warn(`[PROVISIONING]: Using plain HTTP toward private host: ${pendingServerUrl}`);
        }

        const allowInsecureTLS =
            process.env.ALLOW_INSECURE_PROVISIONING_TLS === '1' && !app.isPackaged;
        const httpsAgent = isHttps && allowInsecureTLS
            ? new https.Agent({ rejectUnauthorized: false })
            : undefined;

        socket = io(pendingServerUrl, {
            auth: { provisioning: true, nonce },
            reconnection: true,
            reconnectionAttempts: 3,
            timeout: 10000,
            ...(httpsAgent ? { agent: httpsAgent } : {}),
        });

        socket.on('connect', () => {
            log.info('[PROVISIONING]: Connection successful. Registering for linking...');
            socket.emit('register-for-provisioning', deviceId);
            provisionWindow.webContents.send('provision-status', {
                type: 'success',
                message: 'Connected. Waiting for linking from control panel...',
            });
        });

        // Single-use nonce the server requires when we POST /agent-token.
        socket.on('provision-token-nonce', (payload) => {
            agentTokenNonce = payload?.nonce || '';
            log.info('[PROVISIONING]: Received agent-token nonce.');
        });

        socket.on('connect_error', (error) => {
            log.error(`[PROVISIONING]: Connection error to ${pendingServerUrl}: ${error.message}`);
            provisionWindow.webContents.send('provision-status', {
                type: 'error',
                message: 'Could not connect to the server. Check the URL and try again.',
            });
        });

        socket.on('provision-success', async () => {
            log.info('[PROVISIONING]: Successful linking detected. Requesting token...');

            try {
                const response = await fetch(`${pendingServerUrl}/api/auth/agent-token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ deviceId, nonce: agentTokenNonce }),
                });

                if (!response.ok) throw new Error('Error obtaining token from server');

                const { token } = await response.json();

                saveConfig({
                    deviceId,
                    provisioned: true,
                    agentToken: token,
                    serverUrl: pendingServerUrl,
                });

                log.info('[PROVISIONING]: Configuration saved. Restarting...');

                socket.disconnect();
                app.relaunch();
                app.exit(0);
            } catch (err) {
                log.error('[PROVISIONING]: Failed to finalize linking:', err.message);
                provisionWindow.webContents.send('provision-status', {
                    type: 'error',
                    message: `Error finalizing: ${err.message}`,
                });
            }
        });
    });

    ipcMain.on('window-control', (event, action) => {
        if (!provisionWindow || provisionWindow.isDestroyed()) return;
        if (action === 'minimize') provisionWindow.minimize();
        if (action === 'close') provisionWindow.close();
    });

    provisionWindow.loadFile(path.join(__dirname, '../provision.html'));

    provisionWindow.webContents.on('did-finish-load', () => {
        provisionWindow.webContents.send('device-id', deviceId);
    });

    return provisionWindow;
}

module.exports = {
    startProvisioningMode,
};
