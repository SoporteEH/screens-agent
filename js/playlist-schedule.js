// Playlist time rules. Dependency-free and byte-identical in four copies:
// screens-api/utils/playlistSchedule.js, screens-agent/js/playlist-schedule.js,
// screens-front/src/lib/playlist-schedule.js and screens-front/public/play/assets/ (the banner
// player). Each repo runs playlist-schedule.fixtures.json against its copy, so they cannot drift.
//
// All times are the salon's wall clock: "HH:mm", dates "YYYY-MM-DD", validity bounds (a
// playlist's and an item window's) "YYYY-MM-DDTHH:mm". Nothing here converts time zones; the
// caller builds the clock.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlaylistSchedule = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const DAY_MINUTES = 1440;

    function pad(n) {
        return String(n).padStart(2, '0');
    }

    // Wall clock of `date` in `timeZone` (an IANA name), or in the runtime's own zone.
    function localClock(date, timeZone) {
        const at = date || new Date();
        let y, mo, d, h, mi, s, day;
        if (timeZone) {
            const parts = {};
            new Intl.DateTimeFormat('en-GB', {
                timeZone,
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                weekday: 'short',
                hourCycle: 'h23',
            })
                .formatToParts(at)
                .forEach((p) => {
                    parts[p.type] = p.value;
                });
            y = Number(parts.year);
            mo = Number(parts.month);
            d = Number(parts.day);
            h = Number(parts.hour);
            mi = Number(parts.minute);
            s = Number(parts.second);
            day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
        } else {
            y = at.getFullYear();
            mo = at.getMonth() + 1;
            d = at.getDate();
            h = at.getHours();
            mi = at.getMinutes();
            s = at.getSeconds();
            day = at.getDay();
        }
        return {
            date: `${y}-${pad(mo)}-${pad(d)}`,
            time: `${pad(h)}:${pad(mi)}`,
            day,
            minutes: h * 60 + mi,
            seconds: s,
        };
    }

    function toMinutes(hhmm) {
        const [h, m] = hhmm.split(':').map(Number);
        return h * 60 + m;
    }

    function dayAllowed(window, day) {
        const days = window.daysOfWeek;
        return !days || days.length === 0 || days.indexOf(day) !== -1;
    }

    // `validFrom` inclusive, `validUntil` exclusive, against the clock itself.
    function isWithinValidity(bounds, clock) {
        const stamp = `${clock.date}T${clock.time}`;
        if (bounds.validFrom && stamp < bounds.validFrom) return false;
        if (bounds.validUntil && stamp >= bounds.validUntil) return false;
        return true;
    }

    function isWindowActive(window, clock) {
        const w = window || {};
        if (!isWithinValidity(w, clock)) return false;
        if (!w.startTime || !w.endTime) return dayAllowed(w, clock.day);

        const start = toMinutes(w.startTime);
        const end = toMinutes(w.endTime);
        const now = clock.minutes;
        if (start < end) return now >= start && now < end && dayAllowed(w, clock.day);
        // Crosses midnight: the hours after 00:00 belong to the day the window opened.
        if (now >= start) return dayAllowed(w, clock.day);
        if (now < end) return dayAllowed(w, (clock.day + 6) % 7);
        return false;
    }

    function activeItems(items, clock) {
        return (items || []).filter((item) => isWindowActive(item.window, clock));
    }

    // What the screen should play now: `items` in playing order, and why.
    function resolve(playlist, clock) {
        const fallback = playlist.fallback ? [playlist.fallback] : [];
        if (!isWithinValidity(playlist, clock)) {
            return { state: 'outside-validity', items: fallback };
        }
        const active = activeItems(playlist.items, clock);
        if (active.length > 0) return { state: 'playing', items: active };
        return { state: fallback.length ? 'fallback' : 'empty', items: fallback };
    }

    // Whole minutes until any rule could change the result; the engine re-resolves then.
    function minutesUntilNextChange(playlist, clock) {
        const now = clock.minutes;
        const candidates = [DAY_MINUTES - now];
        const consider = (minuteOfDay) => {
            let delta = minuteOfDay - now;
            if (delta <= 0) delta += DAY_MINUTES;
            candidates.push(delta);
        };
        const bounds = [playlist.validFrom, playlist.validUntil];
        (playlist.items || []).forEach((item) => {
            const w = item.window || {};
            if (w.startTime && w.endTime) {
                consider(toMinutes(w.startTime));
                consider(toMinutes(w.endTime));
            }
            bounds.push(w.validFrom, w.validUntil);
        });
        bounds.forEach((bound) => {
            if (bound && bound.slice(0, 10) === clock.date) {
                consider(toMinutes(bound.slice(11, 16)));
            }
        });
        return Math.min.apply(null, candidates);
    }

    return {
        localClock,
        isWindowActive,
        isWithinValidity,
        activeItems,
        resolve,
        minutesUntilNextChange,
    };
});
