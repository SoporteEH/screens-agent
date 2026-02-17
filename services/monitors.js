/**
 * Display & Network Monitors
 */

const { screen } = require('electron');
const { log } = require('../utils/logConfig');
const { startNetworkMonitoring } = require('./network');
const { buildDisplayMap, loadLastState } = require('./state');

let screenChangeTimeout;

const initializeMonitors = (context) => {
    const onScreenChange = (reason) => {
        const {
            hardwareIdToDisplayMap,
            managedWindows,
            handleShowUrl,
            socket,
            registerDevice,
            CONSTANTS,
        } = context;

        if (screenChangeTimeout) clearTimeout(screenChangeTimeout);
        log.info(`[DISPLAY]: Cambio detectado (${reason})`);

        screenChangeTimeout = setTimeout(async () => {
            log.info('[DISPLAY]: Actualizando mapa de pantallas.');

            const previousIds = Array.from(hardwareIdToDisplayMap.keys());
            await buildDisplayMap(hardwareIdToDisplayMap);
            const currentIds = Array.from(hardwareIdToDisplayMap.keys());

            if (reason === 'removed') {
                const orphanedIds = previousIds.filter((id) => !currentIds.includes(id));
                for (const id of orphanedIds) {
                    const win = managedWindows.get(id);
                    if (win && !win.isDestroyed()) {
                        log.info(`[DISPLAY]: Cerrando ventana huerfana: ${id}`);
                        win.close();
                    }
                    managedWindows.delete(id);
                }
            }

            if (reason === 'added') {
                const newIds = currentIds.filter((id) => !previousIds.includes(id));
                if (newIds.length > 0) {
                    log.info(`[DISPLAY]: Nuevas pantallas: ${newIds.join(', ')}`);
                    const lastState = loadLastState();
                    for (const id of newIds) {
                        if (lastState[id]) {
                            log.info(`[DISPLAY]: Restaurando ${id}: ${lastState[id].url}`);
                            setTimeout(() => {
                                handleShowUrl({
                                    action: 'show_url',
                                    screenIndex: id,
                                    url: lastState[id].url,
                                    credentials: lastState[id].credentials || null,
                                });
                            }, 500);
                        }
                    }
                }
            }

            if (socket?.connected) registerDevice();
        }, CONSTANTS.SCREEN_DEBOUNCE_MS);
    };

    screen.on('display-added', () => onScreenChange('added'));
    screen.on('display-removed', () => onScreenChange('removed'));
    screen.on('display-metrics-changed', () => onScreenChange('metrics-changed'));

    startNetworkMonitoring({
        onOffline: () => context.onNetworkOffline(),
        onOnline: () => context.onNetworkOnline(),
        onCheckOnline: () => {
            if (context.socket && !context.socket.connected) {
                log.info('[NETWORK]: Socket desconectado. Reconectando...');
                context.socket.connect();
            }
        },
    });
};

module.exports = { initializeMonitors };
