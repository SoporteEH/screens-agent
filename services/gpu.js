/**
 * GPU Management Service
 */

const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logConfig');

const GPU_CONFIG_FILE = path.join(app.getPath('userData'), 'gpu-config.json');

function hasGpuFailed() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(GPU_CONFIG_FILE, 'utf8'));
            return config.gpuFailed === true;
        }
    } catch (_e) {}
    return false;
}

function markGpuAsFailed() {
    try {
        fs.writeFileSync(
            GPU_CONFIG_FILE,
            JSON.stringify({ gpuFailed: true, failedAt: new Date().toISOString() })
        );
        log.info('[GPU]: Marcada como fallida.');
    } catch (e) {
        log.error('[GPU]: Error guardando estado:', e);
    }
}

function resetGpuState() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            fs.unlinkSync(GPU_CONFIG_FILE);
        }
    } catch (_e) {}
}

function configureGpu() {
    const disableGpu = process.env.DISABLE_GPU === 'true';

    if (disableGpu) {
        log.info('[GPU]: Hardware acceleration DISABLED (via DISABLE_GPU environment variable).');
        app.disableHardwareAcceleration();
        return;
    }

    log.info('[GPU]: Usando aceleracion por hardware (Comportamiento Conservador).');

    // Optimizaciones basicas de rasterizado y decodificacion
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-accelerated-video-decode');
    app.commandLine.appendSwitch('enable-zero-copy');
    app.commandLine.appendSwitch('use-angle', 'default');
    app.commandLine.appendSwitch('enable-webgl');
}

function configureMemory() {
    app.commandLine.appendSwitch('js-flags', '--max-old-space-size=384 --max-semi-space-size=2');
    app.commandLine.appendSwitch('renderer-process-limit', '6');
    app.commandLine.appendSwitch('disk-cache-size', '5242880');
    app.commandLine.appendSwitch('media-cache-size', '5242880');
    app.commandLine.appendSwitch('disable-http-cache');
    app.commandLine.appendSwitch(
        'disable-features',
        'MediaRouter,AudioServiceOutOfProcess,CalculateNativeWinOcclusion,HardwareMediaKeyHandling'
    );
    app.commandLine.appendSwitch('disable-extensions');
    app.commandLine.appendSwitch('disable-sync');
    app.commandLine.appendSwitch('disable-translate');
    app.commandLine.appendSwitch('disable-background-networking');
    app.commandLine.appendSwitch('disable-notifications');
    app.commandLine.appendSwitch('disable-domain-reliability');

    log.info('[MEMORY]: Optimizacion aplicada.');
}

function registerGpuCrashHandlers() {
    app.on('gpu-process-crashed', (_event, killed) => {
        log.error(`[GPU]: Proceso crasheo (killed: ${killed})`);
        markGpuAsFailed();
    });

    app.on('render-process-gone', (_event, _webContents, details) => {
        if (details.reason === 'crashed' || details.reason === 'gpu-dead') {
            log.error(`[GPU]: Renderizado fallo (${details.reason})`);
            markGpuAsFailed();
        }
    });
}

module.exports = {
    hasGpuFailed,
    markGpuAsFailed,
    resetGpuState,
    configureGpu,
    configureMemory,
    registerGpuCrashHandlers,
};
