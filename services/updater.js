/**
 * Manages update checking, downloading, and installation.
 */

const { autoUpdater } = require('electron-updater');
const { log } = require('../utils/logConfig');
const { app, BrowserWindow } = require('electron');

let isCheckingForUpdate = false;
let checksumRetries = 0;

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
        isCheckingForUpdate = false;
        notifyAllWindows({ type: 'up-to-date', message: 'Agent is up to date' });
    });

    autoUpdater.on('error', (err) => {
        log.error('[UPDATER]: Update error:', err);
        isCheckingForUpdate = false;
        notifyAllWindows({ status: 'error', message: 'Error checking for updates' });

        if (err.message && err.message.includes('checksum')) {
            if (checksumRetries < 3) {
                checksumRetries++;
                log.info(`[UPDATER]: Checksum error. Retrying... (${checksumRetries}/3)`);
                autoUpdater.autoDownload = true;
                autoUpdater.allowDowngrade = true;
                setTimeout(() => autoUpdater.checkForUpdates(), 5000);
            } else {
                log.error('[UPDATER]: Max checksum retries reached. Suspending updates for 12 hours.');
                checksumRetries = 0;
                // Block the 10-minute interval check by faking isCheckingForUpdate
                isCheckingForUpdate = true;
                setTimeout(() => {
                    isCheckingForUpdate = false;
                }, 12 * 60 * 60 * 1000);
            }
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
