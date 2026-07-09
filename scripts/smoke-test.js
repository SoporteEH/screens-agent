/**
 * CI smoke test
 */

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BOOT_MARKER = 'ScreensWeb Agent starting';
const TIMEOUT_MS = 60000;

function findBinary() {
    const dir = path.resolve('dist', 'win-unpacked');
    if (!fs.existsSync(dir)) return null;
    const preferred = path.join(dir, 'screens-web-agent.exe');
    if (fs.existsSync(preferred)) return preferred;
    const exe = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.exe'));
    return exe ? path.join(dir, exe) : null;
}

// Fallback for environments where the GUI subsystem does not pipe stdout:
function markerInLogFiles() {
    const appData = process.env.APPDATA || path.join(os.homedir(), '.config');
    const candidates = [
        path.join(appData, 'ScreensWeb Agent', 'logs'),
        path.join(appData, 'ScreensWeb', 'logs'),
        path.join(appData, 'screensWeb', 'logs'),
    ];
    for (const dir of candidates) {
        try {
            if (!fs.existsSync(dir)) continue;
            for (const file of fs.readdirSync(dir)) {
                if (!file.startsWith('general') || !file.endsWith('.log')) continue;
                if (fs.readFileSync(path.join(dir, file), 'utf8').includes(BOOT_MARKER)) {
                    return true;
                }
            }
        } catch (_) {
            // ignore unreadable candidate dirs
        }
    }
    return false;
}

function killTree(pid) {
    if (!pid) return;
    try {
        if (process.platform === 'win32') {
            spawnSync('taskkill', ['/PID', String(pid), '/T', '/F']);
        } else {
            process.kill(pid, 'SIGKILL');
        }
    } catch (_) {
        // process already gone
    }
}

function main() {
    const bin = findBinary();
    if (!bin) {
        console.error('[SMOKE] FAIL: packaged binary not found under dist/win-unpacked');
        process.exit(1);
    }
    console.log(`[SMOKE] Launching: ${bin}`);

    let output = '';
    let settled = false;

    const child = spawn(bin, ['--disable-gpu', '--no-sandbox'], {
        env: { ...process.env, ELECTRON_ENABLE_LOGGING: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });

    const finish = (ok, reason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killTree(child.pid);
        setTimeout(() => {
            if (ok) {
                console.log(`[SMOKE] PASS: ${reason}`);
                process.exit(0);
            } else {
                console.error(`[SMOKE] FAIL: ${reason}`);
                console.error('[SMOKE] --- captured output (tail) ---');
                console.error(output.split('\n').slice(-40).join('\n') || '(no output captured)');
                process.exit(1);
            }
        }, 2000);
    };

    const onData = (buf) => {
        const text = buf.toString();
        output += text;
        process.stdout.write(text);
        if (output.includes(BOOT_MARKER)) {
            finish(true, `boot marker detected ("${BOOT_MARKER}")`);
        }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (err) => finish(false, `failed to spawn binary: ${err.message}`));

    child.on('exit', (code, signal) => {
        if (settled) return;
        if (markerInLogFiles()) {
            finish(true, 'boot marker found in log file (process exited after booting)');
        } else {
            finish(false, `process exited early (code=${code}, signal=${signal}) before reaching boot marker`);
        }
    });

    const timer = setTimeout(() => {
        if (markerInLogFiles()) {
            finish(true, 'boot marker found in log file');
        } else {
            finish(false, `timed out after ${TIMEOUT_MS / 1000}s without reaching boot marker`);
        }
    }, TIMEOUT_MS);
}

main();
