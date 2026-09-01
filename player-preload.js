const { contextBridge, ipcRenderer } = require('electron');

// Main→renderer only: the wrapper reports health through document.title ('[stalled]').
contextBridge.exposeInMainWorld('playerAPI', {
    onInit: (callback) => ipcRenderer.on('player:init', (_e, payload) => callback(payload)),
    onShow: (callback) => ipcRenderer.on('player:show', (_e, payload) => callback(payload)),
    onStatus: (callback) => ipcRenderer.on('player:status', (_e, payload) => callback(payload)),
    onRefresh: (callback) => ipcRenderer.on('player:refresh', () => callback()),
});
