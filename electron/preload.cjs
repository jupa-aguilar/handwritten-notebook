// Exposes the system-browser Google OAuth flow to the web app. sync.js checks
// for window.nativeGoogleAuth to decide between this and in-page GIS (which
// Google blocks inside Electron).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nativeGoogleAuth', (clientId) =>
  ipcRenderer.invoke('google-oauth', clientId)
);
