/**
 * Manages update checking, downloading, and installation.
 */

const { autoUpdater } = require('electron-updater');
const { log } = require('../utils/logConfig');
const { app, BrowserWindow } = require('electron');

let isCheckingForUpdate = false;

function configureUpdater() {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = true;
    autoUpdater.allowPrerelease = false;

    if (!app.isPackaged) {
        autoUpdater.forceDevUpdateConfig = true;
    }
    autoUpdater.fullChangelog = true;
}

function notifyAllWindows(data) {
    BrowserWindow.getAllWindows().forEach((win) => {
        if (win && !win.isDestroyed()) {
            win.webContents.send('update-status', data);
        }
    });
}

async function checkForUpdates() {
    log.info('[UPDATER]: Checking for updates...');

    autoUpdater.removeAllListeners('update-available');
    autoUpdater.removeAllListeners('update-not-available');
    autoUpdater.removeAllListeners('error');
    autoUpdater.removeAllListeners('download-progress');
    autoUpdater.removeAllListeners('update-downloaded');

    autoUpdater.on('update-available', (info) => {
        log.info('[UPDATER]: Update available:', info.version);
        notifyAllWindows({
            type: 'downloading',
            message: `Downloading version ${info.version}...`,
        });
    });

    autoUpdater.on('update-not-available', () => {
        log.info('[UPDATER]: You are currently on the latest version.');
        isCheckingForUpdate = false;
        notifyAllWindows({ type: 'up-to-date', message: 'Agent is up to date' });
    });

    autoUpdater.on('error', (err) => {
        log.error('[UPDATER]: Update error:', err);
        isCheckingForUpdate = false;
        notifyAllWindows({ status: 'error', message: 'Error checking for updates' });

        if (err.message && err.message.includes('checksum')) {
            log.info('[UPDATER]: Checksum error. Retrying...');
            autoUpdater.autoDownload = true;
            autoUpdater.allowDowngrade = true;
            autoUpdater.checkForUpdates();
        }
    });

    autoUpdater.on('download-progress', (progressObj) => {
        log.info(`[UPDATER]: Downloading: ${Math.round(progressObj.percent)}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('[UPDATER]: Update downloaded:', info.version);
        notifyAllWindows({
            type: 'downloaded',
            message: 'Update downloaded. Restarting...',
        });

        setTimeout(() => autoUpdater.quitAndInstall(true, true), 5000);
    });

    autoUpdater.disableWebInstaller = false;
    autoUpdater.allowDowngrade = true;

    autoUpdater.checkForUpdates().catch((error) => {
        log.error('[UPDATER]: Error checking for updates:', error);
        isCheckingForUpdate = false;
    });

    setInterval(
        () => {
            if (!isCheckingForUpdate) {
                log.info('[UPDATER]: Periodic update check retry...');
                autoUpdater.checkForUpdates().catch(() => { });
            }
        },
        10 * 60 * 1000
    );
}

function isUpdating() {
    return isCheckingForUpdate;
}

function setUpdating(value) {
    isCheckingForUpdate = value;
}

async function handleForceUpdate() {
    if (isCheckingForUpdate) {
        log.info('[UPDATER]: An update check is already in progress.');
        return;
    }
    log.info('[UPDATER]: Forcing update check...');

    isCheckingForUpdate = true;
    await checkForUpdates();

    setTimeout(
        () => {
            isCheckingForUpdate = false;
        },
        3 * 60 * 1000
    );
}

module.exports = {
    configureUpdater,
    checkForUpdates,
    isUpdating,
    setUpdating,
    handleForceUpdate,
};
