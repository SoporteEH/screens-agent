const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-manifest-'));
const CONTENT_DIR = path.join(root, 'content');
const ASSET_INDEX_PATH = path.join(root, 'asset-index.json');

const constantsPath = require.resolve('../config/constants');
require.cache[constantsPath] = {
    id: constantsPath,
    filename: constantsPath,
    loaded: true,
    exports: { CONTENT_DIR, ASSET_INDEX_PATH },
};

const { resolveForRenderer, localAssetIds, isPlaylistUrl } = require('../utils/playlistManifest');

const SYNCED = '65f0c0ffee0000000000aaaa';
const PENDING = '65f0c0ffee0000000000bbbb';

fs.mkdirSync(CONTENT_DIR, { recursive: true });
fs.writeFileSync(path.join(CONTENT_DIR, 'promo.full.ab12.mp4'), 'x');
fs.writeFileSync(ASSET_INDEX_PATH, JSON.stringify({ [SYNCED]: 'promo.full.ab12.mp4' }));

const manifest = {
    playlistId: 'p',
    version: 3,
    items: [
        { id: '1', type: 'video', src: `local:${SYNCED}` },
        { id: '2', type: 'image', src: `local:${PENDING}` },
        { id: '3', type: 'web', src: 'https://example.com/odds' },
    ],
    fallback: { id: 'fallback', type: 'image', src: `local:${SYNCED}` },
};

test('local files reach the renderer as file:// or empty while not synced', () => {
    const out = resolveForRenderer(manifest);
    assert.match(out.items[0].src, /^file:\/\/.*promo\.full\.ab12\.mp4$/);
    assert.equal(out.items[1].src, '');
    assert.equal(out.items[2].src, 'https://example.com/odds');
    assert.match(out.fallback.src, /^file:\/\//);
    assert.equal(manifest.items[0].src, `local:${SYNCED}`, 'the stored manifest is untouched');
});

test('lists the files a manifest needs for the sync priority', () => {
    assert.deepEqual(localAssetIds(manifest), [SYNCED, PENDING, SYNCED]);
    assert.deepEqual(localAssetIds(null), []);
});

test('recognises playlist URLs', () => {
    assert.equal(isPlaylistUrl('playlist:65f0c0ffee0000000000aaaa'), true);
    assert.equal(isPlaylistUrl('https://example.com'), false);
    assert.equal(resolveForRenderer(null), null);
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
