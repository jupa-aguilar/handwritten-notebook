import { IDBFactory } from 'fake-indexeddb';
import { vi } from 'vitest';

const DB_NAME = 'handwritten-notebook';

function promisify(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function txDone(tx) {
  return new Promise((res, rej) => {
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  });
}

// db.js opens the database as a side effect of being imported, so a test that
// wants a clean slate needs both a new IDBFactory and a re-evaluated module —
// otherwise it keeps talking to the previous test's storage.
export function resetStorage() {
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
}

// Split from resetStorage so migration tests can plant a pre-v3 database and
// the old localStorage keys in between.
export async function loadDb() {
  vi.resetModules();
  return import('../src/db.js');
}

export async function freshDb() {
  resetStorage();
  return loadDb();
}

// Recreate the database exactly as schema v2 left it, so the v3 upgrade has
// something real to migrate. Call before importing db.js.
export async function seedSchemaV2({ notebooks = [], pages = [] } = {}) {
  const req = indexedDB.open(DB_NAME, 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    const p = db.createObjectStore('pages', { keyPath: 'id', autoIncrement: true });
    p.createIndex('order', 'order');
    p.createIndex('notebookId', 'notebookId');
    db.createObjectStore('notebooks', { keyPath: 'id', autoIncrement: true });
  };
  const db = await promisify(req);
  const tx = db.transaction(['notebooks', 'pages'], 'readwrite');
  for (const n of notebooks) tx.objectStore('notebooks').add(n);
  for (const p of pages) tx.objectStore('pages').add(p);
  await txDone(tx);
  db.close();
}

// Direct store access, for setting up "what this device already had" without
// going through the app's own write paths (which stamp their own timestamps).
export async function rawPut(store, values) {
  const db = await promisify(indexedDB.open(DB_NAME));
  const tx = db.transaction(store, 'readwrite');
  for (const v of values) tx.objectStore(store).put(v);
  await txDone(tx);
  db.close();
}

export async function rawAll(store) {
  const db = await promisify(indexedDB.open(DB_NAME));
  const result = await promisify(db.transaction(store).objectStore(store).getAll());
  db.close();
  return result;
}

// A page as it appears inside a Drive manifest.
export function manifestPage(overrides = {}) {
  return {
    uuid: 'pg-1',
    order: 0,
    name: 'p1.jpg',
    mediaType: 'image/jpeg',
    width: 100,
    height: 140,
    text: 'remote text',
    words: [],
    ocrStatus: 'done',
    error: '',
    bookmarked: false,
    bookmarkLabel: '',
    modifiedAt: 1000,
    ...overrides,
  };
}

export function manifest(overrides = {}) {
  return {
    uuid: 'nb-1',
    name: 'Remote name',
    createdAt: 1,
    updatedAt: 1000,
    pages: [manifestPage()],
    ...overrides,
  };
}

// A stored page record, as this device would already have it.
export function localPage(overrides = {}) {
  return {
    uuid: 'pg-1',
    notebookId: 1,
    order: 0,
    name: 'p1.jpg',
    blob: new Blob(['local']),
    mediaType: 'image/jpeg',
    width: 100,
    height: 140,
    text: 'local text',
    words: [],
    ocrStatus: 'done',
    error: '',
    bookmarked: false,
    bookmarkLabel: '',
    createdAt: 500,
    modifiedAt: 500,
    ...overrides,
  };
}

export const resolveBlob = async (pm) => new Blob([`downloaded:${pm.uuid}`]);
