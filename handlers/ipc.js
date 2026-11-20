const { ipcMain, app } = require('electron');
const { log } = require('../utils/logConfig');
const { handleForceUpdate, getUpdateState } = require('../services/updater');

// The control panel's buttons (js/control.js).
const registerIpcHandlers = ({ reconnect, identify, catalogue } = {}) => {
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
            case 'reconnect':
                log.info('[IPC]: Reconnecting to the server...');
                reconnect?.();
                break;
            case 'quit':
                log.info('[IPC]: Closing agent...');
                app.quit();
                break;
        }
    });

    ipcMain.handle('get-update-state', () => getUpdateState());

    ipcMain.on('identify-screen', (_event, screenId) => {
        if (typeof screenId === 'string') identify?.(screenId);
    });

    // Connected, the API applies the salon's rules; offline, the saved catalogue does.
    ipcMain.handle('get-catalogue', () => catalogue.getCatalogue());
    ipcMain.handle('show-content', (_event, { screenId, contentId } = {}) => {
        if (typeof screenId !== 'string' || typeof contentId !== 'string') {
            return { error: 'invalid' };
        }
        log.info(`[IPC]: Control window puts content ${contentId} on screen ${screenId}`);
        return catalogue.showContent(screenId, contentId);
    });
};

module.exports = { registerIpcHandlers };
