const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-contenturl-'));
const CONTENT_DIR = path.join(root, 'content');
const ASSET_INDEX_PATH = path.join(root, 'asset-index.json');

// config/constants needs Electron's `app`; the resolver only reads these two paths.
const constantsPath = require.resolve('../config/constants');
require.cache[constantsPath] = {
    id: constantsPath,
    filename: constantsPath,
    loaded: true,
    exports: { CONTENT_DIR, ASSET_INDEX_PATH },
};

const { localAssetPath, resolveLocalContentUrl } = require('../utils/contentUrl');

const ASSET_ID = '65f0c0ffee0000000000abcd';

before(() => {
    fs.mkdirSync(CONTENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(CONTENT_DIR, 'uuid-promo.mp4'), 'x');
    fs.writeFileSync(ASSET_INDEX_PATH, JSON.stringify({ [ASSET_ID]: 'uuid-promo.mp4' }));
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('resolves local:<assetId> through the asset index', () => {
    assert.equal(localAssetPath(`local:${ASSET_ID}`), path.join(CONTENT_DIR, 'uuid-promo.mp4'));
    assert.match(resolveLocalContentUrl(`local:${ASSET_ID}`), /^file:\/\/.*uuid-promo\.mp4$/);
});

test('an asset that is not synced resolves to nothing', () => {
    assert.equal(localAssetPath('local:65f0c0ffee0000000000ffff'), '');
    assert.equal(resolveLocalContentUrl('local:65f0c0ffee0000000000ffff'), '');
});

test('a filename is not an asset id', () => {
    assert.equal(localAssetPath('local:uuid-promo.mp4'), '');
});

test('an index entry cannot escape the content directory', () => {
    fs.writeFileSync(ASSET_INDEX_PATH, JSON.stringify({ [ASSET_ID]: '../asset-index.json' }));
    assert.equal(localAssetPath(`local:${ASSET_ID}`), '');
    fs.writeFileSync(ASSET_INDEX_PATH, JSON.stringify({ [ASSET_ID]: 'uuid-promo.mp4' }));
});

test('remote URLs pass through untouched', () => {
    assert.equal(resolveLocalContentUrl('https://example.com/a'), 'https://example.com/a');
});
