const { ipcMain, app } = require('electron');
const { log } = require('../utils/logConfig');
const { handleForceUpdate, getUpdateState } = require('../services/updater');

// The control panel's buttons (js/control.js).
const registerIpcHandlers = () => {
    ipcMain.on('agent-action', (event, { action }) => {
        log.debug(`[IPC]: Action received: ${action}`);

        switch (action) {
            case 'restart':
                log.info('[IPC]: Restarting agent...');
                app.relaunch();
                app.exit(0);
                break;
            case 'check-update':
                log.info('[IPC]: Forcing update check...');
                handleForceUpdate();
                break;
            case 'quit':
                log.info('[IPC]: Closing agent...');
                app.quit();
                break;
        }
    });

    ipcMain.handle('get-update-state', () => getUpdateState());
};

module.exports = { registerIpcHandlers };
