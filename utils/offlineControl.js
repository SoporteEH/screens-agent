const fs = require('fs');
const { writeFileAtomic } = require('./atomicWrite');
const { isAutologinUrl } = require('./autologinUrl');

// Autologin needs the per-site credentials only the API sends with a show_url: offline the
// screen would land on the login form.
const needsServer = (content) => !!content.autologin || isAutologinUrl(content.url);

function readCatalogue(filePath) {
    try {
        const catalogue = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(catalogue?.contents) ? catalogue : null;
    } catch {
        return null;
    }
}

function writeCatalogue(filePath, catalogue) {
    writeFileAtomic(
        filePath,
        JSON.stringify({
            contents: catalogue.contents,
            pinnedScreens: catalogue.pinnedScreens || [],
            licensedUrls: catalogue.licensedUrls || [],
            suspended: !!catalogue.suspended,
            savedAt: new Date().toISOString(),
        })
    );
}

function offlineChoices(catalogue, isPlayable) {
    if (!catalogue) return [];
    return catalogue.contents.filter((c) => !needsServer(c) && isPlayable(c.url));
}

// The rules the API applies to a control-window change, checked against the catalogue saved at
// the last connection. registerDevice checks the change again when the device reconnects.
// `screenUrls` maps every slot of this device to what it shows.
function offlineChangeError({ catalogue, screenId, contentId, screenUrls, isPlayable }) {
    if (!catalogue) return 'offline';
    const content = catalogue.contents.find((c) => c.id === contentId);
    if (!content) return 'contentNotAllowed';
    if (catalogue.suspended) return 'accountSuspended';
    if ((catalogue.pinnedScreens || []).includes(screenId)) return 'screenPinned';
    if (needsServer(content)) return 'needsServer';
    if (!isPlayable(content.url)) return 'unavailableOffline';

    const licensed = new Set(catalogue.licensedUrls || []);
    if (licensed.has(content.url)) {
        const busy = Object.entries(screenUrls).some(
            ([id, url]) => id !== screenId && licensed.has(url)
        );
        if (busy) return 'singleScreenBusy';
    }
    return null;
}

module.exports = { readCatalogue, writeCatalogue, offlineChoices, offlineChangeError };
