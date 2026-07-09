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

// True when both URLs share a host (or one is a subdomain of the other).
function isSameSite(urlA, urlB) {
    let a, b;
    try {
        a = new URL(urlA).hostname.toLowerCase();
        b = new URL(urlB).hostname.toLowerCase();
    } catch {
        return false;
    }
    return a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
}

module.exports = { isAutologinUrl, isSameSite };
