const { contextBridge, ipcRenderer } = require('electron');

// Health still travels through document.title ('[stalled]'); the only renderer→main message is
// what a playlist screen is showing, kept by the main process for get_now_playing.
contextBridge.exposeInMainWorld('playerAPI', {
    onInit: (callback) => ipcRenderer.on('player:init', (_e, payload) => callback(payload)),
    onShow: (callback) => ipcRenderer.on('player:show', (_e, payload) => callback(payload)),
    onStatus: (callback) => ipcRenderer.on('player:status', (_e, payload) => callback(payload)),
    onRefresh: (callback) => ipcRenderer.on('player:refresh', () => callback()),
    onItemFailed: (callback) =>
        ipcRenderer.on('player:item-failed', (_e, payload) => callback(payload)),
    reportNowPlaying: (info) => ipcRenderer.send('player:now-playing', info),
});
