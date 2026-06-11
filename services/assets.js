/**
 * Asset Sync Service
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('../utils/logConfig');
const { SYNC_API_URL, CONTENT_DIR, SERVER_URL } = require('../config/constants');
const { loadConfig } = require('../utils/configManager');
const { getHttpClient } = require('../utils/httpClient');

const DEFAULT_MAX_STORAGE_MB = 750;

function getMaxStorageBytes() {
    const config = loadConfig();
    const mb = config.maxStorageMB ?? DEFAULT_MAX_STORAGE_MB;
    return mb * 1024 * 1024;
}

const ALLOWED_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.svg',
    '.bmp',
    '.mp4',
    '.webm',
    '.mov',
    '.avi',
    '.mkv',
    '.mp3',
    '.wav',
    '.ogg',
    '.aac',
    '.pdf',
    '.html',
    '.htm',
]);

function getDirSizeBytes(dir) {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).reduce((total, file) => {
        try {
            return total + fs.statSync(path.join(dir, file)).size;
        } catch (_) {
            return total;
        }
    }, 0);
}

function md5OfFile(filePath) {
    const hash = crypto.createHash('md5');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
}

async function syncDir(assets, targetDir, remotePath) {
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const serverAssetMap = new Map(assets.map((a) => [a.serverFilename, a]));
    const localFiles = fs.readdirSync(targetDir);

    const filesToDelete = localFiles.filter((f) => !serverAssetMap.has(f));
    for (const file of filesToDelete) {
        try {
            fs.unlinkSync(path.join(targetDir, file));
            log.info(`[SYNC]: Deleted obsolete asset: ${file}`);
        } catch (err) {
            log.error(`[SYNC]: Error deleting asset ${file}:`, err);
        }
    }

    const filesToDownload = assets.filter((a) => !localFiles.includes(a.serverFilename));

    // Scan the content dir once and track the size incrementally per download,
    // instead of re-walking the whole directory (sync readdir+stat) per file.
    const maxBytes = getMaxStorageBytes();
    let currentSize = getDirSizeBytes(CONTENT_DIR);

    for (const asset of filesToDownload) {
        // Validate file extension
        const ext = path.extname(asset.serverFilename).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
            log.warn(
                `[SYNC]: Skipping asset with disallowed extension: ${asset.originalFilename} (${ext})`
            );
            continue;
        }

        if (currentSize >= maxBytes) {
            log.warn(
                `[SYNC]: Storage limit reached (${(currentSize / 1024 / 1024).toFixed(0)}MB / ${maxBytes / 1024 / 1024}MB). Skipping remaining downloads.`
            );
            break;
        }

        log.info(`[SYNC]: Downloading: ${asset.originalFilename}`);
        const url = `${SERVER_URL}${remotePath}${asset.serverFilename}`;
        const destPath = path.join(targetDir, asset.serverFilename);

        try {
            const client = getHttpClient();
            const res = await client.get(url, { responseType: 'stream' });

            const fileStream = fs.createWriteStream(destPath);
            await new Promise((resolve, reject) => {
                res.data.pipe(fileStream);
                fileStream.on('finish', resolve);
                fileStream.on('error', reject);
            });

            // MD5 verification if the server provided a checksum
            if (asset.md5) {
                const actualMd5 = md5OfFile(destPath);
                if (actualMd5 !== asset.md5) {
                    log.error(
                        `[SYNC]: MD5 mismatch for ${asset.originalFilename}. Expected: ${asset.md5}, got: ${actualMd5}. Discarding.`
                    );
                    fs.unlinkSync(destPath);
                    continue;
                }
            }

            try {
                currentSize += fs.statSync(destPath).size;
            } catch (_) {
                /* size tracking is best-effort; limit re-checked on next sync */
            }
            log.info(`[SYNC]: Completed: ${asset.originalFilename}`);
        } catch (err) {
            log.error(`[SYNC]: Error downloading ${asset.originalFilename}:`, err);
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        }
    }
}

async function syncLocalAssets(agentToken) {
    log.info('[SYNC]: Initiating asset synchronization...');

    try {
        const client = getHttpClient();
        const res = await client.get(SYNC_API_URL, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        const assets = res.data;
        const generalAssets = assets.filter((a) => a.assetType !== 'playlist');

        log.info(`[SYNC]: ${generalAssets.length} general assets`);

        await syncDir(generalAssets, CONTENT_DIR, '/local-assets/');

        log.info('[SYNC]: Synchronization completed.');
        return true;
    } catch (error) {
        log.error('[SYNC]: Sync failed:', error.message);
        return false;
    }
}

module.exports = { syncLocalAssets };
