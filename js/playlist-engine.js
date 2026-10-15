// Renders a playlist manifest inside the player wrapper, with no server involved: rules are read
// against the PC clock (playlist-schedule.js), the order comes from playlist-sequencer.js, and
// local files arrive here already resolved to file:// by the main process.
(function (root) {
    const FADE_MS = 600;
    const BLACK_MS = 350;
    const REVEAL_MS = 3000;
    const LOAD_TIMEOUT_MS = 15000;
    const FAIL_COOLDOWN_MS = 5 * 60 * 1000;
    const RETRY_DELAY_MS = 1000;
    const VIDEO_CEILING_MS = 10 * 60 * 1000;
    const STALLED_AFTER_FAILURES = 3;
    const IDLE_ID = '__idle__';

    // Chromium reports the URL it normalised (trailing slash, fragment dropped).
    function sameUrl(a, b) {
        const norm = (u) =>
            String(u || '')
                .split('#')[0]
                .replace(/\/$/, '');
        return norm(a) === norm(b);
    }

    function createPlaylistEngine(container, hooks) {
        const schedule = root.PlaylistSchedule;
        const sequencer = root.PlaylistSequencer.createSequencer(schedule);
        const watchdog = root.MediaWatchdog;
        const log = (msg) => console.log('[PLAYER] Playlist: ' + msg);
        const warn = (msg) => console.warn('[PLAYER] Playlist: ' + msg);

        let manifest = null;
        let signature = '';
        let fallbackUrl = null;
        let network = 'connected';
        let current = null;
        let token = 0;
        let itemTimer = null;
        let refreshTimer = null;
        let tickTimer = null;
        let failures = 0;
        const failedUntil = new Map();

        // Web items need the internet (not our server); local files always play.
        function canPlay(item) {
            if (!item || !item.src) return false;
            if (item.type === 'web' && network === 'offline' && !item.src.startsWith('file:')) {
                return false;
            }
            const until = failedUntil.get(item.src);
            return !until || until < Date.now();
        }

        function clearTimers() {
            clearTimeout(itemTimer);
            clearInterval(refreshTimer);
            itemTimer = null;
            refreshTimer = null;
        }

        function teardown(entry) {
            if (!entry) return;
            if (entry.stopWatch) entry.stopWatch();
            if (entry.el && entry.el.tagName === 'VIDEO') watchdog.releaseVideo(entry.el);
            if (entry.el && entry.el.tagName === 'IFRAME') entry.el.src = 'about:blank';
            if (entry.layer.parentNode) entry.layer.parentNode.removeChild(entry.layer);
        }

        function buildElement(item) {
            let el;
            if (item.type === 'image') {
                el = document.createElement('img');
                el.alt = '';
                el.draggable = false;
            } else if (item.type === 'video') {
                el = document.createElement('video');
                el.muted = true;
                el.playsInline = true;
                el.preload = 'auto';
            } else {
                el = document.createElement('iframe');
                el.allow = 'autoplay; fullscreen; encrypted-media';
            }
            return el;
        }

        function nowPlaying(entry, state) {
            hooks.onNowPlaying &&
                hooks.onNowPlaying({
                    playlistId: manifest ? manifest.playlistId : null,
                    version: manifest ? manifest.version : null,
                    itemId: entry.idle ? null : entry.item.id,
                    name: entry.idle ? null : entry.item.name || null,
                    type: entry.item.type,
                    state,
                    since: new Date().toISOString(),
                });
        }

        function armTimers(entry, t) {
            clearTimers();
            const item = entry.item;
            const rotates =
                manifest && manifest.mode !== 'scheduled' && !entry.isFallback && !entry.idle;

            if (item.type === 'video') {
                entry.el.onended = function () {
                    if (t !== token) return;
                    if (rotates) advance(t);
                    else restart(entry, t);
                };
                if (rotates) {
                    const seconds = item.durationSeconds > 0 ? item.durationSeconds : null;
                    const ceiling = item.mediaDurationSec
                        ? item.mediaDurationSec * 1000 + 5000
                        : VIDEO_CEILING_MS;
                    itemTimer = setTimeout(
                        function () {
                            if (!seconds) warn('video "' + item.name + '" outlived its duration');
                            advance(t);
                        },
                        seconds ? seconds * 1000 : ceiling
                    );
                }
                return;
            }

            if (rotates) {
                itemTimer = setTimeout(
                    function () {
                        advance(t);
                    },
                    Math.max(1, item.durationSeconds || 10) * 1000
                );
            } else if (item.type === 'web' && item.refreshInterval > 0) {
                // Shown for hours: honour the content's own refresh, as a single screen would.
                refreshTimer = setInterval(function () {
                    if (t === token && entry.el) entry.el.src = item.src;
                }, item.refreshInterval * 1000);
            }
        }

        function reveal(entry, outgoing, t, state) {
            if (t !== token || entry.revealed) return;
            entry.revealed = true;
            failures = 0;
            hooks.onHealth && hooks.onHealth('ok');
            hooks.onEmpty && hooks.onEmpty(false);

            const transition = entry.item.transition || 'fade';
            entry.layer.classList.add('pl-' + transition);
            requestAnimationFrame(function () {
                entry.layer.classList.add('pl-shown');
                if (outgoing && transition === 'slide')
                    outgoing.layer.classList.add('pl-leave-slide');
            });
            entry.prev = null;
            setTimeout(
                function () {
                    teardown(outgoing);
                },
                transition === 'cut' ? 0 : FADE_MS
            );

            if (entry.el.tagName === 'VIDEO') {
                entry.stopWatch = watchdog.watchVideo(entry.el, function (reason) {
                    fail(entry, t, 'video "' + entry.item.name + '" ' + reason);
                });
            }
            armTimers(entry, t);
            nowPlaying(entry, state);
            log('showing "' + (entry.item.name || entry.item.src) + '"');
        }

        function mount(entry, outgoing, t, state) {
            const el = entry.el;
            container.appendChild(entry.layer);
            entry.layer.appendChild(el);

            const loaded = function () {
                reveal(entry, outgoing, t, state);
            };
            if (el.tagName === 'IMG') {
                el.onload = loaded;
                el.onerror = function () {
                    fail(entry, t, 'image "' + entry.item.name + '" failed to load');
                };
                el.src = entry.item.src;
            } else if (el.tagName === 'VIDEO') {
                el.oncanplay = function () {
                    el.oncanplay = null;
                    el.play().catch(function () {
                        fail(entry, t, 'video "' + entry.item.name + '" play() rejected');
                    });
                    loaded();
                };
                el.onerror = function () {
                    fail(entry, t, 'video "' + entry.item.name + '" failed to load');
                };
                el.src = entry.item.src;
                el.load();
            } else {
                // A cross-origin frame never reports its errors here; the main process does
                // (itemFailed). Reveal early: a heavy page that paints before onload beats black.
                el.onload = loaded;
                setTimeout(loaded, REVEAL_MS);
                el.src = entry.item.src;
            }

            if (el.tagName !== 'IFRAME') {
                setTimeout(function () {
                    if (!entry.revealed) fail(entry, t, '"' + entry.item.name + '" never loaded');
                }, LOAD_TIMEOUT_MS);
            }
        }

        function show(item, state) {
            const t = ++token;
            clearTimers();
            sequencer.markShown(item);

            if (!item) {
                if (fallbackUrl) {
                    item = { id: IDLE_ID, type: 'web', src: fallbackUrl, name: 'offline carousel' };
                } else {
                    teardown(current);
                    current = null;
                    hooks.onEmpty && hooks.onEmpty(true);
                    hooks.onNowPlaying &&
                        hooks.onNowPlaying({
                            playlistId: manifest ? manifest.playlistId : null,
                            itemId: null,
                            state,
                            since: new Date().toISOString(),
                        });
                    log('nothing can play now (' + state + ')');
                    return;
                }
            }

            const layer = document.createElement('div');
            layer.className = 'pl-layer';
            const entry = {
                item,
                layer,
                el: buildElement(item),
                idle: item.id === IDLE_ID,
                isFallback: !!(manifest && manifest.fallback && item.id === manifest.fallback.id),
                revealed: false,
            };
            // An item that never appeared leaves the one before it still on screen.
            let outgoing = current;
            if (outgoing && !outgoing.revealed) {
                const visible = outgoing.prev || null;
                teardown(outgoing);
                outgoing = visible;
            }
            entry.prev = outgoing;
            current = entry;

            // Two videos never decode at once: sibling screens share one decode engine.
            if (outgoing && outgoing.el.tagName === 'VIDEO' && item.type === 'video') {
                outgoing.layer.classList.add('pl-leave-black');
                entry.prev = null;
                setTimeout(function () {
                    if (t !== token) return;
                    teardown(outgoing);
                    mount(entry, null, t, state);
                }, BLACK_MS);
                return;
            }
            mount(entry, outgoing, t, state);
        }

        function restart(entry, t) {
            if (t !== token) return;
            if (entry.el.tagName === 'VIDEO') {
                entry.el.currentTime = 0;
                entry.el.play().catch(function () {});
            }
            armTimers(entry, t);
        }

        function clock() {
            return schedule.localClock(new Date());
        }

        function evaluate(reason) {
            if (!manifest) return;
            const decision = sequencer.decide(clock(), canPlay, reason);
            if (decision.action === 'keep') {
                if (reason === 'advance' && current) restart(current, token);
                return;
            }
            // Already on the idle fallback and still nothing to play: leave it running.
            if (!decision.item && current && current.idle && reason === 'tick') return;
            show(decision.item, decision.state);
        }

        function advance(t) {
            if (t !== token) return;
            evaluate('advance');
        }

        function fail(entry, t, why) {
            if (t !== token || entry !== current) return;
            warn(why);
            if (!entry.idle) failedUntil.set(entry.item.src, Date.now() + FAIL_COOLDOWN_MS);
            failures++;
            if (failures >= STALLED_AFTER_FAILURES && !entry.revealed) {
                hooks.onHealth && hooks.onHealth('stalled');
            }
            clearTimers();
            // Async, so a run of broken items cannot spin; each one is benched meanwhile.
            itemTimer = setTimeout(function () {
                advance(t);
            }, RETRY_DELAY_MS);
        }

        // Rules change on whole minutes, so a tick on each minute boundary is exact.
        function scheduleTick() {
            clearTimeout(tickTimer);
            const now = new Date();
            const wait = (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 50;
            tickTimer = setTimeout(function () {
                evaluate('tick');
                scheduleTick();
            }, wait);
        }

        function load(next, nextFallbackUrl) {
            fallbackUrl = nextFallbackUrl || null;
            const nextSignature = JSON.stringify([
                next.playlistId,
                next.version,
                next.items.map((i) => i.id + '|' + i.src),
                next.fallback ? next.fallback.src : null,
            ]);
            if (nextSignature === signature) return;
            signature = nextSignature;
            manifest = next;
            sequencer.setManifest(next);
            // The item on screen survives a new version that still lists it unchanged.
            if (current && !current.idle) {
                const same = next.items.find(
                    (i) => i.id === current.item.id && i.src === current.item.src
                );
                if (same) current.item = same;
            }
            log(
                'loaded "' + next.name + '" v' + next.version + ' (' + next.items.length + ' items)'
            );
            evaluate('tick');
            scheduleTick();
        }

        return {
            load,
            setNetwork(state) {
                if (state === network) return;
                network = state;
                evaluate('tick');
            },
            // The main process saw this URL fail inside the frame.
            itemFailed(url) {
                const failed = manifest
                    ? manifest.items
                          .concat(manifest.fallback || [])
                          .find((i) => sameUrl(i.src, url))
                    : null;
                if (!failed) return;
                if (current && current.item.src === failed.src) {
                    fail(current, token, '"' + failed.src + '" failed to load');
                } else {
                    failedUntil.set(failed.src, Date.now() + FAIL_COOLDOWN_MS);
                }
            },
            refresh() {
                if (current && current.el.tagName === 'IFRAME') current.el.src = current.item.src;
            },
            stop() {
                token++;
                clearTimers();
                clearTimeout(tickTimer);
                teardown(current);
                current = null;
                manifest = null;
                signature = '';
            },
            isActive() {
                return !!manifest;
            },
        };
    }

    root.PlaylistEngine = { create: createPlaylistEngine };
})(typeof globalThis !== 'undefined' ? globalThis : this);
