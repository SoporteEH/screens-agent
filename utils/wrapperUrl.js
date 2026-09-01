const path = require('path');
const { pathToFileURL } = require('url');

// Single source of truth for the local player wrapper. isWrapperUrl also matches
// legacy server-served /player/ URLs so old guards keep holding during migration.
const WRAPPER_URL = pathToFileURL(path.join(__dirname, '..', 'player.html')).href;

function getWrapperUrl() {
    return WRAPPER_URL;
}

function isWrapperUrl(url) {
    if (!url) return false;
    return url.startsWith(WRAPPER_URL) || url.includes('/player/');
}

module.exports = { getWrapperUrl, isWrapperUrl };
