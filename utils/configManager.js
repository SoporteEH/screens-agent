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
        log.error('[CONFIG]: Error reading:', error);
        return {};
    }
}

function saveConfig(config) {
    try {
        store.set(config);
    } catch (error) {
        log.error('[CONFIG]: Error saving:', error);
    }
}

function deleteConfig() {
    try {
        store.clear();
        log.info('[CONFIG]: Configuration deleted.');
    } catch (error) {
        log.error('[CONFIG]: Error clearing:', error);
    }
}

module.exports = { loadConfig, saveConfig, deleteConfig };
