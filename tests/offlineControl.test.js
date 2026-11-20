const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    readCatalogue,
    writeCatalogue,
    offlineChoices,
    offlineChangeError,
} = require('../utils/offlineControl');

const catalogue = {
    contents: [
        { id: 'promo', name: 'Promo', url: 'https://promo.example', refreshInterval: 0 },
        { id: 'tv', name: 'TV', url: 'https://tv.example', autologin: true },
        { id: 'legacy', name: 'Legacy', url: 'https://luckiatv.com/live' },
        { id: 'odds', name: 'Odds', url: 'https://odds.example' },
        { id: 'odds2', name: 'Odds 2', url: 'https://odds2.example' },
        { id: 'server', name: 'Server page', url: 'https://panel.example/view/1' },
    ],
    pinnedScreens: ['3'],
    licensedUrls: ['https://odds.example', 'https://odds2.example'],
    suspended: false,
};
const isPlayable = (url) => !url.includes('/view/');
const change = (overrides) =>
    offlineChangeError({
        catalogue,
        screenId: '1',
        contentId: 'promo',
        screenUrls: { 1: '', 2: '', 3: '' },
        isPlayable,
        ...overrides,
    });

test('offers only what plays without the server, never autologin content', () => {
    assert.deepEqual(
        offlineChoices(catalogue, isPlayable).map((c) => c.id),
        ['promo', 'odds', 'odds2']
    );
    assert.deepEqual(offlineChoices(null, isPlayable), []);
});

test('accepts a catalogue URL on a free screen', () => {
    assert.equal(change(), null);
});

test('applies the salon rules the API would', () => {
    assert.equal(change({ catalogue: null }), 'offline');
    assert.equal(change({ contentId: 'gone' }), 'contentNotAllowed');
    assert.equal(change({ catalogue: { ...catalogue, suspended: true } }), 'accountSuspended');
    assert.equal(change({ screenId: '3' }), 'screenPinned');
    assert.equal(change({ contentId: 'tv' }), 'needsServer');
    assert.equal(change({ contentId: 'legacy' }), 'needsServer');
    assert.equal(change({ contentId: 'server' }), 'unavailableOffline');
});

test('keeps licensed content on one screen of the device', () => {
    const screenUrls = { 1: 'https://odds.example', 2: '', 3: '' };
    assert.equal(change({ contentId: 'odds2', screenId: '2', screenUrls }), 'singleScreenBusy');
    // Swapping it on the screen that already holds it is fine.
    assert.equal(change({ contentId: 'odds2', screenId: '1', screenUrls }), null);
    assert.equal(change({ contentId: 'promo', screenId: '2', screenUrls }), null);
});

test('saves the catalogue and reads it back; a broken file reads as none', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-offline-'));
    const file = path.join(dir, 'control-catalogue.json');
    try {
        writeCatalogue(file, catalogue);
        const saved = readCatalogue(file);
        assert.deepEqual(saved.contents, catalogue.contents);
        assert.deepEqual(saved.pinnedScreens, ['3']);

        fs.writeFileSync(file, '{"contents":');
        assert.equal(readCatalogue(file), null);
        assert.equal(readCatalogue(path.join(dir, 'missing.json')), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
