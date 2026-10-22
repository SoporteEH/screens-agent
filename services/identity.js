// Shown in the control panel; the server's device name replaces it on connect.
let deviceName = 'PC CUOTAS';

function setDeviceName(name) {
    if (name) deviceName = name;
}

function getDeviceName() {
    return deviceName;
}

module.exports = { setDeviceName, getDeviceName };
