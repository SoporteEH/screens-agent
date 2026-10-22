const axios = require('axios');
const { loadConfig } = require('./configManager');

let _client = null;

// Shared axios instance pointed at the configured server. A new server URL comes with a
// re-provisioning, which restarts the agent.
function getHttpClient() {
    if (_client) return _client;

    const config = loadConfig();
    _client = axios.create({
        baseURL: config.serverUrl || '',
        timeout: 30000,
    });

    return _client;
}

module.exports = { getHttpClient };
