const { resolveLocalContentUrl } = require('./contentUrl');

const isPlaylistUrl = (url) => typeof url === 'string' && url.startsWith('playlist:');

// The wrapper cannot read the asset index: local files go to it as file:// URLs, or '' while
// they are not on disk yet (the engine skips those until the next push after a sync).
function resolveForRenderer(manifest) {
    if (!manifest) return null;
    const resolve = (entry) =>
        entry && {
            ...entry,
            src: entry.src.startsWith('local:') ? resolveLocalContentUrl(entry.src) : entry.src,
        };
    return {
        ...manifest,
        items: (manifest.items || []).map(resolve),
        fallback: resolve(manifest.fallback),
    };
}

// Asset ids a manifest plays, so the sync can fetch them before anything else.
function localAssetIds(manifest) {
    if (!manifest) return [];
    return [...(manifest.items || []), manifest.fallback]
        .filter((entry) => entry && entry.src && entry.src.startsWith('local:'))
        .map((entry) => entry.src.slice('local:'.length));
}

module.exports = { isPlaylistUrl, resolveForRenderer, localAssetIds };
