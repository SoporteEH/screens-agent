/**
 * Asset Sync Service
 * Descarga y mantiene contenidos locales actualizados
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

    const serverAssetMap = new Map(assets.map((asset) => [asset.serverFilename, asset]));
    const localFiles = fs.readdirSync(targetDir);

    // Elimina archivos locales que no están en la lista del servidor
    const filesToDelete = localFiles.filter((file) => !serverAssetMap.has(file));
    for (const fileToDelete of filesToDelete) {
        try {
            fs.unlinkSync(path.join(targetDir, fileToDelete));
            log.info(
                `[SYNC]: Archivo obsoleto eliminado de ${path.basename(targetDir)}: ${fileToDelete}`
            );
        } catch (err) {
            log.error(`[SYNC]: Error al eliminar ${fileToDelete} en ${targetDir}:`, err);
        }
    }

    // Descarga archivos nuevos
    const filesToDownload = assets.filter((asset) => !localFiles.includes(asset.serverFilename));
    for (const assetToDownload of filesToDownload) {
        log.info(
            `[SYNC]: Descargando activo (${assetToDownload.assetType || 'general'}): ${assetToDownload.originalFilename}...`
        );
        const downloadUrl = `${SERVER_URL}${remotePath}${assetToDownload.serverFilename}`;
        const destinationPath = path.join(targetDir, assetToDownload.serverFilename);

        try {
            const downloadResponse = await fetch(downloadUrl);
            if (!downloadResponse.ok)
                throw new Error(`Fallo la descarga: ${downloadResponse.statusText}`);

            const fileStream = fs.createWriteStream(destinationPath);
            await new Promise((resolve, reject) => {
                Readable.fromWeb(downloadResponse.body).pipe(fileStream);
                fileStream.on('finish', resolve);
                fileStream.on('error', reject);
            });
            log.info(`[SYNC]: Descarga completa: ${assetToDownload.originalFilename}`);
        } catch (err) {
            log.error(`[SYNC]: Error al descargar ${assetToDownload.originalFilename}: `, err);
            if (fs.existsSync(destinationPath)) {
                fs.unlinkSync(destinationPath);
            }
        }
    }
}

async function syncLocalAssets(agentToken) {
    log.info('[SYNC]: Iniciando proceso de sincronizacion de activos locales...');

    try {
        const response = await fetch(SYNC_API_URL, {
            headers: { Authorization: `Bearer ${agentToken}` },
        });
        if (!response.ok) {
            throw new Error(
                `Error del servidor al obtener la lista de activos: ${response.status}`
            );
        }
        const serverAssets = await response.json();
        const generalAssets = serverAssets.filter((a) => a.assetType !== 'playlist');
        const playlistAssets = serverAssets.filter((a) => a.assetType === 'playlist');

        log.info(
            `[SYNC]: Pendientes ${generalAssets.length} generales y ${playlistAssets.length} recursos de playlist.`
        );

        await syncDir(generalAssets, CONTENT_DIR, '/local-assets/');
        await syncDir(playlistAssets, PLAYLIST_ASSETS_DIR, '/playlist-assets/');

        log.info('[SYNC]: Proceso de sincronizacion finalizado.');
        return true;
    } catch (error) {
        log.error('[SYNC]: Error critico durante la sincronizacion:', error.message);
        return false;
    }
}

module.exports = {
    syncLocalAssets,
};
