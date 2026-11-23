// Task Manager 2 - preload bridge.
// Only two things cross the boundary: "is this the desktop build" and a request
// to relaunch elevated.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tm2', {
  isDesktop: true,
  relaunchAsAdmin: () => ipcRenderer.invoke('tm2:elevate'),
});
