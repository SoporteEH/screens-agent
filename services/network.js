// Active detection: OS check + server ping.
const { net } = require('electron');
const { log } = require('../utils/logConfig');
const { getServerUrl } = require('../config/constants');
const http = require('http');
const https = require('https');

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
        } catch {
            resolve(false);
        }
    });
}

// Via Chromium (net.fetch) so the system proxy applies, as it does for the content.
const INTERNET_PROBES = ['https://www.gstatic.com/generate_204', 'https://1.1.1.1/'];
const PROBE_TIMEOUT_MS = 4000;

function probe(target) {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(false), PROBE_TIMEOUT_MS));
    const request = net
        .fetch(target, { method: 'HEAD', cache: 'no-store' })
        .then(() => true)
        .catch(() => false);
    return Promise.race([request, timeout]);
}

// The second target only when the first fails: one request per check while all is well.
async function pingInternet() {
    for (const target of INTERNET_PROBES) {
        if (await probe(target)) return true;
    }
    return false;
}

const STABLE_INTERVAL_MS = 15_000;
const DEGRADED_INTERVAL_MS = 5_000;

// handlers.isServerConnected: a live socket already proves the server answers, so /health is
// only asked while it is down. checkNow() is for the moment it drops.
function startNetworkMonitoring(handlers) {
    let lastState = { internetReachable: true, serverReachable: true };
    let isDegraded = false;
    let stopped = false;
    let timer = null;
    let running = false;
    let rerun = false;

    log.info('[NETWORK]: Starting adaptive monitoring (stable: 15s, degraded: 5s).');

    async function check() {
        const osOnline = net.isOnline();
        const [internetReachable, serverReachable] = osOnline
            ? await Promise.all([pingInternet(), handlers.isServerConnected?.() || pingServer()])
            : [false, false];

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
    }

    async function runCheck() {
        if (stopped) return;
        // A check asked for mid-run must still happen: the one in flight may predate the drop.
        if (running) {
            rerun = true;
            return;
        }
        running = true;
        clearTimeout(timer);
        try {
            await check();
        } catch (error) {
            log.error('[NETWORK]: Check failed:', error);
        }
        running = false;

        if (rerun) {
            rerun = false;
            runCheck();
        } else if (!stopped) {
            timer = setTimeout(runCheck, isDegraded ? DEGRADED_INTERVAL_MS : STABLE_INTERVAL_MS);
        }
    }

    timer = setTimeout(runCheck, 1000);

    return {
        checkNow: runCheck,
        stop: () => {
            stopped = true;
            clearTimeout(timer);
        },
    };
}

module.exports = { startNetworkMonitoring, pingServer };
