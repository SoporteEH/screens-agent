const AUTOLOGIN_HOSTS = new Set([
    'lcr.sportradar.com',
    'luckiatv.com',
    'luckia-tv.com',
]);

const AUTOLOGIN_DOMAIN_SUFFIXES = ['.luckiatv.com', '.luckia-tv.com'];

function isAutologinUrl(url) {
    if (!url || typeof url !== 'string') return false;
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }
    if (AUTOLOGIN_HOSTS.has(host)) return true;
    return AUTOLOGIN_DOMAIN_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

module.exports = { isAutologinUrl };
