/**
 * Device Service - System identity and commands
 */

const { machineIdSync } = require('node-machine-id');
const { exec } = require('child_process');
const { log } = require('../utils/logConfig');
const { app } = require('electron');
const { loadLastState } = require('./state');

function getMachineId() {
    try {
        return machineIdSync();
    } catch (error) {
        log.error('[DEVICE]: Error retrieving Machine ID:', error);
        return 'unknown-device-' + Date.now();
    }
}

function registerDevice(socket, deviceId, hardwareIdToDisplayMap) {
    if (!socket?.connected) return;

    const lastState = loadLastState();
    const screenInfo = Array.from(hardwareIdToDisplayMap.entries()).map(
        ([hardwareId, display]) => ({
            id: hardwareId,
            size: {
                width: Math.round(display.size.width * display.scaleFactor),
                height: Math.round(display.size.height * display.scaleFactor),
            },
            currentUrl: lastState[hardwareId]?.url || '',
        })
    );

    log.info('[DEVICE]: Registering with displays:', screenInfo);
    socket.emit('registerDevice', {
        deviceId,
        screens: screenInfo,
        agentVersion: app.getVersion(),
    });
}

function handleRebootDevice() {
    const platform = process.platform;
    let command = '';

    if (platform === 'win32') command = 'shutdown /r /t 0';
    else if (platform === 'darwin' || platform === 'linux') command = 'sudo reboot';
    else {
        log.error(`[DEVICE]: Platform ${platform} not supported.`);
        return;
    }

    log.info(`[DEVICE]: Rebooting: ${command}`);
    exec(command, (error, stdout, stderr) => {
        if (error) log.error(`[DEVICE]: Error: ${error.message}`);
        if (stderr) log.error(`[DEVICE]: ${stderr}`);
        if (stdout) log.info(`[DEVICE]: ${stdout}`);
    });
}

module.exports = {
    getMachineId,
    registerDevice,
    handleRebootDevice,
};
