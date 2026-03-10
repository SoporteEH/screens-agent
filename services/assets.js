/**
 * Asset Sync Service
 */

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { log } = require('../utils/logConfig');
const {
    SYNC_API_URL,
    CONTENT_DIR,
    PLAYLIST_ASSETS_DIR,
    SERVER_URL,
} = require('../config/constants');

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
    for (const asset of filesToDownload) {
        log.info(`[SYNC]: Downloading: ${asset.originalFilename}`);
        const url = `${SERVER_URL}${remotePath}${asset.serverFilename}`;
        const destPath = path.join(targetDir, asset.serverFilename);

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Download failed: ${res.statusText}`);

            const fileStream = fs.createWriteStream(destPath);
            await new Promise((resolve, reject) => {
                Readable.fromWeb(res.body).pipe(fileStream);
                fileStream.on('finish', resolve);
                fileStream.on('error', reject);
            });
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
        const res = await fetch(SYNC_API_URL, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        if (!res.ok) throw new Error(`Server error: ${res.status}`);

        const assets = await res.json();
        const generalAssets = assets.filter((a) => a.assetType !== 'playlist');
        const playlistAssets = assets.filter((a) => a.assetType === 'playlist');

        log.info(`[SYNC]: ${generalAssets.length} general assets, ${playlistAssets.length} playlist assets`);

        await syncDir(generalAssets, CONTENT_DIR, '/local-assets/');
        await syncDir(playlistAssets, PLAYLIST_ASSETS_DIR, '/playlist-assets/');

        log.info('[SYNC]: Synchronization completed.');
        return true;
    } catch (error) {
        log.error('[SYNC]: Sync failed:', error.message);
        return false;
    }
}

module.exports = { syncLocalAssets };
