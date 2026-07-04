// Electron shell for the notebook app.
//
// The window loads the hosted PWA so the Mac app shares the same origin as the
// browser/iPhone versions — required for Google Drive sync (OAuth doesn't work
// from file://) and it means all devices run the same deployed code. If the
// network is down on first launch, it falls back to the bundled static build
// (fully functional except sync/OCR).
const { app, BrowserWindow, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const APP_URL = 'https://jupa-aguilar.github.io/handwritten-notebook/';

// Google refuses to sign in inside embedded browsers ("this browser or app
// may not be secure"), so OAuth runs in the system browser instead: we open
// the auth URL externally and catch the redirect on a local loopback server.
// The implicit-flow token arrives in the URL fragment, which never reaches an
// HTTP server, so the landing page forwards it back via fetch().
// Requires `http://127.0.0.1:17987` in the OAuth client's authorized redirect URIs.
const OAUTH_PORT = 17987;

// Only one sign-in attempt at a time: retrying cancels the previous one so
// the port is free again (otherwise a stale attempt blocks retries).
let cancelPendingOauth = null;

ipcMain.handle('google-oauth', (_evt, clientId) => {
  if (cancelPendingOauth) cancelPendingOauth();
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      cancelPendingOauth = null;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      fn(arg);
    };
    cancelPendingOauth = () =>
      finish(reject, new Error('Superseded by a newer sign-in attempt'));

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${OAUTH_PORT}`);
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>My Notebook</title>
<body style="font-family:sans-serif;padding:2rem;background:#2b2622;color:#f4f1ea">
<p id="m">Completing sign-in…</p>
<script>fetch('/token?'+location.hash.slice(1)).then(()=>{
  document.getElementById('m').textContent='Signed in ✓ You can close this tab and return to My Notebook.';
});</script>`);
      } else if (url.pathname === '/token') {
        res.writeHead(200);
        res.end('ok');
        const token = url.searchParams.get('access_token');
        if (token && url.searchParams.get('state') === state) {
          finish(resolve, {
            token,
            expiresIn: Number(url.searchParams.get('expires_in') || 3600),
          });
        } else {
          finish(reject, new Error(url.searchParams.get('error') || 'Sign-in failed'));
        }
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    server.on('error', (err) => finish(reject, new Error(`Sign-in server: ${err.message}`)));
    server.listen(OAUTH_PORT, '127.0.0.1', () => {
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `http://127.0.0.1:${OAUTH_PORT}`,
        response_type: 'token',
        scope: 'https://www.googleapis.com/auth/drive.appdata',
        state,
      });
      shell.openExternal(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    });
    setTimeout(
      () =>
        finish(
          reject,
          new Error(
            'Sign-in timed out — finish the Google page in your browser (keep the app open), then click Sync again'
          )
        ),
      10 * 60_000
    );
  });
});

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
      preload: path.join(__dirname, 'preload.cjs'),
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
