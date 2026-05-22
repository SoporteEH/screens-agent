const { io } = require('socket.io-client');
const { log, heartbeatLog } = require('../utils/logConfig');
const { SERVER_URL, CONSTANTS } = require('../config/constants');
const { getHttpsAgent } = require('../utils/httpClient');

function connectToSocketServer(token, handlers) {
    let consecutiveFailures = 0;
    let circuitBreakerState = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    let circuitBreakerTimer = null;

    const isHttps = SERVER_URL && SERVER_URL.startsWith('https://');

    const socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: CONSTANTS.SOCKET_RECONNECT_DELAY_MS,
        reconnectionDelayMax: CONSTANTS.SOCKET_RECONNECT_DELAY_MAX_MS,
        randomizationFactor: 0.5,
        timeout: 20000,
        auth: { token },
        ...(isHttps ? { agent: getHttpsAgent() } : {}),
    });

    // CIRCUIT BREAKER: CLOSED
    socket.on('connect', () => {
        if (circuitBreakerState !== 'CLOSED') {
            log.info(
                `[CIRCUIT BREAKER]: CLOSED — connection restored after ${consecutiveFailures} consecutive failures`
            );
            circuitBreakerState = 'CLOSED';
        }
        if (circuitBreakerTimer) {
            clearTimeout(circuitBreakerTimer);
            circuitBreakerTimer = null;
        }
        consecutiveFailures = 0;

        log.info('[SOCKET]: Connected.');
        if (handlers.onConnect) handlers.onConnect();
    });

    socket.on('disconnect', (reason) => {
        log.info(`[SOCKET]: Disconnected: ${reason}`);
        if (handlers.onDisconnect) handlers.onDisconnect(reason);

        if (reason === 'io server disconnect') {
            socket.connect();
        }
    });

    socket.on('reconnect', (attemptNumber) => {
        log.info(`[SOCKET]: Reconnected after ${attemptNumber} attempt(s)`);
        if (handlers.onReconnect) handlers.onReconnect(attemptNumber);
    });

    socket.on('reconnect_attempt', (n) => {
        log.debug(`[SOCKET]: Reconnecting attempt #${n}...`);
    });

    // CIRCUIT BREAKER: OPEN/HALF-OPEN state management
    socket.on('connect_error', (err) => {
        consecutiveFailures++;

        if (circuitBreakerState === 'CLOSED' && consecutiveFailures === CONSTANTS.CIRCUIT_BREAKER_THRESHOLD) {
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

    socket.on('reconnect_error', (err) => {
        log.error(`[SOCKET]: Reconnection error: ${err.message}`);
    });

    // DOMAIN EVENTS
    socket.on('command', (cmd) => handlers.onCommand?.(cmd));
    socket.on('device-info', (device) => handlers.onDeviceInfo?.(device));
    socket.on('assets-updated', () => handlers.onAssetsUpdated?.());
    socket.on('force-reprovision', () => handlers.onForceReprovision?.());

    socket.clearCircuitBreaker = () => {
        if (circuitBreakerTimer) {
            clearTimeout(circuitBreakerTimer);
            circuitBreakerTimer = null;
        }
    };

    return socket;
}

/**
 * Emits a heartbeat to the server with the current list of active screen IDs.
 * No-ops if the socket is not connected.
 */
function sendHeartbeat(socket, screenIds) {
    if (!socket?.connected) return;
    socket.emit('heartbeat', { screenIds });
    heartbeatLog.info(screenIds);
}

module.exports = {
    connectToSocketServer,
    sendHeartbeat,
};
