// Network events fire only on state changes, so a window left on a dead page is never
// noticed. This verifies what is actually on screen, online or not.
const { log } = require('../utils/logConfig');

const CHECK_INTERVAL_MS = 60 * 1000;
// A screen mid-transition briefly looks wrong; require two consecutive bad checks.
const STRIKES_BEFORE_RECOVERY = 2;

function startScreenWatchdog(context) {
    const strikes = new Map();

    const timer = setInterval(() => {
        try {
            runCheck(context, strikes);
        } catch (error) {
            log.error('[SCREEN-WATCHDOG]: Check failed:', error);
        }
    }, CHECK_INTERVAL_MS);
    timer.unref?.();

    log.info(`[SCREEN-WATCHDOG]: Started (every ${CHECK_INTERVAL_MS / 1000}s).`);
    return () => clearInterval(timer);
}

function runCheck(context, strikes) {
    const online = context.networkState === 'ONLINE';

    context.managedWindows.forEach((win, screenId) => {
        const screenIdStr = String(screenId);

        if (!win || win.isDestroyed()) {
            strikes.delete(screenIdStr);
            return;
        }
        // A scheduled fallback or an in-flight navigation is already handling this screen.
        if (context.fallbackTimers.has(screenIdStr)) return;
        if (context.retryManager.has(screenIdStr)) return;
        if (win.webContents.isLoading()) return;

        const verdict = context.inspectScreen(screenId, win, online);
        if (verdict.ok) {
            strikes.delete(screenIdStr);
            return;
        }

        const count = (strikes.get(screenIdStr) || 0) + 1;
        strikes.set(screenIdStr, count);

        if (count < STRIKES_BEFORE_RECOVERY) {
            log.warn(
                `[SCREEN-WATCHDOG]: Screen ${screenIdStr} is ${verdict.reason} (strike ${count}). Re-checking next cycle.`
            );
            return;
        }

        strikes.delete(screenIdStr);
        log.warn(`[SCREEN-WATCHDOG]: Recovering screen ${screenIdStr} — ${verdict.reason}.`);

        if (online) {
            context.applyOnlineScreen(screenId);
        } else {
            context.applyOfflineScreen(screenId);
        }
    });
}

module.exports = { startScreenWatchdog };
