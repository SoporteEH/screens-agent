const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logConfig');
const { CONTENT_DIR, CONFIG_DIR } = require('../config/constants');

const CAROUSEL_HTML_PATH = path.join(CONFIG_DIR, 'offline-carousel.html');

/**
 * Builds an offline HTML file that acts as a carousel for all 
 * media files (images and videos) stored in CONTENT_DIR. 
 * @returns {string|null} The file:// URL to the generated HTML, or null if no assets exist.
 */

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
    <title>ScreensWeb - Modo Offline</title>
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
        .offline-indicator {
            position: fixed; bottom: 10px; right: 10px;
            background: rgba(0,0,0,0.6); color: #fff;
            padding: 5px 10px; border-radius: 4px; z-index: 100;
            font-family: sans-serif; font-size: 12px;
            display: flex; align-items: center; gap: 8px;
        }
        .dot {
            width: 5px; height: 5px; border-radius: 50%; background: #af3333ff;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.4; }
            100% { opacity: 1; }
        }
    </style>
</head>
<body>
    <div id="container" class="media-container"></div>
    <div class="offline-indicator">
        <div class="dot"></div>
        Modo Offline
    </div>

    <script>
        const mediaUrls = ${JSON.stringify(mediaUrls)};
        const container = document.getElementById('container');
        let currentIndex = 0;
        let elements = [];

        // Pre-create DOM elements
        mediaUrls.forEach((url, i) => {
            const isVideo = url.toLowerCase().match(/\\.(mp4|mkv|avi)$/);
            let el;
            if (isVideo) {
                el = document.createElement('video');
                el.src = url;
                el.muted = true;
                el.playsInline = true;
                
                el.onerror = () => nextMedia();
                el.onended = () => nextMedia();
            } else {
                el = document.createElement('img');
                el.src = url;
                
                el.onerror = () => nextMedia();
            }
            container.appendChild(el);
            elements.push({ type: isVideo ? 'video' : 'image', el });
        });

        let imageTimer = null;

        function showNext() {
            if (elements.length === 0) return;
            
            // Hide all
            elements.forEach(item => {
                item.el.classList.remove('active');
                if (item.type === 'video') item.el.pause();
            });

            // Show current
            const currentItem = elements[currentIndex];
            currentItem.el.classList.add('active');

            if (currentItem.type === 'video') {
                currentItem.el.currentTime = 0;
                currentItem.el.play().catch(e => {
                    console.error("Video play failed", e);
                    nextMedia();
                });
            } else {
                clearTimeout(imageTimer);
                imageTimer = setTimeout(nextMedia, 10000); // 10 seconds per image
            }
        }

        function nextMedia() {
            currentIndex = (currentIndex + 1) % elements.length;
            showNext();
        }

        // Start
        showNext();
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
