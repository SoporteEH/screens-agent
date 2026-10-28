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

// The agent's userData is %APPDATA%\local-agent (the package name), packaged or not.
const LOG_DIR = path.join(
    process.env.APPDATA || path.join(os.homedir(), '.config'),
    'local-agent',
    'logs'
);

function generalLogs() {
    try {
        return fs
            .readdirSync(LOG_DIR)
            .filter((file) => file.startsWith('general') && file.endsWith('.log'));
    } catch {
        return [];
    }
}

function logSizes() {
    return new Map(generalLogs().map((file) => [file, fs.statSync(path.join(LOG_DIR, file)).size]));
}

// Fallback for environments where the GUI subsystem does not pipe stdout. Only what this launch
// appended counts: an earlier run on the same machine has the marker in the file already.
function markerInLogFiles(sizesAtLaunch) {
    for (const file of generalLogs()) {
        try {
            const appended = fs
                .readFileSync(path.join(LOG_DIR, file))
                .subarray(sizesAtLaunch.get(file) || 0);
            if (appended.toString('utf8').includes(BOOT_MARKER)) return true;
        } catch {
            // Being rotated: the next file or check will have it.
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
    } catch {
        // Already gone.
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
    const sizesAtLaunch = logSizes();

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
        if (markerInLogFiles(sizesAtLaunch)) {
            finish(true, 'boot marker found in log file (process exited after booting)');
        } else {
            finish(
                false,
                `process exited early (code=${code}, signal=${signal}) before reaching boot marker`
            );
        }
    });

    const timer = setTimeout(() => {
        if (markerInLogFiles(sizesAtLaunch)) {
            finish(true, 'boot marker found in log file');
        } else {
            finish(false, `timed out after ${TIMEOUT_MS / 1000}s without reaching boot marker`);
        }
    }, TIMEOUT_MS);
}

main();
