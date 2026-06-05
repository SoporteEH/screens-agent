/**
 * Manages update checking, downloading, and installation.
 */

const { autoUpdater } = require('electron-updater');
const { log } = require('../utils/logConfig');
const { app, BrowserWindow } = require('electron');

let isCheckingForUpdate = false;
let checksumRetries = 0;

// Latest update verdict from electron-updater for THIS device's channel
// (latest.yml or beta.yml). The control panel reads this via the
// 'get-update-state' IPC instead of doing its own version math, so the
// indicator is always channel-correct and never misreads a -beta suffix.
let lastUpdateState = { state: 'checking', message: 'Comprobando versión…' };

function getUpdateState() {
    return lastUpdateState;
}

// Records the verdict and pushes it to any open window in one place.
function setUpdateState(state, extra = {}) {
    lastUpdateState = { state, ...extra };
    notifyAllWindows({ type: state, state, ...extra });
}

/**
 * Reads the device's update channel from config. Defaults to 'latest' (stable)
 * on any error so a config problem can never silently move a device to beta.
 */
function getChannel() {
    try {
        const { loadConfig } = require('../utils/configManager');
        return loadConfig().updateChannel === 'beta' ? 'beta' : 'latest';
    } catch (_) {
        return 'latest';
    }
}

/**
 * Points electron-updater at the right channel file (latest.yml vs beta.yml).
 * Beta devices opt into prereleases; stable devices never see them.
 */
function applyChannel() {
    const channel = getChannel();
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = channel === 'beta';
    log.info(`[UPDATER]: Update channel = ${channel}`);
    return channel;
}

function configureUpdater() {
    autoUpdater.logger = {
        info: (msg) => {
            if (msg && !msg.includes('Checking for update')) log.info(msg);
        },
        // disableWebInstaller=false is intentional (we ship the nsis-web installer),
        // so electron-updater's deprecation warning about it is just noise.
        warn: (msg) => {
            if (msg && msg.includes('disableWebInstaller')) return;
            log.warn(msg);
        },
        error: (msg) => log.error(msg),
        debug: (msg) => log.debug(msg)
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = true;
    applyChannel();

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
        setUpdateState('downloading', {
            message: `Downloading version ${info.version}...`,
            version: info.version,
        });
    });

    autoUpdater.on('update-not-available', () => {
        isCheckingForUpdate = false;
        setUpdateState('up-to-date', { message: 'Agent is up to date' });
    });

    autoUpdater.on('error', (err) => {
        log.error('[UPDATER]: Update error:', err);
        isCheckingForUpdate = false;
        setUpdateState('error', { message: 'Error checking for updates' });

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
        const percent = Math.round(progressObj.percent);
        log.info(`[UPDATER]: Downloading: ${percent}%`);
        setUpdateState('downloading', { message: `Downloading ${percent}%`, percent });
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('[UPDATER]: Update downloaded:', info.version);
        setUpdateState('downloaded', {
            message: 'Update downloaded. Restarting...',
            version: info.version,
        });

        setTimeout(() => autoUpdater.quitAndInstall(true, true), 5000);
    });

    autoUpdater.disableWebInstaller = false;
    autoUpdater.allowDowngrade = true;
    applyChannel();

    setUpdateState('checking', { message: 'Comprobando versión…' });
    autoUpdater.checkForUpdates().catch((error) => {
        log.error('[UPDATER]: Error checking for updates:', error);
        isCheckingForUpdate = false;
        setUpdateState('error', { message: 'Error checking for updates' });
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

/**
 * Remote command: move this device between the 'latest' (stable) and 'beta'
 * (canary) update channels, then immediately re-check so beta devices pick up
 * the staged build without waiting for the next interval.
 */
async function handleSetChannel(command) {
    const requested = command && command.channel;
    if (requested !== 'beta' && requested !== 'latest') {
        log.warn(`[UPDATER]: set_channel ignored — invalid channel: ${JSON.stringify(requested)}`);
        return;
    }

    try {
        const { saveConfig } = require('../utils/configManager');
        saveConfig({ updateChannel: requested });
    } catch (e) {
        log.error('[UPDATER]: Failed to persist update channel:', e);
        return;
    }

    log.info(`[UPDATER]: Update channel set to "${requested}". Re-checking for updates...`);
    applyChannel();

    if (!isCheckingForUpdate) {
        autoUpdater.checkForUpdates().catch((e) =>
            log.error('[UPDATER]: set_channel re-check failed:', e)
        );
    }
}

module.exports = {
    configureUpdater,
    checkForUpdates,
    isUpdating,
    setUpdating,
    handleForceUpdate,
    handleSetChannel,
    getUpdateState,
};
