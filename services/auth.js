/**
 * Authentication Service - JWT Token Refresh
 */

const { jwtDecode } = require('jwt-decode');
const { log } = require('../utils/logConfig');
const { AGENT_REFRESH_URL } = require('../config/constants');
const { loadConfig, saveConfig } = require('../utils/configManager');

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function refreshAgentToken(currentAgentToken) {
    log.info('[AUTH]: Refreshing agent token...');
    try {
        const response = await fetch(AGENT_REFRESH_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${currentAgentToken}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ msg: 'Network error' }));
            throw new Error(`API error: ${response.status} - ${errorData.msg}`);
        }

        const data = await response.json();
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
    log.info('[AUTH]: Starting token verification loop (interval: 4h)');
    let currentToken = agentToken;

    return setInterval(async () => {
        try {
            if (!currentToken) return;

            const decoded = jwtDecode(currentToken);
            const expTimeMs = decoded.exp * 1000;

            if (expTimeMs - Date.now() < THIRTY_DAYS_MS) {
                log.info('[AUTH]: Token near expiration, refreshing...');
                const newToken = await refreshAgentToken(currentToken);
                if (newToken !== currentToken) {
                    currentToken = newToken;
                    onTokenRefreshed?.(newToken);
                }
            }
        } catch (e) {
            log.error('[AUTH]: Error in token verification loop:', e);
        }
    }, FOUR_HOURS_MS);
}

module.exports = {
    refreshAgentToken,
    startTokenRefreshLoop,
};
