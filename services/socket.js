const { io } = require('socket.io-client');
const { log, heartbeatLog } = require('../utils/logConfig');
const { SERVER_URL, CONSTANTS } = require('../config/constants');

// Bounds how often an external trigger may abort the manager's backoff.
const FORCE_RECONNECT_MIN_INTERVAL_MS = 10 * 1000;
// Another machine holds this identity: step aside.
const DUPLICATE_BACKOFF_MS = 10 * 60 * 1000;
const OUTAGE_LOG_INTERVAL_MS = 60 * 60 * 1000;

function connectToSocketServer(token, handlers) {
    let consecutiveFailures = 0;
    let circuitBreakerState = 'CLOSED';
    let circuitBreakerTimer = null;
    let lastForcedAt = 0;
    let hasConnected = false;
    let holdUntil = 0;
    let outageLoggedAt = 0;
    const onHold = () => Date.now() < holdUntil;

    const socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: CONSTANTS.SOCKET_RECONNECT_DELAY_MS,
        reconnectionDelayMax: CONSTANTS.SOCKET_RECONNECT_DELAY_MAX_MS,
        randomizationFactor: 0.5,
        timeout: 20000,
        // A transport that fails within an attempt hands over to the other one.
        tryAllTransports: true,
        auth: { token },
    });

    // Reconnections open on the transport the last connection ended up on, so once WebSocket has
    // worked they skip the long-polling handshake. Not engine.io's rememberUpgrade: it drops to
    // polling after any failed attempt, an API restart included.
    socket.io.on('open', () => {
        const engine = socket.io.engine;
        const remember = () => {
            socket.io.opts.transports =
                engine.transport.name === 'websocket'
                    ? ['websocket', 'polling']
                    : ['polling', 'websocket'];
        };
        remember();
        engine.on('upgrade', remember);
    });

    const resetCircuitBreaker = () => {
        if (circuitBreakerTimer) {
            clearTimeout(circuitBreakerTimer);
            circuitBreakerTimer = null;
        }
        circuitBreakerState = 'CLOSED';
        consecutiveFailures = 0;
    };

    socket.on('connect', () => {
        if (circuitBreakerState !== 'CLOSED') {
            log.info(
                `[CIRCUIT BREAKER]: CLOSED — connection restored after ${consecutiveFailures} consecutive failures`
            );
        }
        resetCircuitBreaker();

        log.info('[SOCKET]: Connected.');
        if (handlers.onConnect) handlers.onConnect();

        // A forced reconnect opens the manager by hand, which skips its 'reconnect'
        // event. Deriving it from 'connect' covers both paths with one rule.
        if (hasConnected && handlers.onReconnect) handlers.onReconnect();
        hasConnected = true;
    });

    socket.on('disconnect', (reason) => {
        log.info(`[SOCKET]: Disconnected: ${reason}`);
        if (handlers.onDisconnect) handlers.onDisconnect(reason);

        if (reason === 'io server disconnect' && !onHold()) {
            socket.connect();
        }
    });

    // Reconnection events live on the manager in socket.io-client v4; on the
    // socket they silently never fire.
    socket.io.on('reconnect', (attemptNumber) => {
        log.info(`[SOCKET]: Reconnected after ${attemptNumber} attempt(s)`);
    });

    socket.io.on('reconnect_attempt', (n) => {
        log.debug(`[SOCKET]: Reconnecting attempt #${n}...`);
    });

    // Fires on every failed attempt, reconnections included: the one place they are logged.
    // An outage is logged when it starts and then hourly; single attempts go to debug.
    socket.on('connect_error', (err) => {
        consecutiveFailures++;
        const message = `[SOCKET]: Connection error: ${err.message}`;
        if (consecutiveFailures === 1) log.error(message);
        else log.debug(message);

        if (
            circuitBreakerState !== 'OPEN' &&
            consecutiveFailures >= CONSTANTS.CIRCUIT_BREAKER_THRESHOLD
        ) {
            const reopened = circuitBreakerState === 'HALF_OPEN';
            circuitBreakerState = 'OPEN';
            const now = Date.now();
            if (!reopened) {
                outageLoggedAt = now;
                log.warn(
                    `[CIRCUIT BREAKER]: OPEN — ${consecutiveFailures} consecutive failures. ` +
                        `Retrying every 5 minutes.`
                );
            } else if (now - outageLoggedAt >= OUTAGE_LOG_INTERVAL_MS) {
                outageLoggedAt = now;
                log.warn(
                    `[CIRCUIT BREAKER]: Server still unreachable — ${consecutiveFailures} consecutive failures.`
                );
            }
            socket.disconnect();
            circuitBreakerTimer = setTimeout(
                () => {
                    circuitBreakerTimer = null;
                    circuitBreakerState = 'HALF_OPEN';
                    log.debug('[CIRCUIT BREAKER]: HALF_OPEN — attempting reconnect after pause.');
                    socket.connect();
                },
                5 * 60 * 1000
            );
        }

        // Expired or revoked token.
        if (err.message === 'Unauthorized') handlers.onUnauthorized?.();
    });

    socket.on('command', (cmd) => handlers.onCommand?.(cmd));
    socket.on('device-info', (device) => handlers.onDeviceInfo?.(device));
    socket.on('assets-updated', () => handlers.onAssetsUpdated?.());
    socket.on('force-reprovision', () => handlers.onForceReprovision?.());
    socket.on('reset-screens', () => handlers.onResetScreens?.());
    socket.on('duplicate-device', () => {
        log.error(
            `[SOCKET]: Another machine is connected with this device identity (cloned disk image?). ` +
                `Stepping aside for ${DUPLICATE_BACKOFF_MS / 60000} minutes; screens keep playing locally.`
        );
        holdUntil = Date.now() + DUPLICATE_BACKOFF_MS;
        socket.disconnect();
        setTimeout(() => {
            holdUntil = 0;
            socket.connect();
        }, DUPLICATE_BACKOFF_MS);
    });

    socket.clearCircuitBreaker = resetCircuitBreaker;

    // connect() is a no-op while the manager is already waiting out its backoff
    // (it guards on _reconnecting), so a caller that just proved the server is up
    // has to drop that wait first. disconnect() cancels it; connect() then dials now.
    socket.forceReconnect = () => {
        if (socket.connected || onHold()) return false;

        const now = Date.now();
        if (now - lastForcedAt < FORCE_RECONNECT_MIN_INTERVAL_MS) return false;
        lastForcedAt = now;

        resetCircuitBreaker();
        socket.disconnect();
        socket.connect();
        return true;
    };

    return socket;
}

// clientTime lets the API spot a wrong PC clock, which playlists depend on; storage tells the
// panel when files could not all fit.
function sendHeartbeat(socket, screenIds) {
    if (!socket?.connected) return;
    const { getStorageReport } = require('./assets');
    socket.emit('heartbeat', {
        screenIds,
        clientTime: new Date().toISOString(),
        storage: getStorageReport(),
    });
    heartbeatLog.info(screenIds);
}

module.exports = {
    connectToSocketServer,
    sendHeartbeat,
};
