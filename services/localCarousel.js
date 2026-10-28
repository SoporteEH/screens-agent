const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logConfig');
const { CONTENT_DIR, CONFIG_DIR } = require('../config/constants');
const { writeFileAtomic } = require('../utils/atomicWrite');

const CAROUSEL_HTML_PATH = path.join(CONFIG_DIR, 'offline-carousel.html');
// Inlined: the generated page lives in userData, away from the app's own files.
const WATCHDOG_SOURCE = fs.readFileSync(path.join(__dirname, '../js/media-watchdog.js'), 'utf8');

function writeCarouselFile(html, itemCount) {
    try {
        if (fs.readFileSync(CAROUSEL_HTML_PATH, 'utf8') === html) return;
    } catch {
        // Not written yet.
    }

    try {
        writeFileAtomic(CAROUSEL_HTML_PATH, html);
    } catch (error) {
        log.warn('[CAROUSEL]: Atomic write failed, falling back to in-place:', error.message);
        fs.writeFileSync(CAROUSEL_HTML_PATH, html, 'utf8');
    }

    log.info('[CAROUSEL]: Offline carousel built successfully with ' + itemCount + ' items.');
}

function buildLocalCarouselUrl() {
    try {
        if (!fs.existsSync(CONTENT_DIR)) {
            log.warn('[CAROUSEL]: CONTENT_DIR does not exist. Cannot build fallback carousel.');
            return null;
        }

        const files = fs.readdirSync(CONTENT_DIR);
        const mediaFiles = files.filter((f) => {
            const ext = path.extname(f).toLowerCase();
            return ['.mp4', '.mkv', '.avi', '.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext);
        });

        if (mediaFiles.length === 0) {
            log.warn('[CAROUSEL]: No media files found in CONTENT_DIR.');
            return null;
        }
        const mediaUrls = mediaFiles.map(
            (f) => `file://${path.join(CONTENT_DIR, f).replace(/\\/g, '/')}`
        );

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

    <script>${WATCHDOG_SOURCE}</script>
    <script>
        const mediaUrls = ${JSON.stringify(mediaUrls)};
        const container = document.getElementById('container');

        const IMAGE_MS = 10000;
        const VIDEO_CEILING_MS = 600000;
        const FAIL_RETRY_MS = 1000;

        // The wrapper forwards '[PLAYER]' console lines to the agent log; this page is
        // otherwise invisible from outside. Only anomalies are reported, so silence during
        // a freeze means the timers themselves died.
        function report(msg) {
            console.warn('[PLAYER] Carousel: ' + msg);
        }

        // No src until shown: the folder may hold hundreds of photos, and every loaded one
        // stays in memory. Only the image on screen and the next one are loaded.
        const items = mediaUrls.map(function (url) {
            const isVideo = /\\.(mp4|mkv|avi)$/i.test(url);
            const el = document.createElement(isVideo ? 'video' : 'img');
            if (isVideo) {
                el.muted = true;
                el.playsInline = true;
                el.preload = 'none';
            }
            container.appendChild(el);
            return { url: url, isVideo: isVideo, el: el };
        });

        let index = -1;
        let token = 0;
        let advanceTimer = null;
        let stopWatch = null;

        function advance(t) {
            if (t !== token || items.length === 0) return;
            show((index + 1) % items.length);
        }

        // Async so a run of unplayable items cannot recurse into a tight loop.
        function fail(t, why) {
            if (t !== token) return;
            report(why);
            clearTimeout(advanceTimer);
            advanceTimer = setTimeout(function () { advance(t); }, FAIL_RETRY_MS);
        }

        function release(item, keepImage) {
            const el = item.el;
            el.onended = el.onerror = el.onloadedmetadata = null;
            el.classList.remove('active');
            if (item.isVideo) MediaWatchdog.releaseVideo(el);
            else if (!keepImage) el.removeAttribute('src');
        }

        // Decoded ahead, so the swap does not wait on a large photo.
        function preload(item) {
            if (item.isVideo || item.el.getAttribute('src')) return;
            item.el.src = item.url;
            item.el.decode().catch(function () {});
        }

        function show(i) {
            const t = ++token;
            clearTimeout(advanceTimer);
            if (stopWatch) stopWatch();
            stopWatch = null;
            index = i;

            const next = items[(i + 1) % items.length];
            items.forEach(function (item, j) { if (j !== i) release(item, item === next); });

            const item = items[i];
            const el = item.el;
            el.classList.add('active');

            if (!item.isVideo) {
                el.onerror = function () { fail(t, 'image ' + i + ' failed to load'); };
                if (!el.getAttribute('src')) {
                    el.src = item.url;
                } else if (el.complete && el.naturalWidth === 0) {
                    // Preloaded and already failed: onerror will not fire again.
                    fail(t, 'image ' + i + ' is broken');
                    return;
                }
                preload(next);
                advanceTimer = setTimeout(function () { advance(t); }, IMAGE_MS);
                return;
            }

            el.onended = function () { advance(t); };
            el.onerror = function () { fail(t, 'video ' + i + ' failed to load'); };
            el.onloadedmetadata = function () {
                if (t !== token || !isFinite(el.duration) || el.duration <= 0) return;
                const ceiling = el.duration * 1000 + 5000;
                clearTimeout(advanceTimer);
                advanceTimer = setTimeout(function () {
                    report('video ' + i + ' outlived its ' + Math.round(el.duration) + 's duration');
                    advance(t);
                }, ceiling);
            };

            el.src = item.url;
            el.load();
            el.play().catch(function () { fail(t, 'video ' + i + ' play() rejected'); });
            preload(next);

            advanceTimer = setTimeout(function () {
                report('video ' + i + ' hit the hard ceiling');
                advance(t);
            }, VIDEO_CEILING_MS);

            stopWatch = MediaWatchdog.watchVideo(el, function (reason) {
                if (t !== token) return;
                report('video ' + i + ' ' + reason);
                advance(t);
            });
        }

        // Random entry point: sibling screens otherwise open the same clip at the same instant.
        if (items.length > 0) {
            const start = Math.floor(Math.random() * items.length);
            console.log('[PLAYER] Carousel started: ' + items.length + ' items, from #' + start);
            show(start);
        }
    </script>
</body>
</html>`;

        writeCarouselFile(htmlContent, mediaFiles.length);
        return 'file://' + CAROUSEL_HTML_PATH.replace(/\\/g, '/');
    } catch (error) {
        log.error('[CAROUSEL]: Error building local carousel:', error);
        return null;
    }
}

module.exports = { buildLocalCarouselUrl };
