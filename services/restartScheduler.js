// Restarts the app, never the machine. The schedule lives in the agent's own config
// so it keeps firing with the API down.
const { app } = require('electron');
const { log } = require('../utils/logConfig');

const TICK_MS = 60 * 1000;
// A daily restart lands the app back inside its own target minute; without this the
// first tick after boot would match again and loop.
const MIN_UPTIME_BEFORE_RESTART_MS = 5 * 60 * 1000;

const startedAt = Date.now();
let timer = null;

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
            if (Date.now() - startedAt < MIN_UPTIME_BEFORE_RESTART_MS) return;
            const now = new Date();
            if (now.getHours() === target.hours && now.getMinutes() === target.minutes) {
                restartApp(`daily at ${schedule.dailyTime}`);
            }
        }, TICK_MS);
        return;
    }

    log.warn(`[RESTART]: Unknown schedule mode "${mode}", ignoring.`);
}

module.exports = { applyRestartSchedule };
