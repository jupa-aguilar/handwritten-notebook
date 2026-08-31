// IndexedDB persistence.
//
// Stores:
//   notebooks:          { id, name, createdAt, updatedAt }
//   pages:              { id, notebookId, order, name, blob, mediaType, width,
//                         height, text, ocrStatus, error, bookmarked,
//                         bookmarkLabel }
//     ocrStatus: 'pending' | 'done' | 'error' | 'skipped'
//   pageTombstones:     { uuid, at }  pages deleted/replaced here
//   notebookTombstones: { uuid, at }  notebooks deleted here
//   syncState:          { uuid, localAt, remoteAt, at }  per notebook
//   chats:              { notebookId, messages, updatedAt }  chat history
//   cards:              { id, uuid, notebookId, pageId, pageUuid, q, a, box, ...srs }
//                       review cards drawn from a page
//   cardTombstones:     { uuid, at }  cards deleted here
//   reviewDays:         { notebookId, device, day, answered[3], missed[3] }
//                       what was answered on a given day, and at which rung of
//                       the hint ladder — one row per device, summed to show
//
// Chats are local-only on purpose: they are cheap to regenerate, would bloat
// every sync manifest, and can contain a stray question the user would rather
// not copy to another device. Cards are not: a review schedule you can only
// reach from one machine is half a review schedule, so they sync — in a file
// of their own (see sync.js), because grading a card must not drag a notebook
// manifest full of page text and word boxes up to Drive with it.
//
// The last three are sync bookkeeping and used to live in localStorage. They
// don't anymore: localStorage and IndexedDB have independent lifetimes, so
// anything that wiped one but not the other (privacy extensions, a partial
// "clear site data", a stale profile) left the notebooks without their
// tombstones — and the next pull cheerfully resurrected every page the user
// had deleted. Same database means they fall together or not at all, and a
// delete can now share one transaction with its tombstone.
import { openDB } from 'idb';
import { getDeviceId } from './usage.js';
import { dayKey, recordAnswer, normaliseStats } from './stats.js';

// Pre-v3 homes of the stores above, read once by the v3 migration.
const LEGACY_SYNC_KEYS = [
  'notebook.syncPageTombstones',
  'notebook.syncTombstones',
  'notebook.syncState',
];

function readLegacyMap(key) {
  try {
    const map = JSON.parse(localStorage.getItem(key) || '{}');
    return map && typeof map === 'object' ? map : {};
  } catch {
    return {};
  }
}

// Copy the localStorage bookkeeping into the new stores. Runs inside the
// upgrade transaction, so a failed upgrade leaves the originals as the only
// copy; they're removed once the database has actually opened (below).
function migrateLegacySyncState(tx) {
  const [pageKey, notebookKey, stateKey] = LEGACY_SYNC_KEYS;
  for (const [uuid, at] of Object.entries(readLegacyMap(pageKey))) {
    if (typeof at === 'number') tx.objectStore('pageTombstones').put({ uuid, at });
  }
  for (const [uuid, at] of Object.entries(readLegacyMap(notebookKey))) {
    if (typeof at === 'number') tx.objectStore('notebookTombstones').put({ uuid, at });
  }
  for (const [uuid, s] of Object.entries(readLegacyMap(stateKey))) {
    if (!s || typeof s !== 'object') continue;
    tx.objectStore('syncState').put({
      uuid,
      localAt: s.localAt || 0,
      remoteAt: s.remoteAt || 0,
      at: s.at || 0,
    });
  }
}

const dbPromise = openDB('handwritten-notebook', 8, {
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
    if (oldVersion < 3) {
      db.createObjectStore('pageTombstones', { keyPath: 'uuid' });
      db.createObjectStore('notebookTombstones', { keyPath: 'uuid' });
      db.createObjectStore('syncState', { keyPath: 'uuid' });
      migrateLegacySyncState(tx);
    }
    if (oldVersion < 4) {
      db.createObjectStore('chats', { keyPath: 'notebookId' });
    }
    if (oldVersion < 5) {
      const cards = db.createObjectStore('cards', {
        keyPath: 'id',
        autoIncrement: true,
      });
      cards.createIndex('notebookId', 'notebookId');
      // Cards follow the page's *local* id, not its uuid: replacing a page's
      // image mints a fresh uuid (see swapPageImage) and re-scanning a page
      // must not throw away what you learned from it.
      cards.createIndex('pageId', 'pageId');
    }
    if (oldVersion < 6) {
      db.createObjectStore('cardTombstones', { keyPath: 'uuid' });
      // Cards made before they synced have no identity beyond their local
      // autoincrement id, which means nothing on another device.
      if (oldVersion >= 5) {
        const cards = tx.objectStore('cards');
        let cursor = await cards.openCursor();
        while (cursor) {
          const card = cursor.value;
          if (!card.uuid) {
            card.uuid = crypto.randomUUID();
            card.modifiedAt ||= card.reviewedAt || card.createdAt || Date.now();
            await cursor.update(card);
          }
          cursor = await cursor.continue();
        }
      }
    }
    if (oldVersion < 7) {
      // One row per device per day, never one row per day: these are running
      // totals, so a device writing over the shared figure would erase
      // everybody else's. Same reasoning as usage.js, which says it at length.
      const days = db.createObjectStore('reviewDays', {
        keyPath: ['notebookId', 'device', 'day'],
      });
      days.createIndex('notebookId', 'notebookId');
    }
    if (oldVersion < 8) {
      // So a page's uuid can be read without its image. A key cursor over an
      // index hands back the key itself and never deserialises the record,
      // which for a notebook of a hundred photographs is the difference
      // between a few hundred bytes and every one of them.
      tx.objectStore('pages').createIndex('nbUuid', ['notebookId', 'uuid']);
    }
  },
}).then((db) => {
  // The upgrade committed, so the copies in localStorage are now the stale
  // ones. Dropping them here (not inside the upgrade, which could still have
  // aborted) means there is only ever one source of truth.
  for (const key of LEGACY_SYNC_KEYS) localStorage.removeItem(key);
  return db;
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
  const tx = db.transaction(
    ['notebooks', 'pages', 'syncState', 'chats', 'cards'],
    'readwrite'
  );
  const notebooks = tx.objectStore('notebooks');
  const nb = await notebooks.get(id);
  await notebooks.delete(id);
  await tx.objectStore('chats').delete(id); // its conversation goes with it
  // Its synced-state record describes a notebook that no longer exists; left
  // behind, a later pull of the same uuid would start from stale timestamps.
  // (The tombstone is recorded separately — only deletions the *user* made
  // should propagate, not ones sync itself just applied.)
  if (nb?.uuid) await tx.objectStore('syncState').delete(nb.uuid);
  for (const store of ['pages', 'cards']) {
    let cursor = await tx.objectStore(store).index('notebookId').openCursor(id);
    while (cursor) {
      await cursor.delete();
      cursor = await cursor.continue();
    }
  }
  await tx.done;
}

// ---------- pages (scoped to a notebook) ----------

export async function getPages(notebookId) {
  const db = await dbPromise;
  const all = await db.getAllFromIndex('pages', 'notebookId', notebookId);
  return all.sort((a, b) => a.order - b.order);
}

/**
 * Every page's uuid and local id, without reading a single image. Used by the
 * sync's check for images Drive is missing: it only needs to compare names,
 * and getPages() would have loaded the whole notebook's photographs to do it.
 *
 * Pages from before sync existed have no uuid and so no entry in the compound
 * index. That is right: they have no file on Drive to be missing either, and
 * ensureSyncIds() gives them one before any of this runs.
 */
export async function getPage(id) {
  const db = await dbPromise;
  return db.get('pages', id);
}

export async function listPageIds(notebookId) {
  const db = await dbPromise;
  const out = [];
  const range = IDBKeyRange.bound([notebookId, ''], [notebookId, '\uffff']);
  let cursor = await db.transaction('pages').store.index('nbUuid').openKeyCursor(range);
  while (cursor) {
    out.push({ uuid: cursor.key[1], id: cursor.primaryKey });
    cursor = await cursor.continue();
  }
  return out;
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
  const tx = db.transaction(
    ['pages', 'pageTombstones', 'cards', 'cardTombstones'],
    'readwrite'
  );
  const pages = tx.objectStore('pages');
  const page = await pages.get(id);
  // One transaction: the page can't go without its tombstone, which is the
  // only thing stopping the next pull from bringing it back.
  if (page?.uuid) {
    await tx.objectStore('pageTombstones').put({ uuid: page.uuid, at: Date.now() });
  }
  await pages.delete(id);
  // The cards drawn from it have nothing left to point at.
  const cardTombs = tx.objectStore('cardTombstones');
  let cursor = await tx.objectStore('cards').index('pageId').openCursor(id);
  while (cursor) {
    if (cursor.value.uuid) await cardTombs.put({ uuid: cursor.value.uuid, at: Date.now() });
    await cursor.delete();
    cursor = await cursor.continue();
  }
  await tx.done;
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
  // Sync bookkeeping describes notebooks that are about to stop existing, so
  // it goes with them — otherwise the next sync would push tombstones for a
  // library the user just chose to wipe.
  const stores = [
    'notebooks',
    'pages',
    'pageTombstones',
    'notebookTombstones',
    'syncState',
    'chats',
    'cards',
    'cardTombstones',
  ];
  const tx = db.transaction(stores, 'readwrite');
  await Promise.all(stores.map((s) => tx.objectStore(s).clear()));
  await tx.done;
}

// ---------- chat history ----------
//
// One conversation per notebook, replaced wholesale on each turn — they are
// short, and rewriting the thread is simpler than tracking single messages.
// Failed exchanges are stored too: they are visible in the panel, so dropping
// them on reload would be its own little surprise.

export async function getChat(notebookId) {
  if (notebookId == null) return [];
  const db = await dbPromise;
  const row = await db.get('chats', notebookId);
  return Array.isArray(row?.messages) ? row.messages : [];
}

export async function saveChat(notebookId, messages) {
  if (notebookId == null) return;
  const db = await dbPromise;
  // An empty thread is an absent row, so 🧹 and "never asked anything" look
  // the same in storage rather than leaving an empty husk behind.
  if (!messages?.length) return db.delete('chats', notebookId);
  return db.put('chats', { notebookId, messages, updatedAt: Date.now() });
}

// ---------- review cards ----------
//
// One card is one question drawn from one page, plus the box on that page
// where its answer is written. The scheduling fields (see srs.js) live on the
// same record: there are only ever a few hundred of them per notebook, so the
// review queue is a filter over getAll rather than a cursor over a due index.

export async function listCards(notebookId) {
  if (notebookId == null) return [];
  const db = await dbPromise;
  return db.getAllFromIndex('cards', 'notebookId', notebookId);
}

// Cards arrive a pageful at a time, so they go in a pageful at a time.
export async function addCards(cards) {
  if (!cards?.length) return [];
  const db = await dbPromise;
  const tx = db.transaction('cards', 'readwrite');
  const store = tx.objectStore('cards');
  const ids = [];
  for (const card of cards) {
    card.uuid ||= crypto.randomUUID();
    card.modifiedAt ||= card.createdAt || Date.now();
    ids.push(await store.add(card));
  }
  await tx.done;
  return ids;
}

// Every app-side write lands here, so this is where modifiedAt gets bumped —
// the card merge picks the newer side by it. (Sync-applied remote cards are
// written with raw puts and keep the remote's own timestamp.)
export async function listCardsForPage(pageId) {
  const db = await dbPromise;
  return db.getAllFromIndex('cards', 'pageId', pageId);
}

export async function putCard(card) {
  const db = await dbPromise;
  card.uuid ||= crypto.randomUUID();
  card.modifiedAt = Date.now();
  return db.put('cards', card);
}

export async function deleteCard(id) {
  const db = await dbPromise;
  const tx = db.transaction(['cards', 'cardTombstones'], 'readwrite');
  const card = await tx.objectStore('cards').get(id);
  // Same transaction as the delete, for the same reason pages do it: the
  // tombstone is the only thing stopping the next pull from bringing it back.
  if (card?.uuid) {
    await tx.objectStore('cardTombstones').put({ uuid: card.uuid, at: Date.now() });
  }
  await tx.objectStore('cards').delete(id);
  await tx.done;
}

// Every card drawn from a page, dropped when its questions turn out to be
// wrong — the way to redo a page is to clear it and generate again.
export async function deleteCardsForPage(pageId) {
  const db = await dbPromise;
  const tx = db.transaction(['cards', 'cardTombstones'], 'readwrite');
  const tombs = tx.objectStore('cardTombstones');
  let cursor = await tx.objectStore('cards').index('pageId').openCursor(pageId);
  let n = 0;
  while (cursor) {
    if (cursor.value.uuid) await tombs.put({ uuid: cursor.value.uuid, at: Date.now() });
    await cursor.delete();
    n++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return n;
}

// Cards travel between devices in a file of their own, so their merge lives
// here beside the one for pages. It is a simpler problem: a card is a small
// independent record, so the union of both sides wins, per card, by
// modifiedAt. What makes it work at all is that the deletions ride along in
// the same file — a device that never saw the delete would otherwise push the
// card straight back up.

const CARD_TOMBSTONE_TTL = 60 * 24 * 60 * 60 * 1000; // 60 days, as for pages

export async function getCardTombstones() {
  const db = await dbPromise;
  const tx = db.transaction('cardTombstones', 'readwrite');
  const cutoff = Date.now() - CARD_TOMBSTONE_TTL;
  const map = {};
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if (cursor.value.at < cutoff) await cursor.delete();
    else map[cursor.value.uuid] = cursor.value.at;
    cursor = await cursor.continue();
  }
  await tx.done;
  return map;
}

export async function recordCardTombstones(map) {
  const db = await dbPromise;
  const tx = db.transaction('cardTombstones', 'readwrite');
  for (const [uuid, at] of Object.entries(map || {})) {
    const existing = await tx.store.get(uuid);
    if (!existing || existing.at < at) await tx.store.put({ uuid, at });
  }
  await tx.done;
}

// What goes in the file: the page's uuid instead of its local id, and nothing
// the other device can work out for itself.
const CARD_WIRE_FIELDS = [
  'uuid',
  'q',
  'a',
  'topic',
  'hint',
  'insight',
  'decoys',
  'stats',
  'anchor',
  'box',
  'ease',
  'interval',
  'reps',
  'lapses',
  'due',
  'reviewedAt',
  'suspended',
  'createdAt',
  'modifiedAt',
];

export function cardToWire(card, pageUuid) {
  const out = { pageUuid: pageUuid || card.pageUuid || '' };
  for (const k of CARD_WIRE_FIELDS) if (card[k] !== undefined) out[k] = card[k];
  return out;
}

// Merge a notebook's cards with the copy on Drive. Returns what the file
// should now hold, and whether the remote is missing anything we have — the
// only reason to spend an upload.
export async function applyRemoteCards(notebookId, remoteCards = [], remoteTombs = {}) {
  const db = await dbPromise;
  await recordCardTombstones(remoteTombs);
  const tombstones = await getCardTombstones();

  const pages = await getPages(notebookId);
  const pageByUuid = new Map(pages.map((p) => [p.uuid, p]));
  const local = await db.getAllFromIndex('cards', 'notebookId', notebookId);
  const byUuid = new Map(local.map((c) => [c.uuid, c]));
  let changed = false;

  for (const r of remoteCards) {
    if (!r?.uuid) continue;
    const mine = byUuid.get(r.uuid);
    if (tombstones[r.uuid]) {
      // Deleted here. The upload below drops it, which is how the other
      // device finds out.
      if (mine) await db.delete('cards', mine.id);
      byUuid.delete(r.uuid);
      changed = true;
      continue;
    }
    if (mine) {
      if ((mine.modifiedAt || 0) > (r.modifiedAt || 0)) {
        changed = true; // our grade is the newer one: push it back
        continue;
      }
      // Raw put, not putCard: the remote's modifiedAt is the whole point.
      await db.put('cards', { ...mine, ...fromWire(r, mine.pageId, mine.notebookId) });
      byUuid.set(r.uuid, { ...mine, ...fromWire(r, mine.pageId, mine.notebookId) });
      continue;
    }
    const page = pageByUuid.get(r.pageUuid);
    // Its page hasn't landed here yet (a first sync where an image failed, or
    // a page re-scanned elsewhere). Leave it on Drive and pick it up next
    // round rather than storing a card that points at nothing.
    if (!page) continue;
    const record = fromWire(r, page.id, notebookId);
    const id = await db.add('cards', record);
    byUuid.set(r.uuid, { ...record, id });
  }

  const remoteUuids = new Set(remoteCards.map((r) => r?.uuid));
  for (const c of local) {
    if (remoteUuids.has(c.uuid)) continue;
    if (tombstones[c.uuid]) {
      await db.delete('cards', c.id);
      byUuid.delete(c.uuid);
      changed = true;
    } else {
      changed = true; // made here since the last sync
    }
  }
  // Deletions this device recorded that the file doesn't carry yet.
  for (const uuid of Object.keys(tombstones)) {
    if (!(uuid in (remoteTombs || {}))) changed = true;
  }

  const pageById = new Map(pages.map((p) => [p.id, p]));
  const cards = [...byUuid.values()].map((c) =>
    cardToWire(c, pageById.get(c.pageId)?.uuid)
  );
  return { cards, tombstones, changed };
}

function fromWire(r, pageId, notebookId) {
  const out = { notebookId, pageId, pageUuid: r.pageUuid || '' };
  for (const k of CARD_WIRE_FIELDS) if (r[k] !== undefined) out[k] = r[k];
  out.modifiedAt ||= out.createdAt || Date.now();
  return out;
}

// ---------- what was reviewed, and when ----------
//
// A day's tally per device, for the same reason usage.js keeps its counters
// that way: these are running totals, and last-write-wins between two devices
// would silently throw one device's week away. Each owns one row per day and
// only ever writes that; every reader sums.

// Three years. Past that the rows are answering a question nobody is asking,
// and they ride inside a file that is re-uploaded on every grade.
const DAY_ROW_TTL_DAYS = 365 * 3;

function tooOld(day, now = Date.now()) {
  return day < dayKey(now - DAY_ROW_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// One answer, on this device, today.
export async function bumpReviewDay(notebookId, grade, step, now = Date.now()) {
  if (notebookId == null) return;
  const db = await dbPromise;
  const day = dayKey(now);
  const device = getDeviceId();
  const tx = db.transaction('reviewDays', 'readwrite');
  const existing = await tx.store.get([notebookId, device, day]);
  const next = recordAnswer(existing, grade, step);
  await tx.store.put({ notebookId, device, day, ...next });
  await tx.done;
}

// Every device's rows for one notebook. Summing them is the caller's business
// (see bucket() in stats.js), because how they are grouped depends on what is
// being drawn.
export async function listReviewDays(notebookId) {
  if (notebookId == null) return [];
  const db = await dbPromise;
  return db.getAllFromIndex('reviewDays', 'notebookId', notebookId);
}

// Normalised on the way out as well as on the way in: a row stored before a
// rung existed is still the width it was, and letting those go up as they lie
// would make the shared file ragged — some rows one width, some another,
// depending on which build last touched them.
const historyFromRows = (rows) => {
  const out = {};
  for (const r of rows) {
    const { answered, missed } = normaliseStats({ answered: r.answered, missed: r.missed });
    (out[r.device] ||= {})[r.day] = { a: answered, m: missed };
  }
  return out;
};

/**
 * Merge the history carried in the cards file. Other devices' rows are stored
 * as they arrive; ours are never taken from the file, because the copy here is
 * the newer one by construction — this device is the only thing that writes
 * it. Returns what the file should now hold and whether ours differs from what
 * it held, which is the only reason to spend an upload on it.
 */
export async function applyRemoteHistory(notebookId, remote = {}, now = Date.now()) {
  const db = await dbPromise;
  const me = getDeviceId();
  const tx = db.transaction('reviewDays', 'readwrite');

  for (const [device, days] of Object.entries(remote || {})) {
    if (device === me) continue;
    for (const [day, row] of Object.entries(days || {})) {
      if (tooOld(day, now)) continue;
      await tx.store.put({
        notebookId,
        device,
        day,
        ...normaliseStats({ answered: row?.a, missed: row?.m }),
      });
    }
  }

  const mine = [];
  let cursor = await tx.store.index('notebookId').openCursor(notebookId);
  while (cursor) {
    if (tooOld(cursor.value.day, now)) await cursor.delete();
    else mine.push(cursor.value);
    cursor = await cursor.continue();
  }
  await tx.done;

  const history = historyFromRows(mine);
  const ours = JSON.stringify(history[me] || {});
  const theirs = JSON.stringify(remote?.[me] || {});
  return { history, changed: ours !== theirs };
}

// ---------- sync support ----------

// Uuids of pages deleted (or replaced — same thing to sync) on this device.
// A pull consults them so a manifest that still lists such a page can't
// resurrect it here; the following push then removes it remotely as well.
// Pruned by age: once every device has synced they're dead weight.
const PAGE_TOMBSTONE_TTL = 60 * 24 * 60 * 60 * 1000; // 60 days

// Returns { [uuid]: deletedAtMs }, dropping expired entries on the way — a
// map, because the merge looks up hundreds of pages against it.
export async function getPageTombstones() {
  const db = await dbPromise;
  const tx = db.transaction('pageTombstones', 'readwrite');
  const cutoff = Date.now() - PAGE_TOMBSTONE_TTL;
  const map = {};
  let cursor = await tx.store.openCursor();
  while (cursor) {
    if (cursor.value.at < cutoff) await cursor.delete();
    else map[cursor.value.uuid] = cursor.value.at;
    cursor = await cursor.continue();
  }
  await tx.done;
  return map;
}

export async function recordPageTombstone(uuid) {
  if (!uuid) return;
  const db = await dbPromise;
  return db.put('pageTombstones', { uuid, at: Date.now() });
}

// Notebooks deleted locally since the last successful sync, so the deletion
// can propagate: { [uuid]: deletedAtMs }.
export async function getNotebookTombstones() {
  const db = await dbPromise;
  const all = await db.getAll('notebookTombstones');
  return Object.fromEntries(all.map((t) => [t.uuid, t.at]));
}

export async function recordNotebookTombstone(uuid) {
  if (!uuid) return;
  const db = await dbPromise;
  return db.put('notebookTombstones', { uuid, at: Date.now() });
}

// Replace the whole set. A sync run drops entries from its in-memory copy as
// it propagates them and saves what's left once, at the end — so a run that
// dies halfway retries the lot rather than forgetting a deletion it never
// managed to publish.
export async function setNotebookTombstones(map) {
  const db = await dbPromise;
  const tx = db.transaction('notebookTombstones', 'readwrite');
  await tx.store.clear();
  for (const [uuid, at] of Object.entries(map)) await tx.store.put({ uuid, at });
  await tx.done;
}

// What a notebook looked like right after its last successful sync:
// { uuid, localAt, remoteAt, at } — the updatedAt seen on each side, plus the
// local wall-clock moment. Comparing both sides against this tells a real
// change apart from mere clock differences between devices, and `at` is what
// page merging compares local createdAt/modifiedAt against (same clock, so no
// cross-device skew).
export async function getSyncedState(uuid) {
  const db = await dbPromise;
  return (await db.get('syncState', uuid)) || null;
}

export async function setSyncedState(uuid, localAt, remoteAt) {
  const db = await dbPromise;
  const prev = (await db.get('syncState', uuid)) || {};
  return db.put('syncState', { ...prev, uuid, localAt, remoteAt, at: Date.now() });
}

/**
 * What this notebook's cards look like right now, cheaply enough to ask on
 * every sync: how many there are and the newest edit among them. Together
 * they catch every local change worth an upload — an edit or a grade moves
 * the timestamp, and a deletion moves the count, which nothing else would
 * show since the card is gone.
 */
export async function cardsFingerprint(notebookId) {
  const db = await dbPromise;
  const cards = await db.getAllFromIndex('cards', 'notebookId', notebookId);
  let max = 0;
  for (const c of cards) max = Math.max(max, c.modifiedAt || 0);
  return { count: cards.length, max };
}

/** Remembered beside the notebook's own sync state; see syncCards. */
export async function setCardsSynced(uuid, cards) {
  const db = await dbPromise;
  const prev = (await db.get('syncState', uuid)) || { uuid, localAt: 0, remoteAt: 0 };
  return db.put('syncState', { ...prev, uuid, cards, at: Date.now() });
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
//
// A remote page whose image cannot be fetched is reported in `missing` rather
// than thrown: see the note at the call. A caller that sees anything in there
// is holding an incomplete copy and must neither publish it back nor record
// the sync as done.
// Returns { id, merged, updatedAt }; merged means local material survived
// that the remote lacks, so the caller must push the result back.
export async function applyRemoteNotebook(manifest, resolveBlob, opts = {}) {
  const { lastSyncAt = 0, pageTombstones = {} } = opts;
  const db = await dbPromise;
  let merged = false;
  // Pages the remote has that could not be fetched this time round.
  const missing = [];
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
      let blob;
      try {
        blob = await resolveBlob(pm);
      } catch (err) {
        // One image that will not come down must not take the rest of the
        // notebook with it. A phone on mobile data drops a request now and
        // then, and this used to throw all the way out of syncNow — leaving
        // the notebook half-copied and skipping every notebook queued behind
        // it, cards included. The page is left for the next pull, which is
        // why the caller must not record this sync as a complete one.
        console.error('Could not fetch the image for page', pm.uuid, err);
        missing.push(pm.uuid);
        continue;
      }
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
  return { id: nb.id, merged, updatedAt: nb.updatedAt, missing };
}
