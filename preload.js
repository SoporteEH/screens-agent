const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    // Identification
    onDeviceId: (callback) => ipcRenderer.on('device-id', (event, ...args) => callback(...args)),

    onAgentInfo: (callback) => ipcRenderer.on('agent-info', (event, ...args) => callback(...args)),
    onUpdateStatus: (callback) =>
        ipcRenderer.on('update-status', (event, ...args) => callback(...args)),

    sendAction: (action, data) => ipcRenderer.send('agent-action', { action, data }),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    getUpdateState: () => ipcRenderer.invoke('get-update-state'),
    minimizeWindow: () => ipcRenderer.send('window-control', 'minimize'),
    closeWindow: () => ipcRenderer.send('window-control', 'close'),

    send: (channel, data) => {
        const allowed = ['set-server-url', 'window-control', 'agent-action'];
        if (allowed.includes(channel)) ipcRenderer.send(channel, data);
    },
    on: (channel, func) => {
        const allowed = ['provision-status', 'device-id', 'agent-info', 'update-status'];
        if (allowed.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    },
});
