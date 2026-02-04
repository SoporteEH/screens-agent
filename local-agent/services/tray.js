/**
 * Tray Service - Icono de bandeja del sistema
 */

const { Tray, Menu, app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { log } = require('../utils/logConfig');
const { getDeviceName } = require('./identity');

let tray = null;
let controlWindow = null;

function createTray(serverUrl, version) {
    if (tray) return tray;

    try {
        const iconPath = path.join(__dirname, '..', 'icons', 'icon.png');
        tray = new Tray(iconPath);

        const contextMenu = Menu.buildFromTemplate([
            { label: `ScreensWeb Agent v${version}`, enabled: false },
            { label: 'Servidor: ' + (serverUrl || 'No configurado'), enabled: false },
            { type: 'separator' },
            { label: 'Abrir Panel de Control', click: () => openControlWindow(serverUrl, version) },
            { type: 'separator' },
            {
                label: 'Reiniciar Agente',
                click: () => {
                    log.info('[TRAY]: Reiniciando...');
                    app.relaunch();
                    app.exit(0);
                },
            },
            {
                label: 'Buscar Actualizacion',
                click: () => require('./updater').handleForceUpdate(),
            },
            { type: 'separator' },
            {
                label: 'Salir',
                click: () => {
                    log.info('[TRAY]: Saliendo...');
                    app.isQuitting = true;
                    app.quit();
                },
            },
        ]);

        tray.setToolTip('ScreensWeb Agent');
        tray.setContextMenu(contextMenu);
        tray.on('double-click', () => openControlWindow(serverUrl, version));

        return tray;
    } catch (error) {
        log.error('[TRAY]: Error al crear tray:', error);
        return null;
    }
}

function openControlWindow(serverUrl, version) {
    if (controlWindow) {
        controlWindow.focus();
        return;
    }

    controlWindow = new BrowserWindow({
        width: 420,
        height: 600,
        title: 'ScreensWeb Control',
        icon: path.join(__dirname, '..', 'icons', 'icon.png'),
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        backgroundColor: '#1a1a1a',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload.js'),
        },
    });

    controlWindow.loadFile(path.join(__dirname, '..', 'control.html'));

    controlWindow.webContents.on('did-finish-load', () => {
        controlWindow.webContents.send('agent-info', {
            serverUrl: serverUrl || 'Desconocido',
            version: version || '1.0.0',
            status: 'Online',
            deviceName: getDeviceName(),
        });
    });

    controlWindow.on('closed', () => {
        controlWindow = null;
    });

    controlWindow.setMenuBarVisibility(false);

    ipcMain.removeAllListeners('window-control');
    ipcMain.on('window-control', (_event, action) => {
        if (controlWindow && !controlWindow.isDestroyed()) {
            if (action === 'minimize') controlWindow.minimize();
            else if (action === 'close') controlWindow.close();
        }
    });
}

module.exports = {
    createTray,
    openControlWindow,
};
