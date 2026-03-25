/**
 * Manages initial device registration
 */

const { BrowserWindow, app, ipcMain } = require('electron');
const path = require('path');

const { io } = require('socket.io-client');
const { log } = require('../utils/logConfig');
const { SERVER_URL } = require('../config/constants');
const { saveConfig } = require('../utils/configManager');
const { getMachineId } = require('../services/device');

function startProvisioningMode() {
    const deviceId = getMachineId();
    let pendingServerUrl = '';
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

    // Listen for URL from window
    ipcMain.on('set-server-url', (event, url) => {
        if (socket) {
            socket.disconnect();
            socket.removeAllListeners();
        }

        pendingServerUrl = url.endsWith('/') ? url.slice(0, -1) : url;
        log.info(`[PROVISIONING]: Attempting to connect to: ${pendingServerUrl}`);

        socket = io(pendingServerUrl, {
            auth: {
                provisioning: true
            },
            reconnection: true,
            reconnectionAttempts: 3,
            timeout: 10000,
        });

        socket.on('connect', () => {
            log.info('[PROVISIONING]: Connection successful. Registering for linking...');
            socket.emit('register-for-provisioning', deviceId);
            provisionWindow.webContents.send('provision-status', {
                type: 'success',
                message: 'Connected. Waiting for linking from control panel...',
            });
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
                    body: JSON.stringify({ deviceId }),
                });

                if (!response.ok) throw new Error('Error obtaining token from server');

                const { token } = await response.json();

                // Save all configuration, including the successful URL
                saveConfig({
                    deviceId,
                    provisioned: true,
                    agentToken: token,
                    serverUrl: pendingServerUrl,
                });

                log.info('[PROVISIONING]: Configuracion guardada. Reiniciando...');

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

    // Basic handlers
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
