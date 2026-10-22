const { autoUpdater } = require('electron-updater');
const { log, briefError } = require('../utils/logConfig');
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

let isCheckingForUpdate = false;
let checksumRetries = 0;

const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000;
let updateCheckTimer = null;

// Routine updates wait for the quiet hours; forced ones install at once.
const INSTALL_WINDOW_START_HOUR = 3;
const INSTALL_WINDOW_END_HOUR = 6;
let installRequested = false;
let installWindowTimer = null;
let downloadedVersion = null;

function inInstallWindow(date = new Date()) {
    const hour = date.getHours();
    return hour >= INSTALL_WINDOW_START_HOUR && hour < INSTALL_WINDOW_END_HOUR;
}

function installNow(reason) {
    if (installWindowTimer) {
        clearInterval(installWindowTimer);
        installWindowTimer = null;
    }
    log.info(`[UPDATER]: Installing update (${reason}).`);
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 5000);
}

// Dev builds only run updates if dev-app-update.yml exists; otherwise electron-updater spams ENOENT.
const DEV_UPDATE_CONFIG = path.join(__dirname, '..', 'dev-app-update.yml');
function updatesEnabled() {
    return app.isPackaged || fs.existsSync(DEV_UPDATE_CONFIG);
}

// Cached verdict for this device's channel; control panel reads it via 'get-update-state'
// IPC so it never misreads a -beta suffix.
let lastUpdateState = { state: 'checking', message: 'Checking for updates…' };

function getUpdateState() {
    return lastUpdateState;
}

function setUpdateState(state, extra = {}) {
    lastUpdateState = { state, ...extra };
    notifyAllWindows({ type: state, state, ...extra });
}

// Defaults to 'latest' on any error — a config problem must never silently move a device to beta.
// The config is required here, not at load: the updater must keep working (and replace a broken
// build) even when the rest of the agent fails to load.
function getChannel() {
    try {
        const { loadConfig } = require('../utils/configManager');
        return loadConfig().updateChannel === 'beta' ? 'beta' : 'latest';
    } catch {
        return 'latest';
    }
}

// Beta channel opts into prereleases; stable never sees them.
function applyChannel() {
    const channel = getChannel();
    autoUpdater.channel = channel;
    autoUpdater.allowPrerelease = channel === 'beta';
    log.info(`[UPDATER]: Update channel = ${channel}`);
    return channel;
}

function configureUpdater() {
    autoUpdater.logger = {
        // The library narrates every check ("update is not available", staging ids); the
        // listeners below already log the transitions that matter.
        info: (msg) => log.debug(msg),
        // disableWebInstaller=false is intentional (nsis-web installer); suppress the deprecation noise.
        warn: (msg) => {
            if (msg && msg.includes('disableWebInstaller')) return;
            log.warn(briefError(msg));
        },
        error: (msg) => log.error(briefError(msg)),
        debug: (msg) => log.debug(msg),
    };
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowDowngrade = true;
    applyChannel();

    if (!app.isPackaged && updatesEnabled()) {
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
    if (!updatesEnabled()) {
        log.info('[UPDATER]: Dev mode without dev-app-update.yml — skipping update checks.');
        setUpdateState('up-to-date', { message: 'Updates disabled (dev)' });
        return;
    }

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
        log.error('[UPDATER]:', briefError(err));
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
                log.error(
                    '[UPDATER]: Max checksum retries reached. Suspending updates for 12 hours.'
                );
                checksumRetries = 0;
                // Reuses isCheckingForUpdate as a suspend flag for 12h.
                isCheckingForUpdate = true;
                setTimeout(
                    () => {
                        isCheckingForUpdate = false;
                    },
                    12 * 60 * 60 * 1000
                );
            }
        }
    });

    // The UI still gets every tick; only the file log is throttled to 25% steps.
    let lastLoggedPercent = -1;
    autoUpdater.on('download-progress', (progressObj) => {
        const percent = Math.round(progressObj.percent);
        const step = Math.floor(percent / 25);
        if (step > lastLoggedPercent) {
            lastLoggedPercent = step;
            log.info(`[UPDATER]: Downloading: ${percent}%`);
        }
        setUpdateState('downloading', { message: `Downloading ${percent}%`, percent });
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('[UPDATER]: Update downloaded:', info.version);
        downloadedVersion = info.version;
        if (installRequested || inInstallWindow()) {
            setUpdateState('downloaded', {
                message: 'Update downloaded. Restarting...',
                version: info.version,
            });
            installNow(installRequested ? 'forced' : 'install window');
            return;
        }

        setUpdateState('downloaded', {
            message: `Update downloaded. It will install between ${INSTALL_WINDOW_START_HOUR}:00 and ${INSTALL_WINDOW_END_HOUR}:00.`,
            version: info.version,
        });
        if (!installWindowTimer) {
            installWindowTimer = setInterval(() => {
                if (inInstallWindow()) installNow('install window');
            }, 60 * 1000);
        }
    });

    autoUpdater.disableWebInstaller = false;
    autoUpdater.allowDowngrade = true;
    applyChannel();

    setUpdateState('checking', { message: 'Checking for updates…' });
    // Rejection is already reported by the 'error' listener above; swallow it here so
    // a single failure isn't logged twice.
    autoUpdater.checkForUpdates().catch(() => {});

    // checkForUpdates() can run multiple times (boot/delayed/force); only the first starts the periodic timer.
    if (!updateCheckTimer) {
        log.info('[UPDATER]: Periodic update check started (every 60 min).');
        updateCheckTimer = setInterval(() => {
            if (!isCheckingForUpdate) {
                autoUpdater.checkForUpdates().catch(() => {});
            }
        }, UPDATE_CHECK_INTERVAL_MS);
    }
}

// app.exit() skips autoInstallOnAppQuit, so a scheduled restart installs it here.
function installPendingUpdate(reason) {
    if (!downloadedVersion) return false;
    installNow(`${reason}, ${downloadedVersion}`);
    return true;
}

async function handleForceUpdate() {
    if (isCheckingForUpdate) {
        log.info('[UPDATER]: An update check is already in progress.');
        return;
    }
    log.info('[UPDATER]: Forcing update check...');

    installRequested = true;
    isCheckingForUpdate = true;
    await checkForUpdates();

    setTimeout(
        () => {
            isCheckingForUpdate = false;
        },
        3 * 60 * 1000
    );
}

// Remote command: switch channel then re-check immediately so beta devices don't wait for the next interval.
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

    if (!updatesEnabled()) {
        log.info('[UPDATER]: Dev mode — channel persisted but update re-check skipped.');
        return;
    }

    if (!isCheckingForUpdate) {
        autoUpdater.checkForUpdates().catch(() => {});
    }
}

module.exports = {
    configureUpdater,
    checkForUpdates,
    handleForceUpdate,
    handleSetChannel,
    getUpdateState,
    installPendingUpdate,
};
