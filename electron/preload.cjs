// Exposes the system-browser Google OAuth flow to the web app. sync.js checks
// for these to decide between them and in-page GIS (which Google blocks
// inside Electron).
const { contextBridge, ipcRenderer } = require('electron');

// V1: interactive-only implicit flow. Kept so an app updated ahead of the
// hosted site (or vice versa) keeps signing in the old way.
contextBridge.exposeInMainWorld('nativeGoogleAuth', (clientId) =>
  ipcRenderer.invoke('google-oauth', clientId)
);

// V2: with a client secret, holds a refresh token so renewal is silent.
contextBridge.exposeInMainWorld('nativeGoogleAuthV2', (clientId, clientSecret, interactive) =>
  ipcRenderer.invoke('google-oauth-v2', clientId, clientSecret, interactive)
);
