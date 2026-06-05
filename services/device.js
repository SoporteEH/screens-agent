/**
 * Device Service - System identity and commands
 */

const { machineIdSync } = require('node-machine-id');
const { exec } = require('child_process');
const { log } = require('../utils/logConfig');
const { app } = require('electron');
const { loadLastState } = require('./state');
const { loadConfig } = require('../utils/configManager');

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

    const updateChannel = loadConfig().updateChannel === 'beta' ? 'beta' : 'latest';

    log.info('[DEVICE]: Registering with displays:', screenInfo);
    socket.emit('registerDevice', {
        deviceId,
        screens: screenInfo,
        agentVersion: app.getVersion(),
        updateChannel,
    });
}

function handleRebootDevice() {
    const platform = process.platform;
    let command = '';

    if (platform === 'win32') {
        command = 'shutdown /r /t 0';
    } else if (platform === 'darwin' || platform === 'linux') {
        // Try sudo reboot first, then systemctl as fallback
        command = 'sudo reboot || systemctl reboot';
    } else {
        log.error(`[DEVICE]: Platform ${platform} not supported for reboot.`);
        return;
    }

    log.info(`[DEVICE]: Rebooting: ${command}`);
    exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error) log.error(`[DEVICE]: Error: ${error.message}`);
        if (stderr) log.error(`[DEVICE]: ${stderr}`);
        if (stdout) log.info(`[DEVICE]: ${stdout}`);
    });
}

function setupAutostart() {
    if (!app.isPackaged) return;

    const platform = process.platform;
    if (platform === 'win32' || platform === 'darwin') {
        try {
            app.setLoginItemSettings({
                openAtLogin: true,
                path: app.getPath('exe'),
                args: ['--hidden'],
            });
            log.info(`[DEVICE]: Auto-start configured for ${platform}`);
        } catch (error) {
            log.error(`[DEVICE]: Failed to set auto-start for ${platform}:`, error);
        }
    } else if (platform === 'linux') {
        try {
            const fs = require('fs');
            const path = require('path');
            const autostartDir = path.join(app.getPath('home'), '.config', 'autostart');
            if (!fs.existsSync(autostartDir)) {
                fs.mkdirSync(autostartDir, { recursive: true });
            }

            const desktopFile = path.join(autostartDir, 'screens-web-agent.desktop');
            const execPath = app.getPath('exe');
            const content = `[Desktop Entry]
Type=Application
Name=ScreensWeb Agent
Exec=${execPath} --hidden
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
Comment=ScreensWeb Agent for Digital Signage
`;
            fs.writeFileSync(desktopFile, content);
            log.info('[DEVICE]: Linux autostart desktop file created.');
        } catch (error) {
            log.error('[DEVICE]: Failed to set Linux autostart:', error);
        }
    }
}

module.exports = {
    getMachineId,
    registerDevice,
    handleRebootDevice,
    setupAutostart,
};
