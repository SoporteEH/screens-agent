/**
 * Network Monitoring Service
 * Active detection: OS check + server ping
 */

const { net } = require('electron');
const { log } = require('../utils/logConfig');
const { CONSTANTS, getServerUrl } = require('../config/constants');
const http = require('http');
const https = require('https');
const url = require('url');

/**
 * Ping al servidor para verificar conectividad real.
 * Retorna true si el servidor responde, false si no.
 */
function pingServer() {
    return new Promise((resolve) => {
        const serverUrl = getServerUrl();
        if (!serverUrl) {
            resolve(false);
            return;
        }

        try {
            const parsed = new URL(serverUrl);
            const client = parsed.protocol === 'https:' ? https : http;

            const req = client.request(
                {
                    hostname: parsed.hostname,
                    port: parsed.port,
                    path: '/health',
                    method: 'HEAD',
                    timeout: 5000,
                },
                (res) => {
                    res.resume();
                    resolve(true);
                }
            );

            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.end();
        } catch (e) {
            resolve(false);
        }
    });
}

function startNetworkMonitoring(handlers) {
    let lastState = { osOnline: net.isOnline(), serverReachable: true };
    log.info('[NETWORK]: Starting monitoring with active ping.');

    return setInterval(async () => {
        const osOnline = net.isOnline();
        // Only attempt ping if OS confirms connection
        const serverReachable = osOnline ? await pingServer() : false;

        if (osOnline !== lastState.osOnline || serverReachable !== lastState.serverReachable) {
            log.info(
                `[NETWORK]: State changed. OS Online: ${osOnline}, Server Reachable: ${serverReachable}`
            );

            if (!osOnline) {
                log.info('[NETWORK]: No connection (OS).');
                handlers.onOffline?.('NO_INTERNET');
            } else if (!serverReachable) {
                log.info('[NETWORK]: Server unreachable (ping failed).');
                handlers.onOffline?.('NO_SERVER');
            } else {
                log.info('[NETWORK]: Connection restored.');
                handlers.onOnline?.();
            }

            lastState = { osOnline, serverReachable };
        } else if (serverReachable) {
            handlers.onCheckOnline?.();
        }
    }, CONSTANTS.NETWORK_CHECK_INTERVAL_MS);
}

module.exports = { startNetworkMonitoring, pingServer };
