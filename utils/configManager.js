/**
 * Config Manager - electron-store wrapper
 */

const Store = require('electron-store');
const { log } = require('./logConfig');

const store = new Store({
    name: 'config',
    encryptionKey: 'screensweb-agent-secure-key',
    clearInvalidConfig: true,
});

function loadConfig() {
    try {
        return store.store;
    } catch (error) {
        log.error('[CONFIG]: Error leyendo:', error);
        return {};
    }
}

function saveConfig(config) {
    try {
        store.set(config);
    } catch (error) {
        log.error('[CONFIG]: Error guardando:', error);
    }
}

function deleteConfig() {
    try {
        store.clear();
        log.info('[CONFIG]: Configuracion eliminada.');
    } catch (error) {
        log.error('[CONFIG]: Error limpiando:', error);
    }
}

module.exports = { loadConfig, saveConfig, deleteConfig };
