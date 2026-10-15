// Decides what a playlist screen shows next. No DOM and no timers, so it runs under node:test;
// playlist-engine.js owns the rendering and calls in here whenever something may have changed.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PlaylistSequencer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function createSequencer(schedule, random) {
        const rand = random || Math.random;
        let manifest = null;
        let currentId = null;
        let cycle = [];

        function shuffled(ids) {
            const out = ids.slice();
            for (let i = out.length - 1; i > 0; i--) {
                const j = Math.floor(rand() * (i + 1));
                const tmp = out[i];
                out[i] = out[j];
                out[j] = tmp;
            }
            // A new round must not open with what just played.
            if (out.length > 1 && out[0] === currentId) {
                out.push(out.shift());
            }
            return out;
        }

        // What may play now, in order, and why.
        function candidates(clock, canPlay) {
            if (!schedule.isWithinValidity(manifest, clock)) {
                return { state: 'outside-validity', list: [] };
            }
            const active = schedule.activeItems(manifest.items, clock).filter(canPlay);
            // Scheduled mode shows one item; an unplayable first match yields to the next one.
            return {
                state: 'playing',
                list: manifest.mode === 'scheduled' ? active.slice(0, 1) : active,
            };
        }

        function following(list) {
            if (manifest.order === 'shuffle') {
                const ids = list.map((i) => i.id);
                cycle = cycle.filter((id) => ids.indexOf(id) !== -1);
                if (cycle.length === 0) cycle = shuffled(ids);
                const id = cycle.shift();
                return list.find((i) => i.id === id);
            }
            // By position in the whole playlist, so a benched or expired current item hands over
            // to the one after it rather than sending the rotation back to the start.
            const position = (id) => manifest.items.findIndex((i) => i.id === id);
            const from = position(currentId);
            return list.find((i) => position(i.id) > from) || list[0];
        }

        function setManifest(next) {
            const sameList = manifest && next && manifest.playlistId === next.playlistId;
            manifest = next;
            if (!sameList) {
                currentId = null;
                cycle = [];
            }
        }

        // reason 'tick': the clock or the network moved — keep the current item if it still applies.
        // reason 'advance': the current item finished or failed — move on.
        // Returns { action: 'keep' | 'show', item, state }; a null item means nothing can play.
        function decide(clock, canPlay, reason) {
            if (!manifest) return { action: 'show', item: null, state: 'empty' };

            const { state, list } = candidates(clock, canPlay);
            if (list.length === 0) {
                const fallback =
                    manifest.fallback && canPlay(manifest.fallback) ? manifest.fallback : null;
                const resultState = fallback ? (state === 'playing' ? 'fallback' : state) : 'empty';
                if (fallback && currentId === fallback.id && reason === 'tick') {
                    return { action: 'keep', item: fallback, state: resultState };
                }
                return { action: 'show', item: fallback, state: resultState };
            }

            const current = list.find((i) => i.id === currentId);
            if (current && reason === 'tick') return { action: 'keep', item: current, state };
            if (manifest.mode === 'scheduled') {
                return { action: current ? 'keep' : 'show', item: list[0], state };
            }
            const item = following(list);
            return { action: item.id === currentId ? 'keep' : 'show', item, state };
        }

        function markShown(item) {
            currentId = item ? item.id : null;
        }

        return { setManifest, decide, markShown };
    }

    return { createSequencer };
});
