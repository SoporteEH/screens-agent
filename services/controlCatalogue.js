const path = require('path');
const { log } = require('../utils/logConfig');
const { CONFIG_DIR } = require('../config/constants');
const {
    readCatalogue,
    writeCatalogue,
    offlineChoices,
    offlineChangeError,
} = require('../utils/offlineControl');

const CATALOGUE_PATH = path.join(CONFIG_DIR, 'control-catalogue.json');

// The control window's catalogue: the API's answer while connected, the copy saved from it
// while the server is away, so the salon can still change its screens.
function createControlCatalogue({ askServer, isConnected, isPlayableOffline, screenUrls, apply }) {
    async function refresh() {
        const result = await askServer('agent:catalogue');
        if (!Array.isArray(result?.contents)) return null;
        try {
            writeCatalogue(CATALOGUE_PATH, result);
        } catch (error) {
            log.error('[CONTROL]: Could not save the catalogue:', error);
        }
        return result;
    }

    async function getCatalogue() {
        if (isConnected()) {
            const result = await refresh();
            if (result) return { contents: result.contents };
        }
        const saved = readCatalogue(CATALOGUE_PATH);
        if (!saved) return { error: 'offline' };
        return { contents: offlineChoices(saved, isPlayableOffline), offline: true };
    }

    async function showContent(screenId, contentId) {
        if (isConnected()) return askServer('agent:show-content', { screenId, contentId });

        const catalogue = readCatalogue(CATALOGUE_PATH);
        const error = offlineChangeError({
            catalogue,
            screenId,
            contentId,
            screenUrls: screenUrls(),
            isPlayable: isPlayableOffline,
        });
        if (error) {
            log.info(`[CONTROL]: Offline change on screen ${screenId} refused (${error})`);
            return { error };
        }
        const content = catalogue.contents.find((c) => c.id === contentId);
        log.info(`[CONTROL]: Screen ${screenId} → ${content.url} while offline`);
        await apply(screenId, content);
        return { ok: true };
    }

    return { refresh, getCatalogue, showContent };
}

module.exports = { createControlCatalogue };
