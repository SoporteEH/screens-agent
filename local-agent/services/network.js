/**
 * Network Monitoring Service
 * Deteccion activa: OS check + ping al servidor
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
    let wasOffline = false;
    log.info('[NETWORK]: Iniciando monitoreo con ping activo.');

    return setInterval(async () => {
        const osOnline = net.isOnline();

        if (!osOnline) {
            // OS dice offline → definitivamente offline
            if (!wasOffline) {
                wasOffline = true;
                log.info('[NETWORK]: Sin conexion (OS).');
                handlers.onOffline?.();
            }
            return;
        }

        // OS dice online → verificar con ping real al servidor
        const serverReachable = await pingServer();

        if (!serverReachable && !wasOffline) {
            wasOffline = true;
            log.info('[NETWORK]: Servidor inalcanzable (ping fallido).');
            handlers.onOffline?.();
        } else if (serverReachable && wasOffline) {
            log.info('[NETWORK]: Conexion restaurada (ping exitoso).');
            wasOffline = false;
            handlers.onOnline?.();
        } else if (serverReachable) {
            handlers.onCheckOnline?.();
        }
    }, CONSTANTS.NETWORK_CHECK_INTERVAL_MS);
}

module.exports = { startNetworkMonitoring };
