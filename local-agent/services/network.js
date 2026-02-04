/**
 * Network Monitoring Service
 */

const { net } = require('electron');
const { log } = require('../utils/logConfig');
const { CONSTANTS } = require('../config/constants');

function startNetworkMonitoring(handlers) {
    let wasOffline = false;
    log.info('[NETWORK]: Iniciando monitoreo.');

    return setInterval(() => {
        const isOnline = net.isOnline();

        if (!isOnline && !wasOffline) {
            wasOffline = true;
            log.info('[NETWORK]: Sin conexion.');
            handlers.onOffline?.();
        } else if (isOnline && wasOffline) {
            log.info('[NETWORK]: Conexion restaurada.');
            wasOffline = false;
            handlers.onOnline?.();
        } else if (isOnline) {
            handlers.onCheckOnline?.();
        }
    }, CONSTANTS.NETWORK_CHECK_INTERVAL_MS);
}

module.exports = { startNetworkMonitoring };
