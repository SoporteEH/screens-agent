// Restarts the app, never the machine. The schedule lives in the agent's own config
// so it keeps firing with the API down.
const { app } = require('electron');
const { log } = require('../utils/logConfig');

const TICK_MS = 60 * 1000;

const startedAt = Date.now();
let timer = null;
let appliedKey = null;
let lastFiredKey = null;

function scheduleKey(schedule) {
    return [
        schedule?.mode || 'off',
        schedule?.intervalHours ?? '',
        schedule?.dailyTime ?? '',
    ].join('|');
}

function parseDailyTime(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || ''));
    return match ? { hours: Number(match[1]), minutes: Number(match[2]) } : null;
}

function restartApp(reason) {
    log.warn(`[RESTART]: Scheduled app restart (${reason}). Relaunching.`);
    app.relaunch();
    app.exit(0);
}

// A tick beats one long timeout: it survives clock changes, DST and machine sleep,
// any of which would leave a multi-hour timeout firing at the wrong moment.
function applyRestartSchedule(schedule) {
    const key = scheduleKey(schedule);
    // device-info repeats on every reconnect, and re-arming would push the next tick
    // 60s further out each time — on a flapping socket it would never fire at all.
    if (key === appliedKey) return;
    appliedKey = key;

    if (timer) {
        clearInterval(timer);
        timer = null;
    }

    const mode = schedule?.mode || 'off';
    if (mode === 'off') {
        log.info('[RESTART]: No scheduled restart.');
        return;
    }

    if (mode === 'interval') {
        const hours = Number(schedule.intervalHours);
        if (!Number.isFinite(hours) || hours < 1) {
            log.warn(`[RESTART]: Ignoring interval schedule with invalid hours: ${schedule.intervalHours}`);
            return;
        }
        const intervalMs = hours * 60 * 60 * 1000;
        log.info(`[RESTART]: Scheduled every ${hours}h from this start.`);
        timer = setInterval(() => {
            if (Date.now() - startedAt >= intervalMs) restartApp(`every ${hours}h`);
        }, TICK_MS);
        return;
    }

    if (mode === 'daily') {
        const target = parseDailyTime(schedule.dailyTime);
        if (!target) {
            log.warn(`[RESTART]: Ignoring daily schedule with invalid time: ${schedule.dailyTime}`);
            return;
        }
        log.info(`[RESTART]: Scheduled daily at ${schedule.dailyTime}.`);
        timer = setInterval(() => {
            const now = new Date();
            if (now.getHours() !== target.hours || now.getMinutes() !== target.minutes) return;

            // The restart lands the app back inside its own target minute, but the first
            // tick of the new process is 60s after boot and therefore already past it —
            // so only a repeat within this process has to be guarded.
            const fired = `${now.toDateString()} ${schedule.dailyTime}`;
            if (lastFiredKey === fired) return;
            lastFiredKey = fired;

            restartApp(`daily at ${schedule.dailyTime}`);
        }, TICK_MS);
        return;
    }

    log.warn(`[RESTART]: Unknown schedule mode "${mode}", ignoring.`);
}

module.exports = { applyRestartSchedule };
