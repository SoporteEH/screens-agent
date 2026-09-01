const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const { log } = require('../utils/logConfig');

const GPU_CONFIG_FILE = path.join(app.getPath('userData'), 'gpu-config.json');

const GPU_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

let hardwareAccelerationRequested = false;

function hasGpuFailed() {
    try {
        if (fs.existsSync(GPU_CONFIG_FILE)) {
            const config = JSON.parse(fs.readFileSync(GPU_CONFIG_FILE, 'utf8'));
            if (config.gpuFailed !== true) return false;

            const failedAt = Date.parse(config.failedAt || '');
            if (Number.isFinite(failedAt) && Date.now() - failedAt > GPU_RETRY_AFTER_MS) {
                resetGpuState();
                return false;
            }
            return true;
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

    if (hasGpuFailed()) {
        log.warn('[GPU]: A previous run lost the GPU process. Starting in software rendering.');
        app.disableHardwareAcceleration();
        return;
    }

    hardwareAccelerationRequested = true;
    log.info('[GPU]: Using hardware acceleration.');

    // A/B knob: keep acceleration but let Chromium's blocklist decide instead of forcing raster/decode on old iGPUs.
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

    let maxOldSpace = 384; // Default for low-end devices (e.g. Raspberry Pi 3)
    if (totalMemMb > 3500) {
        maxOldSpace = 1024; // High-end devices (4GB+ RAM)
    } else if (totalMemMb > 1500) {
        maxOldSpace = 512; // Mid-range (2GB RAM)
    }

    app.commandLine.appendSwitch('js-flags', `--max-old-space-size=${maxOldSpace} --max-semi-space-size=8`);
    app.commandLine.appendSwitch('renderer-process-limit', '10');
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

const GPU_INFO_TIMEOUT_MS = 5000;

// Call after app.whenReady. Diagnostic aid for dual-GPU boxes that copy every
function logGpuDiagnostics() {
    let reported = false;

    const report = () => {
        if (reported) return;
        reported = true;

        try {
            const features = app.getGPUFeatureStatus();
            log.info(
                `[GPU]: Features — compositing: ${features.gpu_compositing}, ` +
                `video_decode: ${features.video_decode}, rasterization: ${features.rasterization}, ` +
                `webgl: ${features.webgl}`
            );
            // Otherwise the startup line claims acceleration a silent fallback already denied.
            if (hardwareAccelerationRequested && !/^enabled/.test(features.gpu_compositing || '')) {
                log.warn(
                    `[GPU]: Acceleration requested but Chromium is compositing in software (${features.gpu_compositing}).`
                );
            }
        } catch (e) {
            log.warn('[GPU]: Could not read feature status:', e.message);
        }

        app.getGPUInfo('complete')
            .then((info) => {
                const gpus = (info?.gpuDevice || []).map(
                    (d) =>
                        `vendor=0x${(d.vendorId || 0).toString(16)} device=0x${(d.deviceId || 0).toString(16)}${d.active ? ' (active)' : ''}`
                );
                log.info(`[GPU]: Adapters: ${gpus.join(' | ') || 'unknown'}`);

                const renderer = info?.auxAttributes?.glRenderer;
                if (renderer) log.info(`[GPU]: Renderer: ${renderer}`);
            })
            .catch((e) => log.warn('[GPU]: Could not read GPU info:', e.message));
    };

    app.once('gpu-info-update', report);
    setTimeout(report, GPU_INFO_TIMEOUT_MS).unref?.();
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
            return;
        }
        log.error(`[RENDERER]: Process gone (${details.reason}, exit ${details.exitCode})`);
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
