// Cross-device sync through the user's own Google Drive.
//
// Everything lives in the hidden appDataFolder (only this app can see it):
//   meta.json        { version, notebooks: { [uuid]: { name, updatedAt, deletedAt? } } }
//   nb-<uuid>.json   per-notebook manifest: name, updatedAt, pages (text, words, order)
//   pg-<uuid>.jpg    page images — immutable, uploaded once
//
// Reconciliation is last-write-wins per notebook on updatedAt, with tombstones
// for deletions. Locally-added pages survive a pull and get pushed right after
// (see applyRemoteNotebook in db.js).
//
// Auth is Google Identity Services (token client) in the browser; the Electron
// shell swaps in a system-browser loopback flow (electron/main.cjs) that keeps
// a refresh token when a client secret is configured. The user supplies their
// own OAuth Client ID — same bring-your-own-credentials model as the Vision key.

import {
  listNotebooks,
  getNotebook,
  getPages,
  ensureSyncIds,
  applyRemoteNotebook,
  deleteNotebookByUuid,
} from './db.js';

const CLIENT_KEY = 'notebook.syncClientId';
const SECRET_KEY = 'notebook.syncClientSecret';
const TOKEN_KEY = 'notebook.syncToken';
const TOMBSTONES_KEY = 'notebook.syncTombstones';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

export function getSyncClientId() {
  return localStorage.getItem(CLIENT_KEY) || '';
}

export function setSyncClientId(id) {
  if (id) localStorage.setItem(CLIENT_KEY, id);
  else localStorage.removeItem(CLIENT_KEY);
}

// Only needed by the Electron shell, where the token exchange that mints the
// long-lived refresh token requires it. Browsers use GIS and can leave it out.
export function getSyncClientSecret() {
  return localStorage.getItem(SECRET_KEY) || '';
}

export function setSyncClientSecret(secret) {
  // A credential change invalidates the cached token: drop it so the next
  // sync re-authenticates and can mint a refresh token with the new secret.
  if ((secret || '') !== getSyncClientSecret()) localStorage.removeItem(TOKEN_KEY);
  if (secret) localStorage.setItem(SECRET_KEY, secret);
  else localStorage.removeItem(SECRET_KEY);
}

export function isSyncConfigured() {
  return !!getSyncClientId();
}

// Notebooks deleted locally since the last successful sync, so the deletion
// can propagate: { [uuid]: deletedAtMs }.
function getTombstones() {
  try {
    return JSON.parse(localStorage.getItem(TOMBSTONES_KEY) || '{}');
  } catch {
    return {};
  }
}

export function recordTombstone(uuid) {
  if (!uuid) return;
  const t = getTombstones();
  t[uuid] = Date.now();
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(t));
}

// ---------- auth (Google Identity Services) ----------

function loadGis() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in'));
    document.head.appendChild(s);
  });
}

async function authToken(interactive) {
  try {
    const cached = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  } catch {
    /* ignore */
  }

  // Electron: Google blocks sign-in inside embedded browsers, so the shell
  // exposes a system-browser loopback flow instead of in-page GIS. The V2
  // shell renews silently through its stored refresh token (needs the client
  // secret); when that's not possible, sign-in opens a browser tab, so it
  // only runs on explicit request.
  if (window.nativeGoogleAuthV2 || window.nativeGoogleAuth) {
    let res;
    try {
      if (window.nativeGoogleAuthV2) {
        res = await window.nativeGoogleAuthV2(
          getSyncClientId(),
          getSyncClientSecret(),
          interactive
        );
      } else {
        if (!interactive) throw new Error('Sign-in needed — click ☁ Sync');
        res = await window.nativeGoogleAuth(getSyncClientId());
      }
    } catch (err) {
      // ipcRenderer.invoke wraps rejections in "Error invoking remote
      // method '…': Error: <message>" — surface just the message.
      throw new Error(
        String(err?.message || err).replace(
          /^Error invoking remote method '[^']*': (?:Error: )?/,
          ''
        )
      );
    }
    localStorage.setItem(
      TOKEN_KEY,
      JSON.stringify({ token: res.token, exp: Date.now() + (res.expiresIn - 60) * 1000 })
    );
    return res.token;
  }

  await loadGis();
  return new Promise((resolve, reject) => {
    const tc = window.google.accounts.oauth2.initTokenClient({
      client_id: getSyncClientId(),
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        localStorage.setItem(
          TOKEN_KEY,
          JSON.stringify({
            token: resp.access_token,
            exp: Date.now() + (resp.expires_in - 60) * 1000,
          })
        );
        resolve(resp.access_token);
      },
      error_callback: (err) =>
        reject(new Error(err?.message || err?.type || 'Sign-in was cancelled')),
    });
    // Silent refresh unless the caller can show UI (first consent needs it).
    tc.requestAccessToken(interactive ? {} : { prompt: '' });
  });
}

// ---------- Drive REST helpers ----------

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function driveOk(resp, what) {
  if (resp.ok) return resp;
  if (resp.status === 401) localStorage.removeItem(TOKEN_KEY); // stale token
  const body = await resp.text().catch(() => '');
  throw new Error(`Drive ${what} failed (${resp.status}): ${body.slice(0, 200)}`);
}

// All appDataFolder files as a Map name -> { id }.
async function listAppFiles(token) {
  const map = new Map();
  let pageToken;
  do {
    const q = new URLSearchParams({
      spaces: 'appDataFolder',
      fields: 'nextPageToken,files(id,name)',
      pageSize: '1000',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const r = await driveOk(
      await fetch(`${API}/files?${q}`, { headers: authHeaders(token) }),
      'list'
    );
    const data = await r.json();
    for (const f of data.files || []) map.set(f.name, f);
    pageToken = data.nextPageToken;
  } while (pageToken);
  return map;
}

async function downloadFile(token, id, as) {
  const r = await driveOk(
    await fetch(`${API}/files/${id}?alt=media`, { headers: authHeaders(token) }),
    'download'
  );
  return as === 'blob' ? r.blob() : r.json();
}

// Create (metadata then content) or update (content only) a file.
// Returns the file id and records it in the `files` map.
async function uploadFile(token, files, name, mimeType, data) {
  let id = files.get(name)?.id;
  if (!id) {
    const r = await driveOk(
      await fetch(`${API}/files?fields=id`, {
        method: 'POST',
        headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, parents: ['appDataFolder'], mimeType }),
      }),
      'create'
    );
    id = (await r.json()).id;
    files.set(name, { id, name });
  }
  await driveOk(
    await fetch(`${UPLOAD}/files/${id}?uploadType=media`, {
      method: 'PATCH',
      headers: { ...authHeaders(token), 'Content-Type': mimeType },
      body: data,
    }),
    'upload'
  );
  return id;
}

async function deleteFile(token, files, name) {
  const f = files.get(name);
  if (!f) return;
  const r = await fetch(`${API}/files/${f.id}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!r.ok && r.status !== 404) await driveOk(r, 'delete');
  files.delete(name);
}

// ---------- sync algorithm ----------

async function pushNotebook(token, files, meta, nbId, onStatus = () => {}) {
  const nb = await getNotebook(nbId);
  const pages = await getPages(nbId);
  // Images are immutable: upload only the ones Drive doesn't have yet.
  let done = 0;
  for (const p of pages) {
    done++;
    const name = `pg-${p.uuid}`;
    if (!files.has(name)) {
      onStatus(`Uploading “${nb.name}” — page ${done}/${pages.length}…`);
      await uploadFile(token, files, name, p.mediaType || 'image/jpeg', p.blob);
    }
  }
  onStatus(`Uploading “${nb.name}” — saving index…`);
  const manifest = {
    uuid: nb.uuid,
    name: nb.name,
    createdAt: nb.createdAt,
    updatedAt: nb.updatedAt,
    pages: pages.map((p) => ({
      uuid: p.uuid,
      order: p.order,
      name: p.name,
      mediaType: p.mediaType,
      width: p.width,
      height: p.height,
      text: p.text || '',
      words: p.words || [],
      ocrStatus: p.ocrStatus,
      error: p.error || '',
    })),
  };
  await uploadFile(
    token,
    files,
    `nb-${nb.uuid}.json`,
    'application/json',
    JSON.stringify(manifest)
  );
  meta.notebooks[nb.uuid] = { name: nb.name, updatedAt: nb.updatedAt };
}

async function pullNotebook(token, files, meta, uuid, onStatus = () => {}) {
  const mf = files.get(`nb-${uuid}.json`);
  if (!mf) throw new Error(`manifest for ${uuid} missing on Drive`);
  const manifest = await downloadFile(token, mf.id, 'json');
  const total = (manifest.pages || []).length;
  let done = 0;
  const { id, merged } = await applyRemoteNotebook(manifest, async (pm) => {
    const f = files.get(`pg-${pm.uuid}`);
    if (!f) throw new Error(`image for page ${pm.uuid} missing on Drive`);
    done++;
    onStatus(`Downloading “${manifest.name}” — page ${done}/${total}…`);
    return downloadFile(token, f.id, 'blob');
  });
  // Locally-added pages survived the pull: push the merged result back now.
  if (merged) await pushNotebook(token, files, meta, id, onStatus);
}

async function deleteRemoteNotebook(token, files, uuid) {
  const mf = files.get(`nb-${uuid}.json`);
  if (mf) {
    try {
      const manifest = await downloadFile(token, mf.id, 'json');
      for (const pm of manifest.pages || []) {
        await deleteFile(token, files, `pg-${pm.uuid}`);
      }
    } catch {
      /* manifest unreadable — leave any orphaned images behind */
    }
    await deleteFile(token, files, `nb-${uuid}.json`);
  }
}

// Returns { pulled, pushed, deletedLocal, deletedRemote } (arrays of uuids).
export async function syncNow({ interactive = false, onStatus = () => {} } = {}) {
  if (!isSyncConfigured()) {
    throw new Error('Add a Google OAuth Client ID in Settings first');
  }
  onStatus('Signing in…');
  const token = await authToken(interactive);

  onStatus('Checking Drive…');
  await ensureSyncIds();
  const files = await listAppFiles(token);

  let meta = { version: 1, notebooks: {} };
  const metaFile = files.get('meta.json');
  if (metaFile) {
    try {
      meta = await downloadFile(token, metaFile.id, 'json');
      if (!meta.notebooks) meta = { version: 1, notebooks: {} };
    } catch {
      /* corrupt meta: rebuild from scratch below */
    }
  }

  const result = { pulled: [], pushed: [], deletedLocal: [], deletedRemote: [] };
  const tombs = getTombstones();

  // 1. Propagate local deletions (unless the remote copy is newer — it wins).
  for (const [uuid, deletedAt] of Object.entries(tombs)) {
    const entry = meta.notebooks[uuid];
    if (entry && !entry.deletedAt && entry.updatedAt > deletedAt) {
      delete tombs[uuid]; // remote survived with newer edits; it'll pull below
      continue;
    }
    onStatus('Deleting on Drive…');
    await deleteRemoteNotebook(token, files, uuid);
    meta.notebooks[uuid] = {
      name: entry?.name || '',
      updatedAt: deletedAt,
      deletedAt,
    };
    result.deletedRemote.push(uuid);
    delete tombs[uuid];
  }

  // 2. Reconcile every notebook present on either side.
  const locals = await listNotebooks();
  const localByUuid = new Map(locals.map((n) => [n.uuid, n]));

  for (const [uuid, entry] of Object.entries(meta.notebooks)) {
    const local = localByUuid.get(uuid);
    if (entry.deletedAt) {
      if (local && local.updatedAt > entry.deletedAt) {
        onStatus(`Uploading “${local.name}”…`);
        delete entry.deletedAt; // local edits after the delete revive it
        await pushNotebook(token, files, meta, local.id, onStatus);
        result.pushed.push(uuid);
      } else if (local) {
        await deleteNotebookByUuid(uuid);
        result.deletedLocal.push(uuid);
      }
      continue;
    }
    if (!local) {
      onStatus(`Downloading “${entry.name}”…`);
      await pullNotebook(token, files, meta, uuid, onStatus);
      result.pulled.push(uuid);
    } else if (entry.updatedAt > local.updatedAt) {
      onStatus(`Downloading “${entry.name}”…`);
      await pullNotebook(token, files, meta, uuid, onStatus);
      result.pulled.push(uuid);
    } else if (entry.updatedAt < local.updatedAt) {
      onStatus(`Uploading “${local.name}”…`);
      await pushNotebook(token, files, meta, local.id, onStatus);
      result.pushed.push(uuid);
    }
  }

  // 3. Notebooks that only exist locally.
  for (const nb of locals) {
    if (!meta.notebooks[nb.uuid]) {
      onStatus(`Uploading “${nb.name}”…`);
      await pushNotebook(token, files, meta, nb.id, onStatus);
      result.pushed.push(nb.uuid);
    }
  }

  onStatus('Saving index…');
  await uploadFile(token, files, 'meta.json', 'application/json', JSON.stringify(meta));
  localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(tombs));
  return result;
}
