// Active detection: OS check + server ping.
const { net } = require('electron');
const { log } = require('../utils/logConfig');
const { CONSTANTS, getServerUrl } = require('../config/constants');
const http = require('http');
const https = require('https');
const url = require('url');

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

const STABLE_INTERVAL_MS = 15_000;
const DEGRADED_INTERVAL_MS = 5_000;

function startNetworkMonitoring(handlers) {
    let lastState = { internetReachable: true, serverReachable: true };
    let isDegraded = false;
    let stopped = false;

    log.info('[NETWORK]: Starting adaptive monitoring (stable: 15s, degraded: 5s).');

    async function runCheck() {
        if (stopped) return;

        const osOnline = net.isOnline();
        const internetReachable = osOnline ? await pingInternet() : false;
        const serverReachable = internetReachable ? await pingServer() : false;

        const hasStateChanged =
            internetReachable !== lastState.internetReachable ||
            serverReachable !== lastState.serverReachable;

        const allGood = internetReachable && serverReachable;

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

            lastState = { internetReachable, serverReachable };
        } else if (allGood) {
            handlers.onCheckOnline?.();
        }

        isDegraded = !allGood;

        if (!stopped) {
            const nextInterval = isDegraded ? DEGRADED_INTERVAL_MS : STABLE_INTERVAL_MS;
            setTimeout(runCheck, nextInterval);
        }
    }

    setTimeout(runCheck, 1000);

    return () => { stopped = true; };
}

module.exports = { startNetworkMonitoring, pingServer };
