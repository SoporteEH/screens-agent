const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    onDeviceId: (callback) => ipcRenderer.on('device-id', (event, ...args) => callback(...args)),

    onAgentInfo: (callback) => ipcRenderer.on('agent-info', (event, ...args) => callback(...args)),
    onUpdateStatus: (callback) =>
        ipcRenderer.on('update-status', (event, ...args) => callback(...args)),

    sendAction: (action) => ipcRenderer.send('agent-action', { action }),
    getUpdateState: () => ipcRenderer.invoke('get-update-state'),
    minimizeWindow: () => ipcRenderer.send('window-control', 'minimize'),
    closeWindow: () => ipcRenderer.send('window-control', 'close'),

    send: (channel, data) => {
        if (channel === 'set-server-url') ipcRenderer.send(channel, data);
    },
    on: (channel, func) => {
        if (channel === 'provision-status') {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    },
});
