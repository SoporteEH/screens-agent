
const { app } = require('electron');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { loadConfig } = require('../utils/configManager');
const config = loadConfig();
let SERVER_URL = config.serverUrl || process.env.SERVER_URL;

if (!SERVER_URL) {
    try {
        const packageJson = require('../package.json');
        SERVER_URL = packageJson.config?.serverUrl;
    } catch (e) {
    }
}

const CONFIG_DIR = path.join(app.getPath('userData'), 'ScreensWeb');
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'config.json');
const STATE_FILE_PATH = path.join(CONFIG_DIR, 'state.json');
const DISPLAYS_FILE_PATH = path.join(CONFIG_DIR, 'displays.json');
const CONTENT_DIR = path.join(CONFIG_DIR, 'content');

const AGENT_REFRESH_URL = SERVER_URL ? `${SERVER_URL}/api/auth/agent-refresh` : '';
const SYNC_API_URL = SERVER_URL ? `${SERVER_URL}/api/users/me/local-assets` : '';

const CONSTANTS = {
    HEARTBEAT_INTERVAL_MS: 60 * 1000,
    TOKEN_CHECK_INTERVAL_MS: 4 * 60 * 60 * 1000,
    UPDATE_CHECK_MIN_DELAY_MS: 15000,
    UPDATE_CHECK_MAX_DELAY_MS: 60000,
    SCREEN_DEBOUNCE_MS: 500,
    RETRY_BACKOFF_BASE_MS: 30 * 1000,
    GC_INTERVAL_MS: 4 * 60 * 60 * 1000,
    SOCKET_RECONNECT_DELAY_MS: 3 * 1000,
    SOCKET_RECONNECT_DELAY_MAX_MS: 5 * 60 * 1000,
    CIRCUIT_BREAKER_THRESHOLD: 10,
    FALLBACK_DELAY_MS: 4000,
    RECONNECT_RELOAD_THRESHOLD_MS: 2 * 60 * 1000, // Skip live-screen reloads for socket blips shorter than this
};

let AGENT_VERSION = 'Unknown';
try {
    const packageJson = require('../package.json');
    AGENT_VERSION = packageJson.version;
} catch (e) {
    console.error('[CONFIG]: Failed to read version from package.json');
}

function getServerUrl() {
    const freshConfig = loadConfig();
    return freshConfig.serverUrl || SERVER_URL;
}

module.exports = {
    SERVER_URL,
    getServerUrl,
    CONFIG_DIR,
    CONFIG_FILE_PATH,
    STATE_FILE_PATH,
    DISPLAYS_FILE_PATH,
    CONTENT_DIR,
    AGENT_REFRESH_URL,
    SYNC_API_URL,
    CONSTANTS,
    AGENT_VERSION,
};
