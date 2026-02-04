/**
 * Gestiona búsqueda, descarga e instalación de actualizaciones.
 */

const { autoUpdater } = require('electron-updater');
const { log } = require('../utils/logConfig');
const { app, BrowserWindow } = require('electron');

let isCheckingForUpdate = false;

function configureUpdater() {
    autoUpdater.logger = log;
    autoUpdater.logger.transports.file.level = 'info';
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
    log.info('[UPDATER]: Buscando actualizaciones...');

    autoUpdater.removeAllListeners('update-available');
    autoUpdater.removeAllListeners('update-not-available');
    autoUpdater.removeAllListeners('error');
    autoUpdater.removeAllListeners('download-progress');
    autoUpdater.removeAllListeners('update-downloaded');

    autoUpdater.on('update-available', (info) => {
        log.info('[UPDATER]: Actualización disponible:', info.version);
        notifyAllWindows({
            type: 'downloading',
            message: `Descargando versión ${info.version}...`,
        });
    });

    autoUpdater.on('update-not-available', () => {
        log.info('[UPDATER]: Ya estás en la última versión.');
        isCheckingForUpdate = false;
        notifyAllWindows({ type: 'up-to-date', message: 'Agente en la última versión' });
    });

    autoUpdater.on('error', (err) => {
        log.error('[UPDATER]: Error en la actualización:', err);
        isCheckingForUpdate = false;
        notifyAllWindows({ status: 'error', message: 'Error al buscar actualización' });

        if (err.message && err.message.includes('checksum')) {
            log.info('[UPDATER]: Error de checksum. Reintentando...');
            autoUpdater.autoDownload = true;
            autoUpdater.allowDowngrade = true;
            autoUpdater.checkForUpdates();
        }
    });

    autoUpdater.on('download-progress', (progressObj) => {
        log.info(`[UPDATER]: Descargando: ${Math.round(progressObj.percent)}%`);
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('[UPDATER]: Actualización descargada:', info.version);
        notifyAllWindows({
            type: 'downloaded',
            message: 'Actualización descargada. Reiniciando...',
        });

        setTimeout(() => autoUpdater.quitAndInstall(true, true), 5000);
    });

    autoUpdater.disableWebInstaller = false;
    autoUpdater.allowDowngrade = true;

    autoUpdater.checkForUpdates().catch((error) => {
        log.error('[UPDATER]: Error al buscar actualizaciones:', error);
        isCheckingForUpdate = false;
    });

    setInterval(
        () => {
            if (!isCheckingForUpdate) {
                log.info('[UPDATER]: Reintento periódico...');
                autoUpdater.checkForUpdates().catch(() => {});
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
        log.info('[UPDATER]: Ya hay una búsqueda en curso.');
        return;
    }
    log.info('[UPDATER]: Forzando búsqueda de actualizaciones...');

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
