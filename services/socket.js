/**
 * Socket Service — WebSocket connection to the central server.
 *
 * ## Circuit Breaker
 *
 * Problem: if the server goes down and there are 500+ agents, each agent retrying
 * every 3 seconds produces thousands of requests per second exactly when the server
 * is most fragile (during restart/recovery). This is known as a "thundering herd".
 *
 * Solution — a circuit breaker with three states:
 *
 *   CLOSED (normal)
 *     The socket uses Socket.IO's built-in exponential backoff:
 *     3s → 4.5s → 6.75s → ... up to SOCKET_RECONNECT_DELAY_MAX_MS.
 *     Jitter (±50%) is added to each delay to spread retries across agents.
 *
 *   OPEN (server appears down)
 *     Triggered after CIRCUIT_BREAKER_THRESHOLD consecutive failed attempts.
 *     The delay is already at its maximum (5 minutes) so the agent
 *     stops hammering the server. A warning is logged so operators can see
 *     the circuit opened.
 *     The agent NEVER stops retrying — there is no human to restart it.
 *
 *   CLOSED again (recovery)
 *     As soon as one attempt succeeds, the failure counter resets and a
 *     recovery log is emitted. Normal backoff resumes from the base delay.
 *
 * Backoff progression (randomizationFactor = 0.5, max = 5 min):
 *   Attempt  1 →   3s  (±50%)
 *   Attempt  3 →   9s
 *   Attempt  5 →  27s
 *   Attempt  7 →  81s
 *   Attempt  8 → ~2min
 *   Attempt  9 → ~3min
 *   Attempt 10 → ~5min  ← CIRCUIT OPENS here, stays at 5 min max
 */

const { io } = require('socket.io-client');
const { log, heartbeatLog } = require('../utils/logConfig');
const { SERVER_URL, CONSTANTS } = require('../config/constants');
const { getHttpsAgent } = require('../utils/httpClient');

/**
 * Opens a WebSocket connection to the server and attaches all event handlers.
 *
 * Reconnection is handled automatically by Socket.IO with exponential backoff.
 * The circuit breaker logic layers on top by tracking consecutive failures and
 * logging state transitions — it does NOT interrupt Socket.IO's internal retry loop.
 *
 * @param {string} token - Agent JWT used to authenticate the socket handshake.
 * @param {object} handlers - Callbacks for each socket event.
 * @returns {Socket} The Socket.IO socket instance.
 */
function connectToSocketServer(token, handlers) {
    let consecutiveFailures = 0;

    const socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: CONSTANTS.SOCKET_RECONNECT_DELAY_MS,
        reconnectionDelayMax: CONSTANTS.SOCKET_RECONNECT_DELAY_MAX_MS,
        // randomizationFactor adds ±50% jitter to each delay, spreading retries
        // across agents so they don't all hit the server at the same instant.
        randomizationFactor: 0.5,
        timeout: 20000,
        auth: { token },
        // mTLS: present client certificate in the TLS handshake (production)
        agent: getHttpsAgent(),
    });

    // ── CIRCUIT BREAKER: CLOSED ──────────────────────────────────────────────
    socket.on('connect', () => {
        if (consecutiveFailures >= CONSTANTS.CIRCUIT_BREAKER_THRESHOLD) {
            log.info(
                `[CIRCUIT BREAKER]: CLOSED — connection restored after ${consecutiveFailures} consecutive failures`
            );
        }
        consecutiveFailures = 0;

        log.info('[SOCKET]: Connected.');
        if (handlers.onConnect) handlers.onConnect();
    });

    socket.on('disconnect', (reason) => {
        log.info(`[SOCKET]: Disconnected: ${reason}`);
        if (handlers.onDisconnect) handlers.onDisconnect(reason);

        // 'io server disconnect' means the server explicitly kicked this socket.
        // Socket.IO won't auto-reconnect in that case — we trigger it manually.
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

    // ── CIRCUIT BREAKER: OPEN ────────────────────────────────────────────────
    // connect_error fires once per failed attempt (initial + each reconnect).
    socket.on('connect_error', (err) => {
        consecutiveFailures++;

        if (consecutiveFailures === CONSTANTS.CIRCUIT_BREAKER_THRESHOLD) {
            // Circuit just opened — log clearly so operators know.
            log.warn(
                `[CIRCUIT BREAKER]: OPEN — ${consecutiveFailures} consecutive failures. ` +
                `Server appears down. Retry interval now at max ` +
                `(${CONSTANTS.SOCKET_RECONNECT_DELAY_MAX_MS / 1000}s + jitter). ` +
                `Will keep retrying indefinitely.`
            );
        } else if (
            consecutiveFailures > CONSTANTS.CIRCUIT_BREAKER_THRESHOLD &&
            consecutiveFailures % 10 === 0
        ) {
            // Periodic reminder every 10 additional failures (~50 min at 5 min intervals).
            log.warn(
                `[CIRCUIT BREAKER]: Still open — ${consecutiveFailures} total failures. ` +
                `Server still unreachable.`
            );
        }

        log.error(`[SOCKET]: Connection error: ${err.message}`);
    });

    socket.on('reconnect_error', (err) => {
        // reconnect_error fires after connect_error during reconnection.
        // Failure counting is already handled in connect_error — only log here.
        log.error(`[SOCKET]: Reconnection error: ${err.message}`);
    });

    // ── DOMAIN EVENTS ────────────────────────────────────────────────────────
    socket.on('command', (cmd) => handlers.onCommand?.(cmd));
    socket.on('device-info', (device) => handlers.onDeviceInfo?.(device));
    socket.on('assets-updated', () => handlers.onAssetsUpdated?.());
    socket.on('force-reprovision', () => handlers.onForceReprovision?.());

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
