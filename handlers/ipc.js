const { ipcMain, app } = require('electron');
const { log } = require('../utils/logConfig');
const { openControlWindow } = require('../services/tray');
const { handleForceUpdate, getUpdateState } = require('../services/updater');

const registerIpcHandlers = (getServerUrl, AGENT_VERSION, getStatus) => {
    ipcMain.on('agent-action', (event, { action, data }) => {
        log.info(`[IPC]: Action received: ${action}`);

        switch (action) {
            case 'restart':
            case 'restart-agent':
                log.info('[IPC]: Restarting agent...');
                app.relaunch();
                app.exit(0);
                break;
            case 'check-update':
                log.info('[IPC]: Forcing update check...');
                handleForceUpdate();
                break;
            case 'quit':
            case 'quit-agent':
                log.info('[IPC]: Closing agent...');
                app.isQuitting = true;
                app.quit();
                break;
            case 'open-control':
                const status = typeof getStatus === 'function' ? getStatus() : { isOnline: true };
                openControlWindow(getServerUrl(), AGENT_VERSION, status);
                break;
        }
    });

    ipcMain.handle('get-app-version', () => {
        return AGENT_VERSION;
    });

    // Channel-correct update verdict from electron-updater, for the control panel.
    ipcMain.handle('get-update-state', () => getUpdateState());
};

module.exports = { registerIpcHandlers };
