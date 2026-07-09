const https = require('https');
const axios = require('axios');
const { loadConfig } = require('./configManager');

let _httpsAgent = null;
let _client = null;

/**
 * Returns a shared https.Agent configured with the device client certificate.
 */

function getHttpsAgent() {
    if (_httpsAgent) return _httpsAgent;

    const config = loadConfig();
    const isHttps = config.serverUrl && config.serverUrl.startsWith('https://');

    if (config.certPem && config.keyPem && isHttps) {
        const agentOptions = {
            cert: config.certPem,
            key: config.keyPem,
            rejectUnauthorized: true,
        };
        
        if (config.serverCaCert) {
            agentOptions.ca = config.serverCaCert;
        }
        _httpsAgent = new https.Agent(agentOptions);
    } else {
        _httpsAgent = new https.Agent();
    }

    return _httpsAgent;
}

/**
 * Returns a shared axios instance pre-configured with the device's TLS agent.
 */
function getHttpClient() {
    if (_client) return _client;

    const config = loadConfig();
    _client = axios.create({
        baseURL: config.serverUrl || '',
        httpsAgent: getHttpsAgent(),
        timeout: 30000,
    });

    return _client;
}

/**
 * Resets cached client and agent. Call after cert renewal so new certs are used.
 */
function resetHttpClient() {
    _httpsAgent = null;
    _client = null;
}

module.exports = { getHttpClient, getHttpsAgent, resetHttpClient };
