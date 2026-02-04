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
            log.info(`[SYNC]: Eliminado obsoleto: ${file}`);
        } catch (err) {
            log.error(`[SYNC]: Error eliminando ${file}:`, err);
        }
    }

    const filesToDownload = assets.filter((a) => !localFiles.includes(a.serverFilename));
    for (const asset of filesToDownload) {
        log.info(`[SYNC]: Descargando: ${asset.originalFilename}`);
        const url = `${SERVER_URL}${remotePath}${asset.serverFilename}`;
        const destPath = path.join(targetDir, asset.serverFilename);

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Fallo: ${res.statusText}`);

            const fileStream = fs.createWriteStream(destPath);
            await new Promise((resolve, reject) => {
                Readable.fromWeb(res.body).pipe(fileStream);
                fileStream.on('finish', resolve);
                fileStream.on('error', reject);
            });
            log.info(`[SYNC]: Completado: ${asset.originalFilename}`);
        } catch (err) {
            log.error(`[SYNC]: Error descargando ${asset.originalFilename}:`, err);
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
        }
    }
}

async function syncLocalAssets(agentToken) {
    log.info('[SYNC]: Iniciando sincronización...');

    try {
        const res = await fetch(SYNC_API_URL, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        if (!res.ok) throw new Error(`Error servidor: ${res.status}`);

        const assets = await res.json();
        const generalAssets = assets.filter((a) => a.assetType !== 'playlist');
        const playlistAssets = assets.filter((a) => a.assetType === 'playlist');

        log.info(`[SYNC]: ${generalAssets.length} generales, ${playlistAssets.length} playlist`);

        await syncDir(generalAssets, CONTENT_DIR, '/local-assets/');
        await syncDir(playlistAssets, PLAYLIST_ASSETS_DIR, '/playlist-assets/');

        log.info('[SYNC]: Sincronización completada.');
        return true;
    } catch (error) {
        log.error('[SYNC]: Error:', error.message);
        return false;
    }
}

module.exports = { syncLocalAssets };
