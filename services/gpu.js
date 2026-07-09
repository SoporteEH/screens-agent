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
    } catch (_e) { }
    return false;
}

function markGpuAsFailed() {
    try {
        fs.writeFileSync(
            GPU_CONFIG_FILE,
            JSON.stringify({ gpuFailed: true, failedAt: new Date().toISOString() })
        );
        log.info('[GPU]: Marked as failed.');
    } catch (e) {
        log.error('[GPU]: Error saving state:', e);
    }
}

function resetGpuState() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            fs.unlinkSync(GPU_CONFIG_FILE);
        }
    } catch (_e) { }
}

function configureGpu() {
    const disableGpu = process.env.DISABLE_GPU === 'true';

    if (disableGpu) {
        log.info('[GPU]: Hardware acceleration DISABLED (via DISABLE_GPU environment variable).');
        app.disableHardwareAcceleration();
        return;
    }

    log.info('[GPU]: Using hardware acceleration.');

    // A/B knob for problem boxes: keep acceleration but let Chromium's
    // blocklist decide instead of forcing raster/decode on old iGPUs.
    if (process.env.GPU_SAFE_MODE === 'true') {
        log.info('[GPU]: Safe mode — skipping forced GPU switches.');
        return;
    }

    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-accelerated-video-decode');
    app.commandLine.appendSwitch('enable-zero-copy');
    app.commandLine.appendSwitch('use-angle', 'default');
    app.commandLine.appendSwitch('enable-webgl');
}

function configureMemory() {
    const os = require('os');
    const totalMemMb = os.totalmem() / (1024 * 1024);

    // Dynamic memory allocation based on system resources
    let maxOldSpace = 384; // Default for low-end devices (e.g. Raspberry Pi 3)
    if (totalMemMb > 3500) {
        maxOldSpace = 1024; // High-end devices (4GB+ RAM)
    } else if (totalMemMb > 1500) {
        maxOldSpace = 512; // Mid-range (2GB RAM)
    }

    app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${maxOldSpace} --max-semi-space-size=8`);
    app.commandLine.appendSwitch('renderer-process-limit', '10');
    // Kiosk tradeoff for 4GB boxes: player pages hold no secrets and content is
    // admin-curated, so shared renderers + in-process iframes are acceptable.
    app.commandLine.appendSwitch('process-per-site');
    app.commandLine.appendSwitch('disable-site-isolation-trials');
    app.commandLine.appendSwitch('disk-cache-size', '157286400'); // 150MB
    app.commandLine.appendSwitch('media-cache-size', '52428800'); // 50MB
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

    // Opt-in: sites honoring prefers-reduced-motion tone down decorative animations
    if (process.env.REDUCED_MOTION === 'true') {
        app.commandLine.appendSwitch('force-prefers-reduced-motion');
    }

    log.info(`[MEMORY]: Optimization applied (Max Old Space: ${maxOldSpace}MB). Total RAM: ${Math.round(totalMemMb)}MB`);
}

// Call after app.whenReady: shows per-box whether compositing/video decode are
// hardware and which adapter Chromium picked (dual-GPU boxes copy every frame
// across adapters — the fix is operational, but this log pinpoints it).
function logGpuDiagnostics() {
    try {
        const features = app.getGPUFeatureStatus();
        log.info(
            `[GPU]: Features — compositing: ${features.gpu_compositing}, ` +
            `video_decode: ${features.video_decode}, rasterization: ${features.rasterization}, ` +
            `webgl: ${features.webgl}`
        );
    } catch (e) {
        log.warn('[GPU]: Could not read feature status:', e.message);
    }

    app.getGPUInfo('basic')
        .then((info) => {
            const gpus = (info?.gpuDevice || []).map(
                (d) =>
                    `vendor=0x${(d.vendorId || 0).toString(16)} device=0x${(d.deviceId || 0).toString(16)}${d.active ? ' (active)' : ''}`
            );
            log.info(`[GPU]: Adapters: ${gpus.join(' | ') || 'unknown'}`);
        })
        .catch((e) => log.warn('[GPU]: Could not read GPU info:', e.message));
}

function registerGpuCrashHandlers() {
    app.on('gpu-process-crashed', (_event, killed) => {
        log.error(`[GPU]: Process crashed (killed: ${killed})`);
        markGpuAsFailed();
    });

    app.on('render-process-gone', (_event, _webContents, details) => {
        if (details.reason === 'crashed' || details.reason === 'gpu-dead') {
            log.error(`[GPU]: Render failed (${details.reason})`);
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
    logGpuDiagnostics,
    registerGpuCrashHandlers,
};
