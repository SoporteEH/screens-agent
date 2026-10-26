// inject-config writes SERVER_URL into the tracked package.json, so the restore runs even when
// the build fails.
const { spawnSync } = require('child_process');
const path = require('path');

const run = (script, args = []) =>
    spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' }).status ?? 1;

let status = run(path.join(__dirname, 'inject-config.js'));
if (status === 0) {
    status = run(require.resolve('electron-builder/cli.js'), process.argv.slice(2));
}
const restored = run(path.join(__dirname, 'restore-config.js'));
process.exit(status || restored);
