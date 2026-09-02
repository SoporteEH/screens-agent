const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logConfig');
const { CONTENT_DIR, CONFIG_DIR } = require('../config/constants');

const CAROUSEL_HTML_PATH = path.join(CONFIG_DIR, 'offline-carousel.html');

function buildLocalCarouselUrl() {
    try {
        if (!fs.existsSync(CONTENT_DIR)) {
            log.warn('[CAROUSEL]: CONTENT_DIR does not exist. Cannot build fallback carousel.');
            return null;
        }

        const files = fs.readdirSync(CONTENT_DIR);
        const mediaFiles = files.filter(f => {
            const ext = path.extname(f).toLowerCase();
            return ['.mp4', '.mkv', '.avi', '.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
        });

        if (mediaFiles.length === 0) {
            log.warn('[CAROUSEL]: No media files found in CONTENT_DIR.');
            return null;
        }
        const mediaUrls = mediaFiles.map(f => `file://${path.join(CONTENT_DIR, f).replace(/\\/g, '/')}`);

        const htmlContent = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ScreensWeb</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; overflow: hidden; background: #000; }
        .media-container {
            position: absolute;
            top: 0; left: 0; width: 100%; height: 100%;
            display: flex; justify-content: center; align-items: center;
        }
        img, video {
            max-width: 100%; max-height: 100%;
            object-fit: contain;
            display: none;
        }
        .active { display: block; }
    </style>
</head>
<body>
    <!-- Status dot lives in the wrapper that iframes this page. -->
    <div id="container" class="media-container"></div>

    <script>
        const mediaUrls = ${JSON.stringify(mediaUrls)};
        const container = document.getElementById('container');

        const IMAGE_MS = 10000;
        const VIDEO_CEILING_MS = 600000;
        const STALL_TICK_MS = 1000;
        const STALL_GRACE_MS = 10000;
        const FAIL_RETRY_MS = 1000;

        const items = mediaUrls.map(function (url) {
            const isVideo = /\\.(mp4|mkv|avi)$/i.test(url);
            const el = document.createElement(isVideo ? 'video' : 'img');
            if (isVideo) {
                el.muted = true;
                el.playsInline = true;
                el.preload = 'none';
            } else {
                el.src = url;
            }
            container.appendChild(el);
            return { url: url, isVideo: isVideo, el: el };
        });

        let index = -1;
        let token = 0;
        let advanceTimer = null;
        let stallTimer = null;

        function advance(t) {
            if (t !== token || items.length === 0) return;
            show((index + 1) % items.length);
        }

        // Async so a run of unplayable items cannot recurse into a tight loop.
        function fail(t) {
            if (t !== token) return;
            clearTimeout(advanceTimer);
            advanceTimer = setTimeout(function () { advance(t); }, FAIL_RETRY_MS);
        }

        function release(item) {
            const el = item.el;
            el.onended = el.onerror = el.onloadedmetadata = null;
            el.classList.remove('active');
            if (!item.isVideo || !el.getAttribute('src')) return;
            el.pause();
            // Hand the decoder back: sibling screens share one hardware decode engine.
            el.removeAttribute('src');
            el.load();
        }

        function show(i) {
            const t = ++token;
            clearTimeout(advanceTimer);
            clearInterval(stallTimer);
            index = i;

            items.forEach(function (item, j) { if (j !== i) release(item); });

            const item = items[i];
            const el = item.el;
            el.classList.add('active');

            if (!item.isVideo) {
                el.onerror = function () { fail(t); };
                // A src that failed before this turn will never re-fire onerror.
                if (el.complete && el.naturalWidth === 0) { fail(t); return; }
                advanceTimer = setTimeout(function () { advance(t); }, IMAGE_MS);
                return;
            }

            el.onended = function () { advance(t); };
            el.onerror = function () { fail(t); };
            el.onloadedmetadata = function () {
                if (t !== token || !isFinite(el.duration) || el.duration <= 0) return;
                clearTimeout(advanceTimer);
                advanceTimer = setTimeout(function () { advance(t); }, el.duration * 1000 + 5000);
            };

            el.src = item.url;
            el.load();
            el.play().catch(function () { fail(t); });

            advanceTimer = setTimeout(function () { advance(t); }, VIDEO_CEILING_MS);

            // 'ended' is not a guarantee: a decoder that never starts emits no event at all.
            let lastTime = -1;
            let idleMs = 0;
            stallTimer = setInterval(function () {
                if (t !== token) return;
                if (el.currentTime !== lastTime) {
                    lastTime = el.currentTime;
                    idleMs = 0;
                    return;
                }
                idleMs += STALL_TICK_MS;
                if (idleMs >= STALL_GRACE_MS) advance(t);
            }, STALL_TICK_MS);
        }

        // Random entry point: sibling screens otherwise open the same clip at the same instant.
        if (items.length > 0) show(Math.floor(Math.random() * items.length));
    </script>
</body>
</html>`;

        fs.writeFileSync(CAROUSEL_HTML_PATH, htmlContent, 'utf8');
        log.info('[CAROUSEL]: Offline carousel built successfully with ' + mediaFiles.length + ' items.');
        return 'file://' + CAROUSEL_HTML_PATH.replace(/\\/g, '/');

    } catch (error) {
        log.error('[CAROUSEL]: Error building local carousel:', error);
        return null;
    }
}

module.exports = { buildLocalCarouselUrl };
