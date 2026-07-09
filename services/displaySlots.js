/**
 * Display Slots Service
 *
 * Persistent mapping between physical monitors and fixed screen slots
 * ("1", "2", ...). A slot keeps its number for the life of the device: a
 * monitor turning off or disconnecting never renumbers the remaining screens,
 * and its saved content is restored when it comes back.
 *
 * Slot identity is reconciled in three passes:
 *   1. Electron `display.id` (stable within a session, usually across reboots).
 *   2. Monitor label + physical resolution, only when unambiguous.
 *   3. Last known position (bounds) — covers wholesale display.id churn after
 *      reboots/driver updates and lets a replacement monitor inherit the slot
 *      of the one it replaces.
 * Displays that still don't match any free slot get a brand-new number.
 * Slots are never deleted automatically; only applyExpectedScreens() prunes
 * tail slots when the admin lowers the device's screen count.
 */

const { screen } = require('electron');
const fs = require('fs');
const { log } = require('../utils/logConfig');
const { DISPLAYS_FILE_PATH, STATE_FILE_PATH } = require('../config/constants');

function loadSlots() {
    try {
        if (fs.existsSync(DISPLAYS_FILE_PATH)) {
            const data = JSON.parse(fs.readFileSync(DISPLAYS_FILE_PATH, 'utf8'));
            if (data && typeof data.slots === 'object' && data.slots !== null) {
                return data.slots;
            }
        }
    } catch (error) {
        log.error('[SLOTS]: Error reading displays file:', error);
    }
    return {};
}

function saveSlots(slots) {
    try {
        fs.writeFileSync(
            DISPLAYS_FILE_PATH,
            JSON.stringify({ version: 1, slots }, null, 2)
        );
    } catch (error) {
        log.error('[SLOTS]: Error saving displays file:', error);
    }
}

function getAllSlots() {
    return loadSlots();
}

// Wipes the persisted slot map so the next reconcile re-seeds contiguous 1..K
// from the currently-connected monitors (admin "reset screens" action).
function clearSlots() {
    try {
        if (fs.existsSync(DISPLAYS_FILE_PATH)) fs.unlinkSync(DISPLAYS_FILE_PATH);
        log.info('[SLOTS]: Slot map cleared.');
    } catch (error) {
        log.error('[SLOTS]: Error clearing displays file:', error);
    }
}

function hasSlot(slotId) {
    return Object.prototype.hasOwnProperty.call(loadSlots(), String(slotId));
}

// Creates an empty (unbound) slot so content can be parked on a screen that is
// currently disconnected. No-op if the slot already exists.
function ensureSlot(slotId) {
    const slots = loadSlots();
    const id = String(slotId);
    if (!slots[id]) {
        slots[id] = emptySlot();
        saveSlots(slots);
        log.info(`[SLOTS]: Created unbound slot ${id} for offline content.`);
    }
}

function emptySlot() {
    return {
        displayId: null,
        label: '',
        width: 1920,
        height: 1080,
        x: null,
        y: null,
        lastConnectedAt: null,
    };
}

function describeDisplay(display) {
    return {
        displayId: display.id,
        label: display.label || '',
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor),
        x: display.bounds.x,
        y: display.bounds.y,
        lastConnectedAt: new Date().toISOString(),
    };
}

// Slot ids recorded in state.json (raw read: only the keys are needed here).
function readStateSlotIds() {
    try {
        if (fs.existsSync(STATE_FILE_PATH)) {
            const state = JSON.parse(fs.readFileSync(STATE_FILE_PATH, 'utf8')) || {};
            return Object.keys(state);
        }
    } catch (error) {
        log.error('[SLOTS]: Error reading state file for slot seeding:', error);
    }
    return [];
}

function sortedDisplays() {
    return screen
        .getAllDisplays()
        .slice()
        .sort((a, b) => a.bounds.x - b.bounds.x || a.bounds.y - b.bounds.y);
}

// First run: replicate the legacy positional mapping (left-to-right = 1..N) so
// existing state.json keys keep pointing at the same physical monitors, and
// reserve slots for any state entry whose monitor is currently off.
function seedSlots(displays) {
    const slots = {};
    displays.forEach((display, index) => {
        slots[String(index + 1)] = describeDisplay(display);
    });
    for (const stateId of readStateSlotIds()) {
        if (!slots[stateId] && /^\d+$/.test(stateId)) {
            slots[stateId] = emptySlot();
        }
    }
    log.info(`[SLOTS]: Seeded slot map: ${Object.keys(slots).join(', ')}`);
    return slots;
}

// Among free slots, prefer the one whose last known position is closest to the
// display; slots without positional info fall back to the lowest number.
function pickSlotForDisplay(display, freeSlotIds, slots) {
    let best = null;
    let bestDist = Infinity;
    for (const slotId of freeSlotIds) {
        const slot = slots[slotId];
        if (typeof slot.x === 'number') {
            const dist =
                Math.abs(slot.x - display.bounds.x) +
                Math.abs((slot.y ?? 0) - display.bounds.y);
            if (dist < bestDist) {
                bestDist = dist;
                best = slotId;
            }
        }
    }
    if (best !== null) return best;
    const numeric = [...freeSlotIds].sort((a, b) => Number(a) - Number(b));
    return numeric.length > 0 ? numeric[0] : null;
}

/**
 * Reconciles the currently attached displays against the persisted slot map
 * and rebuilds `hardwareIdToDisplayMap` in place (only bound slots get an
 * entry, so the map can have numbering gaps like "1", "3").
 *
 * @returns {{ boundSlotIds: string[], unboundSlotIds: string[],
 *             newlyBound: string[], newlyUnbound: string[] }}
 */
async function reconcileDisplays(hardwareIdToDisplayMap) {
    const previousBound = Array.from(hardwareIdToDisplayMap.keys());
    const displays = sortedDisplays();
    let slots = loadSlots();

    if (Object.keys(slots).length === 0) {
        slots = seedSlots(displays);
    }

    const assigned = new Map(); // slotId -> Display
    const unmatched = new Set(displays);
    const freeSlotIds = new Set(Object.keys(slots));

    // Pass 1: stable display.id
    for (const display of displays) {
        for (const slotId of freeSlotIds) {
            if (slots[slotId].displayId === display.id) {
                assigned.set(slotId, display);
                freeSlotIds.delete(slotId);
                unmatched.delete(display);
                break;
            }
        }
    }

    // Pass 2: label + physical resolution, only when unique on both sides
    if (unmatched.size > 0 && freeSlotIds.size > 0) {
        const keyOfSlot = (s) => `${s.label}|${s.width}x${s.height}`;
        const keyOfDisplay = (d) => {
            const w = Math.round(d.size.width * d.scaleFactor);
            const h = Math.round(d.size.height * d.scaleFactor);
            return `${d.label || ''}|${w}x${h}`;
        };

        const displaysByKey = new Map();
        for (const display of unmatched) {
            const key = keyOfDisplay(display);
            displaysByKey.set(key, (displaysByKey.get(key) || []).concat(display));
        }
        const slotsByKey = new Map();
        for (const slotId of freeSlotIds) {
            if (!slots[slotId].label) continue;
            const key = keyOfSlot(slots[slotId]);
            slotsByKey.set(key, (slotsByKey.get(key) || []).concat(slotId));
        }

        for (const [key, keyDisplays] of displaysByKey) {
            const keySlots = slotsByKey.get(key) || [];
            if (keyDisplays.length === 1 && keySlots.length === 1) {
                assigned.set(keySlots[0], keyDisplays[0]);
                freeSlotIds.delete(keySlots[0]);
                unmatched.delete(keyDisplays[0]);
            }
        }
    }

    // Pass 3: last known position — replacement monitors inherit the free slot
    for (const display of displays) {
        if (!unmatched.has(display)) continue;
        if (freeSlotIds.size === 0) break;
        const slotId = pickSlotForDisplay(display, freeSlotIds, slots);
        if (slotId !== null) {
            assigned.set(slotId, display);
            freeSlotIds.delete(slotId);
            unmatched.delete(display);
        }
    }

    // Overflow: genuinely new displays get a brand-new slot number
    let maxSlot = Object.keys(slots).reduce(
        (max, id) => Math.max(max, Number(id) || 0),
        0
    );
    for (const display of unmatched) {
        maxSlot += 1;
        const slotId = String(maxSlot);
        slots[slotId] = emptySlot();
        assigned.set(slotId, display);
        log.info(`[SLOTS]: New display detected, assigned new slot ${slotId}.`);
    }

    for (const [slotId, display] of assigned) {
        slots[slotId] = describeDisplay(display);
    }
    saveSlots(slots);

    hardwareIdToDisplayMap.clear();
    for (const [slotId, display] of assigned) {
        hardwareIdToDisplayMap.set(slotId, display);
    }

    const numericSort = (a, b) => Number(a) - Number(b);
    const boundSlotIds = Array.from(assigned.keys()).sort(numericSort);
    const unboundSlotIds = Object.keys(slots)
        .filter((id) => !assigned.has(id))
        .sort(numericSort);
    const newlyBound = boundSlotIds.filter((id) => !previousBound.includes(id));
    const newlyUnbound = previousBound.filter((id) => !assigned.has(id));

    log.info(
        `[SLOTS]: Reconciled. Bound: [${boundSlotIds.join(', ')}], disconnected: [${unboundSlotIds.join(', ')}]`
    );

    return { boundSlotIds, unboundSlotIds, newlyBound, newlyUnbound };
}

/**
 * Applies the admin-configured screen count: deletes slots above the limit
 * that are not currently bound to a display. Returns the removed slot ids so
 * the caller can purge their state.json entries.
 */
function applyExpectedScreens(expectedScreens, boundSlotIds) {
    if (!Number.isInteger(expectedScreens) || expectedScreens < 1) return [];

    const slots = loadSlots();
    const removed = [];
    for (const slotId of Object.keys(slots)) {
        if (Number(slotId) > expectedScreens && !boundSlotIds.includes(slotId)) {
            delete slots[slotId];
            removed.push(slotId);
        }
    }
    if (removed.length > 0) {
        saveSlots(slots);
        log.info(
            `[SLOTS]: Pruned slots above expectedScreens=${expectedScreens}: ${removed.join(', ')}`
        );
    }
    return removed;
}

module.exports = {
    loadSlots,
    getAllSlots,
    hasSlot,
    ensureSlot,
    clearSlots,
    reconcileDisplays,
    applyExpectedScreens,
};
