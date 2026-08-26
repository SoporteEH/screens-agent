const Store = require('electron-store');
const crypto = require('crypto');
const { log } = require('./logConfig');

const LEGACY_KEY = 'screensweb-agent-secure-key';
const SENSITIVE_FIELDS = ['agentToken'];

let _usingFallbackKey = false;
let _hardwareKey;

function getHardwareKey() {
    if (_hardwareKey !== undefined) return _hardwareKey;
    try {
        const { machineIdSync } = require('node-machine-id');
        _hardwareKey = `screensweb-${machineIdSync({ original: true })}`;
    } catch (e) {
        _hardwareKey = null;
    }
    return _hardwareKey;
}

function initStore() {
    const hwKey = getHardwareKey();

    if (!hwKey) {
        log.error('[CONFIG]: Hardware ID unavailable. The agent token will NOT be persisted — device requires re-provisioning after each restart.');
        _usingFallbackKey = true;
        return new Store({ name: 'config', encryptionKey: LEGACY_KEY, clearInvalidConfig: true });
    }

    // Non-destructive probe (clearInvalidConfig: false)
    try {
        const hwStore = new Store({ name: 'config', encryptionKey: hwKey, clearInvalidConfig: false });
        const data = hwStore.store;

        if (data && Object.keys(data).length > 0) {
            return hwStore;
        }
    } catch (_) {

    }

    let legacyData = null;
    try {
        const legacyStore = new Store({
            name: 'config',
            encryptionKey: LEGACY_KEY,
            clearInvalidConfig: false,
        });
        const data = legacyStore.store;
        if (data && Object.keys(data).length > 0) {
            legacyData = { ...data };
        }
    } catch (_) {
        
    }

    const finalStore = new Store({ name: 'config', encryptionKey: hwKey, clearInvalidConfig: true });

    if (legacyData) {
        Object.entries(legacyData).forEach(([k, v]) => finalStore.set(k, v));
        log.info('[CONFIG]: Config migrated from shared key to per-device key.');
    }

    return finalStore;
}

const store = initStore();

function loadConfig() {
    try {
        const data = store.store;
        if (_usingFallbackKey) {
            const safe = { ...data };
            SENSITIVE_FIELDS.forEach((f) => delete safe[f]);
            return safe;
        }
        return data;
    } catch (error) {
        log.error('[CONFIG]: Error reading:', error);
        return {};
    }
}

function saveConfig(config) {
    try {
        if (_usingFallbackKey) {
            const safe = { ...config };
            SENSITIVE_FIELDS.forEach((f) => delete safe[f]);
            store.set(safe);
        } else {
            store.set(config);
        }
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

function getAesKey() {
    const hwKey = getHardwareKey();
    if (!hwKey) return null;
    return crypto.createHash('sha256').update(hwKey).digest(); // 32 bytes
}

function encryptCredentials(credentials) {
    if (!credentials) return null;
    const key = getAesKey();
    if (!key) return null;
    try {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const plaintext = JSON.stringify(credentials);
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const authTag = cipher.getAuthTag();
        return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
    } catch (e) {
        log.error('[CONFIG]: Failed to encrypt credentials:', e);
        return null;
    }
}

function decryptCredentials(encrypted) {
    if (!encrypted || typeof encrypted !== 'string') return null;
    const key = getAesKey();
    if (!key) return null;
    try {
        const [ivHex, tagHex, ctHex] = encrypted.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(tagHex, 'hex');
        const ciphertext = Buffer.from(ctHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        const plaintext = decipher.update(ciphertext) + decipher.final('utf8');
        return JSON.parse(plaintext);
    } catch (e) {
        log.error('[CONFIG]: Failed to decrypt credentials — may be legacy plaintext:', e.message);
        return null;
    }
}

module.exports = { loadConfig, saveConfig, deleteConfig, encryptCredentials, decryptCredentials };
