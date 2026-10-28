const { Tray, Menu, app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { log } = require('../utils/logConfig');
const { handleForceUpdate } = require('./updater');

let tray = null;
let controlWindow = null;

// getStatus returns what the control panel shows: { version, connection, deviceName, screens }.
function createTray(getStatus) {
    if (tray) return tray;

    // The panel polls it: screen content changes without any event of its own.
    ipcMain.handle('get-agent-info', () => getStatus());

    try {
        const iconPath = path.join(__dirname, '..', 'icons', 'icon.png');
        tray = new Tray(iconPath);

        const contextMenu = Menu.buildFromTemplate([
            { label: `ScreensWeb Agent v${getStatus().version}`, enabled: false },
            { type: 'separator' },
            { label: 'Open Control Panel', click: () => openControlWindow(getStatus) },
            { type: 'separator' },
            {
                label: 'Restart Agent',
                click: () => {
                    log.info('[TRAY]: Restarting...');
                    app.relaunch();
                    app.exit(0);
                },
            },
            { label: 'Check for Updates', click: () => handleForceUpdate() },
            { type: 'separator' },
            {
                label: 'Exit',
                click: () => {
                    log.info('[TRAY]: Exiting...');
                    app.quit();
                },
            },
        ]);

        tray.setToolTip('ScreensWeb Agent');
        tray.setContextMenu(contextMenu);
        return tray;
    } catch (error) {
        log.error('[TRAY]: Error creating tray icon:', error);
        return null;
    }
}

function updateControlWindow(info) {
    if (controlWindow && !controlWindow.isDestroyed()) {
        controlWindow.webContents.send('agent-info', info);
    }
}

function openControlWindow(getStatus) {
    if (controlWindow) {
        controlWindow.focus();
        return;
    }

    controlWindow = new BrowserWindow({
        width: 420,
        height: 640,
        title: 'ScreensWeb Control',
        icon: path.join(__dirname, '..', 'icons', 'icon.png'),
        frame: false,
        resizable: false,
        alwaysOnTop: true,
        backgroundColor: '#141312',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, '..', 'preload.js'),
        },
    });

    controlWindow.loadFile(path.join(__dirname, '..', 'control.html'));

    controlWindow.webContents.on('did-finish-load', () => {
        controlWindow.webContents.send('agent-info', getStatus());
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

module.exports = { createTray, updateControlWindow };
