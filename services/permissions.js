const { app, session } = require('electron');
const { log } = require('../utils/logConfig');

// Content frames get what the wrapper delegates to them (allow="autoplay; fullscreen;
// encrypted-media"; autoplay is not a permission). Without a handler Electron grants everything.
const ALLOWED = new Set(['fullscreen', 'mediaKeySystem']);

const reported = new Set();

function originOf(url) {
    try {
        const { origin, protocol } = new URL(url);
        return origin === 'null' ? protocol : origin;
    } catch {
        return 'an unknown origin';
    }
}

function restrict(ses) {
    ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
        if (ALLOWED.has(permission)) return callback(true);

        const denial = `'${permission}' to ${originOf(details.requestingUrl)}`;
        // Once: a page may ask again on every reload.
        if (!reported.has(denial)) {
            reported.add(denial);
            log.info(`[PERMISSIONS]: Denied ${denial}`);
        }
        callback(false);
    });
    ses.setPermissionCheckHandler((webContents, permission) => ALLOWED.has(permission));
    // No page gets a HID, USB or serial device.
    ses.setDevicePermissionHandler(() => false);
}

function restrictWebPermissions() {
    restrict(session.defaultSession);
    app.on('session-created', restrict);
}

module.exports = { restrictWebPermissions };
