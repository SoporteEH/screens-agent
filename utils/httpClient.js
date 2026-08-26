const axios = require('axios');
const { loadConfig } = require('./configManager');

let _client = null;

// Shared axios instance pointed at the configured server.
function getHttpClient() {
    if (_client) return _client;

    const config = loadConfig();
    _client = axios.create({
        baseURL: config.serverUrl || '',
        timeout: 30000,
    });

    return _client;
}

/** Drops the cached client so a later call picks up a changed serverUrl. */
function resetHttpClient() {
    _client = null;
}

module.exports = { getHttpClient, resetHttpClient };
