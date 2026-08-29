// Cross-device sync through the user's own Google Drive.
//
// Everything lives in the hidden appDataFolder (only this app can see it):
//   meta.json        { version, notebooks: { [uuid]: { name, updatedAt, deletedAt? } } }
//   nb-<uuid>.json   per-notebook manifest: name, updatedAt, pages (text, words, order)
//   pg-<uuid>.jpg    page images — immutable, uploaded once
//   cd-<uuid>.json   that notebook's review cards, their deletions, and the
//                    per-day review tallies (one entry per device, summed)
//
// Cards sit in a file of their own rather than in the manifest, because the
// two change on completely different rhythms: grading forty cards in a sitting
// would otherwise re-upload every page's text and word boxes forty times. The
// file carries its own tombstones so a device that never saw a deletion can't
// push the card back up (see applyRemoteCards in db.js).
//
// Reconciliation is a per-page merge: when a notebook changed on both sides
// since this device's last sync, the pull merges page by page (newest
// modifiedAt wins; local-only pages created since the last sync survive;
// tombstoned pages stay dead) and pushes the union back — see
// applyRemoteNotebook in db.js. Notebook deletions still propagate through
// tombstones in meta.json.
//
// This module holds no local state of its own: tombstones and per-notebook
// synced state live in IndexedDB next to the notebooks they describe (db.js).
// Only the credentials below stay in localStorage — losing them costs a
// sign-in, not data.
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
  getPageTombstones,
  getNotebookTombstones,
  setNotebookTombstones,
  getSyncedState,
  setSyncedState,
  applyRemoteCards,
  applyRemoteHistory,
} from './db.js';
import { applySharedUsage, withOwnContribution } from './usage.js';

const USAGE_FILE = 'usage.json'; // shared quota tally, see usage.js
const CLIENT_KEY = 'notebook.syncClientId';
const SECRET_KEY = 'notebook.syncClientSecret';
const TOKEN_KEY = 'notebook.syncToken';
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
  // Note which images the outgoing manifest stops referencing (deleted or
  // replaced pages). Images are immutable and per-uuid, so once no manifest
  // lists one it can never be needed again — but only delete them AFTER the
  // new manifest is safely up: deleting first could leave the old manifest
  // pointing at missing images if the upload then failed.
  let staleImages = [];
  const oldMf = files.get(`nb-${nb.uuid}.json`);
  if (oldMf) {
    try {
      const old = await downloadFile(token, oldMf.id, 'json');
      const keep = new Set(pages.map((p) => p.uuid));
      staleImages = (old.pages || [])
        .map((pm) => pm.uuid)
        .filter((uuid) => uuid && !keep.has(uuid));
    } catch {
      /* unreadable old manifest: skip the cleanup this round */
    }
  }

  onStatus(`Uploading “${nb.name}” — saving index…`);
  const manifest = {
    uuid: nb.uuid,
    name: nb.name,
    ...(typeof nb.order === 'number' ? { order: nb.order } : {}),
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
      bookmarked: !!p.bookmarked,
      bookmarkLabel: p.bookmarkLabel || '',
      // Older records without a modifiedAt inherit the notebook's, which
      // reproduces the pre-merge last-write-wins for them.
      modifiedAt: p.modifiedAt ?? nb.updatedAt,
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
  await setSyncedState(nb.uuid, nb.updatedAt, nb.updatedAt);
  for (const uuid of staleImages) {
    try {
      await deleteFile(token, files, `pg-${uuid}`);
    } catch {
      /* orphans are harmless; another push will retry */
    }
  }
}

async function pullNotebook(token, files, meta, uuid, onStatus = () => {}) {
  const mf = files.get(`nb-${uuid}.json`);
  if (!mf) throw new Error(`manifest for ${uuid} missing on Drive`);
  const manifest = await downloadFile(token, mf.id, 'json');
  const total = (manifest.pages || []).length;
  let done = 0;
  const { id, merged, updatedAt } = await applyRemoteNotebook(
    manifest,
    async (pm) => {
      const f = files.get(`pg-${pm.uuid}`);
      if (!f) throw new Error(`image for page ${pm.uuid} missing on Drive`);
      done++;
      onStatus(`Downloading “${manifest.name}” — page ${done}/${total}…`);
      return downloadFile(token, f.id, 'blob');
    },
    {
      lastSyncAt: (await getSyncedState(uuid))?.at || 0,
      pageTombstones: await getPageTombstones(),
    }
  );
  // Anything local the remote lacked survived the merge: publish it back so
  // every device converges on the union. (pushNotebook records the state.)
  if (merged) await pushNotebook(token, files, meta, id, onStatus);
  else await setSyncedState(uuid, updatedAt, manifest.updatedAt);
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
  await deleteFile(token, files, `cd-${uuid}.json`);
}

// One notebook's review cards. Cheap enough to reconcile on every run: the
// file is a few kilobytes, and its own timestamps decide everything, so there
// is no per-notebook synced state to keep for it.
async function syncCards(token, files, nb) {
  const name = `cd-${nb.uuid}.json`;
  const file = files.get(name);
  let remote = null;
  if (file) {
    try {
      remote = await downloadFile(token, file.id, 'json');
    } catch {
      /* unreadable: rebuild the file from what this device holds */
    }
  }
  const { cards, tombstones, changed } = await applyRemoteCards(
    nb.id,
    remote?.cards || [],
    remote?.tombstones || {}
  );
  // The day tallies ride in this file rather than one of their own: it is
  // already re-uploaded every time a card is graded, which is exactly when a
  // tally moves.
  const { history, changed: historyChanged } = await applyRemoteHistory(
    nb.id,
    remote?.history || {}
  );
  // Nothing of ours is missing up there, so an upload would only rewrite the
  // same bytes with a newer timestamp.
  if (!changed && !historyChanged && file) return false;
  if (!cards.length && !Object.keys(tombstones).length && !Object.keys(history).length) {
    return false;
  }
  await uploadFile(
    token,
    files,
    name,
    'application/json',
    JSON.stringify({ notebook: nb.uuid, updatedAt: Date.now(), cards, tombstones, history })
  );
  return true;
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

  const result = {
    pulled: [],
    pushed: [],
    deletedLocal: [],
    deletedRemote: [],
    cards: [],
  };
  const tombs = await getNotebookTombstones();

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
      continue;
    }
    // Compare each side against what it looked like after the last sync of
    // THIS device — not against each other, whose clocks may disagree.
    const st = (await getSyncedState(uuid)) || { localAt: 0, remoteAt: 0 };
    const localChanged = local.updatedAt !== st.localAt;
    const remoteChanged = entry.updatedAt !== st.remoteAt;
    if (remoteChanged) {
      // Pull even when we changed too: the pull merges page by page and, if
      // anything local survived that the remote lacks, pushes the union back
      // — neither device's edits get stomped.
      onStatus(`Downloading “${entry.name}”…`);
      await pullNotebook(token, files, meta, uuid, onStatus);
      result.pulled.push(uuid);
    } else if (localChanged) {
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

  // 4. Review cards, once the pages they point at are in place — a card whose
  // page arrived in this very run has to find it.
  for (const nb of await listNotebooks()) {
    try {
      onStatus(`Syncing cards for “${nb.name}”…`);
      if (await syncCards(token, files, nb)) result.cards.push(nb.uuid);
    } catch (err) {
      // A card file is worth less than the notebook it belongs to: never fail
      // a sync that already moved pages over a review schedule.
      console.error('Could not sync cards for', nb.name, err);
    }
  }

  onStatus('Saving index…');
  await uploadFile(token, files, 'meta.json', 'application/json', JSON.stringify(meta));
  await setNotebookTombstones(tombs);
  await syncUsage(token, files);
  return result;
}

// The shared quota tally. Read, add this device's entry, write back, and keep
// the sum of everyone else's for display. Deliberately last in the run and
// deliberately swallowing its own errors: knowing how much of the free tier
// is left is useful, but not worth failing a notebook sync over.
async function syncUsage(token, files) {
  try {
    let shared = null;
    const file = files.get(USAGE_FILE);
    if (file) {
      try {
        shared = await downloadFile(token, file.id, 'json');
      } catch {
        /* unreadable: start a fresh tally rather than lose the sync */
      }
    }
    const next = withOwnContribution(shared);
    await uploadFile(token, files, USAGE_FILE, 'application/json', JSON.stringify(next));
    applySharedUsage(next);
  } catch (err) {
    console.error('Could not sync the usage tally', err);
  }
}
