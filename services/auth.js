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

function startTokenRefreshLoop(agentToken, onTokenRefreshed) {
    log.info(
        `[AUTH]: Starting token verification loop (interval: ${CONSTANTS.TOKEN_CHECK_INTERVAL_MS / 3600000}h)`
    );
    let currentToken = agentToken;

    return setInterval(async () => {
        try {
            if (!currentToken) return;

            const decoded = jwtDecode(currentToken);
            const remainingMs = decoded.exp * 1000 - Date.now();

            if (remainingMs < REFRESH_WHEN_REMAINING_MS) {
                if (remainingMs <= 0) {
                    log.warn('[AUTH]: Token already expired, attempting recovery refresh...');
                } else {
                    log.info('[AUTH]: Token near expiration, refreshing...');
                }

                const newToken = await refreshAgentToken(currentToken);
                if (newToken !== currentToken) {
                    currentToken = newToken;
                    onTokenRefreshed?.(newToken);
                }
            }
        } catch (e) {
            log.error('[AUTH]: Error in token verification loop:', e);
        }
    }, CONSTANTS.TOKEN_CHECK_INTERVAL_MS);
}

module.exports = {
    refreshAgentToken,
    startTokenRefreshLoop,
};
