const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { log } = require('../utils/logConfig');
const { SYNC_API_URL, CONTENT_DIR, ASSET_INDEX_PATH, SERVER_URL } = require('../config/constants');
const { writeFileAtomic } = require('../utils/atomicWrite');
const { loadConfig } = require('../utils/configManager');
const { getHttpClient } = require('../utils/httpClient');
const { localAssetIds } = require('../utils/playlistManifest');
const { loadLastState } = require('./state');

const DEFAULT_MAX_STORAGE_MB = 500;

function getMaxStorageBytes() {
    const config = loadConfig();
    const mb = config.maxStorageMB ?? DEFAULT_MAX_STORAGE_MB;
    return mb * 1024 * 1024;
}

// What the API accepts and its media pipeline produces; nothing scriptable (HTML, SVG).
const ALLOWED_EXTENSIONS = new Set([
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.webp',
    '.mp4',
    '.webm',
    '.mov',
    '.mkv',
    '.pdf',
]);

function getDirSizeBytes(dir) {
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).reduce((total, file) => {
        try {
            return total + fs.statSync(path.join(dir, file)).size;
        } catch {
            return total;
        }
    }, 0);
}

// Streamed: assets are videos of up to 100 MB.
function md5OfFile(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        fs.createReadStream(filePath)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });
}

// Catches downloads truncated by a power loss.
function isIncomplete(filePath, asset) {
    if (typeof asset.size !== 'number') return false;
    try {
        return fs.statSync(filePath).size !== asset.size;
    } catch {
        return true;
    }
}

// Files the last sync wanted but could not keep (storage cap, failed or refused download).
let lastMissing = 0;
// Only a sync changes the folder, so it is measured once after each one.
let usedBytes = null;

function getStorageReport() {
    if (usedBytes === null) usedBytes = getDirSizeBytes(CONTENT_DIR);
    return {
        usedMB: Math.round(usedBytes / (1024 * 1024)),
        limitMB: Math.round(getMaxStorageBytes() / (1024 * 1024)),
        missing: lastMissing,
    };
}

// Files the playlists on screen play go first: under the storage cap they are the ones to keep.
function playlistAssetIds() {
    const ids = new Set();
    for (const entry of Object.values(loadLastState())) {
        localAssetIds(entry?.playlist).forEach((id) => ids.add(id));
    }
    return ids;
}

async function syncDir(assets, targetDir, remotePath, agentToken, priorityIds = new Set()) {
    if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
    }

    const serverAssetMap = new Map(assets.map((a) => [a.serverFilename, a]));
    const localFiles = fs.readdirSync(targetDir);

    const filesToDelete = localFiles.filter((f) => !serverAssetMap.has(f));
    for (const file of filesToDelete) {
        try {
            fs.unlinkSync(path.join(targetDir, file));
            log.debug(`[SYNC]: Deleted obsolete asset: ${file}`);
        } catch (err) {
            log.error(`[SYNC]: Error deleting asset ${file}:`, err);
        }
    }

    const filesToDownload = assets
        .filter(
            (a) =>
                !localFiles.includes(a.serverFilename) ||
                isIncomplete(path.join(targetDir, a.serverFilename), a)
        )
        .sort(
            (a, b) =>
                Number(priorityIds.has(String(b._id))) - Number(priorityIds.has(String(a._id)))
        );

    // Track size incrementally instead of re-walking the dir per download.
    const maxBytes = getMaxStorageBytes();
    let currentSize = getDirSizeBytes(CONTENT_DIR);

    for (const asset of filesToDownload) {
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

        log.debug(`[SYNC]: Downloading: ${asset.originalFilename}`);
        const url = `${SERVER_URL}${remotePath}${asset.serverFilename}`;
        const destPath = path.join(targetDir, asset.serverFilename);
        // Only a complete, verified file gets the final name.
        const partPath = `${destPath}.part`;

        try {
            const client = getHttpClient();
            const res = await client.get(url, {
                responseType: 'stream',
                headers: { Authorization: `Bearer ${agentToken}` },
            });

            const fileStream = fs.createWriteStream(partPath);
            await new Promise((resolve, reject) => {
                res.data.on('error', reject);
                res.data.pipe(fileStream);
                fileStream.on('finish', resolve);
                fileStream.on('error', reject);
            });

            // `checksum` is the MD5.
            if (asset.checksum && /^[a-f0-9]{32}$/i.test(asset.checksum)) {
                const actualMd5 = await md5OfFile(partPath);
                if (actualMd5 !== asset.checksum) {
                    log.error(
                        `[SYNC]: MD5 mismatch for ${asset.originalFilename}. Expected: ${asset.checksum}, got: ${actualMd5}. Discarding.`
                    );
                    fs.unlinkSync(partPath);
                    continue;
                }
            }
            fs.renameSync(partPath, destPath);

            try {
                currentSize += fs.statSync(destPath).size;
            } catch {
                // Best effort: the next sync checks the limit again.
            }
            log.debug(`[SYNC]: Completed: ${asset.originalFilename}`);
        } catch (err) {
            log.error(`[SYNC]: Error downloading ${asset.originalFilename}:`, err.message);
            if (fs.existsSync(partPath)) fs.unlinkSync(partPath);
        }
    }
}

// The API names local content `local:<assetId>`; files on disk carry the serverFilename.
function writeAssetIndex(assets) {
    const index = {};
    for (const asset of assets) {
        if (asset._id && fs.existsSync(path.join(CONTENT_DIR, asset.serverFilename))) {
            index[asset._id] = asset.serverFilename;
        }
    }
    try {
        writeFileAtomic(ASSET_INDEX_PATH, JSON.stringify(index));
    } catch (err) {
        log.error('[SYNC]: Could not write the asset index:', err.message);
    }
}

// One sync at a time; a request during a run triggers one more.
let syncRunning = false;
let syncPending = false;

async function syncLocalAssets(agentToken) {
    if (syncRunning) {
        syncPending = true;
        return false;
    }
    syncRunning = true;
    try {
        let result;
        do {
            syncPending = false;
            result = await runSync(agentToken);
        } while (syncPending);
        return result;
    } finally {
        syncRunning = false;
    }
}

async function runSync(agentToken) {
    log.info('[SYNC]: Initiating asset synchronization...');

    try {
        const client = getHttpClient();
        const res = await client.get(SYNC_API_URL, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        // The API already picked each file's rendition for this device's media profile.
        const assets = res.data;

        log.info(`[SYNC]: ${assets.length} assets`);

        await syncDir(assets, CONTENT_DIR, '/local-assets/', agentToken, playlistAssetIds());
        writeAssetIndex(assets);
        lastMissing = assets.filter(
            (a) => !fs.existsSync(path.join(CONTENT_DIR, a.serverFilename))
        ).length;
        if (lastMissing > 0) log.warn(`[SYNC]: ${lastMissing} file(s) could not be stored.`);

        log.info('[SYNC]: Synchronization completed.');
        return true;
    } catch (error) {
        log.error('[SYNC]: Sync failed:', error.message);
        return false;
    } finally {
        usedBytes = null;
    }
}

module.exports = { syncLocalAssets, getStorageReport };
