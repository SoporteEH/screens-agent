const { jwtDecode } = require('jwt-decode');
const { log } = require('../utils/logConfig');
const { loadConfig, saveConfig } = require('../utils/configManager');
const { getHttpClient } = require('../utils/httpClient');
const { CONSTANTS } = require('../config/constants');

// Refresh well ahead of expiry
const REFRESH_WHEN_REMAINING_MS = 90 * 24 * 60 * 60 * 1000;

async function refreshAgentToken(currentAgentToken) {
    log.info('[AUTH]: Refreshing agent token...');
    try {
        const client = getHttpClient();
        const { data } = await client.post('/api/auth/agent-refresh', {}, {
            headers: { Authorization: `Bearer ${currentAgentToken}` },
        });

        const config = loadConfig();
        config.agentToken = data.token;
        saveConfig(config);

        log.info('[AUTH]: Token successfully refreshed.');
        return data.token;
    } catch (error) {
        log.error('[AUTH]: Error refreshing token:', error.message);
        return currentAgentToken;
    }
}

// The refresh limiter is 10/h per IP, shared by the whole site.
const REJECTION_REFRESH_MIN_INTERVAL_MS = 15 * 60 * 1000;

let currentToken = null;
let onRefreshed = null;
let lastRejectionRefreshAt = 0;

async function refreshIfNeeded({ force = false } = {}) {
    if (!currentToken) return false;
    try {
        const decoded = jwtDecode(currentToken);
        const remainingMs = decoded.exp * 1000 - Date.now();
        if (!force && remainingMs >= REFRESH_WHEN_REMAINING_MS) return false;

        if (remainingMs <= 0) log.warn('[AUTH]: Token already expired, attempting recovery refresh...');
        else if (force) log.warn('[AUTH]: Server rejected the token, attempting a refresh...');
        else log.info('[AUTH]: Token near expiration, refreshing...');

        const newToken = await refreshAgentToken(currentToken);
        if (newToken === currentToken) return false;
        currentToken = newToken;
        onRefreshed?.(newToken);
        return true;
    } catch (e) {
        log.error('[AUTH]: Error in token verification loop:', e);
        return false;
    }
}

// Also checks at start: an expired token would keep the screens offline for hours.
function startTokenRefreshLoop(agentToken, onTokenRefreshed) {
    log.info(
        `[AUTH]: Starting token verification loop (interval: ${CONSTANTS.TOKEN_CHECK_INTERVAL_MS / 3600000}h)`
    );
    currentToken = agentToken;
    onRefreshed = onTokenRefreshed;
    refreshIfNeeded();
    return setInterval(() => refreshIfNeeded(), CONSTANTS.TOKEN_CHECK_INTERVAL_MS);
}

// On a refused handshake; true when a new token was obtained.
async function refreshAfterRejection() {
    const now = Date.now();
    if (now - lastRejectionRefreshAt < REJECTION_REFRESH_MIN_INTERVAL_MS) return false;
    lastRejectionRefreshAt = now;
    return refreshIfNeeded({ force: true });
}

module.exports = {
    refreshAgentToken,
    startTokenRefreshLoop,
    refreshAfterRejection,
};
