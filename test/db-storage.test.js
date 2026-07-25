// Schema v3 moved the sync bookkeeping out of localStorage and into the
// database. These cover the migration off the old keys and the invariants the
// move bought: a delete and its tombstone are atomic, and state doesn't
// outlive the notebook it describes.
import { describe, it, expect, beforeEach } from 'vitest';
import { freshDb, resetStorage, loadDb, seedSchemaV2, rawAll, localPage } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;
const LEGACY_PAGE_TOMBSTONES = 'notebook.syncPageTombstones';
const LEGACY_NOTEBOOK_TOMBSTONES = 'notebook.syncTombstones';
const LEGACY_SYNC_STATE = 'notebook.syncState';

describe('migrating off localStorage', () => {
  const now = Date.now();
  let db;

  beforeEach(async () => {
    resetStorage();
    await seedSchemaV2({
      notebooks: [{ id: 1, uuid: 'nb-1', name: 'Kept', createdAt: 1, updatedAt: 2 }],
      pages: [localPage({ id: 1, uuid: 'pg-1', notebookId: 1 })],
    });
    localStorage.setItem(
      LEGACY_PAGE_TOMBSTONES,
      JSON.stringify({ 'pg-recent': now - 5 * DAY, 'pg-ancient': now - 90 * DAY })
    );
    localStorage.setItem(
      LEGACY_NOTEBOOK_TOMBSTONES,
      JSON.stringify({ 'nb-gone': now - 2 * DAY })
    );
    localStorage.setItem(
      LEGACY_SYNC_STATE,
      JSON.stringify({ 'nb-1': { localAt: 2, remoteAt: 2, at: now - DAY } })
    );
    db = await loadDb();
  });

  it('carries the page tombstones over', async () => {
    expect(await db.getPageTombstones()).toMatchObject({ 'pg-recent': now - 5 * DAY });
  });

  it('drops tombstones older than the 60-day TTL, from the store and not just the result', async () => {
    expect(await db.getPageTombstones()).not.toHaveProperty('pg-ancient');
    expect((await rawAll('pageTombstones')).map((t) => t.uuid)).toEqual(['pg-recent']);
  });

  it('carries the notebook tombstones over', async () => {
    expect(await db.getNotebookTombstones()).toEqual({ 'nb-gone': now - 2 * DAY });
  });

  it('carries the synced state over', async () => {
    expect(await db.getSyncedState('nb-1')).toEqual({
      uuid: 'nb-1',
      localAt: 2,
      remoteAt: 2,
      at: now - DAY,
    });
  });

  it('removes the old keys, so there is one source of truth', async () => {
    await db.listNotebooks(); // any call awaits the open that clears them
    for (const key of [LEGACY_PAGE_TOMBSTONES, LEGACY_NOTEBOOK_TOMBSTONES, LEGACY_SYNC_STATE]) {
      expect(localStorage.getItem(key)).toBeNull();
    }
  });

  it('leaves the notebooks and pages alone', async () => {
    expect(await db.listNotebooks()).toHaveLength(1);
    expect(await db.getPages(1)).toHaveLength(1);
  });

  it('survives corrupt legacy values instead of failing to open', async () => {
    resetStorage();
    await seedSchemaV2();
    localStorage.setItem(LEGACY_PAGE_TOMBSTONES, '{not json');
    localStorage.setItem(LEGACY_SYNC_STATE, 'null');
    const fresh = await loadDb();
    expect(await fresh.getPageTombstones()).toEqual({});
    expect(await fresh.getSyncedState('anything')).toBeNull();
  });
});

describe('deleting a page', () => {
  let db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('records the tombstone in the same breath', async () => {
    const nb = await db.addNotebook('N');
    const id = await db.addPage(localPage({ uuid: 'pg-doomed', notebookId: nb }));

    await db.deletePage(id);

    expect(await db.getPageTombstones()).toHaveProperty('pg-doomed');
    expect(await db.getPages(nb)).toEqual([]);
  });

  it('skips the tombstone for a page that never had a uuid', async () => {
    const nb = await db.addNotebook('N');
    const page = localPage({ notebookId: nb });
    delete page.uuid;
    const id = await db.addPage(page);

    await db.deletePage(id);

    expect(await db.getPageTombstones()).toEqual({});
  });
});

describe('deleting a notebook', () => {
  let db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('clears its synced state but leaves other notebooks alone', async () => {
    const doomed = await db.addNotebook('Doomed');
    const kept = await db.addNotebook('Kept');
    const doomedUuid = (await db.getNotebook(doomed)).uuid;
    const keptUuid = (await db.getNotebook(kept)).uuid;
    await db.setSyncedState(doomedUuid, 10, 10);
    await db.setSyncedState(keptUuid, 20, 20);

    await db.deleteNotebook(doomed);

    expect(await db.getSyncedState(doomedUuid)).toBeNull();
    expect(await db.getSyncedState(keptUuid)).toMatchObject({ localAt: 20 });
  });

  it('takes its pages with it', async () => {
    const nb = await db.addNotebook('N');
    await db.addPage(localPage({ uuid: 'a', notebookId: nb }));
    await db.addPage(localPage({ uuid: 'b', notebookId: nb }));

    await db.deleteNotebook(nb);

    expect(await rawAll('pages')).toEqual([]);
  });
});

describe('tombstone and state bookkeeping', () => {
  let db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('replaces the notebook tombstone set wholesale', async () => {
    await db.recordNotebookTombstone('nb-a');
    await db.recordNotebookTombstone('nb-b');

    await db.setNotebookTombstones({ 'nb-c': 123 });

    expect(await db.getNotebookTombstones()).toEqual({ 'nb-c': 123 });
  });

  it('ignores empty uuids rather than storing junk', async () => {
    await db.recordNotebookTombstone('');
    await db.recordNotebookTombstone(undefined);
    await db.recordPageTombstone(null);

    expect(await db.getNotebookTombstones()).toEqual({});
    expect(await db.getPageTombstones()).toEqual({});
  });

  it('wipes the bookkeeping along with the notebooks on clearAll', async () => {
    const nb = await db.addNotebook('N');
    await db.setSyncedState((await db.getNotebook(nb)).uuid, 1, 1);
    await db.recordPageTombstone('pg-x');
    await db.recordNotebookTombstone('nb-x');

    await db.clearAll();

    expect(await db.listNotebooks()).toEqual([]);
    expect(await db.getPageTombstones()).toEqual({});
    expect(await db.getNotebookTombstones()).toEqual({});
    expect(await rawAll('syncState')).toEqual([]);
  });
});

describe('the mutation ritual sync depends on', () => {
  let db;
  beforeEach(async () => {
    db = await freshDb();
  });

  it('stamps modifiedAt on every write through putPage', async () => {
    const nb = await db.addNotebook('N');
    const id = await db.addPage(localPage({ notebookId: nb, modifiedAt: 1 }));
    const [page] = await db.getPages(nb);

    page.text = 'edited';
    await db.putPage(page);

    const [saved] = await db.getPages(nb);
    expect(saved.modifiedAt).toBeGreaterThan(1);
    expect(saved.id).toBe(id);
  });

  it('gives new pages a modifiedAt so the merge can compare them', async () => {
    const nb = await db.addNotebook('N');
    const page = localPage({ notebookId: nb, createdAt: 4242 });
    delete page.modifiedAt;
    await db.addPage(page);

    expect((await db.getPages(nb))[0].modifiedAt).toBe(4242);
  });

  it('bumps modifiedAt when reordering, so page moves propagate', async () => {
    const nb = await db.addNotebook('N');
    const a = await db.addPage(localPage({ uuid: 'a', notebookId: nb, order: 0, modifiedAt: 1 }));
    const b = await db.addPage(localPage({ uuid: 'b', notebookId: nb, order: 1, modifiedAt: 1 }));

    await db.reorderPages([b, a]);

    const pages = await db.getPages(nb);
    expect(pages.map((p) => p.uuid)).toEqual(['b', 'a']);
    expect(pages.every((p) => p.modifiedAt > 1)).toBe(true);
  });

  it('backfills uuids on records that predate sync', async () => {
    const nb = await db.addNotebook('N');
    const page = localPage({ notebookId: nb });
    delete page.uuid;
    await db.addPage(page);

    await db.ensureSyncIds();

    expect((await db.getPages(nb))[0].uuid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('orders notebooks by explicit order, putting never-ordered ones last', async () => {
    const first = await db.addNotebook('First');
    const second = await db.addNotebook('Second');
    const unordered = await db.addNotebook('Unordered');
    await db.reorderNotebooks([second, first]);

    expect((await db.listNotebooks()).map((n) => n.name)).toEqual([
      'Second',
      'First',
      'Unordered',
    ]);
  });
});
