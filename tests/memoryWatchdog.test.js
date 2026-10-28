const { test } = require('node:test');
const assert = require('node:assert/strict');

// The logger opens rotating files under the user's profile; these checks need none of it.
const logConfigPath = require.resolve('../utils/logConfig');
const noop = () => {};
require.cache[logConfigPath] = {
    id: logConfigPath,
    filename: logConfigPath,
    loaded: true,
    exports: { log: { debug: noop, info: noop, warn: noop, error: noop } },
};

const { planReloads, memoryLimitMb } = require('../services/memoryWatchdog');

const WRAPPER_PID = 10;
const usage = (entries) => new Map(entries);
const wrapperScreen = (screenId, contentPid) => ({
    screenId,
    mainPid: WRAPPER_PID,
    framePids: [WRAPPER_PID, contentPid],
    isWrapper: true,
});

test('the limit is a share of the RAM, within bounds', () => {
    assert.equal(memoryLimitMb(4096), 614);
    assert.equal(memoryLimitMb(2048), 350);
    assert.equal(memoryLimitMb(16384), 1024);
});

test('a heavy page inside the wrapper reloads only its frame', () => {
    const plan = planReloads(
        [wrapperScreen('1', 20)],
        usage([
            [10, 40],
            [20, 900],
        ]),
        614
    );
    assert.equal(plan.length, 1);
    assert.equal(plan[0].action, 'refresh-content');
    assert.equal(plan[0].pid, 20);
    assert.equal(plan[0].mb, 900);
});

test('screens sharing the heavy page process all reload it', () => {
    const plan = planReloads(
        [wrapperScreen('1', 20), wrapperScreen('2', 20), wrapperScreen('3', 30)],
        usage([
            [10, 40],
            [20, 900],
            [30, 200],
        ]),
        614
    );
    assert.deepEqual(
        plan.map((p) => [p.screen.screenId, p.action]),
        [
            ['1', 'refresh-content'],
            ['2', 'refresh-content'],
        ]
    );
});

test('a heavy wrapper or a direct page reloads the whole window', () => {
    const plan = planReloads(
        [
            wrapperScreen('1', 20),
            { screenId: '2', mainPid: 40, framePids: [40, 41], isWrapper: false },
        ],
        usage([
            [10, 700],
            [20, 900],
            [40, 100],
            [41, 800],
        ]),
        614
    );
    assert.deepEqual(
        plan.map((p) => [p.screen.screenId, p.action, p.pid]),
        [
            ['1', 'reload', 10],
            ['2', 'reload', 41],
        ]
    );
});

test('nothing under the limit is touched', () => {
    assert.deepEqual(
        planReloads(
            [wrapperScreen('1', 20)],
            usage([
                [10, 40],
                [20, 300],
            ]),
            614
        ),
        []
    );
});
