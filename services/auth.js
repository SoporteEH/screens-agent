/**
 * Authentication Service - JWT Token Refresh + mTLS cert renewal
 */

const { jwtDecode } = require('jwt-decode');
const { log } = require('../utils/logConfig');
const { loadConfig, saveConfig } = require('../utils/configManager');
const { getHttpClient, resetHttpClient } = require('../utils/httpClient');

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

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

async function renewCertIfNeeded() {
    const config = loadConfig();
    if (!config.certPem || !config.agentToken) return;

    try {
        // Parse cert expiry from PEM using built-in crypto
        const { X509Certificate } = require('crypto');
        const cert = new X509Certificate(config.certPem);
        const expiresAt = new Date(cert.validTo);
        const daysLeft = (expiresAt - Date.now()) / (1000 * 60 * 60 * 24);

        if (daysLeft > 30) return;

        log.info(`[AUTH]: Certificate expires in ${Math.floor(daysLeft)} days — renewing...`);
        const client = getHttpClient();
        const { data } = await client.post('/api/auth/agent-cert-renew', {}, {
            headers: { Authorization: `Bearer ${config.agentToken}` },
        });

        saveConfig({ ...config, certPem: data.certPem, keyPem: data.keyPem });
        resetHttpClient(); // force new https.Agent with renewed cert
        log.info('[AUTH]: Certificate renewed successfully.');
    } catch (err) {
        log.error('[AUTH]: Certificate renewal failed:', err.message);
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

            // Check if mTLS cert needs renewal (30 days before expiry)
            await renewCertIfNeeded();
        } catch (e) {
            log.error('[AUTH]: Error in token verification loop:', e);
        }
    }, FOUR_HOURS_MS);
}

module.exports = {
    refreshAgentToken,
    renewCertIfNeeded,
    startTokenRefreshLoop,
};
