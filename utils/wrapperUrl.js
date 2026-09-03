const path = require('path');
const { pathToFileURL } = require('url');

// Single source of truth for the local player wrapper.
const WRAPPER_URL = pathToFileURL(path.join(__dirname, '..', 'player.html')).href;

function getWrapperUrl() {
    return WRAPPER_URL;
}

function isWrapperUrl(url) {
    if (!url) return false;
    return url.startsWith(WRAPPER_URL);
}

module.exports = { getWrapperUrl, isWrapperUrl };
