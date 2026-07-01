// Electron shell for the notebook app. The renderer is the plain static build
// from dist/ — no Node integration needed, everything stays sandboxed.
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

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

  // External links (e.g. Google Cloud Console) open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  // Single-page app: block all in-window navigation (also stops an image
  // dropped outside the book area from replacing the page).
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  const devUrl = process.env.ELECTRON_START_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '../dist/index.html'));
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
