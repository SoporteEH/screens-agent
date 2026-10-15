const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const schedule = require('../js/playlist-schedule');
const { createSequencer } = require('../js/playlist-sequencer');
const fixtures = require('./fixtures/playlist-schedule.fixtures.json');

const MONDAY_10 = { date: '2026-10-12', time: '10:00', day: 1, minutes: 600, seconds: 0 };
const all = () => true;

const item = (id, window = {}) => ({ id, src: `local:${id}`, window });

function manifest(over) {
    return {
        playlistId: 'p1',
        version: 1,
        mode: 'carousel',
        order: 'sequential',
        items: [],
        fallback: null,
        ...over,
    };
}

// Plays `n` items in a row, as the engine would on each item's end.
function run(seq, n, canPlay = all, clock = MONDAY_10) {
    const shown = [];
    for (let i = 0; i < n; i++) {
        const { item } = seq.decide(clock, canPlay, 'advance');
        seq.markShown(item);
        shown.push(item && item.id);
    }
    return shown;
}

describe('shared schedule fixtures', () => {
    for (const c of fixtures.cases) {
        test(c.name, () => {
            const playlist = fixtures.playlists[c.playlist];
            const result = schedule.resolve(playlist, c.clock);
            assert.deepEqual(
                schedule.activeItems(playlist.items, c.clock).map((i) => i.id),
                c.expect.active
            );
            assert.equal(result.state, c.expect.state);
            assert.deepEqual(
                result.items.map((i) => i.id),
                c.expect.items
            );
            if (c.expect.minutesUntilNextChange !== undefined) {
                assert.equal(
                    schedule.minutesUntilNextChange(playlist, c.clock),
                    c.expect.minutesUntilNextChange
                );
            }
        });
    }
});

describe('carousel', () => {
    test('rotates through the active items in order', () => {
        const seq = createSequencer(schedule);
        seq.setManifest(manifest({ items: [item('a'), item('b'), item('c')] }));
        assert.deepEqual(run(seq, 5), ['a', 'b', 'c', 'a', 'b']);
    });

    test('skips items outside their window and items that cannot play', () => {
        const seq = createSequencer(schedule);
        seq.setManifest(
            manifest({
                items: [
                    item('a'),
                    item('night', { startTime: '22:00', endTime: '02:00' }),
                    item('b'),
                    item('web'),
                ],
            })
        );
        assert.deepEqual(
            run(seq, 4, (i) => i.id !== 'web'),
            ['a', 'b', 'a', 'b']
        );
    });

    test('a failed item hands over to the next one, not to the first', () => {
        const seq = createSequencer(schedule);
        seq.setManifest(manifest({ items: [item('a'), item('b'), item('c'), item('d')] }));
        run(seq, 2);
        const benched = new Set(['b']);
        assert.deepEqual(
            run(seq, 3, (i) => !benched.has(i.id)),
            ['c', 'd', 'a']
        );
    });

    test('keeps the current item on a tick while it still applies', () => {
        const seq = createSequencer(schedule);
        seq.setManifest(manifest({ items: [item('a'), item('b')] }));
        run(seq, 1);
        const { action, item: kept } = seq.decide(MONDAY_10, all, 'tick');
        assert.deepEqual([action, kept.id], ['keep', 'a']);
    });

    test('a single playable item keeps playing', () => {
        const seq = createSequencer(schedule);
        seq.setManifest(manifest({ items: [item('a')] }));
        run(seq, 1);
        assert.equal(seq.decide(MONDAY_10, all, 'advance').action, 'keep');
    });

    test('shuffle plays each item once per round and never repeats across rounds', () => {
        let x = 0.3;
        const seq = createSequencer(schedule, () => (x = (x * 7.13) % 1));
        seq.setManifest(
            manifest({ order: 'shuffle', items: ['a', 'b', 'c', 'd'].map((id) => item(id)) })
        );
        const shown = run(seq, 12);
        for (let round = 0; round < 3; round++) {
            assert.deepEqual(shown.slice(round * 4, round * 4 + 4).sort(), ['a', 'b', 'c', 'd']);
        }
        for (let i = 1; i < shown.length; i++) assert.notEqual(shown[i], shown[i - 1]);
    });
});

describe('fallback', () => {
    const fallback = { id: 'fallback', src: 'local:f', window: {} };

    test('plays when nothing applies, then yields when something does', () => {
        const seq = createSequencer(schedule);
        seq.setManifest(
            manifest({ items: [item('night', { startTime: '22:00', endTime: '02:00' })], fallback })
        );
        const first = seq.decide(MONDAY_10, all, 'tick');
        assert.deepEqual([first.item.id, first.state], ['fallback', 'fallback']);
        seq.markShown(first.item);
        assert.equal(seq.decide(MONDAY_10, all, 'tick').action, 'keep');

        const at23 = { ...MONDAY_10, time: '23:00', minutes: 1380 };
        assert.equal(seq.decide(at23, all, 'tick').item.id, 'night');
    });

    test('covers the time outside validity', () => {
        const seq = createSequencer(schedule);
        seq.setManifest(manifest({ validUntil: '2026-10-12T09:00', items: [item('a')], fallback }));
        assert.deepEqual(seq.decide(MONDAY_10, all, 'tick').state, 'outside-validity');
    });

    test('nothing at all when the fallback cannot play either', () => {
        const seq = createSequencer(schedule);
        seq.setManifest(manifest({ items: [], fallback }));
        assert.deepEqual(
            seq.decide(MONDAY_10, () => false, 'tick'),
            { action: 'show', item: null, state: 'empty' }
        );
    });
});

test('a new version of the same playlist keeps its place', () => {
    const seq = createSequencer(schedule);
    seq.setManifest(manifest({ items: [item('a'), item('b'), item('c')] }));
    run(seq, 2);
    seq.setManifest(manifest({ version: 2, items: [item('a'), item('b'), item('c')] }));
    assert.equal(seq.decide(MONDAY_10, all, 'advance').item.id, 'c');
});
