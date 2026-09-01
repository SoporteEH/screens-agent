// Static contract checks for the local player wrapper. The '[stalled]' title literal
// is the interface the watchdog reads via getTitle(); a wrapper without it ships
// screens that can go dark undetected.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const failures = [];

function check(condition, message) {
    if (!condition) failures.push(message);
}

const playerPath = path.join(root, 'player.html');
const preloadPath = path.join(root, 'player-preload.js');

check(fs.existsSync(playerPath), 'player.html is missing');
check(fs.existsSync(preloadPath), 'player-preload.js is missing');

if (fs.existsSync(playerPath)) {
    const html = fs.readFileSync(playerPath, 'utf8');
    check(html.includes("' [stalled]'"), "player.html lost the ' [stalled]' title contract");
    check(html.includes('MAX_CONTENT_RETRIES'), 'player.html lost the content retry logic');
    check(!/fetch\s*\(/.test(html), 'player.html must not call the server (no fetch)');
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
check(
    (pkg.build?.files || []).includes('player-preload.js'),
    'package.json build.files must include player-preload.js or the packaged app ships without it'
);

if (failures.length) {
    console.error('Player contract check FAILED:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
}
console.log('Player contract check OK.');
