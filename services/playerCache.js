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

// Timestamp marker, not the page: records that this screen rendered the player once.
function cachePlayerHTML(screenIndex) {
    try {
        ensureDir(PLAYER_CACHE_DIR);
        fs.writeFile(getCachePath(screenIndex), new Date().toISOString(), () => {});
    } catch (error) {
        log.error(`[PLAYER-CACHE]: Error marking player cache for screen ${screenIndex}:`, error);
    }
}

function hasCachedPlayer(screenIndex) {
    return fs.existsSync(getCachePath(screenIndex));
}

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
        log.debug(`[CONTENT-CACHE]: Cached content for ${url}`);
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
        log.debug(`[CONTENT-CACHE]: Prepared offline content for ${url}`);
        return offlinePath;
    } catch (error) {
        log.error(`[CONTENT-CACHE]: Error preparing offline content: ${error.message}`);
    }
    return null;
}

// The wrapper is API-served with no local copy, so it is server dependent too.
function isServerDependentUrl(url, serverUrl) {
    if (!url) return false;
    // Views (playlists) require the live server to render.
    if (url.includes('/view/')) return true;
    if (serverUrl && url.startsWith(serverUrl)) return true;
    // localhost/127.0.0.1 = dev server, treated as server dependent.
    if (/https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(url)) return true;
    return false;
}

function buildOfflinePlayerHTML(screenIndex, currentUrl, serverUrl, reason = 'NO_SERVER') {
    const carouselUrl = buildLocalCarouselUrl();
    let iframeUrl = null;
    let usingCache = false;

    if (currentUrl) {
        if (isServerDependentUrl(currentUrl, serverUrl)) {
            iframeUrl = carouselUrl;
            if (iframeUrl) usingCache = true;
        } else if (currentUrl.startsWith('http://') || currentUrl.startsWith('https://')) {
            iframeUrl = currentUrl;
        }
    }

    if (!iframeUrl) {
        iframeUrl = carouselUrl;
        if (iframeUrl) usingCache = true;
    }

    const statusText = usingCache ? 'Playing local' : 'No valid content';
    const dotState = reason === 'NO_INTERNET' ? 'offline' : 'server-down';

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
        .status-dot { position: fixed; bottom: 7px; right: 7px; width: 7px; height: 7px; border-radius: 50%; background: #9ca3af; z-index: 9999; }
        .status-dot.server-down { background: #9ca3af; }
        .status-dot.offline { background: #b55353; }
    </style>
</head>
<body>
    <iframe id="contentFrame" style="display:none;" allow="autoplay; fullscreen; encrypted-media"></iframe>
    <div class="offline-msg" id="offlineMsg" style="display:none;">
        <h2>${statusText}</h2>
        <p>Screen ${screenIndex}</p>
    </div>
    <div class="status-dot" id="statusDot"></div>
    <script>
        var iframeUrl = ${JSON.stringify(iframeUrl)};
        var carouselUrl = ${JSON.stringify(carouselUrl || null)};
        var dotState = ${JSON.stringify(dotState)};
        var frame = document.getElementById('contentFrame');
        var offlineMsg = document.getElementById('offlineMsg');
        var statusDot = document.getElementById('statusDot');

        // The reason comes from a real ping: navigator.onLine may only escalate to red.
        function paintDot(state) {
            statusDot.className = 'status-dot ' + state;
            statusDot.title = state === 'offline' ? 'No network' : 'No connection to the server';
        }
        paintDot(navigator.onLine ? dotState : 'offline');
        window.addEventListener('offline', function() { paintDot('offline'); });
        window.addEventListener('online', function() { paintDot(dotState); });

        var loaded = false;

        if (iframeUrl) {
            frame.onload = function() {
                loaded = true;
                frame.style.display = 'block';
                offlineMsg.style.display = 'none';
            };
            frame.src = iframeUrl;
            frame.style.display = 'block';

            // The assigned URL can be unreachable while the server is down; the cached
            // carousel is local and always loads, so it is the better dark-screen answer.
            setTimeout(function() {
                if (loaded || !carouselUrl || carouselUrl === iframeUrl) return;
                iframeUrl = carouselUrl;
                frame.src = carouselUrl;
            }, 12000);
        } else {
            frame.style.display = 'none';
            offlineMsg.style.display = 'block';
        }

        // Reloading a file:// page cannot reach the server — the agent handles recovery.
        // Retry only while nothing is playing, instead of interrupting content every minute.
        setInterval(function() { if (!loaded) location.reload(); }, 60000);
    </script>
</body>
</html>`;
}

function getCachedPlayerFileUrl(screenIndex, currentUrl, serverUrl, reason = 'NO_SERVER') {
    ensureDir(PLAYER_CACHE_DIR);
    const offlineHtml = buildOfflinePlayerHTML(screenIndex, currentUrl, serverUrl, reason);
    const offlinePath = path.join(PLAYER_CACHE_DIR, `offline-${screenIndex}.html`);
    fs.writeFileSync(offlinePath, offlineHtml, 'utf8');
    return `file://${offlinePath.replace(/\\/g, '/')}`;
}

module.exports = {
    cachePlayerHTML,
    hasCachedPlayer,
    buildOfflinePlayerHTML,
    getCachedPlayerFileUrl,
    cacheContentURL,
    isServerDependentUrl,
    PLAYER_CACHE_DIR,
    CONTENT_CACHE_DIR,
};
