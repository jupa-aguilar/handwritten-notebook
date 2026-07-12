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
  return all.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
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
  return db.add('pages', page);
}

export async function putPage(page) {
  const db = await dbPromise;
  return db.put('pages', page);
}

export async function deletePage(id) {
  const db = await dbPromise;
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

// Create or update a local notebook from a remote manifest. `resolveBlob(pm)`
// fetches the image for pages we don't have locally. Local pages created
// after the remote's updatedAt are kept (they'll be pushed on the next pass);
// returns { id, merged } where merged means such pages survived.
export async function applyRemoteNotebook(manifest, resolveBlob) {
  const db = await dbPromise;
  let nb = await getNotebookByUuid(manifest.uuid);
  if (!nb) {
    const id = await db.add('notebooks', {
      uuid: manifest.uuid,
      name: manifest.name,
      createdAt: manifest.createdAt || Date.now(),
      updatedAt: manifest.updatedAt,
    });
    nb = await db.get('notebooks', id);
  } else {
    nb.name = manifest.name;
    nb.updatedAt = manifest.updatedAt;
    await db.put('notebooks', nb);
  }

  const existing = await getPages(nb.id);
  const byUuid = new Map(existing.map((p) => [p.uuid, p]));
  const inManifest = new Set();
  for (const pm of manifest.pages) {
    inManifest.add(pm.uuid);
    const local = byUuid.get(pm.uuid);
    if (local) {
      Object.assign(local, {
        order: pm.order,
        name: pm.name,
        text: pm.text || '',
        words: pm.words || [],
        ocrStatus: pm.ocrStatus,
        error: pm.error || '',
        bookmarked: !!pm.bookmarked,
        bookmarkLabel: pm.bookmarkLabel || '',
      });
      await db.put('pages', local);
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
        createdAt: Date.now(),
      });
    }
  }

  let merged = false;
  for (const p of existing) {
    if (inManifest.has(p.uuid)) continue;
    if ((p.createdAt || 0) > manifest.updatedAt) {
      merged = true; // locally-new page: keep it, push it later
    } else {
      await db.delete('pages', p.id);
    }
  }
  if (merged) {
    nb.updatedAt = Date.now();
    await db.put('notebooks', nb);
  }
  return { id: nb.id, merged };
}
