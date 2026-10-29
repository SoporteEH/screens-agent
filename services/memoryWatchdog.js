// A screen's page runs in a renderer of its own, apart from the wrapper that frames it (one
// process for every screen), so a leaking page shows only in the processes of its frames.
const os = require('os');
const path = require('path');
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

// What a frame shows, for the log: the site's host, or the agent's own page by name.
function frameLabel(url) {
    if (!url || url === 'about:blank') return null;
    if (isWrapperUrl(url)) return 'wrapper';
    try {
        const { protocol, hostname, pathname } = new URL(url);
        if (protocol === 'file:') return path.basename(pathname, '.html');
        return hostname || null;
    } catch {
        return null;
    }
}

// One line per check: which process holds what, so a slow growth over hours can be traced to
// a site. A process lists its sites and the screens showing them; the rest is the agent's own.
function formatUsage({ totalMb, mainMb, gpuMb, usageMb, screens }) {
    const hosted = new Map();
    for (const screen of screens) {
        for (const { pid, label } of screen.frames) {
            if (!hosted.has(pid)) hosted.set(pid, { labels: new Set(), screens: new Set() });
            if (label) hosted.get(pid).labels.add(label);
            hosted.get(pid).screens.add(String(screen.screenId));
        }
    }
    const rendererMb = [...usageMb.values()].reduce((sum, mb) => sum + mb, 0);
    let attributedMb = 0;
    const parts = [...hosted]
        .filter(([pid]) => usageMb.has(pid))
        .map(([pid, { labels, screens: shownOn }]) => {
            attributedMb += usageMb.get(pid);
            const sites = [...labels].slice(0, 3).join(', ') || 'blank';
            const where = [...shownOn].sort().join(', ');
            return {
                mb: usageMb.get(pid),
                text: `${Math.round(usageMb.get(pid))} ${sites} (screen ${where})`,
            };
        })
        .sort((a, b) => b.mb - a.mb)
        .map((p) => p.text);
    const otherMb = Math.round(rendererMb - attributedMb);
    if (otherMb > 0) parts.push(`${otherMb} other`);
    return (
        `Agent ${Math.round(totalMb)} MB (main ${Math.round(mainMb)}, GPU ${Math.round(gpuMb)}, ` +
        `renderers ${Math.round(rendererMb)}) | ${parts.join(' | ')}`
    );
}

function describeScreens(managedWindows) {
    const screens = [];
    for (const [screenId, win] of managedWindows) {
        if (!win || win.isDestroyed() || win.webContents.isLoading()) continue;
        const wc = win.webContents;
        const frames = wc.mainFrame.framesInSubtree.map((frame) => ({
            pid: frame.osProcessId,
            label: frameLabel(frame.url),
        }));
        screens.push({
            screenId,
            win,
            mainPid: wc.getOSProcessId(),
            frames,
            framePids: frames.map((frame) => frame.pid),
            isWrapper: isWrapperUrl(wc.getURL()),
        });
    }
    return screens;
}

function check(managedWindows, lastReload) {
    const limitMb = memoryLimitMb();
    // Kilobytes; privateBytes exists on Windows only.
    const metrics = app.getAppMetrics().map((m) => ({
        type: m.type,
        pid: m.pid,
        mb: (m.memory.privateBytes ?? m.memory.workingSetSize) / 1024,
    }));
    const usageMb = new Map(metrics.filter((m) => m.type === 'Tab').map((m) => [m.pid, m.mb]));
    const sumOf = (type) => metrics.filter((m) => m.type === type).reduce((s, m) => s + m.mb, 0);
    const screens = describeScreens(managedWindows);
    log.info(
        `[MEMORY]: ${formatUsage({
            totalMb: metrics.reduce((s, m) => s + m.mb, 0),
            mainMb: sumOf('Browser'),
            gpuMb: sumOf('GPU'),
            usageMb,
            screens,
        })}`
    );

    const now = Date.now();
    for (const { screen, mb, action } of planReloads(screens, usageMb, limitMb)) {
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

module.exports = { startMemoryWatchdog, planReloads, memoryLimitMb, formatUsage, frameLabel };
