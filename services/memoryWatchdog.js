// A screen's page runs in a renderer of its own, apart from the wrapper that frames it (one
// process for every screen), so a leaking page shows only in the processes of its frames.
const os = require('os');
const { app } = require('electron');
const { log } = require('../utils/logConfig');
const { isWrapperUrl } = require('../utils/wrapperUrl');

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
// A page that is simply heavy is not reloaded on every check.
const RELOAD_COOLDOWN_MS = 60 * 60 * 1000;

// Per renderer: a share of the RAM, so a 4 GB PC acts before Windows starts paging.
function memoryLimitMb(totalMb = os.totalmem() / (1024 * 1024)) {
    return Math.round(Math.min(1024, Math.max(350, totalMb * 0.15)));
}

// screens: [{ screenId, mainPid, framePids, isWrapper }]; usageMb: pid -> MB.
// A page inside the wrapper gets only its frame reloaded; anything else, the whole window.
function planReloads(screens, usageMb, limitMb) {
    const plan = [];
    for (const screen of screens) {
        const over = [...new Set(screen.framePids)].filter((pid) => usageMb.get(pid) > limitMb);
        if (over.length === 0) continue;
        const pid = over.includes(screen.mainPid) ? screen.mainPid : over[0];
        plan.push({
            screen,
            pid,
            mb: Math.round(usageMb.get(pid)),
            action: screen.isWrapper && pid !== screen.mainPid ? 'refresh-content' : 'reload',
        });
    }
    return plan;
}

function describeScreens(managedWindows) {
    const screens = [];
    for (const [screenId, win] of managedWindows) {
        if (!win || win.isDestroyed() || win.webContents.isLoading()) continue;
        const wc = win.webContents;
        screens.push({
            screenId,
            win,
            mainPid: wc.getOSProcessId(),
            framePids: wc.mainFrame.framesInSubtree.map((frame) => frame.osProcessId),
            isWrapper: isWrapperUrl(wc.getURL()),
        });
    }
    return screens;
}

function check(managedWindows, lastReload) {
    const limitMb = memoryLimitMb();
    const usageMb = new Map(
        app
            .getAppMetrics()
            .filter((m) => m.type === 'Tab')
            // Kilobytes; privateBytes exists on Windows only.
            .map((m) => [m.pid, (m.memory.privateBytes ?? m.memory.workingSetSize) / 1024])
    );
    log.debug(
        `[MEMORY]: Renderers ${[...usageMb.values()].map(Math.round).join(', ')} MB (limit ${limitMb} MB)`
    );

    const now = Date.now();
    for (const { screen, mb, action } of planReloads(
        describeScreens(managedWindows),
        usageMb,
        limitMb
    )) {
        const key = String(screen.screenId);
        if (now - (lastReload.get(key) || 0) < RELOAD_COOLDOWN_MS) continue;
        lastReload.set(key, now);

        if (action === 'refresh-content') {
            log.warn(
                `[MEMORY]: Screen ${key} content uses ${mb} MB (limit ${limitMb} MB). Reloading the content.`
            );
            screen.win.webContents.send('player:refresh');
        } else {
            log.warn(
                `[MEMORY]: Screen ${key} uses ${mb} MB (limit ${limitMb} MB). Reloading the window.`
            );
            screen.win.webContents.reload();
        }
    }
}

function startMemoryWatchdog(managedWindows) {
    const lastReload = new Map();
    const timer = setInterval(() => {
        try {
            check(managedWindows, lastReload);
        } catch (error) {
            log.error('[MEMORY]: Check failed:', error);
        }
    }, CHECK_INTERVAL_MS);
    timer.unref?.();
    log.info(`[MEMORY]: Watchdog started (limit ${memoryLimitMb()} MB per renderer).`);
    return () => clearInterval(timer);
}

module.exports = { startMemoryWatchdog, planReloads, memoryLimitMb };
