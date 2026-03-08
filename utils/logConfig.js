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

const generalTransport = new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'general-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '10m',
    maxFiles: '90d',
    level: 'info',
});

const errorTransport = new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '10m',
    maxFiles: '90d',
    level: 'warn',
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
                request.on('error', () => {});
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
            log.debug(`[HEARTBEAT]: Latidos enviados (ultimos 5 min): ${this._counter % 10 || 10}`);
            this._lastLog = now;
        }
    },
};

const updaterLog = {
    _lastUpdateCheck: 0,

    logCheck(version) {
        const now = Date.now();
        if (now - this._lastUpdateCheck > 10 * 60 * 1000) {
            log.info(`[UPDATER]: Verificacion periodica - Version actual: ${version}`);
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
    const date = new Date().toISOString().split('T')[0];
    return path.join(LOG_DIR, `general-${date}.log`);
}

function getTodayLogPaths() {
    const date = new Date().toISOString().split('T')[0];
    return [
        { name: 'general', path: path.join(LOG_DIR, `general-${date}.log`) },
        { name: 'error', path: path.join(LOG_DIR, `error-${date}.log`) },
    ];
}

module.exports = {
    log,
    heartbeatLog,
    updaterLog,
    getLogDir,
    getGeneralLogPath,
    getTodayLogPaths,
};
