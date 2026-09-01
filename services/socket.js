const { io } = require('socket.io-client');
const { log, heartbeatLog } = require('../utils/logConfig');
const { SERVER_URL, CONSTANTS } = require('../config/constants');

// Bounds how often an external trigger may abort the manager's backoff.
const FORCE_RECONNECT_MIN_INTERVAL_MS = 10 * 1000;

function connectToSocketServer(token, handlers) {
    let consecutiveFailures = 0;
    let circuitBreakerState = 'CLOSED';
    let circuitBreakerTimer = null;
    let lastForcedAt = 0;
    let hasConnected = false;

    const socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: CONSTANTS.SOCKET_RECONNECT_DELAY_MS,
        reconnectionDelayMax: CONSTANTS.SOCKET_RECONNECT_DELAY_MAX_MS,
        randomizationFactor: 0.5,
        timeout: 20000,
        auth: { token },
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

        if (reason === 'io server disconnect') {
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

    socket.on('connect_error', (err) => {
        consecutiveFailures++;

        if (circuitBreakerState !== 'OPEN' && consecutiveFailures >= CONSTANTS.CIRCUIT_BREAKER_THRESHOLD) {
            circuitBreakerState = 'OPEN';
            log.warn(
                `[CIRCUIT BREAKER]: OPEN — ${consecutiveFailures} consecutive failures. ` +
                `Disconnecting and pausing for 5 minutes before next attempt.`
            );
            socket.disconnect();
            circuitBreakerTimer = setTimeout(() => {
                circuitBreakerTimer = null;
                circuitBreakerState = 'HALF_OPEN';
                log.info('[CIRCUIT BREAKER]: HALF_OPEN — attempting reconnect after pause.');
                socket.connect();
            }, 5 * 60 * 1000);
        } else if (
            circuitBreakerState === 'OPEN' &&
            consecutiveFailures > CONSTANTS.CIRCUIT_BREAKER_THRESHOLD &&
            consecutiveFailures % 10 === 0
        ) {
            log.warn(
                `[CIRCUIT BREAKER]: Still open — ${consecutiveFailures} total failures. ` +
                `Server still unreachable.`
            );
        }

        log.error(`[SOCKET]: Connection error: ${err.message}`);
    });

    socket.io.on('reconnect_error', (err) => {
        log.error(`[SOCKET]: Reconnection error: ${err.message}`);
    });

    socket.on('command', (cmd) => handlers.onCommand?.(cmd));
    socket.on('device-info', (device) => handlers.onDeviceInfo?.(device));
    socket.on('assets-updated', () => handlers.onAssetsUpdated?.());
    socket.on('force-reprovision', () => handlers.onForceReprovision?.());
    socket.on('reset-screens', () => handlers.onResetScreens?.());

    socket.clearCircuitBreaker = resetCircuitBreaker;

    // connect() is a no-op while the manager is already waiting out its backoff
    // (it guards on _reconnecting), so a caller that just proved the server is up
    // has to drop that wait first. disconnect() cancels it; connect() then dials now.
    socket.forceReconnect = () => {
        if (socket.connected) return false;

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

function sendHeartbeat(socket, screenIds) {
    if (!socket?.connected) return;
    socket.emit('heartbeat', { screenIds });
    heartbeatLog.info(screenIds);
}

module.exports = {
    connectToSocketServer,
    sendHeartbeat,
};
