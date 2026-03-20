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

/**
 * Ping an external host to verify real internet connectivity.
 */
function pingInternet() {
    return new Promise((resolve) => {
        try {
            const client = https;
            const req = client.request(
                {
                    hostname: '1.1.1.1',
                    port: 443,
                    path: '/',
                    method: 'HEAD',
                    timeout: 4000,
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
    let lastState = { osOnline: net.isOnline(), internetReachable: true, serverReachable: true };
    log.info('[NETWORK]: Starting monitoring with active internet and server pings.');

    return setInterval(async () => {
        const osOnline = net.isOnline();

        // Verify real internet if OS says online
        const internetReachable = osOnline ? await pingInternet() : false;

        // Verify server only if internet is available
        const serverReachable = internetReachable ? await pingServer() : false;

        const hasStateChanged =
            osOnline !== lastState.osOnline ||
            internetReachable !== lastState.internetReachable ||
            serverReachable !== lastState.serverReachable;

        if (hasStateChanged) {
            log.info(
                `[NETWORK]: State changed. OS: ${osOnline}, Internet: ${internetReachable}, Server: ${serverReachable}`
            );

            if (!internetReachable) {
                log.info('[NETWORK]: No internet connection.');
                handlers.onOffline?.('NO_INTERNET');
            } else if (!serverReachable) {
                log.info('[NETWORK]: Server unreachable (but internet is OK).');
                handlers.onOffline?.('NO_SERVER');
            } else {
                log.info('[NETWORK]: Connection restored.');
                handlers.onOnline?.();
            }

            lastState = { osOnline, internetReachable, serverReachable };
        } else if (serverReachable) {
            handlers.onCheckOnline?.();
        }
    }, CONSTANTS.NETWORK_CHECK_INTERVAL_MS);
}

module.exports = { startNetworkMonitoring, pingServer };
