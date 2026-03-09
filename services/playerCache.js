const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { log } = require('../utils/logConfig');
const { CONFIG_DIR } = require('../config/constants');

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

function cachePlayerHTML(screenIndex, html) {
    try {
        ensureDir(PLAYER_CACHE_DIR);
        fs.writeFileSync(getCachePath(screenIndex), html, 'utf8');
        log.info(`[PLAYER-CACHE]: Cached player HTML for screen ${screenIndex}`);
    } catch (error) {
        log.error(`[PLAYER-CACHE]: Error caching HTML for screen ${screenIndex}:`, error);
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

// --- Content caching (playlists, views) ---

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
    if (url.includes('/view/')) return true;
    if (url.includes('/player/')) return true;
    if (serverUrl && url.startsWith(serverUrl)) return true;
    if (/https?:\/\/(localhost|127\.0\.0\.1):\d+/.test(url)) return true;
    return false;
}

function buildOfflinePlayerHTML(screenIndex, currentUrl, serverUrl) {
    let iframeUrl = null;
    let usingCache = false;

    if (currentUrl) {
        if (isServerDependentUrl(currentUrl, serverUrl)) {
            const offlinePath = getOfflineContentFilePath(currentUrl, serverUrl);
            if (offlinePath) {
                iframeUrl = 'file://' + offlinePath.replace(/\\/g, '/');
                usingCache = true;
            }
        } else if (currentUrl.startsWith('http://') || currentUrl.startsWith('https://')) {
            iframeUrl = currentUrl;
        }
    }

    const statusText = usingCache ? 'Reproduciendo desde cache local' : 'Servidor no disponible';

    return `<!DOCTYPE html>
<html lang="es">
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
        .status-dot { position: fixed; bottom: 8px; right: 8px; width: 8px; height: 8px; border-radius: 50%; background: ${usingCache ? '#f59e0b' : '#ef4444'}; z-index: 9999; }
    </style>
</head>
<body>
    <iframe id="contentFrame" style="display:none;" allow="autoplay; fullscreen; encrypted-media"></iframe>
    <div class="offline-msg" id="offlineMsg" style="display:none;">
        <h2>${statusText}</h2>
        <p>Pantalla ${screenIndex}</p>
    </div>
    <div class="status-dot" id="statusDot" title="Offline"></div>
    <script>
        var iframeUrl = ${JSON.stringify(iframeUrl)};
        var frame = document.getElementById('contentFrame');
        var offlineMsg = document.getElementById('offlineMsg');
        var loaded = false;

        function showMsg() {
            if (!loaded) { frame.style.display = 'none'; offlineMsg.style.display = 'block'; }
        }

        if (iframeUrl) {
            frame.onload = function() { loaded = true; frame.style.display = 'block'; offlineMsg.style.display = 'none'; };
            frame.onerror = function() { showMsg(); };
            frame.src = iframeUrl;
            frame.style.display = 'block';
            setTimeout(showMsg, 10000);
        } else {
            showMsg();
        }

        setInterval(function() { location.reload(); }, 60000);
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
