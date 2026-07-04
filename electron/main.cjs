// Electron shell for the notebook app.
//
// The window loads the hosted PWA so the Mac app shares the same origin as the
// browser/iPhone versions — required for Google Drive sync (OAuth doesn't work
// from file://) and it means all devices run the same deployed code. If the
// network is down on first launch, it falls back to the bundled static build
// (fully functional except sync/OCR).
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

const APP_URL = 'https://jupa-aguilar.github.io/handwritten-notebook/';

// Google blocks OAuth in browsers it identifies as embedded; strip the
// Electron token from the user agent so sign-in popups work.
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/[\d.]+/, '')
  .replace(/\shandwritten-notebook\/[\d.]+/, '');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 700,
    minHeight: 500,
    backgroundColor: '#2b2622', // matches the app's --bg to avoid a white flash
    title: 'My Notebook',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    // The Google sign-in popup must stay in-app to hand the token back.
    if (url.startsWith('https://accounts.google.com/')) return { action: 'allow' };
    // Everything else (e.g. Cloud Console links) opens in the default browser.
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Single-page app: block in-window navigation (also stops an image dropped
  // outside the book area from replacing the page). Programmatic loadURL/
  // loadFile calls don't emit this event.
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadURL(APP_URL).catch(() => {
      win.loadFile(path.join(__dirname, '../dist/index.html'));
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
