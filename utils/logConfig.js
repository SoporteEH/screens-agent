// general-*.log + error-*.log (warn/error); daily rotation, 30d
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const os = require('os');

function resolveLogDir() {
    try {
        const { app } = require('electron');
        if (app && typeof app.getPath === 'function') {
            return app.getPath('logs');
        }
    } catch {
        // Outside Electron (node:test, scripts).
    }
    const base = process.env.APPDATA || path.join(os.homedir(), '.config');
    return path.join(base, 'screensWeb', 'logs');
}

const LOG_DIR = resolveLogDir();

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    })
);

const consoleFormat = winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
    winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] [${level}] ${message}`;
    })
);

const infoAndBelow = winston.format((info) => {
    if (info.level === 'info' || info.level === 'debug') return info;
})();

const warnAndAbove = winston.format((info) => {
    if (info.level === 'warn' || info.level === 'error') return info;
})();

const DEFAULT_FILE_LEVEL = 'info';

const generalTransport = new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'general-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '7m',
    maxFiles: '30d',
    zippedArchive: true,
    level: DEFAULT_FILE_LEVEL,
    format: winston.format.combine(infoAndBelow, fileFormat),
});

const errorTransport = new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '7m',
    maxFiles: '30d',
    zippedArchive: true,
    level: 'warn',
    format: winston.format.combine(warnAndAbove, fileFormat),
});

// One batch a minute; repeats collapse; a failed send is dropped (lines are on disk).
const REMOTE_FLUSH_INTERVAL_MS = 60 * 1000;
const REMOTE_MAX_DISTINCT = 200;
const REMOTE_MAX_PER_BATCH = 50;
const REMOTE_MAX_MESSAGE_CHARS = 1000;

class ServerLogTransport extends winston.Transport {
    constructor(opts) {
        super({ ...opts, level: 'warn' });
        this.buffer = new Map();
        this.dropped = 0;
        this.timer = setInterval(() => this.flush(), REMOTE_FLUSH_INTERVAL_MS);
        this.timer.unref?.();
    }

    log(info, callback) {
        const message = String(info.message).slice(0, REMOTE_MAX_MESSAGE_CHARS);
        const key = `${info.level}|${message}`;
        const entry = this.buffer.get(key);
        if (entry) entry.count++;
        else if (this.buffer.size < REMOTE_MAX_DISTINCT) {
            this.buffer.set(key, { level: info.level, message, count: 1 });
        } else this.dropped++;
        callback();
    }

    flush() {
        if (this.buffer.size === 0 && this.dropped === 0) return;
        const all = Array.from(this.buffer.values());
        const entries = all.slice(0, REMOTE_MAX_PER_BATCH);
        const dropped = this.dropped + (all.length - entries.length);
        this.buffer.clear();
        this.dropped = 0;

        try {
            const { SERVER_URL, AGENT_VERSION } = require('../config/constants');
            const { loadConfig } = require('./configManager');
            const { getHttpClient } = require('./httpClient');

            if (!SERVER_URL) return;
            const config = loadConfig();
            if (!config.deviceId || !config.agentToken) return;

            getHttpClient()
                .post(
                    '/api/logs',
                    { entries, dropped, agentVersion: AGENT_VERSION },
                    { headers: { Authorization: `Bearer ${config.agentToken}` } }
                )
                .catch(() => {});
        } catch {
            // Shipping logs must never throw into the logger.
        }
    }
}

function isPackaged() {
    try {
        return require('electron').app?.isPackaged === true;
    } catch {
        return false;
    }
}

const transports = [generalTransport, errorTransport, new ServerLogTransport()];
// An installed agent has no console anyone reads: each line would be formatted for nothing.
if (!isPackaged()) {
    transports.push(new winston.transports.Console({ level: 'debug', format: consoleFormat }));
}

const winstonLogger = winston.createLogger({
    level: 'debug',
    format: fileFormat,
    transports,
});

// Supports multi-arg calls: log.error('msg:', errorObj)
function formatArgs(args) {
    return args
        .map((a) => {
            if (a instanceof Error) return a.stack || a.message;
            if (typeof a === 'object') return JSON.stringify(a);
            return String(a);
        })
        .join(' ');
}

const log = {
    error: (...args) => winstonLogger.error(formatArgs(args)),
    warn: (...args) => winstonLogger.warn(formatArgs(args)),
    info: (...args) => winstonLogger.info(formatArgs(args)),
    debug: (...args) => winstonLogger.debug(formatArgs(args)),
};

// Lazy config read — configManager requires this module, so it can't be imported at load.
function applyConfiguredLogLevel() {
    let level = process.env.LOG_LEVEL;
    if (!level) {
        try {
            level = require('./configManager').loadConfig().logLevel;
        } catch {
            // Default level.
        }
    }
    if (level !== 'debug' && level !== 'info' && level !== 'warn') return DEFAULT_FILE_LEVEL;
    generalTransport.level = level;
    if (level !== DEFAULT_FILE_LEVEL) log.info(`[LOG]: File log level set to "${level}".`);
    return level;
}

// Collapses HttpError-style multi-line dumps (headers, cookies) to their first line.
function briefError(err) {
    if (!err) return 'unknown error';
    const first = String(err.message || err)
        .split('\n')[0]
        .trim();
    const name = err.name && err.name !== 'Error' ? `${err.name}: ` : '';
    return `${name}${first}`;
}

const heartbeatLog = {
    _counter: 0,
    _lastLog: 0,

    info(_message) {
        this._counter++;
        const now = Date.now();
        if (this._counter % 10 === 0 || now - this._lastLog > 5 * 60 * 1000) {
            log.debug(`[HEARTBEAT]: Heartbeats sent (last 5 min): ${this._counter % 10 || 10}`);
            this._lastLog = now;
        }
    },
};

function getLogDir() {
    return LOG_DIR;
}

const LOG_FILE_DATE_RE = /^(general|error)-(\d{4}-\d{2}-\d{2})\.log(\.\d+)?(\.gz)?$/;

function getLogPathsForDays(days) {
    const today = new Date();
    const oldest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1));
    const pad = (n) => String(n).padStart(2, '0');
    const cutoff = `${oldest.getFullYear()}-${pad(oldest.getMonth() + 1)}-${pad(oldest.getDate())}`;
    try {
        return fs
            .readdirSync(LOG_DIR)
            .map((name) => ({ name, match: name.match(LOG_FILE_DATE_RE) }))
            .filter(({ match }) => match && match[2] >= cutoff)
            .map(({ name }) => ({
                name,
                path: path.join(LOG_DIR, name),
                compressed: name.endsWith('.gz'),
            }));
    } catch {
        return [];
    }
}

function cleanupOldLogs() {
    try {
        const now = Date.now();
        const maxAge = 90 * 24 * 60 * 60 * 1000;
        const files = fs.readdirSync(LOG_DIR);

        files.forEach((file) => {
            const filePath = path.join(LOG_DIR, file);
            if (!file.endsWith('.log') && !file.endsWith('.gz')) return;

            try {
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                    log.info(`[CLEANUP]: Deleted old log file: ${file}`);
                }
            } catch {
                // A file in use stays until the next cleanup.
            }
        });
    } catch {
        // No log directory yet.
    }
}

module.exports = {
    log,
    heartbeatLog,
    applyConfiguredLogLevel,
    briefError,
    getLogDir,
    getLogPathsForDays,
    cleanupOldLogs,
};
