const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { log } = require('../utils/logConfig');
const { CONFIG_DIR } = require('../config/constants');
const { buildLocalCarouselUrl } = require('./localCarousel');

const PLAYER_CACHE_DIR = path.join(CONFIG_DIR, 'player-cache');
const CONTENT_CACHE_DIR = path.join(CONFIG_DIR, 'content-cache');

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function getCachePath(screenIndex) {
    return path.join(PLAYER_CACHE_DIR, `player-${screenIndex}.html`);
}

function cachePlayerHTML(screenIndex) {
    try {
        ensureDir(PLAYER_CACHE_DIR);
        fs.writeFile(getCachePath(screenIndex), new Date().toISOString(), () => {});
    } catch (error) {
        log.error(`[PLAYER-CACHE]: Error marking player cache for screen ${screenIndex}:`, error);
    }
}

function loadCachedPlayerHTML(screenIndex) {
    try {
        const cachePath = getCachePath(screenIndex);
        if (fs.existsSync(cachePath)) {
            const html = fs.readFileSync(cachePath, 'utf8');
            log.info(`[PLAYER-CACHE]: Loaded cached player HTML for screen ${screenIndex}`);
            return html;
        }
    } catch (error) {
        log.error(`[PLAYER-CACHE]: Error loading cached HTML for screen ${screenIndex}:`, error);
    }
    return null;
}

function hasCachedPlayer(screenIndex) {
    return fs.existsSync(getCachePath(screenIndex));
}

// Content caching (playlists, views)

function getContentCacheKey(url) {
    return crypto.createHash('md5').update(url).digest('hex');
}

function normalizeContentUrl(url, serverUrl) {
    if (!url || !serverUrl) return url;
    return url
        .replace(/https?:\/\/localhost:\d+/, serverUrl)
        .replace(/https?:\/\/127\.0\.0\.1:\d+/, serverUrl);
}

async function cacheContentURL(url, serverUrl) {
    if (!url || !url.includes('/view/')) return;
    try {
        const normalizedUrl = normalizeContentUrl(url, serverUrl);
        ensureDir(CONTENT_CACHE_DIR);
        const response = await axios.get(normalizedUrl, { timeout: 10000 });
        if (typeof response.data !== 'string') return;
        const key = getContentCacheKey(url);
        fs.writeFileSync(path.join(CONTENT_CACHE_DIR, `${key}.html`), response.data, 'utf8');
        log.info(`[CONTENT-CACHE]: Cached content for ${url}`);
    } catch (error) {
        log.error(`[CONTENT-CACHE]: Error caching ${url}: ${error.message}`);
    }
}

function getOfflineContentFilePath(url, serverUrl) {
    if (!url) return null;
    try {
        const key = getContentCacheKey(url);
        const cachedPath = path.join(CONTENT_CACHE_DIR, `${key}.html`);
        if (!fs.existsSync(cachedPath)) return null;

        let html = fs.readFileSync(cachedPath, 'utf8');
        if (serverUrl) {
            html = html.replace(/<base href="\/">/i, `<base href="${serverUrl}/">`);
        }
        const offlinePath = path.join(CONTENT_CACHE_DIR, `offline-${key}.html`);
        fs.writeFileSync(offlinePath, html, 'utf8');
        log.info(`[CONTENT-CACHE]: Prepared offline content for ${url}`);
        return offlinePath;
    } catch (error) {
        log.error(`[CONTENT-CACHE]: Error preparing offline content: ${error.message}`);
    }
    return null;
}

function isServerDependentUrl(url, serverUrl) {
    if (!url) return false;
    // Views (playlists) ARE server dependent to render correctly
    if (url.includes('/view/')) return true;
    // Player wrappers are NOT server dependent - cached locally
    if (url.includes('/player/')) return false;
    // Other URLs starting with serverUrl are likely server dependent
    if (serverUrl && url.startsWith(serverUrl)) return true;
    // Localhost/127.0.0.1 are considered server dependent (dev server)
    if (/https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(url)) return true;
    return false;
}

function buildOfflinePlayerHTML(screenIndex, currentUrl, serverUrl) {
    let iframeUrl = null;
    let usingCache = false;

    if (currentUrl) {
        if (isServerDependentUrl(currentUrl, serverUrl)) {
            iframeUrl = buildLocalCarouselUrl();
            if (iframeUrl) usingCache = true;
        } else if (currentUrl.startsWith('http://') || currentUrl.startsWith('https://')) {
            iframeUrl = currentUrl;
        }
    }

    if (!iframeUrl) {
        iframeUrl = buildLocalCarouselUrl();
        if (iframeUrl) usingCache = true;
    }

    const statusText = usingCache ? 'Playing local' : 'No valid content';

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ScreensWeb Player - Offline</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; overflow: hidden; background: #111; font-family: sans-serif; }
        #contentFrame { position: absolute; top: 0; left: 0; width: 100%; height: 100%; border: none; background: #000; }
        .offline-msg { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); color: #888; text-align: center; z-index: 5; }
        .offline-msg h2 { font-size: 1.8rem; margin-bottom: 0.5rem; }
        .offline-msg p { font-size: 1rem; color: #666; margin-top: 0.3rem; }
        .status-dot { position: fixed; bottom: 7px; right: 7px; width: 7px; height: 7px; border-radius: 50%; background: #ee3232ff; z-index: 9999; display: none; }
    </style>
</head>
<body>
    <iframe id="contentFrame" style="display:none;" allow="autoplay; fullscreen; encrypted-media"></iframe>
    <div class="offline-msg" id="offlineMsg" style="display:none;">
        <h2>${statusText}</h2>
        <p>Screen ${screenIndex}</p>
    </div>
    <div class="status-dot" id="statusDot" title="Offline"></div>
    <script>
        var iframeUrl = ${JSON.stringify(iframeUrl)};
        var frame = document.getElementById('contentFrame');
        var offlineMsg = document.getElementById('offlineMsg');
        var statusDot = document.getElementById('statusDot');

        if (iframeUrl) {
            frame.onload = function() {
                frame.style.display = 'block';
                offlineMsg.style.display = 'none';
            };
            frame.src = iframeUrl;
            frame.style.display = 'block';
            // Carousel inside iframe shows its own red dot — hide wrapper dot to avoid duplicates
        } else {
            // No content at all: show message and red dot from wrapper
            frame.style.display = 'none';
            offlineMsg.style.display = 'block';
            statusDot.style.display = 'block';
        }

        setInterval(function() { location.reload(); }, 60000); // 1 minute retry
    </script>
</body>
</html>`;
}

function getCachedPlayerFileUrl(screenIndex, currentUrl, serverUrl) {
    ensureDir(PLAYER_CACHE_DIR);
    const offlineHtml = buildOfflinePlayerHTML(screenIndex, currentUrl, serverUrl);
    const offlinePath = path.join(PLAYER_CACHE_DIR, `offline-${screenIndex}.html`);
    fs.writeFileSync(offlinePath, offlineHtml, 'utf8');
    return `file://${offlinePath}`;
}

module.exports = {
    cachePlayerHTML,
    loadCachedPlayerHTML,
    hasCachedPlayer,
    buildOfflinePlayerHTML,
    getCachedPlayerFileUrl,
    cacheContentURL,
    isServerDependentUrl,
    PLAYER_CACHE_DIR,
    CONTENT_CACHE_DIR,
};
