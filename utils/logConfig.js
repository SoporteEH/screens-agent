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
    } catch (_) {}
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

class ServerLogTransport extends winston.Transport {
    constructor(opts) {
        super({ ...opts, level: 'warn' });
    }

    log(info, callback) {
        setTimeout(() => {
            try {
                const { SERVER_URL, AGENT_VERSION } = require('../config/constants');
                const { loadConfig } = require('./configManager');
                const { getHttpClient } = require('./httpClient');

                if (!SERVER_URL) return callback();
                const config = loadConfig();
                if (!config.deviceId || !config.agentToken) return callback();

                const client = getHttpClient();
                client.post('/api/logs', {
                    level: info.level,
                    message: info.message,
                    deviceId: config.deviceId,
                    agentVersion: AGENT_VERSION,
                    timestamp: new Date().toISOString(),
                }, {
                    headers: { Authorization: `Bearer ${config.agentToken}` },
                }).catch(() => { });
            } catch (e) {
                void e;
            }
            callback();
        }, 0);
    }
}

const winstonLogger = winston.createLogger({
    level: 'debug',
    format: fileFormat,
    transports: [
        generalTransport,
        errorTransport,
        new ServerLogTransport(),
        new winston.transports.Console({ level: 'debug', format: consoleFormat }),
    ],
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
        } catch (_) {}
    }
    if (level !== 'debug' && level !== 'info' && level !== 'warn') return DEFAULT_FILE_LEVEL;
    generalTransport.level = level;
    if (level !== DEFAULT_FILE_LEVEL) log.info(`[LOG]: File log level set to "${level}".`);
    return level;
}

// Collapses HttpError-style multi-line dumps (headers, cookies) to their first line.
function briefError(err) {
    if (!err) return 'unknown error';
    const first = String(err.message || err).split('\n')[0].trim();
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

const updaterLog = {
    _lastUpdateCheck: 0,

    logCheck(version) {
        const now = Date.now();
        if (now - this._lastUpdateCheck > 10 * 60 * 1000) {
            log.info(`[UPDATER]: Periodic check - Current version: ${version}`);
            this._lastUpdateCheck = now;
        }
    },

    logUpdate(message) {
        log.info(`[UPDATER]: ${message}`);
    },
};

function getLogDir() {
    return LOG_DIR;
}

function getGeneralLogPath() {
    return path.join(LOG_DIR, 'general.log');
}

// Used by GetLogs to build the log zip.
function getAllLogPaths() {
    try {
        const files = fs.readdirSync(LOG_DIR);
        return files
            .filter((f) => (f.startsWith('general') || f.startsWith('error')) && (f.endsWith('.log') || f.endsWith('.gz')))
            .map((f) => ({
                name: f.replace('.log', '').replace('.gz', ''),
                path: path.join(LOG_DIR, f),
            }));
    } catch (err) {
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
                    console.log(`[CLEANUP]: Deleted old log file: ${file}`);
                }
            } catch (e) {
            }
        });
    } catch (err) {
    }
}

module.exports = {
    log,
    heartbeatLog,
    updaterLog,
    applyConfiguredLogLevel,
    briefError,
    getLogDir,
    getGeneralLogPath,
    getAllLogPaths,
    cleanupOldLogs,
};
