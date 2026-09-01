const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { CONTENT_DIR } = require('../config/constants');

// True for URLs that cannot render without the live server.
function isServerDependentUrl(url, serverUrl) {
    if (!url) return false;
    // Views (playlists) require the live server to render.
    if (url.includes('/view/')) return true;
    if (serverUrl && url.startsWith(serverUrl)) return true;
    // localhost/127.0.0.1 = dev server, treated as server dependent.
    if (/https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(url)) return true;
    return false;
}

// local: assets resolve to file:// before reaching the wrapper iframe.
function resolveLocalContentUrl(url) {
    if (!url || !url.startsWith('local:')) return url;
    const filename = path.basename(url.substring(6));
    const filePath = path.join(CONTENT_DIR, filename);
    return fs.existsSync(filePath) ? pathToFileURL(filePath).href : '';
}

module.exports = { isServerDependentUrl, resolveLocalContentUrl };
