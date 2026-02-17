/**
 * Socket Service - Conexion WebSocket
 */

const { io } = require('socket.io-client');
const { log, heartbeatLog } = require('../utils/logConfig');
const { SERVER_URL, CONSTANTS } = require('../config/constants');

function connectToSocketServer(token, handlers) {
    const socket = io(SERVER_URL, {
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 3000,
        reconnectionDelayMax: CONSTANTS.SOCKET_RECONNECT_DELAY_MAX_MS,
        randomizationFactor: 0.5,
        timeout: 20000,
        auth: { token },
    });

    socket.on('connect', () => {
        log.info('[SOCKET]: Conectado.');
        if (handlers.onConnect) handlers.onConnect();
    });

    socket.on('disconnect', (reason) => {
        log.info(`[SOCKET]: Desconectado: ${reason}`);
        if (handlers.onDisconnect) handlers.onDisconnect(reason);

        if (reason === 'io server disconnect') {
            socket.connect();
        }
    });

    socket.on('reconnect', (attemptNumber) => {
        log.info(`[SOCKET]: Reconectado (intento ${attemptNumber})`);
        if (handlers.onReconnect) handlers.onReconnect(attemptNumber);
    });

    socket.on('reconnect_attempt', (n) => log.info(`[SOCKET]: Reconectando #${n}...`));
    socket.on('reconnect_error', (err) => log.error(`[SOCKET]: Error reconexion: ${err.message}`));
    socket.on('connect_error', (err) => log.error(`[SOCKET]: Error conexion: ${err.message}`));

    socket.on('command', (cmd) => handlers.onCommand?.(cmd));
    socket.on('device-info', (device) => handlers.onDeviceInfo?.(device));
    socket.on('assets-updated', () => handlers.onAssetsUpdated?.());
    socket.on('force-reprovision', () => handlers.onForceReprovision?.());

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
