const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { CONTENT_DIR, ASSET_INDEX_PATH } = require('../config/constants');

// A banner's public page: its Service Worker keeps it playing with no server and no network.
function isBannerUrl(url) {
    try {
        const { protocol, pathname } = new URL(url);
        return /^https?:$/.test(protocol) && pathname.startsWith('/play/');
    } catch {
        return false;
    }
}

// True for URLs that cannot render without the live server.
function isServerDependentUrl(url, serverUrl) {
    if (!url || isBannerUrl(url)) return false;
    // Views (playlists) require the live server to render.
    if (url.includes('/view/')) return true;
    if (serverUrl && url.startsWith(serverUrl)) return true;
    // localhost/127.0.0.1 = dev server, treated as server dependent.
    if (/https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(url)) return true;
    return false;
}

function readAssetIndex() {
    try {
        return JSON.parse(fs.readFileSync(ASSET_INDEX_PATH, 'utf8'));
    } catch {
        return {};
    }
}

// `local:<assetId>` → absolute path of the synced file, or '' when it is not on disk.
function localAssetPath(url) {
    if (!url || !url.startsWith('local:')) return '';
    const serverFilename = readAssetIndex()[url.slice('local:'.length)];
    if (!serverFilename) return '';
    const filePath = path.join(CONTENT_DIR, path.basename(serverFilename));
    return fs.existsSync(filePath) ? filePath : '';
}

// local: assets resolve to file:// before reaching the wrapper iframe.
function resolveLocalContentUrl(url) {
    if (!url || !url.startsWith('local:')) return url;
    const filePath = localAssetPath(url);
    return filePath ? pathToFileURL(filePath).href : '';
}

module.exports = { isBannerUrl, isServerDependentUrl, localAssetPath, resolveLocalContentUrl };
