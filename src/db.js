// IndexedDB persistence.
//
// Stores:
//   notebooks: { id, name, createdAt, updatedAt }
//   pages:     { id, notebookId, order, name, blob, mediaType, width, height,
//                text, ocrStatus, error, bookmarked, bookmarkLabel }
//     ocrStatus: 'pending' | 'done' | 'error' | 'skipped'
import { openDB } from 'idb';

const dbPromise = openDB('handwritten-notebook', 2, {
  async upgrade(db, oldVersion, _newVersion, tx) {
    if (oldVersion < 1) {
      const pages = db.createObjectStore('pages', {
        keyPath: 'id',
        autoIncrement: true,
      });
      pages.createIndex('order', 'order');
    }
    if (oldVersion < 2) {
      db.createObjectStore('notebooks', { keyPath: 'id', autoIncrement: true });
      const pages = tx.objectStore('pages');
      pages.createIndex('notebookId', 'notebookId');
      // Migrate any pages from the single-notebook version into a default notebook.
      const existing = await pages.getAll();
      if (existing.length) {
        const nbId = await tx.objectStore('notebooks').add({
          name: 'My Notebook',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        for (const p of existing) {
          p.notebookId = nbId;
          await pages.put(p);
        }
      }
    }
  },
});

// ---------- notebooks ----------

export async function listNotebooks() {
  const db = await dbPromise;
  const all = await db.getAll('notebooks');
  // Manual order when set; notebooks that never got one (pre-reorder records,
  // or pulled from an older device) fall back to creation time, which sorts
  // them after the ordered ones (small ints vs epoch ms) — i.e. at the end.
  const key = (n) => (typeof n.order === 'number' ? n.order : n.createdAt || 0);
  return all.sort((a, b) => key(a) - key(b));
}

export async function addNotebook(name) {
  const db = await dbPromise;
  return db.add('notebooks', {
    name,
    uuid: crypto.randomUUID(), // stable cross-device id for sync
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
}

export async function getNotebook(id) {
  const db = await dbPromise;
  return db.get('notebooks', id);
}

export async function renameNotebook(id, name) {
  const db = await dbPromise;
  const nb = await db.get('notebooks', id);
  if (!nb) return;
  nb.name = name;
  nb.updatedAt = Date.now();
  return db.put('notebooks', nb);
}

// Persist a new notebook order. `orderedIds` lists notebook ids in their
// desired order; each notebook's `order` field is set to its position in that
// list. Moved notebooks get a fresh updatedAt so sync propagates the change.
export async function reorderNotebooks(orderedIds) {
  const db = await dbPromise;
  const tx = db.transaction('notebooks', 'readwrite');
  const store = tx.objectStore('notebooks');
  for (let i = 0; i < orderedIds.length; i++) {
    const nb = await store.get(orderedIds[i]);
    if (nb && nb.order !== i) {
      nb.order = i;
      nb.updatedAt = Date.now();
      await store.put(nb);
    }
  }
  await tx.done;
}

export async function deleteNotebook(id) {
  const db = await dbPromise;
  const tx = db.transaction(['notebooks', 'pages'], 'readwrite');
  await tx.objectStore('notebooks').delete(id);
  const idx = tx.objectStore('pages').index('notebookId');
  let cursor = await idx.openCursor(id);
  while (cursor) {
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
}

// ---------- pages (scoped to a notebook) ----------

export async function getPages(notebookId) {
  const db = await dbPromise;
  const all = await db.getAllFromIndex('pages', 'notebookId', notebookId);
  return all.sort((a, b) => a.order - b.order);
}

export async function countPages(notebookId) {
  const db = await dbPromise;
  return db.countFromIndex('pages', 'notebookId', notebookId);
}

export async function addPage(page) {
  const db = await dbPromise;
  page.modifiedAt ??= page.createdAt || Date.now();
  return db.add('pages', page);
}

// Every app-side write lands here, so this is where a page's modifiedAt gets
// bumped — the sync merge uses it to decide which device's copy is newer.
// (Sync-applied remote pages are written with raw puts and keep the remote's
// own modifiedAt.)
export async function putPage(page) {
  const db = await dbPromise;
  page.modifiedAt = Date.now();
  return db.put('pages', page);
}

export async function deletePage(id) {
  const db = await dbPromise;
  const page = await db.get('pages', id);
  if (page?.uuid) recordPageTombstone(page.uuid);
  return db.delete('pages', id);
}

// Persist a new page order. `orderedIds` lists page ids in their desired order;
// each page's `order` field is set to its position in that list.
export async function reorderPages(orderedIds) {
  const db = await dbPromise;
  const tx = db.transaction('pages', 'readwrite');
  const store = tx.objectStore('pages');
  for (let i = 0; i < orderedIds.length; i++) {
    const page = await store.get(orderedIds[i]);
    if (page && page.order !== i) {
      page.order = i;
      page.modifiedAt = Date.now(); // reorders propagate through sync too
      await store.put(page);
    }
  }
  await tx.done;
}

export async function nextOrder(notebookId) {
  const pages = await getPages(notebookId);
  return pages.length ? pages[pages.length - 1].order + 1 : 0;
}

export async function clearAll() {
  const db = await dbPromise;
  const tx = db.transaction(['notebooks', 'pages'], 'readwrite');
  await tx.objectStore('notebooks').clear();
  await tx.objectStore('pages').clear();
  await tx.done;
}

// ---------- sync support ----------

// Uuids of pages deleted (or replaced — same thing to sync) on this device.
// A pull consults them so a manifest that still lists such a page can't
// resurrect it here; the following push then removes it remotely as well.
// Pruned by age: once every device has synced they're dead weight.
const PAGE_TOMBSTONES_KEY = 'notebook.syncPageTombstones';
const PAGE_TOMBSTONE_TTL = 60 * 24 * 60 * 60 * 1000; // 60 days

export function getPageTombstones() {
  let map;
  try {
    map = JSON.parse(localStorage.getItem(PAGE_TOMBSTONES_KEY) || '{}');
  } catch {
    map = {};
  }
  const cutoff = Date.now() - PAGE_TOMBSTONE_TTL;
  let dirty = false;
  for (const [uuid, at] of Object.entries(map)) {
    if (at < cutoff) {
      delete map[uuid];
      dirty = true;
    }
  }
  if (dirty) localStorage.setItem(PAGE_TOMBSTONES_KEY, JSON.stringify(map));
  return map;
}

export function recordPageTombstone(uuid) {
  if (!uuid) return;
  const map = getPageTombstones();
  map[uuid] = Date.now();
  localStorage.setItem(PAGE_TOMBSTONES_KEY, JSON.stringify(map));
}

// Give every notebook and page a stable cross-device uuid (pre-sync records
// were created without one).
export async function ensureSyncIds() {
  const db = await dbPromise;
  const tx = db.transaction(['notebooks', 'pages'], 'readwrite');
  for (const store of ['notebooks', 'pages']) {
    let cursor = await tx.objectStore(store).openCursor();
    while (cursor) {
      if (!cursor.value.uuid) {
        await cursor.update({ ...cursor.value, uuid: crypto.randomUUID() });
      }
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

// Bump a notebook's updatedAt — the sync layer uses it for last-write-wins.
export async function touchNotebook(id) {
  const db = await dbPromise;
  const nb = await db.get('notebooks', id);
  if (!nb) return;
  nb.updatedAt = Date.now();
  return db.put('notebooks', nb);
}

export async function getNotebookByUuid(uuid) {
  const all = await listNotebooks();
  return all.find((n) => n.uuid === uuid) || null;
}

export async function deleteNotebookByUuid(uuid) {
  const nb = await getNotebookByUuid(uuid);
  if (nb) await deleteNotebook(nb.id);
}

// Create or update a local notebook from a remote manifest, merging page by
// page so simultaneous edits on two devices both survive. `resolveBlob(pm)`
// fetches the image for pages we don't have locally. Merge rules:
//   - shared page: whichever side modified it last wins (per-page modifiedAt;
//     manifests from older app versions fall back to the notebook updatedAt);
//   - local-only page: kept when created/edited after the last successful
//     sync (`lastSyncAt`, this device's clock) — otherwise its absence means
//     it was deleted remotely, so it goes here too;
//   - remote-only page: added, unless its uuid is tombstoned here (deleted or
//     replaced locally) — then the push-back removes it remotely instead.
// Returns { id, merged, updatedAt }; merged means local material survived
// that the remote lacks, so the caller must push the result back.
export async function applyRemoteNotebook(manifest, resolveBlob, opts = {}) {
  const { lastSyncAt = 0, pageTombstones = {} } = opts;
  const db = await dbPromise;
  let merged = false;
  let nb = await getNotebookByUuid(manifest.uuid);
  if (!nb) {
    const id = await db.add('notebooks', {
      uuid: manifest.uuid,
      name: manifest.name,
      ...(typeof manifest.order === 'number' ? { order: manifest.order } : {}),
      createdAt: manifest.createdAt || Date.now(),
      updatedAt: manifest.updatedAt,
    });
    nb = await db.get('notebooks', id);
  } else if ((nb.updatedAt || 0) > (manifest.updatedAt || 0)) {
    merged = true; // the side that edited last names the notebook
  } else {
    nb.name = manifest.name;
    if (typeof manifest.order === 'number') nb.order = manifest.order;
    nb.updatedAt = manifest.updatedAt;
    await db.put('notebooks', nb);
  }

  const existing = await getPages(nb.id);
  const byUuid = new Map(existing.map((p) => [p.uuid, p]));
  const inManifest = new Set();
  for (const pm of manifest.pages) {
    inManifest.add(pm.uuid);
    const local = byUuid.get(pm.uuid);
    const remoteAt = pm.modifiedAt ?? manifest.updatedAt ?? 0;
    if (local) {
      if ((local.modifiedAt ?? local.createdAt ?? 0) > remoteAt) {
        merged = true; // the local edit is newer: keep it, push it back
        continue;
      }
      Object.assign(local, {
        order: pm.order,
        name: pm.name,
        text: pm.text || '',
        words: pm.words || [],
        ocrStatus: pm.ocrStatus,
        error: pm.error || '',
        bookmarked: !!pm.bookmarked,
        bookmarkLabel: pm.bookmarkLabel || '',
        modifiedAt: remoteAt,
      });
      await db.put('pages', local);
    } else if (pageTombstones[pm.uuid]) {
      merged = true; // deleted/replaced here: the push-back drops it remotely
    } else {
      const blob = await resolveBlob(pm);
      await db.add('pages', {
        uuid: pm.uuid,
        notebookId: nb.id,
        order: pm.order,
        name: pm.name,
        blob,
        mediaType: pm.mediaType || 'image/jpeg',
        width: pm.width,
        height: pm.height,
        text: pm.text || '',
        words: pm.words || [],
        ocrStatus: pm.ocrStatus,
        error: pm.error || '',
        bookmarked: !!pm.bookmarked,
        bookmarkLabel: pm.bookmarkLabel || '',
        modifiedAt: remoteAt,
        createdAt: Date.now(),
      });
    }
  }

  for (const p of existing) {
    if (inManifest.has(p.uuid)) continue;
    // Absent from the remote: either created/edited here since the last sync
    // (keep — edits win over a remote delete) or deleted remotely (drop).
    // Until a synced-state timestamp exists (first sync after upgrading),
    // fall back to the old created-after-remote-update heuristic.
    const localAt = Math.max(p.createdAt || 0, p.modifiedAt || 0);
    const keep =
      lastSyncAt > 0 ? localAt > lastSyncAt : (p.createdAt || 0) > manifest.updatedAt;
    if (keep) merged = true;
    else await db.delete('pages', p.id);
  }

  if (merged) {
    nb.updatedAt = Date.now();
    await db.put('notebooks', nb);
  }
  return { id: nb.id, merged, updatedAt: nb.updatedAt };
}
