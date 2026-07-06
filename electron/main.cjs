// Electron shell for the notebook app.
//
// The window loads the hosted PWA so the Mac app shares the same origin as the
// browser/iPhone versions — required for Google Drive sync (OAuth doesn't work
// from file://) and it means all devices run the same deployed code. If the
// network is down on first launch, it falls back to the bundled static build
// (fully functional except sync/OCR).
const { app, BrowserWindow, shell, ipcMain, safeStorage } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

const APP_URL = 'https://jupa-aguilar.github.io/handwritten-notebook/';

// Google refuses to sign in inside embedded browsers ("this browser or app
// may not be secure"), so OAuth runs in the system browser instead: we open
// the auth URL externally and catch the redirect on a local loopback server.
// Requires `http://127.0.0.1:17987` in the OAuth client's authorized redirect URIs.
//
// With a client secret configured (v2 flow) this is authorization-code + PKCE
// with access_type=offline: the refresh token is stored encrypted, and later
// access tokens mint silently — no browser tab after the first sign-in.
// Without a secret it falls back to the implicit flow, whose token arrives in
// the URL fragment (which never reaches an HTTP server), so the landing page
// forwards it back via fetch(). Those tokens last ~1 h and can't be renewed
// silently.
const OAUTH_PORT = 17987;
const REDIRECT_URI = `http://127.0.0.1:${OAUTH_PORT}`;
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

// ---------- refresh token storage ----------
// One refresh token, tied to the client ID it was minted for, encrypted with
// the OS keychain when available (macOS: Keychain via safeStorage).

function tokenFile() {
  return path.join(app.getPath('userData'), 'google-refresh-token.json');
}

function loadRefreshToken(clientId) {
  try {
    const raw = JSON.parse(fs.readFileSync(tokenFile(), 'utf8'));
    if (raw.clientId !== clientId || !raw.token) return null;
    return raw.encrypted
      ? safeStorage.decryptString(Buffer.from(raw.token, 'base64'))
      : raw.token;
  } catch {
    return null;
  }
}

function saveRefreshToken(clientId, token) {
  const encrypted = safeStorage.isEncryptionAvailable();
  fs.writeFileSync(
    tokenFile(),
    JSON.stringify({
      clientId,
      encrypted,
      token: encrypted ? safeStorage.encryptString(token).toString('base64') : token,
    })
  );
}

function clearRefreshToken() {
  try {
    fs.unlinkSync(tokenFile());
  } catch {
    /* ignore */
  }
}

async function tokenRequest(params, what) {
  const r = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`${what} failed: ${data.error_description || data.error || r.status}`);
    err.code = data.error; // e.g. 'invalid_grant' when a refresh token is dead
    throw err;
  }
  return data;
}

// Only one sign-in attempt at a time: retrying cancels the previous one so
// the port is free again (otherwise a stale attempt blocks retries).
let cancelPendingOauth = null;

// Old hosted builds of sync.js call this: interactive implicit flow only.
ipcMain.handle('google-oauth', (_evt, clientId) => browserSignIn(clientId, ''));

ipcMain.handle('google-oauth-v2', async (_evt, clientId, clientSecret, interactive) => {
  // Silent path: mint a fresh access token from the stored refresh token.
  if (clientSecret) {
    const refreshToken = loadRefreshToken(clientId);
    if (refreshToken) {
      try {
        const d = await tokenRequest(
          {
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
          },
          'Token refresh'
        );
        return { token: d.access_token, expiresIn: d.expires_in || 3600 };
      } catch (err) {
        // Only a rejected grant means the token is dead (revoked, or expired
        // after 7 days while the OAuth app is in Testing). Anything else —
        // offline, Google hiccup — must NOT burn it: rethrow and retry later.
        if (err.code !== 'invalid_grant') throw err;
        clearRefreshToken(); // a new sign-in must mint one
      }
    }
  }
  // Signing in opens a browser tab, so only do it on explicit request.
  if (!interactive) throw new Error('Sign-in needed — click ☁ Sync');
  return browserSignIn(clientId, clientSecret);
});

function browserSignIn(clientId, clientSecret) {
  if (cancelPendingOauth) cancelPendingOauth();
  return new Promise((resolve, reject) => {
    const state = crypto.randomBytes(16).toString('hex');
    const verifier = crypto.randomBytes(32).toString('base64url'); // PKCE
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

    const page = (res, text) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>My Notebook</title>
<body style="font-family:sans-serif;padding:2rem;background:#2b2622;color:#f4f1ea">
<p id="m">${text}</p>`);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname === '/') {
        if (clientSecret) {
          // Code flow: the code arrives in the query string. Trade it for
          // tokens before telling the user they're done.
          const code = url.searchParams.get('code');
          if (!code || url.searchParams.get('state') !== state) {
            page(res, 'Sign-in failed — you can close this tab.');
            return finish(reject, new Error(url.searchParams.get('error') || 'Sign-in failed'));
          }
          tokenRequest(
            {
              client_id: clientId,
              client_secret: clientSecret,
              code,
              code_verifier: verifier,
              redirect_uri: REDIRECT_URI,
              grant_type: 'authorization_code',
            },
            'Sign-in'
          )
            .then((d) => {
              if (d.refresh_token) saveRefreshToken(clientId, d.refresh_token);
              page(res, 'Signed in ✓ You can close this tab and return to My Notebook.');
              finish(resolve, { token: d.access_token, expiresIn: d.expires_in || 3600 });
            })
            .catch((err) => {
              page(res, `Sign-in failed: ${err.message} — you can close this tab.`);
              finish(reject, err);
            });
          return;
        }
        // Implicit flow: the token is in the URL fragment, which never
        // reaches an HTTP server, so the page forwards it back via fetch().
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
        redirect_uri: REDIRECT_URI,
        scope: SCOPE,
        state,
        ...(clientSecret
          ? {
              response_type: 'code',
              access_type: 'offline', // ask for a refresh token
              prompt: 'consent', // …and guarantee one on every sign-in
              code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
              code_challenge_method: 'S256',
            }
          : { response_type: 'token' }),
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
}

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
