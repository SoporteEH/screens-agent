
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
const CONTENT_DIR = path.join(CONFIG_DIR, 'content');
const PLAYLIST_ASSETS_DIR = path.join(CONFIG_DIR, 'playlist-assets');

const AGENT_REFRESH_URL = SERVER_URL ? `${SERVER_URL}/api/auth/agent-refresh` : '';
const SYNC_API_URL = SERVER_URL ? `${SERVER_URL}/api/users/me/local-assets` : '';

const CONSTANTS = {
    HEARTBEAT_INTERVAL_MS: 30 * 1000, // Heartbeat every 30 seconds
    TOKEN_CHECK_INTERVAL_MS: 4 * 60 * 60 * 1000, // Verify token every 4 hours
    UPDATE_CHECK_MIN_DELAY_MS: 15000, // Minimum delay before checking for updates
    UPDATE_CHECK_MAX_DELAY_MS: 60000, // Maximum delay before checking for updates
    SCREEN_DEBOUNCE_MS: 500, // Debounce for screen changes
    RETRY_BACKOFF_BASE_MS: 30 * 1000, // Exponential backoff base
    MAX_RETRIES: 5, // Maximum retries
    GC_INTERVAL_MS: 4 * 60 * 60 * 1000, // Garbage collection every 4 hours
    NETWORK_CHECK_INTERVAL_MS: 3000, // Network monitoring every 3 seconds
    SOCKET_RECONNECT_DELAY_MAX_MS: 60 * 1000, // Maximum delay between reconnections
    FALLBACK_DELAY_MS: 4000, // 4 seconds delay before fallback
};

let AGENT_VERSION = 'Unknown';
try {
    const packageJson = require('../package.json');
    AGENT_VERSION = packageJson.version;
} catch (e) {
    console.error('[CONFIG]: Failed to read version from package.json');
}

// Helper to get updated server URL
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
    CONTENT_DIR,
    PLAYLIST_ASSETS_DIR,
    AGENT_REFRESH_URL,
    SYNC_API_URL,
    CONSTANTS,
    AGENT_VERSION,
};
