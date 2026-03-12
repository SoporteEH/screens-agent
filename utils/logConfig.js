/**
 * - Separate files: general (all), error (warn+error)
 * - Daily rotation with 10MB max size per file
 * - 90-day retention with automatic cleanup
 * - Remote error forwarding to server API
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const LOG_DIR = app.getPath('logs');

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

const generalTransport = new winston.transports.File({
    dirname: LOG_DIR,
    filename: path.join(LOG_DIR, 'general.log'),
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 100,
    level: 'info',
    tailable: true,
    format: winston.format.combine(infoAndBelow, fileFormat),
});

const errorTransport = new winston.transports.File({
    dirname: LOG_DIR,
    filename: path.join(LOG_DIR, 'error.log'),
    maxsize: 10 * 1024 * 1024, // 10MB
    maxFiles: 100,
    level: 'warn',
    tailable: true,
    format: winston.format.combine(warnAndAbove, fileFormat),
});

// Remote transport: forwards warn/error to server API
class ServerLogTransport extends winston.Transport {
    constructor(opts) {
        super({ ...opts, level: 'warn' });
    }

    log(info, callback) {
        setTimeout(() => {
            try {
                const { SERVER_URL, AGENT_VERSION } = require('../config/constants');
                const { loadConfig } = require('./configManager');
                const { net } = require('electron');

                if (!SERVER_URL) return callback();
                const config = loadConfig();
                if (!config.deviceId || !config.agentToken) return callback();

                const request = net.request({
                    method: 'POST',
                    url: `${SERVER_URL}/api/logs`,
                    useSessionCookies: false,
                });
                request.setHeader('Content-Type', 'application/json');
                request.setHeader('Authorization', `Bearer ${config.agentToken}`);
                request.on('error', () => { });
                const body = JSON.stringify({
                    level: info.level,
                    message: info.message,
                    deviceId: config.deviceId,
                    agentVersion: AGENT_VERSION,
                    timestamp: new Date().toISOString(),
                });
                request.write(body);
                request.end();
            } catch (e) {
                void e;
            }
            callback();
        }, 0);
    }
}

const winstonLogger = winston.createLogger({
    format: fileFormat,
    transports: [
        generalTransport,
        errorTransport,
        new ServerLogTransport(),
        new winston.transports.Console({ level: 'debug', format: consoleFormat }),
    ],
});

// Proxy to support multi-arg calls: log.error('msg:', errorObj)
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

// --- Helpers ---

function getLogDir() {
    return LOG_DIR;
}

function getGeneralLogPath() {
    return path.join(LOG_DIR, 'general.log');
}

/**
 * Gets all log files for zipping.
 */
function getAllLogPaths() {
    try {
        const files = fs.readdirSync(LOG_DIR);
        return files
            .filter((f) => (f.startsWith('general') || f.startsWith('error')) && f.endsWith('.log'))
            .map((f) => ({
                name: f.replace('.log', ''),
                path: path.join(LOG_DIR, f),
            }));
    } catch (err) {
        return [];
    }
}

/**
 * Manually cleanup logs older than 90 days.
 * Winston File transport handles maxsize but not maxAge by itself without DailyRotateFile.
 */
function cleanupOldLogs() {
    try {
        const now = Date.now();
        const maxAge = 90 * 24 * 60 * 60 * 1000;
        const files = fs.readdirSync(LOG_DIR);

        files.forEach((file) => {
            const filePath = path.join(LOG_DIR, file);
            if (!file.endsWith('.log')) return;

            try {
                const stats = fs.statSync(filePath);
                if (now - stats.mtimeMs > maxAge) {
                    fs.unlinkSync(filePath);
                    console.log(`[CLEANUP]: Deleted old log file: ${file}`);
                }
            } catch (e) {
                // Ignore skip
            }
        });
    } catch (err) {
        // Silently fail cleanup
    }
}

module.exports = {
    log,
    heartbeatLog,
    updaterLog,
    getLogDir,
    getGeneralLogPath,
    getAllLogPaths,
    cleanupOldLogs,
};
